import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { exitCodeForError } from "../src/cli.js";
import { ConfigError } from "../src/config.js";
import { installShutdownHandlers, SHUTDOWN_SIGNALS } from "../src/shutdown.js";
import { GardenStreamError } from "../src/sse/client.js";
import { startTestGardenServer } from "./helpers/test-sse-server.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 2_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit after signal; stderr: ${stderr}`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

test("registers POSIX and Windows console shutdown signals", () => {
  const source = new EventEmitter();
  const controller = new AbortController();
  const removeHandlers = installShutdownHandlers(controller, source);

  assert.deepEqual(SHUTDOWN_SIGNALS, ["SIGINT", "SIGTERM", "SIGBREAK"]);
  source.emit("SIGBREAK");
  assert.equal(controller.signal.aborted, true);

  removeHandlers();
  for (const signal of SHUTDOWN_SIGNALS) {
    assert.equal(source.listenerCount(signal), 0);
  }
});

test("compiled CLI starts through the platform Node executable", async () => {
  const child = spawn(process.execPath, ["dist/cli.js", "--version"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const result = await waitForExit(child);

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(stdout.trim(), "0.1.0");
});

test("uses a non-restartable exit code for permanent configuration and auth failures", () => {
  assert.equal(exitCodeForError(new GardenStreamError("auth", "unauthorized")), 2);
  assert.equal(exitCodeForError(new GardenStreamError("terminal", "contract mismatch")), 2);
  assert.equal(exitCodeForError(new ConfigError("invalid runtime configuration")), 2);
  assert.equal(exitCodeForError(new GardenStreamError("retryable", "network failed")), 1);
  assert.equal(exitCodeForError(new Error("unexpected crash")), 1);
});

test("compiled check command exits with code 2 after machine-token rejection", async () => {
  const server = await startTestGardenServer({ machineToken: "expected-token" });
  const child = spawn(process.execPath, ["dist/cli.js", "check"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GARDEN_BASE_URL: server.baseUrl.origin,
      GARDEN_MACHINE_TOKEN: "rejected-token",
      GARDEN_LOG_LEVEL: "error",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const result = await waitForExit(child);
    assert.equal(result.code, 2);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /Garden rejected the machine token/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await server.close();
  }
});

  test("compiled run command fails permanently without an injector executable", async () => {
  const child = spawn(process.execPath, ["dist/cli.js", "run"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GARDEN_BASE_URL: "https://garden.example.com",
      GARDEN_MACHINE_TOKEN: "test-token",
      GARDEN_LOG_LEVEL: "error",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const result = await waitForExit(child);
  assert.equal(result.code, 2);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /GARDEN_INJECTOR_EXECUTABLE is required/);
});
