import assert from "node:assert/strict";
import test from "node:test";
import { SseParser, type SseEvent } from "../src/sse/parser.js";

const encoder = new TextEncoder();

test("parses events across arbitrary byte boundaries, including UTF-8 and CRLF", () => {
  const events: SseEvent[] = [];
  const source =
    "event: wake\r\ndata: {\"reason\":\"notification_available\",\"text\":\"通知\"}\r\n\r\n";
  const bytes = encoder.encode(source);
  const parser = new SseParser({ onEvent: (event) => events.push(event) });

  for (const byte of bytes) {
    parser.push(Uint8Array.of(byte));
  }
  parser.finish();

  assert.deepEqual(events, [
    {
      event: "wake",
      data: '{"reason":"notification_available","text":"通知"}',
    },
  ]);
});

test("joins multi-line data and requires a blank line to dispatch", () => {
  const events: SseEvent[] = [];
  const parser = new SseParser({ onEvent: (event) => events.push(event) });

  parser.push(encoder.encode("event: custom\ndata: first\ndata: second"));
  assert.equal(events.length, 0);
  parser.push(encoder.encode("\n\n"));

  assert.deepEqual(events, [{ event: "custom", data: "first\nsecond" }]);
});

test("reports comments without dispatching heartbeat events", () => {
  const comments: string[] = [];
  const events: SseEvent[] = [];
  const parser = new SseParser({
    onEvent: (event) => events.push(event),
    onComment: (comment) => comments.push(comment),
  });

  parser.push(encoder.encode(": ping\n\n:second\n\n"));

  assert.deepEqual(comments, ["ping", "second"]);
  assert.deepEqual(events, []);
});

test("handles a final carriage-return line ending", () => {
  const events: SseEvent[] = [];
  const parser = new SseParser({ onEvent: (event) => events.push(event) });

  parser.push(encoder.encode("data: complete\r\r"));
  parser.finish();

  assert.deepEqual(events, [{ event: "message", data: "complete" }]);
});
