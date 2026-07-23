import assert from "node:assert/strict";
import test from "node:test";
import { ReconnectBackoff } from "../src/backoff.js";
import { DEFAULT_TIMEOUTS, type BridgeConfig } from "../src/config.js";
import { silentLogger } from "../src/logging.js";
import type { RuntimeWake } from "../src/protocol.js";
import type { RuntimeAdapter } from "../src/runtime/adapter.js";
import { runBridge, type GardenEventStream } from "../src/runner.js";
import { GardenStreamError } from "../src/sse/client.js";
import { startTestGardenServer } from "./helpers/test-sse-server.js";

function config(): BridgeConfig {
  return {
    baseUrl: new URL("https://garden.example.com"),
    machineToken: "runner-token",
    wakeMessageMap: {},
    injector: {
      executable: "inject-garden-wake",
      args: [],
      workingDirectory: "/workspace/runtime",
    },
    logLevel: "info",
    timeouts: DEFAULT_TIMEOUTS,
  };
}

test("does not retry an authentication failure", async () => {
  let streamAttempts = 0;
  let sleeps = 0;
  let adapterClosed = false;
  const client = {
    streamOnce: async () => {
      streamAttempts += 1;
      throw new GardenStreamError("auth", "unauthorized", 401);
    },
  } satisfies GardenEventStream;
  const adapter: RuntimeAdapter = {
    wake: async () => undefined,
    close: async () => {
      adapterClosed = true;
    },
  };

  await assert.rejects(
    () =>
      runBridge(config(), adapter, silentLogger, new AbortController().signal, {
        createClient: () => client,
        sleep: async () => {
          sleeps += 1;
        },
      }),
    (error: unknown) => error instanceof GardenStreamError && error.kind === "auth",
  );

  assert.equal(streamAttempts, 1);
  assert.equal(sleeps, 0);
  assert.equal(adapterClosed, true);
});

test("overrides only configured wake messages and passes through the rest", async () => {
  const controller = new AbortController();
  const received: RuntimeWake[] = [];
  const client: GardenEventStream = {
    streamOnce: async (handlers) => {
      handlers.onEvent({ kind: "connected", version: 1 });
      handlers.onEvent({
        kind: "wake",
        reason: "game_turn_required",
        message: "服务端游戏文案",
      });
      handlers.onEvent({
        kind: "wake",
        reason: "forum_notification_available",
        message: "服务端论坛通知文案",
      });
      return { connected: true, durationMs: 1, stopped: false };
    },
  };
  const adapter: RuntimeAdapter = {
    wake: async ({ reason, message }) => {
      received.push({ reason, message });
      if (received.length === 2) {
        controller.abort();
      }
    },
  };

  await runBridge(
    {
      ...config(),
      wakeMessageMap: { game_turn_required: "本地自定义游戏文案" },
    },
    adapter,
    silentLogger,
    controller.signal,
    { createClient: () => client },
  );

  assert.deepEqual(received, [
    { reason: "game_turn_required", message: "本地自定义游戏文案" },
    { reason: "forum_notification_available", message: "服务端论坛通知文案" },
  ]);
});

test("retries failures and resets backoff only after a stable connection", async () => {
  const results = [
    { connected: true, durationMs: 100, stopped: false },
    { connected: false, durationMs: DEFAULT_TIMEOUTS.stableConnectionMs, stopped: false },
    {
      connected: true,
      durationMs: DEFAULT_TIMEOUTS.stableConnectionMs,
      stopped: false,
    },
  ];
  const controller = new AbortController();
  const delays: number[] = [];
  let streamAttempts = 0;
  const client = {
    streamOnce: async () => {
      const result = results[streamAttempts] ?? {
        connected: false,
        durationMs: 0,
        stopped: false,
      };
      streamAttempts += 1;
      return result;
    },
  } satisfies GardenEventStream;
  const backoff = new ReconnectBackoff({
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0,
    random: () => 1,
  });

  await runBridge(
    config(),
    { wake: async () => undefined },
    silentLogger,
    controller.signal,
    {
      createClient: () => client,
      backoff,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        if (delays.length === 3) {
          controller.abort();
        }
      },
    },
  );

  assert.equal(streamAttempts, 3);
  assert.deepEqual(delays, [1_000, 2_000, 1_000]);
});

test("shutdown interrupts reconnect sleep and closes the runtime adapter", async () => {
  const controller = new AbortController();
  let adapterClosed = false;
  const client = {
    streamOnce: async () => ({ connected: true, durationMs: 1, stopped: false }),
  } satisfies GardenEventStream;
  const adapter: RuntimeAdapter = {
    wake: async () => undefined,
    close: async () => {
      adapterClosed = true;
    },
  };

  const running = runBridge(config(), adapter, silentLogger, controller.signal, {
    createClient: () => client,
    sleep: async (_delayMs, signal) => {
      controller.abort();
      assert.equal(signal.aborted, true);
    },
  });

  await running;
  assert.equal(adapterClosed, true);
});

test("routes SSE wakes end to end through the runner and runtime adapter", async () => {
  const token = "runner-integration-token";
  const server = await startTestGardenServer({
    machineToken: token,
    onConnection: (connection) => {
      connection.sendConnected();
      connection.sendComment();
      connection.writeRaw("event: wake\ndata: {\"reason\":\"unknown\"}\n\n");
      connection.sendWake(
        "game_turn_required",
        "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
      );
      connection.sendWake(
        "notification_available",
        "你有新的 Garden 通知，请调用 Garden MCP 查看。",
      );
    },
  });
  const controller = new AbortController();
  const received: Array<{ reason: string; message: string }> = [];
  let adapterClosed = false;
  const adapter: RuntimeAdapter = {
    wake: async (input) => {
      input.signal.throwIfAborted();
      received.push({ reason: input.reason, message: input.message });
      if (received.length === 2) {
        controller.abort();
      }
    },
    close: async () => {
      adapterClosed = true;
    },
  };

  try {
    await runBridge(
      {
        ...config(),
        baseUrl: server.baseUrl,
        machineToken: token,
      },
      adapter,
      silentLogger,
      controller.signal,
    );
    assert.deepEqual(received, [
      {
        reason: "game_turn_required",
        message: "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
      },
      {
        reason: "notification_available",
        message: "你有新的 Garden 通知，请调用 Garden MCP 查看。",
      },
    ]);
    assert.equal(adapterClosed, true);
  } finally {
    await server.close();
  }
});

test("retryable stream errors reconnect and a stable failed stream resets backoff", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let attempts = 0;
  const client: GardenEventStream = {
    streamOnce: async () => {
      attempts += 1;
      const duration = attempts === 1 ? 0 : DEFAULT_TIMEOUTS.stableConnectionMs;
      throw new GardenStreamError("retryable", "network failed", undefined, duration);
    },
  };
  const backoff = new ReconnectBackoff({
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0,
  });

  await runBridge(
    config(),
    { wake: async () => undefined },
    silentLogger,
    controller.signal,
    {
      createClient: () => client,
      backoff,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        if (delays.length === 2) {
          controller.abort();
        }
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1_000, 1_000]);
});
