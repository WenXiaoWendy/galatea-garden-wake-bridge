import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";
import {
  createLogger,
  redactText,
  safeErrorMessage,
  silentLogger,
} from "../src/logging.js";
import { MAX_WAKE_MESSAGE_LENGTH, MAX_WAKE_REASON_LENGTH } from "../src/protocol.js";
import { createRuntimeAdapter } from "../src/runtime/create-adapter.js";

test("accepts HTTP only for local Garden URLs", () => {
  const local = loadConfig({
    GARDEN_BASE_URL: "http://127.0.0.1:8787",
    GARDEN_MACHINE_TOKEN: "secret",
  });
  assert.equal(local.baseUrl.origin, "http://127.0.0.1:8787");
  assert.deepEqual(local.wakeMessageMap, {});
  assert.deepEqual(local.injector, {
    executable: undefined,
    args: [],
    workingDirectory: undefined,
  });

  assert.throws(
    () =>
      loadConfig({
        GARDEN_BASE_URL: "http://garden.example.com",
        GARDEN_MACHINE_TOKEN: "secret",
      }),
    ConfigError,
  );
});

test("loads and validates the runtime injector configuration", () => {
  const config = loadConfig({
    GARDEN_BASE_URL: "https://garden.example.com",
    GARDEN_MACHINE_TOKEN: "secret",
    GARDEN_INJECTOR_EXECUTABLE: "/opt/runtime/bin/inject-garden-wake",
    GARDEN_INJECTOR_ARGS_JSON: '["--target","garden-agent"]',
    GARDEN_INJECTOR_WORKING_DIRECTORY: "/srv/runtime",
  });
  assert.deepEqual(config.injector, {
    executable: "/opt/runtime/bin/inject-garden-wake",
    args: ["--target", "garden-agent"],
    workingDirectory: "/srv/runtime",
  });

  assert.throws(
    () =>
      loadConfig({
        GARDEN_BASE_URL: "https://garden.example.com",
        GARDEN_MACHINE_TOKEN: "secret",
        GARDEN_INJECTOR_ARGS_JSON: "not-json",
      }),
    /must be valid JSON/,
  );
  assert.throws(
    () =>
      loadConfig({
        GARDEN_BASE_URL: "https://garden.example.com",
        GARDEN_MACHINE_TOKEN: "secret",
        GARDEN_INJECTOR_WORKING_DIRECTORY: "relative/path",
      }),
    /must be an absolute path/,
  );
  assert.throws(
    () =>
      loadConfig({
        GARDEN_BASE_URL: "https://garden.example.com",
        GARDEN_MACHINE_TOKEN: "secret",
        GARDEN_INJECTOR_ARGS_JSON: '{"target":"not-an-array"}',
      }),
    /JSON array of strings/,
  );
  assert.throws(
    () =>
      loadConfig({
        GARDEN_BASE_URL: "https://garden.example.com",
        GARDEN_MACHINE_TOKEN: "secret",
        GARDEN_INJECTOR_ARGS_JSON: '["valid",7]',
      }),
    /JSON array of strings/,
  );
});

test("requires an injector executable before creating the runtime adapter", () => {
  const config = loadConfig({
    GARDEN_BASE_URL: "https://garden.example.com",
    GARDEN_MACHINE_TOKEN: "secret",
  });

  assert.throws(
    () => createRuntimeAdapter(config, silentLogger),
    /GARDEN_INJECTOR_EXECUTABLE is required/,
  );
});

test("loads optional wake message overrides and rejects invalid mappings", () => {
  const config = loadConfig({
    GARDEN_BASE_URL: "https://garden.example.com",
    GARDEN_MACHINE_TOKEN: "secret",
    GARDEN_WAKE_MESSAGE_MAP: JSON.stringify({
      game_turn_required: "使用本地游戏文案",
      forum_notification_available: "使用本地论坛通知文案",
    }),
  });
  assert.deepEqual(config.wakeMessageMap, {
    game_turn_required: "使用本地游戏文案",
    forum_notification_available: "使用本地论坛通知文案",
  });

  const invalidMappings = [
    "not-json",
    "[]",
    JSON.stringify({ "": "文案" }),
    JSON.stringify({ ["x".repeat(MAX_WAKE_REASON_LENGTH + 1)]: "文案" }),
    JSON.stringify({ game_turn_required: "   " }),
    JSON.stringify({
      notification_available: "x".repeat(MAX_WAKE_MESSAGE_LENGTH + 1),
    }),
  ];

  for (const mapping of invalidMappings) {
    assert.throws(
      () =>
        loadConfig({
          GARDEN_BASE_URL: "https://garden.example.com",
          GARDEN_MACHINE_TOKEN: "secret",
          GARDEN_WAKE_MESSAGE_MAP: mapping,
        }),
      ConfigError,
    );
  }
});

test("rejects missing Garden secrets", () => {
  assert.throws(
    () => loadConfig({ GARDEN_BASE_URL: "https://garden.example.com" }),
    /GARDEN_MACHINE_TOKEN is required/,
  );
});

test("redacts explicit secrets and bearer values from errors and logs", () => {
  const token = "top-secret-token";
  const lines: string[] = [];
  const logger = createLogger("debug", {
    secrets: [token],
    write: (line) => lines.push(line),
  });

  logger.error(`failed with ${token}`, {
    authorization: `Bearer ${token}`,
    error: new Error(`request exposed ${token}`),
  });

  assert.equal(redactText(`Bearer ${token}`, [token]), "Bearer [REDACTED]");
  assert.equal(safeErrorMessage(new Error(token), [token]), "[REDACTED]");
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /top-secret-token/);
  assert.match(lines[0] ?? "", /\[REDACTED]/);
});

test("logging never throws for bigint or circular error context", () => {
  const lines: string[] = [];
  const circular: Record<string, unknown> = { count: 1n };
  circular.self = circular;
  const logger = createLogger("debug", { write: (line) => lines.push(line) });

  assert.doesNotThrow(() => logger.error("complex failure", { error: circular }));
  assert.match(lines[0] ?? "", /\[Circular]/);
  assert.match(lines[0] ?? "", /"count":"1"/);
});
