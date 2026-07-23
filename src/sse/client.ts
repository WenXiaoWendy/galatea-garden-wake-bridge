import { validateGardenBaseUrl } from "../config.js";
import type { Logger } from "../logging.js";
import { safeErrorMessage } from "../logging.js";
import {
  decodeGardenEvent,
  GARDEN_PROTOCOL,
  type GardenProtocolEvent,
  type ProtocolDiagnostic,
} from "../protocol.js";
import { SseParser } from "./parser.js";

export type GardenStreamErrorKind = "auth" | "terminal" | "retryable";

export class GardenStreamError extends Error {
  readonly kind: GardenStreamErrorKind;
  readonly status: number | undefined;
  readonly connectionDurationMs: number;

  constructor(
    kind: GardenStreamErrorKind,
    message: string,
    status?: number,
    connectionDurationMs = 0,
  ) {
    super(message);
    this.name = "GardenStreamError";
    this.kind = kind;
    this.status = status;
    this.connectionDurationMs = connectionDurationMs;
  }
}

class ConnectTimeoutError extends Error {}
class ReadIdleTimeoutError extends Error {}

export interface GardenSseClientOptions {
  baseUrl: URL;
  machineToken: string;
  connectTimeoutMs: number;
  readIdleTimeoutMs: number;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface StreamAttemptResult {
  connected: boolean;
  durationMs: number;
  stopped: boolean;
}

export interface StreamAttemptHandlers {
  onEvent(event: Exclude<GardenProtocolEvent, { kind: "ignored" }>): boolean | void;
  onIgnored?(diagnostic: ProtocolDiagnostic<"debug" | "warn">): void;
}

export class GardenSseClient {
  readonly #options: GardenSseClientOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;

  constructor(options: GardenSseClientOptions) {
    this.#options = { ...options, baseUrl: validateGardenBaseUrl(options.baseUrl) };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async streamOnce(
    handlers: StreamAttemptHandlers,
    signal: AbortSignal,
  ): Promise<StreamAttemptResult> {
    if (signal.aborted) {
      return { connected: false, durationMs: 0, stopped: true };
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
      throw this.#requestFailure(error, requestController.signal, signal);
    } finally {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    }

    try {
      try {
        this.#validateResponse(response);
      } catch (error) {
        await this.#cancelBody(response.body, "invalid SSE response");
        throw error;
      }
      if (!response.body) {
        throw new GardenStreamError("terminal", "SSE response body is unavailable");
      }

      const reader = response.body.getReader();
      let connected = false;
      let connectedAt: number | undefined;
      let stopRequested = false;
      const parser = new SseParser({
        onEvent: (rawEvent) => {
          const event = decodeGardenEvent(rawEvent);
          if (event.kind === "ignored") {
            if (event.severity === "terminal") {
              throw new GardenStreamError("terminal", event.cause);
            }
            handlers.onIgnored?.({ cause: event.cause, severity: event.severity });
            return;
          }
          if (event.kind === "connected") {
            connected = true;
            connectedAt ??= this.#now();
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
          const readIdleTimer = setTimeout(() => {
            requestController.abort(new ReadIdleTimeoutError("SSE read timed out"));
          }, this.#options.readIdleTimeoutMs);
          try {
            const result = await reader.read();
            if (result.done) {
              parser.finish();
              break;
            }
            parser.push(result.value);
          } finally {
            clearTimeout(readIdleTimer);
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return {
            connected,
            durationMs: connectedAt === undefined ? 0 : this.#now() - connectedAt,
            stopped: true,
          };
        }
        const reason = requestController.signal.reason;
        if (reason instanceof ReadIdleTimeoutError) {
          throw new GardenStreamError(
            "retryable",
            reason.message,
            undefined,
            connectedAt === undefined ? 0 : this.#now() - connectedAt,
          );
        }
        if (error instanceof GardenStreamError) {
          throw new GardenStreamError(
            error.kind,
            error.message,
            error.status,
            connectedAt === undefined ? 0 : this.#now() - connectedAt,
          );
        }
        throw new GardenStreamError(
          "retryable",
          `SSE stream failed: ${safeErrorMessage(error, [this.#options.machineToken])}`,
          undefined,
          connectedAt === undefined ? 0 : this.#now() - connectedAt,
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
        durationMs: connectedAt === undefined ? 0 : this.#now() - connectedAt,
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
        signal.aborted ? "retryable" : "terminal",
        result.connected
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
    externalSignal: AbortSignal,
  ): GardenStreamError {
    if (externalSignal.aborted) {
      return new GardenStreamError("retryable", "bridge stopped");
    }
    if (requestSignal.reason instanceof ConnectTimeoutError) {
      return new GardenStreamError("retryable", requestSignal.reason.message);
    }
    return new GardenStreamError(
      "retryable",
      `SSE connection failed: ${safeErrorMessage(error, [this.#options.machineToken])}`,
    );
  }

  #validateResponse(response: Response): void {
    if (response.status === 401 || response.status === 403) {
      throw new GardenStreamError("auth", "Garden rejected the machine token", response.status);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new GardenStreamError(
        "retryable",
        `Garden SSE request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new GardenStreamError(
        "terminal",
        `Garden SSE redirects are not allowed (HTTP ${response.status})`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new GardenStreamError(
        "terminal",
        `Garden SSE request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    const contentType =
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "text/event-stream") {
      throw new GardenStreamError(
        "terminal",
        "Garden SSE response has an invalid content type",
        response.status,
      );
    }
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
