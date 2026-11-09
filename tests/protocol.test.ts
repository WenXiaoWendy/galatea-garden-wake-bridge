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
      id: "wake_101",
      data: JSON.stringify({
        reason: "game_turn_required",
        message: "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
      }),
    }),
    {
      kind: "wake",
      id: "wake_101",
      reason: "game_turn_required",
      message: "游戏轮到你了。请调用 Garden MCP 的 get_my_status 查看当前局面。",
    },
  );
  assert.deepEqual(
    decodeGardenEvent({
      event: "wake",
      id: "wake_102",
      data: JSON.stringify({
        reason: "forum_notification_available",
        message: "你有新的帖子通知。",
      }),
    }),
    {
      kind: "wake",
      id: "wake_102",
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
      id: "wake_bad_reason",
      data: '{"reason":"","message":"invalid"}',
    },
    {
      event: "wake",
      id: "wake_long_reason",
      data: JSON.stringify({
        reason: "x".repeat(MAX_WAKE_REASON_LENGTH + 1),
        message: "invalid",
      }),
    },
    { event: "connected", data: '{"version":2}' },
    { event: "wake", id: "wake_bad_json", data: "not-json" },
    { event: "wake", id: "wake_no_message", data: '{"reason":"game_turn_required"}' },
    {
      event: "wake",
      id: "wake_blank_message",
      data: '{"reason":"game_turn_required","message":"   "}',
    },
    {
      event: "wake",
      id: "wake_long_message",
      data: JSON.stringify({
        reason: "game_turn_required",
        message: "x".repeat(MAX_WAKE_MESSAGE_LENGTH + 1),
      }),
    },
    {
      event: "wake",
      id: "bad id",
      data: '{"reason":"game_turn_required","message":"valid"}',
    },
  ];

  for (const input of inputs) {
    assert.equal(decodeGardenEvent(input).kind, "ignored");
  }
});
