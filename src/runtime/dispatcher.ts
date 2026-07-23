import { abortableDelay } from "../backoff.js";
import type { Logger } from "../logging.js";
import type { RuntimeWake, WakeReason } from "../protocol.js";
import type { RuntimeAdapter, RuntimeWakeInput } from "./adapter.js";

export interface WakeDispatcherOptions {
  maxAttempts: number;
  retryDelayMs: number;
  deliveryTimeoutMs: number;
  closeTimeoutMs: number;
}

type PendingWake = RuntimeWake;

const DEFAULT_OPTIONS: WakeDispatcherOptions = {
  maxAttempts: 2,
  retryDelayMs: 500,
  deliveryTimeoutMs: 30_000,
  closeTimeoutMs: 10_000,
};

class RuntimeDeliveryTimeoutError extends Error {
  constructor() {
    super("runtime delivery timed out");
    this.name = "RuntimeDeliveryTimeoutError";
  }
}

export class WakeDispatcher {
  readonly #adapter: RuntimeAdapter;
  readonly #logger: Logger;
  readonly #options: WakeDispatcherOptions;
  readonly #pending = new Map<WakeReason, PendingWake>();
  readonly #shutdown = new AbortController();
  #drainPromise: Promise<void> | undefined;
  #accepting = true;
  #closePromise: Promise<void> | undefined;
  #fatalError: unknown;

  constructor(
    adapter: RuntimeAdapter,
    logger: Logger,
    options: Partial<WakeDispatcherOptions> = {},
  ) {
    this.#adapter = adapter;
    this.#logger = logger;
    this.#options = { ...DEFAULT_OPTIONS, ...options };
  }

  enqueue(input: PendingWake): void {
    if (!this.#accepting) {
      this.#logger.debug("wake ignored while dispatcher is unavailable", {
        reason: input.reason,
      });
      return;
    }
    this.#pending.set(input.reason, input);
    this.#startDrain();
  }

  async idle(): Promise<void> {
    while (this.#drainPromise) {
      await this.#drainPromise;
    }
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#accepting = false;
    this.#shutdown.abort(new Error("runtime dispatcher is shutting down"));
    this.#pending.clear();

    const adapterClose = this.#adapter.close?.() ?? Promise.resolve();
    await this.#withHardTimeout(
      Promise.all([this.#drainPromise ?? Promise.resolve(), adapterClose]).then(() => undefined),
      this.#options.closeTimeoutMs,
      "runtime adapter close timed out",
    );
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
  }

  #startDrain(): void {
    if (this.#drainPromise) {
      return;
    }
    const task = this.#drain();
    const guarded = task
      .catch((error: unknown) => {
        this.#fatalError = error;
        this.#accepting = false;
        this.#pending.clear();
        this.#logger.error("runtime dispatcher stopped after an internal failure", { error });
      })
      .finally(() => {
        if (this.#drainPromise === guarded) {
          this.#drainPromise = undefined;
        }
        if (this.#accepting && this.#pending.size > 0) {
          this.#startDrain();
        }
      });
    this.#drainPromise = guarded;
  }

  async #drain(): Promise<void> {
    while (this.#pending.size > 0) {
      const next = this.#pending.values().next().value;
      if (!next) {
        return;
      }
      this.#pending.delete(next.reason);
      await this.#deliver(next);
      if (!this.#accepting) {
        this.#pending.clear();
      }
    }
  }

  async #deliver(input: PendingWake): Promise<void> {
    for (let attempt = 1; attempt <= this.#options.maxAttempts; attempt += 1) {
      if (!this.#accepting || this.#shutdown.signal.aborted) {
        return;
      }

      const attemptController = new AbortController();
      const stopAttempt = (): void => attemptController.abort(this.#shutdown.signal.reason);
      this.#shutdown.signal.addEventListener("abort", stopAttempt, { once: true });
      const deliveryTimer = setTimeout(
        () => attemptController.abort(new RuntimeDeliveryTimeoutError()),
        this.#options.deliveryTimeoutMs,
      );

      try {
        await this.#adapter.wake({ ...input, signal: attemptController.signal });
        attemptController.signal.throwIfAborted();
        return;
      } catch (error) {
        const failure = attemptController.signal.aborted
          ? attemptController.signal.reason
          : error;
        const willRetry =
          this.#accepting &&
          !this.#shutdown.signal.aborted &&
          attempt < this.#options.maxAttempts;
        this.#logger.warn("runtime wake failed", {
          reason: input.reason,
          attempt,
          willRetry,
          error: failure,
        });
        if (!willRetry) {
          return;
        }
      } finally {
        clearTimeout(deliveryTimer);
        this.#shutdown.signal.removeEventListener("abort", stopAttempt);
      }

      await abortableDelay(this.#options.retryDelayMs, this.#shutdown.signal);
      if (!this.#accepting || this.#shutdown.signal.aborted) {
        return;
      }
    }
  }

  async #withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
