import assert from "node:assert/strict";
import test from "node:test";
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

test("opens only one stream and exits after Garden rejects it", async () => {
  let streamAttempts = 0;
  let adapterClosed = false;
  const client: GardenEventStream = {
    streamOnce: async () => {
      streamAttempts += 1;
      throw new GardenStreamError("auth", "invalid token", 401);
    },
  };
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
      }),
    (error: unknown) =>
      error instanceof GardenStreamError && error.status === 401,
  );

  assert.equal(streamAttempts, 1);
  assert.equal(adapterClosed, true);
});

test("does not reconnect after an unexpected stream end", async () => {
  let streamAttempts = 0;
  const client: GardenEventStream = {
    streamOnce: async (handlers) => {
      streamAttempts += 1;
      handlers.onEvent({ kind: "connected", version: 1 });
      return { connected: true, stopped: false };
    },
  };

  await assert.rejects(
    () =>
      runBridge(
        config(),
        { wake: async () => undefined },
        silentLogger,
        new AbortController().signal,
        { createClient: () => client },
      ),
    /stream ended; restart the bridge manually/,
  );
  assert.equal(streamAttempts, 1);
});

test("overrides only configured wake messages and delivers queued wakes before exit", async () => {
  const received: RuntimeWake[] = [];
  const client: GardenEventStream = {
    streamOnce: async (handlers) => {
      handlers.onEvent({ kind: "connected", version: 1 });
      handlers.onEvent({
        kind: "wake",
        id: "wake_201",
        reason: "game_turn_required",
        message: "服务端游戏文案",
      });
      handlers.onEvent({
        kind: "wake",
        id: "wake_202",
        reason: "forum_notification_available",
        message: "服务端论坛通知文案",
      });
      return { connected: true, stopped: false };
    },
  };

  await assert.rejects(
    () =>
      runBridge(
        {
          ...config(),
          wakeMessageMap: { game_turn_required: "本地自定义游戏文案" },
        },
        {
          wake: async ({ id, reason, message }) => {
            received.push({ id, reason, message });
          },
        },
        silentLogger,
        new AbortController().signal,
        { createClient: () => client },
      ),
    GardenStreamError,
  );

  assert.deepEqual(received, [
    { id: "wake_201", reason: "game_turn_required", message: "本地自定义游戏文案" },
    { id: "wake_202", reason: "forum_notification_available", message: "服务端论坛通知文案" },
  ]);
});

test("manual shutdown closes the single stream and runtime adapter cleanly", async () => {
  const controller = new AbortController();
  let streamAttempts = 0;
  let adapterClosed = false;
  const client: GardenEventStream = {
    streamOnce: async () => {
      streamAttempts += 1;
      controller.abort();
      return { connected: true, stopped: true };
    },
  };

  await runBridge(
    config(),
    {
      wake: async () => undefined,
      close: async () => {
        adapterClosed = true;
      },
    },
    silentLogger,
    controller.signal,
    { createClient: () => client },
  );

  assert.equal(streamAttempts, 1);
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
  const received: Array<{ id: string; reason: string; message: string }> = [];
  let adapterClosed = false;
  const adapter: RuntimeAdapter = {
    wake: async (input) => {
      input.signal.throwIfAborted();
      received.push({ id: input.id, reason: input.reason, message: input.message });
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
        id: "wake_1",
        reason: "game_turn_required",
        message: "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
      },
      {
        id: "wake_2",
        reason: "notification_available",
        message: "你有新的 Garden 通知，请调用 Garden MCP 查看。",
      },
    ]);
    assert.equal(adapterClosed, true);
  } finally {
    await server.close();
  }
});
