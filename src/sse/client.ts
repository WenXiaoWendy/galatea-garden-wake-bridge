import { validateGardenBaseUrl } from "../config.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logging.js";
import { safeErrorMessage } from "../logging.js";
import {
  decodeGardenEvent,
  GARDEN_PROTOCOL,
  type GardenProtocolEvent,
  type ProtocolDiagnostic,
} from "../protocol.js";
import { SseParser } from "./parser.js";

export type GardenStreamErrorKind = "auth" | "terminal";

export class GardenStreamError extends Error {
  readonly kind: GardenStreamErrorKind;
  readonly status: number | undefined;

  constructor(kind: GardenStreamErrorKind, message: string, status?: number) {
    super(message);
    this.name = "GardenStreamError";
    this.kind = kind;
    this.status = status;
  }
}

class ConnectTimeoutError extends Error {}

export interface GardenSseClientOptions {
  baseUrl: URL;
  machineToken: string;
  connectTimeoutMs: number;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
}

export interface StreamAttemptResult {
  connected: boolean;
  stopped: boolean;
}

export interface StreamAttemptHandlers {
  onEvent(event: Exclude<GardenProtocolEvent, { kind: "ignored" }>): boolean | void;
  onIgnored?(diagnostic: ProtocolDiagnostic<"debug" | "warn">): void;
}

export class GardenSseClient {
  readonly #options: GardenSseClientOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GardenSseClientOptions) {
    this.#options = { ...options, baseUrl: validateGardenBaseUrl(options.baseUrl) };
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async streamOnce(
    handlers: StreamAttemptHandlers,
    signal: AbortSignal,
  ): Promise<StreamAttemptResult> {
    if (signal.aborted) {
      return { connected: false, stopped: true };
    }
    const requestController = new AbortController();
    const forwardAbort = (): void => requestController.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });
    if (signal.aborted) {
      forwardAbort();
    }

    let connectTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      requestController.abort(new ConnectTimeoutError("connection timed out"));
    }, this.#options.connectTimeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(this.#streamUrl(), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.#options.machineToken}`,
        },
        redirect: "manual",
        signal: requestController.signal,
      });
    } catch (error) {
      signal.removeEventListener("abort", forwardAbort);
      if (signal.aborted) {
        return { connected: false, stopped: true };
      }
      throw this.#requestFailure(error, requestController.signal);
    } finally {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    }

    try {
      await this.#validateResponse(response);
      if (!response.body) {
        throw new GardenStreamError("terminal", "SSE response body is unavailable");
      }

      const reader = response.body.getReader();
      let connected = false;
      let stopRequested = false;
      const parser = new SseParser({
        onEvent: (rawEvent) => {
          // The production Wake endpoint currently omits SSE `id:` fields.
          // Mint one exactly once at ingress so retries of the same decoded
          // RuntimeWake keep a stable identifier while separate wakes never
          // collapse into one Home bridge event.
          const identifiedEvent = rawEvent.event === GARDEN_PROTOCOL.events.wake && !rawEvent.id
            ? { ...rawEvent, id: `wake_${randomUUID().replaceAll("-", "")}` }
            : rawEvent;
          const event = decodeGardenEvent(identifiedEvent);
          if (event.kind === "ignored") {
            if (event.severity === "terminal") {
              throw new GardenStreamError("terminal", event.cause);
            }
            handlers.onIgnored?.({ cause: event.cause, severity: event.severity });
            return;
          }
          if (event.kind === "connected") {
            connected = true;
          } else if (!connected) {
            handlers.onIgnored?.({
              cause: "wake event received before protocol handshake",
              severity: "warn",
            });
            return;
          }
          stopRequested = handlers.onEvent(event) === true || stopRequested;
        },
      });

      try {
        while (!signal.aborted && !stopRequested) {
          const result = await reader.read();
          if (result.done) {
            parser.finish();
            break;
          }
          parser.push(result.value);
        }
      } catch (error) {
        if (signal.aborted) {
          return {
            connected,
            stopped: true,
          };
        }
        if (error instanceof GardenStreamError) {
          throw error;
        }
        throw new GardenStreamError(
          "terminal",
          `SSE stream failed: ${safeErrorMessage(error, [this.#options.machineToken])}`,
        );
      } finally {
        await reader.cancel().catch((error: unknown) => {
          this.#options.logger.warn("failed to cancel Garden SSE reader", {
            error: safeErrorMessage(error, [this.#options.machineToken]),
          });
        });
      }

      return {
        connected,
        stopped: signal.aborted || stopRequested,
      };
    } finally {
      signal.removeEventListener("abort", forwardAbort);
    }
  }

  async probe(signal: AbortSignal): Promise<void> {
    let handshakeSeen = false;
    const result = await this.streamOnce(
      {
        onEvent: (event) => {
          if (event.kind === "connected") {
            handshakeSeen = true;
            return true;
          }
          return false;
        },
        onIgnored: (diagnostic) =>
          this.#options.logger[diagnostic.severity === "warn" ? "warn" : "debug"](
            "probe ignored SSE event",
            { cause: diagnostic.cause },
          ),
      },
      signal,
    );
    if (!handshakeSeen) {
      throw new GardenStreamError(
        "terminal",
        signal.aborted
          ? "SSE probe stopped before the connected event"
          : result.connected
            ? "SSE probe ended unexpectedly"
            : "SSE stream ended before the connected event",
      );
    }
  }

  #streamUrl(): URL {
    return new URL(GARDEN_PROTOCOL.streamPath, this.#options.baseUrl);
  }

  #requestFailure(
    error: unknown,
    requestSignal: AbortSignal,
  ): GardenStreamError {
    if (requestSignal.reason instanceof ConnectTimeoutError) {
      return new GardenStreamError("terminal", requestSignal.reason.message);
    }
    return new GardenStreamError(
      "terminal",
      `SSE connection failed: ${safeErrorMessage(error, [this.#options.machineToken])}`,
    );
  }

  async #validateResponse(response: Response): Promise<void> {
    if (!response.ok) {
      const detail = await this.#responseDetail(response);
      const message = detail
        ? `Garden SSE request failed with HTTP ${response.status}: ${detail}`
        : `Garden SSE request failed with HTTP ${response.status}`;
      throw new GardenStreamError(
        response.status === 401 ? "auth" : "terminal",
        message,
        response.status,
      );
    }
    const contentType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "text/event-stream") {
      await this.#cancelBody(response.body, "invalid SSE content type");
      throw new GardenStreamError(
        "terminal",
        "Garden SSE response has an invalid content type",
        response.status,
      );
    }
  }

  async #responseDetail(response: Response): Promise<string> {
    const body = await response.text().catch(() => "");
    if (!body.trim()) {
      return "";
    }
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "detail" in parsed &&
        typeof parsed.detail === "string"
      ) {
        return safeErrorMessage(parsed.detail, [this.#options.machineToken]);
      }
    } catch {
      // Non-JSON proxy responses are represented by their HTTP status only.
    }
    return "";
  }

  async #cancelBody(body: ReadableStream<Uint8Array> | null, operation: string): Promise<void> {
    if (!body) {
      return;
    }
    await body.cancel().catch((error: unknown) => {
      this.#options.logger.warn("failed to release Garden HTTP response body", {
        operation,
        error: safeErrorMessage(error, [this.#options.machineToken]),
      });
    });
  }
}
