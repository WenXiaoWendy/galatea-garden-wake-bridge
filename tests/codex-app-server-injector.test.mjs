import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  InjectorError,
  parseServerUrl,
  parseTimeout,
} from "../integrations/codex-app-server/inject.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const injector = path.join(root, "integrations/codex-app-server/inject.mjs");

async function startProtocolServer({ resumedThreadId = "game-thread" } = {}) {
  const requests = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString("utf8"));
      requests.push(request);
      if (!("id" in request)) return;
      if (request.method === "initialize") {
        socket.send(JSON.stringify({ id: request.id, result: { serverInfo: {} } }));
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: resumedThreadId } },
          }),
        );
      } else if (request.method === "turn/start") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { turn: { id: "turn-accepted", status: "inProgress" } },
          }),
        );
      }
    });
  });

  return {
    requests,
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runInjector(url, threadId = "game-thread") {
  const child = spawn(process.execPath, [injector], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_APP_SERVER_URL: url,
      CODEX_THREAD_ID: threadId,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(
    `${JSON.stringify({
      version: 1,
      type: "garden_wake",
      reason: "game_turn_required",
      message: "游戏轮到你了。",
    })}\n`,
  );
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

test("injects the wake into the exact thread owned by one app-server", async () => {
  const server = await startProtocolServer();
  try {
    const result = await runInjector(server.url);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      accepted: true,
      threadId: "game-thread",
      turnId: "turn-accepted",
    });
    assert.deepEqual(
      server.requests.map(({ method }) => method),
      ["initialize", "initialized", "thread/resume", "turn/start"],
    );
    assert.equal(
      server.requests[0].params.capabilities.experimentalApi,
      true,
    );
    const turnStart = server.requests.find(({ method }) => method === "turn/start");
    assert.deepEqual(turnStart.params, {
      threadId: "game-thread",
      input: [{ type: "text", text: "游戏轮到你了。", text_elements: [] }],
    });
  } finally {
    await server.close();
  }
});

test("fails instead of injecting when the app-server resumes another thread", async () => {
  const server = await startProtocolServer({ resumedThreadId: "wrong-thread" });
  try {
    const result = await runInjector(server.url);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /wrong-thread instead of game-thread/);
    assert.equal(
      server.requests.some(({ method }) => method === "turn/start"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("accepts secure endpoints and limits unencrypted endpoints to loopback", () => {
  assert.equal(parseServerUrl("ws://127.0.0.1:8765").hostname, "127.0.0.1");
  assert.equal(parseServerUrl("wss://runtime.example.test/socket").protocol, "wss:");
  assert.throws(
    () => parseServerUrl("ws://runtime.example.test:8765"),
    InjectorError,
  );
  assert.throws(() => parseServerUrl("https://runtime.example.test"), InjectorError);
});

test("validates the injector timeout range", () => {
  assert.equal(parseTimeout(undefined), 15_000);
  assert.equal(parseTimeout("1000"), 1_000);
  assert.throws(() => parseTimeout("999"), InjectorError);
  assert.throws(() => parseTimeout("not-a-number"), InjectorError);
});
