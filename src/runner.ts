import type { BridgeConfig } from "./config.js";
import type { Logger } from "./logging.js";
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
    id: event.id,
    reason: event.reason,
    message: messageMap[event.reason] ?? event.message,
  };
}

export interface BridgeRunnerDependencies {
  createClient?: () => GardenEventStream;
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
      logger,
    });
  const dispatcher = new WakeDispatcher(adapter, logger, {
    deliveryTimeoutMs: config.timeouts.runtimeDeliveryMs,
    closeTimeoutMs: config.timeouts.runtimeCloseMs,
  });
  const reportedDiagnostics = new Set<string>();

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
    if (signal.aborted || result.stopped) {
      return;
    }
    await dispatcher.idle();
    throw new GardenStreamError(
      "terminal",
      result.connected
        ? "Garden SSE stream ended; restart the bridge manually after checking Garden status"
        : "Garden SSE stream ended before the connected event",
    );
  } finally {
    await dispatcher.close();
  }
}
