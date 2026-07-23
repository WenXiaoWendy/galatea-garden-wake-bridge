import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeGardenEvent,
  MAX_WAKE_MESSAGE_LENGTH,
  MAX_WAKE_REASON_LENGTH,
} from "../src/protocol.js";

test("passes through messages for server-defined wake reasons", () => {
  assert.deepEqual(
    decodeGardenEvent({
      event: "wake",
      data: JSON.stringify({
        reason: "game_turn_required",
        message: "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
      }),
    }),
    {
      kind: "wake",
      reason: "game_turn_required",
      message: "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
    },
  );
  assert.deepEqual(
    decodeGardenEvent({
      event: "wake",
      data: JSON.stringify({
        reason: "forum_notification_available",
        message: "你有新的帖子通知。",
      }),
    }),
    {
      kind: "wake",
      reason: "forum_notification_available",
      message: "你有新的帖子通知。",
    },
  );
});

test("ignores unknown events, invalid reasons, versions, malformed payloads, and invalid messages", () => {
  const inputs = [
    { event: "other", data: "{}" },
    {
      event: "wake",
      data: '{"reason":"","message":"invalid"}',
    },
    {
      event: "wake",
      data: JSON.stringify({
        reason: "x".repeat(MAX_WAKE_REASON_LENGTH + 1),
        message: "invalid",
      }),
    },
    { event: "connected", data: '{"version":2}' },
    { event: "wake", data: "not-json" },
    { event: "wake", data: '{"reason":"game_turn_required"}' },
    {
      event: "wake",
      data: '{"reason":"game_turn_required","message":"   "}',
    },
    {
      event: "wake",
      data: JSON.stringify({
        reason: "game_turn_required",
        message: "x".repeat(MAX_WAKE_MESSAGE_LENGTH + 1),
      }),
    },
  ];

  for (const input of inputs) {
    assert.equal(decodeGardenEvent(input).kind, "ignored");
  }
});
