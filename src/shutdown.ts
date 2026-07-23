export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface SignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
}

export function installShutdownHandlers(
  controller: AbortController,
  signalSource: SignalSource = process,
): () => void {
  const stop = (): void => controller.abort(new Error("shutdown requested"));
  for (const signal of SHUTDOWN_SIGNALS) {
    signalSource.once(signal, stop);
  }
  return () => {
    for (const signal of SHUTDOWN_SIGNALS) {
      signalSource.removeListener(signal, stop);
    }
  };
}
