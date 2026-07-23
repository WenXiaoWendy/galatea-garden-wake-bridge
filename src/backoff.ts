export interface BackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly random?: () => number;
}

export const DEFAULT_BACKOFF_OPTIONS: Readonly<BackoffOptions> = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
});

export function computeBackoffMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const nominal = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** safeAttempt);
  const lowerBound = Math.max(options.baseDelayMs, nominal * (1 - options.jitterRatio));
  return Math.round(lowerBound + (nominal - lowerBound) * random());
}

export class ReconnectBackoff {
  #attempt = 0;
  readonly #options: BackoffOptions;

  constructor(options: Readonly<BackoffOptions> = DEFAULT_BACKOFF_OPTIONS) {
    this.#options = { ...options };
  }

  nextDelayMs(): number {
    const delay = computeBackoffMs(this.#attempt, this.#options);
    this.#attempt += 1;
    return delay;
  }

  reset(): void {
    this.#attempt = 0;
  }

  get attempt(): number {
    return this.#attempt;
  }
}

export function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
