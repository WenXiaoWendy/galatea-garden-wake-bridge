#!/usr/bin/env node

import { isIP } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

class InjectorError extends Error {
  constructor(message) {
    super(message);
    this.name = "InjectorError";
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InjectorError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function parseTimeout(value) {
  if (value === undefined || value === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new InjectorError(
      "CODEX_INJECTOR_TIMEOUT_MS must be an integer from 1000 to 120000",
    );
  }
  return parsed;
}

function isLoopback(hostname) {
  if (hostname === "localhost") return true;
  const addressType = isIP(hostname);
  if (addressType === 4) return hostname.startsWith("127.");
  if (addressType === 6) return hostname === "::1";
  return false;
}

function parseServerUrl(value) {
  const url = new URL(requireString(value, "CODEX_APP_SERVER_URL"));
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new InjectorError("CODEX_APP_SERVER_URL must use ws:// or wss://");
  }
  if (url.username || url.password || url.hash) {
    throw new InjectorError(
      "CODEX_APP_SERVER_URL must not contain credentials or a fragment",
    );
  }
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) {
    throw new InjectorError("unencrypted ws:// is allowed only for loopback hosts");
  }
  return url;
}

async function readEnvelope(input) {
  let body = "";
  input.setEncoding("utf8");
  for await (const chunk of input) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_INPUT_BYTES) {
      throw new InjectorError(`stdin exceeds ${MAX_INPUT_BYTES} bytes`);
    }
  }

  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new InjectorError("stdin must contain one JSON wake envelope");
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    envelope.version !== 1 ||
    envelope.type !== "garden_wake"
  ) {
    throw new InjectorError("unsupported wake envelope");
  }
  requireString(envelope.reason, "wake reason");
  return {
    message: requireString(envelope.message, "wake message"),
    reason: envelope.reason,
  };
}

class AppServerClient {
  #url;
  #token;
  #timeoutMs;
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor({ url, token, timeoutMs }) {
    this.#url = url;
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  async connect() {
    const headers = this.#token
      ? { Authorization: `Bearer ${this.#token}` }
      : undefined;
    const socket = new WebSocket(this.#url, {
      headers,
      maxPayload: MAX_MESSAGE_BYTES,
    });
    this.#socket = socket;

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#failAll(new InjectorError("app-server sent a binary message"));
        return;
      }
      this.#handleMessage(data.toString("utf8"));
    });
    socket.on("error", (error) => this.#failAll(error));
    socket.on("close", () =>
      this.#failAll(new InjectorError("app-server connection closed")),
    );

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new InjectorError("timed out connecting to app-server"));
      }, this.#timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  #handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.#failAll(new InjectorError("app-server sent invalid JSON"));
      return;
    }
    if (message === null || typeof message !== "object" || !("id" in message)) {
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const code = message.error.code ?? "unknown";
      const details = message.error.message ?? "unknown app-server error";
      pending.reject(new InjectorError(`app-server error ${code}: ${details}`));
      return;
    }
    pending.resolve(message.result);
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  request(method, params) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new InjectorError("app-server is not connected"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new InjectorError(`${method} timed out`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  notify(method, params) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new InjectorError("app-server is not connected");
    }
    socket.send(JSON.stringify({ method, params }));
  }

  close() {
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    socket.close(1000, "delivery accepted");
  }
}

function assertResumedThread(result, threadId) {
  const resumedId = result?.thread?.id;
  if (resumedId !== threadId) {
    throw new InjectorError(
      `thread/resume returned ${String(resumedId)} instead of ${threadId}`,
    );
  }
}

function assertStartedTurn(result) {
  if (typeof result?.turn?.id !== "string" || result.turn.id === "") {
    throw new InjectorError("turn/start did not return an accepted turn id");
  }
  return result.turn.id;
}

async function injectWake({ url, token, timeoutMs, threadId, message }) {
  const client = new AppServerClient({ url, token, timeoutMs });
  try {
    await client.connect();
    await client.request("initialize", {
      clientInfo: {
        name: "galatea-garden-wake-injector",
        title: "Galatea Garden 唤醒注入器",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const resumed = await client.request("thread/resume", {
      threadId,
      excludeTurns: true,
    });
    assertResumedThread(resumed, threadId);
    const started = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: message, text_elements: [] }],
    });
    return assertStartedTurn(started);
  } finally {
    client.close();
  }
}

async function main() {
  const envelope = await readEnvelope(process.stdin);
  const url = parseServerUrl(process.env.CODEX_APP_SERVER_URL);
  const threadId = requireString(process.env.CODEX_THREAD_ID, "CODEX_THREAD_ID");
  const timeoutMs = parseTimeout(process.env.CODEX_INJECTOR_TIMEOUT_MS);
  const token = process.env.CODEX_APP_SERVER_TOKEN?.trim() || undefined;
  const turnId = await injectWake({
    url,
    token,
    timeoutMs,
    threadId,
    message: envelope.message,
  });
  process.stdout.write(`${JSON.stringify({ accepted: true, threadId, turnId })}\n`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Codex injector failed: ${message}\n`);
    process.exitCode = 1;
  });
}

export {
  InjectorError,
  injectWake,
  parseServerUrl,
  parseTimeout,
  readEnvelope,
};
