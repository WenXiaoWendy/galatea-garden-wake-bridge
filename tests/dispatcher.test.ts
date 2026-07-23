import assert from "node:assert/strict";
import test from "node:test";
import { silentLogger } from "../src/logging.js";
import type { RuntimeWake, WakeReason } from "../src/protocol.js";
import type { RuntimeAdapter, RuntimeWakeInput } from "../src/runtime/adapter.js";
import { WakeDispatcher } from "../src/runtime/dispatcher.js";

function wake(reason: WakeReason, message?: string): RuntimeWake {
  return reason === "game_turn_required"
    ? { reason, message: message ?? "游戏轮到你了。" }
    : { reason, message: message ?? "你有新的 Garden 通知。" };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

test("delivers one wake at a time and coalesces duplicate pending reasons", async () => {
  const calls: RuntimeWakeInput[] = [];
  const completions: Array<Deferred<void>> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const adapter: RuntimeAdapter = {
    wake: async (input) => {
      calls.push(input);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const completion = deferred<void>();
      completions.push(completion);
      await completion.promise;
      concurrent -= 1;
    },
  };
  const dispatcher = new WakeDispatcher(adapter, silentLogger, {
    maxAttempts: 1,
    retryDelayMs: 0,
    deliveryTimeoutMs: 1_000,
  });

  dispatcher.enqueue(wake("game_turn_required"));
  await waitFor(() => calls.length === 1);
  dispatcher.enqueue(wake("game_turn_required", "较早的游戏文案"));
  dispatcher.enqueue(wake("game_turn_required", "最新的游戏文案"));
  dispatcher.enqueue(wake("notification_available", "较早的通知文案"));
  dispatcher.enqueue(wake("notification_available", "最新的通知文案"));

  completions[0]?.resolve();
  await waitFor(() => calls.length === 2);
  completions[1]?.resolve();
  await waitFor(() => calls.length === 3);
  completions[2]?.resolve();
  await dispatcher.idle();

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(
    calls.map((call) => call.reason),
    ["game_turn_required", "game_turn_required", "notification_available"],
  );
  assert.deepEqual(
    calls.map((call) => call.message),
    ["游戏轮到你了。", "最新的游戏文案", "最新的通知文案"],
  );
});

test("retries a failed runtime delivery only within the configured bound", async () => {
  const attempts: WakeReason[] = [];
  const adapter: RuntimeAdapter = {
    wake: async ({ reason }) => {
      attempts.push(reason);
      throw new Error("test failure");
    },
  };
  const dispatcher = new WakeDispatcher(adapter, silentLogger, {
    maxAttempts: 2,
    retryDelayMs: 0,
    deliveryTimeoutMs: 100,
  });

  dispatcher.enqueue(wake("notification_available"));
  await dispatcher.idle();

  assert.deepEqual(attempts, ["notification_available", "notification_available"]);
});

test("shutdown drops pending wakes, waits for the active wake, and closes the adapter", async () => {
  const active = deferred<void>();
  const calls: WakeReason[] = [];
  let closed = false;
  const adapter: RuntimeAdapter = {
    wake: async ({ reason }) => {
      calls.push(reason);
      await active.promise;
    },
    close: async () => {
      closed = true;
    },
  };
  const dispatcher = new WakeDispatcher(adapter, silentLogger, {
    maxAttempts: 1,
    retryDelayMs: 0,
    deliveryTimeoutMs: 1_000,
  });

  dispatcher.enqueue(wake("game_turn_required"));
  await waitFor(() => calls.length === 1);
  dispatcher.enqueue(wake("notification_available"));
  const closing = dispatcher.close();
  assert.equal(closed, true);
  active.resolve();
  await closing;

  assert.deepEqual(calls, ["game_turn_required"]);
  assert.equal(closed, true);
});

test("delivery timeout cancels before retrying and never overlaps runtime wakes", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let attempts = 0;
  const adapter: RuntimeAdapter = {
    wake: async ({ signal }) => {
      attempts += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        await new Promise<void>((_resolve, reject) => {
          const stop = (): void => reject(signal.reason);
          signal.addEventListener("abort", stop, { once: true });
        });
      } finally {
        concurrent -= 1;
      }
    },
  };
  const dispatcher = new WakeDispatcher(adapter, silentLogger, {
    maxAttempts: 2,
    retryDelayMs: 0,
    deliveryTimeoutMs: 10,
    closeTimeoutMs: 100,
  });

  dispatcher.enqueue(wake("game_turn_required"));
  await dispatcher.idle();
  await dispatcher.close();

  assert.equal(attempts, 2);
  assert.equal(maxConcurrent, 1);
  assert.equal(concurrent, 0);
});

test("shutdown during retry delay cannot start another wake", async () => {
  let attempts = 0;
  const firstAttempt = deferred<void>();
  const adapter: RuntimeAdapter = {
    wake: async () => {
      attempts += 1;
      firstAttempt.resolve();
      throw new Error("retryable failure");
    },
  };
  const dispatcher = new WakeDispatcher(adapter, silentLogger, {
    maxAttempts: 2,
    retryDelayMs: 1_000,
    deliveryTimeoutMs: 100,
    closeTimeoutMs: 100,
  });

  dispatcher.enqueue(wake("notification_available"));
  await firstAttempt.promise;
  await dispatcher.close();

  assert.equal(attempts, 1);
});

test("adapter close is bounded", async () => {
  const adapter: RuntimeAdapter = {
    wake: async () => undefined,
    close: async () => new Promise<void>(() => undefined),
  };
  const dispatcher = new WakeDispatcher(adapter, silentLogger, { closeTimeoutMs: 10 });

  await assert.rejects(() => dispatcher.close(), /runtime adapter close timed out/);
});
