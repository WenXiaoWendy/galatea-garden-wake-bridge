import assert from "node:assert/strict";
import test from "node:test";
import { silentLogger } from "../src/logging.js";
import type { GardenProtocolEvent } from "../src/protocol.js";
import { GardenSseClient, GardenStreamError } from "../src/sse/client.js";
import { startTestGardenServer } from "./helpers/test-sse-server.js";

const TOKEN = "integration-machine-token";

function clientFor(
  baseUrl: URL,
  options: {
    token?: string;
    fetch?: typeof globalThis.fetch;
    connectTimeoutMs?: number;
  } = {},
): GardenSseClient {
  return new GardenSseClient({
    baseUrl,
    machineToken: options.token ?? TOKEN,
    connectTimeoutMs: options.connectTimeoutMs ?? 1_000,
    logger: silentLogger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

test("streams server-defined wake reasons end to end from a local test SSE server", async () => {
  const server = await startTestGardenServer({
    machineToken: TOKEN,
    onConnection: (connection) => {
      connection.writeRaw("event: con");
      connection.writeRaw("nected\ndata: {\"version\":1}\n\n");
      connection.sendComment("ping");
      connection.writeRaw(
        'event: wake\ndata: {"reason":"forum_notification_available","message":"你有新的帖子通知。"}\n\n',
      );
      connection.writeRaw("event: wake\ndata: {\"reason\":\"\",\"message\":\"无效通知\"}\n\n");
      connection.writeRaw(
        'event: wake\ndata: {"reason":"game_turn_required","message":"游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。"}\n\n',
      );
      connection.writeRaw(
        'event: wake\ndata: {"reason":"notification_available","message":"请查看新的 Garden 通知。"}\n\n',
      );
    },
  });
  const controller = new AbortController();
  const events: Array<Exclude<GardenProtocolEvent, { kind: "ignored" }>> = [];
  const ignored: string[] = [];

  try {
    const result = await clientFor(server.baseUrl).streamOnce(
      {
        onEvent: (event) => {
          events.push(event);
          if (events.filter((candidate) => candidate.kind === "wake").length === 3) {
            controller.abort();
          }
        },
        onIgnored: (diagnostic) => ignored.push(diagnostic.cause),
      },
      controller.signal,
    );

    assert.equal(result.connected, true);
    assert.equal(result.stopped, true);
    const wakes = events.filter((event) => event.kind === "wake");
    assert.equal(new Set(wakes.map((event) => event.id)).size, 3);
    for (const wake of wakes) assert.match(wake.id, /^wake_[a-f0-9]{32}$/u);
    assert.deepEqual(
      wakes.map(({ id: _id, ...event }) => event),
      [
        {
          kind: "wake",
          reason: "forum_notification_available",
          message: "你有新的帖子通知。",
        },
        {
          kind: "wake",
          reason: "game_turn_required",
          message: "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
        },
        {
          kind: "wake",
          reason: "notification_available",
          message: "请查看新的 Garden 通知。",
        },
      ],
    );
    assert.deepEqual(ignored, ["unknown wake reason"]);
  } finally {
    await server.close();
  }
});

test("treats 401 and 403 as terminal server rejections", async () => {
  const server = await startTestGardenServer({ machineToken: TOKEN });
  try {
    await assert.rejects(
      () =>
        clientFor(server.baseUrl, { token: "wrong-token" }).streamOnce(
          { onEvent: () => undefined },
          new AbortController().signal,
        ),
      (error: unknown) =>
        error instanceof GardenStreamError && error.kind === "auth" && error.status === 401,
    );
  } finally {
    await server.close();
  }

  const forbiddenFetch: typeof globalThis.fetch = async () =>
    Response.json(
      { detail: "Wake Bridge notifications are disabled for this machine" },
      { status: 403 },
    );
  await assert.rejects(
    () =>
      clientFor(new URL("https://garden.example.com"), { fetch: forbiddenFetch }).streamOnce(
        { onEvent: () => undefined },
        new AbortController().signal,
      ),
    (error: unknown) =>
      error instanceof GardenStreamError &&
      error.kind === "terminal" &&
      error.status === 403 &&
      /notifications are disabled/.test(error.message),
  );
});

test("treats every non-success HTTP response as terminal", async () => {
  const cases = [429, 500, 503, 400, 404, 302];

  for (const status of cases) {
    let redirectMode: RequestRedirect | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response(null, {
        status,
        ...(status === 302 ? { headers: { Location: "https://other.example.com" } } : {}),
      });
    };
    await assert.rejects(
      () =>
        clientFor(new URL("https://garden.example.com"), { fetch }).streamOnce(
          { onEvent: () => undefined },
          new AbortController().signal,
        ),
      (error: unknown) =>
        error instanceof GardenStreamError &&
        error.kind === "terminal" &&
        error.status === status,
    );
    assert.equal(redirectMode, "manual");
  }
});

test("rejects a successful response with the wrong content type", async () => {
  const fetch: typeof globalThis.fetch = async () =>
    new Response("ok", { status: 200, headers: { "Content-Type": "application/json" } });

  await assert.rejects(
    () =>
      clientFor(new URL("https://garden.example.com"), { fetch }).streamOnce(
        { onEvent: () => undefined },
        new AbortController().signal,
      ),
    (error: unknown) => error instanceof GardenStreamError && error.kind === "terminal",
  );

  const lookalikeFetch: typeof globalThis.fetch = async () =>
    new Response("data: x\n\n", {
      status: 200,
      headers: { "Content-Type": "application/x-text/event-stream" },
    });
  await assert.rejects(
    () =>
      clientFor(new URL("https://garden.example.com"), { fetch: lookalikeFetch }).streamOnce(
        { onEvent: () => undefined },
        new AbortController().signal,
      ),
    (error: unknown) => error instanceof GardenStreamError && error.kind === "terminal",
  );
});

test("uses the current Garden error detail without retrying", async () => {
  const fetch: typeof globalThis.fetch = async () =>
    Response.json(
      {
        detail:
          "Wake Bridge token revoked; inspect duplicate Bridge processes before generating a new token",
      },
      { status: 403 },
    );

  await assert.rejects(
    () =>
      clientFor(new URL("https://garden.example.com"), { fetch }).streamOnce(
        { onEvent: () => undefined },
        new AbortController().signal,
      ),
    (error: unknown) =>
      error instanceof GardenStreamError &&
      error.kind === "terminal" &&
      /token revoked; inspect duplicate Bridge processes/.test(error.message),
  );
});

test("a pre-aborted signal never opens an authenticated request", async () => {
  let fetchCalls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("must not be called");
  };
  const controller = new AbortController();
  controller.abort();

  const result = await clientFor(new URL("https://garden.example.com"), { fetch }).streamOnce(
    { onEvent: () => undefined },
    controller.signal,
  );

  assert.equal(result.stopped, true);
  assert.equal(fetchCalls, 0);
});

test("rejects non-local HTTP even when the client is constructed directly", () => {
  assert.throws(
    () => clientFor(new URL("http://garden.example.com")),
    /must use HTTPS unless it points to localhost/,
  );
});

test("redacts the machine token from connection errors", async () => {
  const fetch: typeof globalThis.fetch = async () => {
    throw new Error(`failed with ${TOKEN} and Bearer ${TOKEN}`);
  };

  await assert.rejects(
    () =>
      clientFor(new URL("https://garden.example.com"), { fetch }).streamOnce(
        { onEvent: () => undefined },
        new AbortController().signal,
      ),
    (error: unknown) => {
      assert.ok(error instanceof GardenStreamError);
      assert.equal(error.kind, "terminal");
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      assert.match(error.message, /\[REDACTED]/);
      return true;
    },
  );
});

test("treats connect timeout as terminal", async () => {
  const fetch: typeof globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      const stop = (): void => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
    });

  await assert.rejects(
    () =>
      clientFor(new URL("https://garden.example.com"), {
        fetch,
        connectTimeoutMs: 10,
      }).streamOnce({ onEvent: () => undefined }, new AbortController().signal),
    (error: unknown) =>
      error instanceof GardenStreamError &&
      error.kind === "terminal" &&
      /connection timed out/.test(error.message),
  );
});

test("sends the token only in the authorization header", async () => {
  let requestedUrl: URL | undefined;
  let authorization: string | null = null;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
    authorization = new Headers(init?.headers).get("authorization");
    return new Response("event: connected\ndata: {\"version\":1}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  await clientFor(new URL("https://garden.example.com"), { fetch }).probe(
    new AbortController().signal,
  );

  assert.equal(requestedUrl?.pathname, "/api/machine-events/stream");
  assert.equal(requestedUrl?.search, "");
  assert.doesNotMatch(requestedUrl?.toString() ?? "", new RegExp(TOKEN));
  assert.equal(authorization, `Bearer ${TOKEN}`);
});

test("treats an established stream failure as terminal", async () => {
  const encoder = new TextEncoder();
  const failingFetch: typeof globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode("event: connected\ndata: {\"version\":1}\n\n"),
          );
          setTimeout(() => controller.error(new Error("stream broke")), 0);
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  const failingClient = new GardenSseClient({
    baseUrl: new URL("https://garden.example.com"),
    machineToken: TOKEN,
    connectTimeoutMs: 100,
    logger: silentLogger,
    fetch: failingFetch,
  });
  await assert.rejects(
    () =>
      failingClient.streamOnce(
        { onEvent: () => undefined },
        new AbortController().signal,
      ),
    (error: unknown) =>
      error instanceof GardenStreamError &&
      error.kind === "terminal" &&
      /stream broke/.test(error.message),
  );
});

test("an idle stream remains open until the caller stops it", async () => {
  const idleServer = await startTestGardenServer({
    machineToken: TOKEN,
    onConnection: (connection) => connection.sendConnected(),
  });
  const controller = new AbortController();
  const stopTimer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await clientFor(idleServer.baseUrl).streamOnce(
      { onEvent: () => undefined },
      controller.signal,
    );
    assert.equal(result.connected, true);
    assert.equal(result.stopped, true);
  } finally {
    clearTimeout(stopTimer);
    await idleServer.close();
  }
});

test("probe ignores wake events and succeeds only after the connected handshake", async () => {
  const server = await startTestGardenServer({
    machineToken: TOKEN,
    onConnection: (connection) => {
      connection.sendWake("notification_available", "请查看新的 Garden 通知。");
      connection.sendConnected();
    },
  });
  try {
    await clientFor(server.baseUrl).probe(new AbortController().signal);
  } finally {
    await server.close();
  }
});

test("run mode ignores wakes before a handshake and rejects unsupported protocol versions", async () => {
  const beforeHandshake = await startTestGardenServer({
    machineToken: TOKEN,
    onConnection: (connection) => {
      connection.sendWake("notification_available", "请查看新的 Garden 通知。");
      connection.close();
    },
  });
  const delivered: GardenProtocolEvent[] = [];
  const diagnostics: string[] = [];
  try {
    await clientFor(beforeHandshake.baseUrl).streamOnce(
      {
        onEvent: (event) => {
          delivered.push(event);
        },
        onIgnored: (diagnostic) => diagnostics.push(diagnostic.cause),
      },
      new AbortController().signal,
    );
    assert.deepEqual(delivered, []);
    assert.deepEqual(diagnostics, ["wake event received before protocol handshake"]);
  } finally {
    await beforeHandshake.close();
  }

  const unsupported = await startTestGardenServer({
    machineToken: TOKEN,
    onConnection: (connection) => {
      connection.writeRaw("event: connected\ndata: {\"version\":2}\n\n");
    },
  });
  try {
    await assert.rejects(
      () =>
        clientFor(unsupported.baseUrl).streamOnce(
          { onEvent: () => undefined },
          new AbortController().signal,
        ),
      (error: unknown) =>
        error instanceof GardenStreamError &&
        error.kind === "terminal" &&
        /unsupported protocol version/.test(error.message),
    );
  } finally {
    await unsupported.close();
  }
});
