import { abortableDelay, ReconnectBackoff } from "./backoff.js";
import type { BridgeConfig } from "./config.js";
import type { Logger } from "./logging.js";
import { safeErrorMessage } from "./logging.js";
import type { GardenProtocolEvent, RuntimeWake } from "./protocol.js";
import type { RuntimeAdapter } from "./runtime/adapter.js";
import { WakeDispatcher } from "./runtime/dispatcher.js";
import {
  GardenSseClient,
  GardenStreamError,
  type StreamAttemptHandlers,
  type StreamAttemptResult,
} from "./sse/client.js";

export interface GardenEventStream {
  streamOnce(
    handlers: StreamAttemptHandlers,
    signal: AbortSignal,
  ): Promise<StreamAttemptResult>;
}

function runtimeWakeFromEvent(
  event: Extract<GardenProtocolEvent, { kind: "wake" }>,
  messageMap: BridgeConfig["wakeMessageMap"],
): RuntimeWake {
  return {
    reason: event.reason,
    message: messageMap[event.reason] ?? event.message,
  };
}

export interface BridgeRunnerDependencies {
  createClient?: () => GardenEventStream;
  backoff?: ReconnectBackoff;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export async function runBridge(
  config: BridgeConfig,
  adapter: RuntimeAdapter,
  logger: Logger,
  signal: AbortSignal,
  dependencies: BridgeRunnerDependencies = {},
): Promise<void> {
  const client =
    dependencies.createClient?.() ??
    new GardenSseClient({
      baseUrl: config.baseUrl,
      machineToken: config.machineToken,
      connectTimeoutMs: config.timeouts.connectMs,
      readIdleTimeoutMs: config.timeouts.readIdleMs,
      logger,
    });
  const backoff = dependencies.backoff ?? new ReconnectBackoff();
  const sleep = dependencies.sleep ?? abortableDelay;
  const dispatcher = new WakeDispatcher(adapter, logger, {
    deliveryTimeoutMs: config.timeouts.runtimeDeliveryMs,
    closeTimeoutMs: config.timeouts.runtimeCloseMs,
  });
  const reportedDiagnostics = new Set<string>();

  try {
    while (!signal.aborted) {
      try {
        logger.info("connecting to Garden SSE", { origin: config.baseUrl.origin });
        const result = await client.streamOnce(
          {
            onEvent: (event) => {
              if (event.kind === "connected") {
                logger.info("Garden SSE connected", { protocolVersion: event.version });
              } else {
                dispatcher.enqueue(runtimeWakeFromEvent(event, config.wakeMessageMap));
              }
            },
            onIgnored: (diagnostic) => {
              if (reportedDiagnostics.has(diagnostic.cause)) {
                return;
              }
              reportedDiagnostics.add(diagnostic.cause);
              logger[diagnostic.severity === "warn" ? "warn" : "debug"](
                "ignored Garden SSE event",
                { cause: diagnostic.cause },
              );
            },
          },
          signal,
        );
        if (result.connected && result.durationMs >= config.timeouts.stableConnectionMs) {
          backoff.reset();
        }
        if (signal.aborted) {
          break;
        }
        logger.warn("Garden SSE stream ended; reconnecting", {
          connected: result.connected,
          durationMs: result.durationMs,
        });
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        if (error instanceof GardenStreamError) {
          if (error.kind === "auth" || error.kind === "terminal") {
            throw error;
          }
          if (error.connectionDurationMs >= config.timeouts.stableConnectionMs) {
            backoff.reset();
          }
        }
        logger.warn("Garden SSE attempt failed; reconnecting", {
          error: safeErrorMessage(error, [config.machineToken]),
        });
      }

      const delayMs = backoff.nextDelayMs();
      logger.info("waiting before Garden SSE reconnect", { delayMs });
      await sleep(delayMs, signal);
    }
  } finally {
    await dispatcher.close();
  }
}
