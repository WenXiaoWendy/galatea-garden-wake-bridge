import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { silentLogger } from "../src/logging.js";
import {
  CommandInjectorAdapter,
  InjectorDeliveryError,
  type SpawnInjector,
} from "../src/runtime/command-injector-adapter.js";

interface ControllableProcess extends EventEmitter {
  stdin: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill(): boolean;
}

function controllableProcess(): ControllableProcess {
  const process = new EventEmitter() as ControllableProcess;
  process.stdin = new PassThrough();
  process.stderr = new PassThrough();
  process.killed = false;
  process.kill = () => {
    process.killed = true;
    return true;
  };
  return process;
}

test("delivers one versioned wake envelope to the configured injector stdin", async () => {
  const child = controllableProcess();
  let executable = "";
  let args: readonly string[] = [];
  let options: Parameters<SpawnInjector>[2] | undefined;
  let stdin = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    stdin += chunk;
  });
  const spawnImpl: SpawnInjector = (nextExecutable, nextArgs, nextOptions) => {
    executable = nextExecutable;
    args = nextArgs;
    options = nextOptions;
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const adapter = new CommandInjectorAdapter(
    {
      executable: "/opt/runtime/bin/inject-garden-wake",
      args: ["--target", "garden-agent"],
      workingDirectory: "/srv/runtime",
    },
    silentLogger,
    spawnImpl,
  );
  const controller = new AbortController();

  await adapter.wake({
    reason: "game_turn_required",
    message: "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
    signal: controller.signal,
  });

  assert.equal(executable, "/opt/runtime/bin/inject-garden-wake");
  assert.deepEqual(args, ["--target", "garden-agent"]);
  assert.equal(options?.cwd, "/srv/runtime");
  assert.equal(options?.env.GARDEN_MACHINE_TOKEN, undefined);
  assert.equal(options?.shell, false);
  assert.equal(options?.signal, controller.signal);
  assert.deepEqual(options?.stdio, ["pipe", "ignore", "pipe"]);
  assert.deepEqual(JSON.parse(stdin), {
    version: 1,
    type: "garden_wake",
    reason: "game_turn_required",
    message: "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
  });
});

test("reports non-zero injector exits with bounded stderr", async () => {
  const child = controllableProcess();
  const spawnImpl: SpawnInjector = () => {
    queueMicrotask(() => {
      child.stderr.write(`prefix-${"x".repeat(10_000)}-suffix`);
      child.emit("exit", 7, null);
    });
    return child;
  };
  const adapter = new CommandInjectorAdapter(
    { executable: "injector", args: [], workingDirectory: undefined },
    silentLogger,
    spawnImpl,
  );

  await assert.rejects(
    () =>
      adapter.wake({
        reason: "forum_notification_available",
        message: "查看通知",
        signal: new AbortController().signal,
      }),
    (error: unknown) => {
      assert.ok(error instanceof InjectorDeliveryError);
      assert.match(error.message, /code 7/);
      assert.match(error.message, /-suffix/);
      assert.doesNotMatch(error.message, /prefix-/);
      return true;
    },
  );
});

test("passes cancellation to the injector process", async () => {
  const child = controllableProcess();
  let receivedSignal: AbortSignal | undefined;
  const spawnImpl: SpawnInjector = (_executable, _args, options) => {
    receivedSignal = options.signal;
    options.signal.addEventListener(
      "abort",
      () => child.emit("error", options.signal.reason),
      { once: true },
    );
    return child;
  };
  const adapter = new CommandInjectorAdapter(
    { executable: "injector", args: [], workingDirectory: undefined },
    silentLogger,
    spawnImpl,
  );
  const controller = new AbortController();
  const waking = adapter.wake({
    reason: "forum_notification_available",
    message: "查看通知",
    signal: controller.signal,
  });

  controller.abort(new Error("cancelled"));
  await assert.rejects(() => waking, /cancelled/);
  assert.equal(receivedSignal, controller.signal);
});
