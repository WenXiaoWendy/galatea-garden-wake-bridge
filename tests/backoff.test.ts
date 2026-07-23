import assert from "node:assert/strict";
import test from "node:test";
import { computeBackoffMs, ReconnectBackoff } from "../src/backoff.js";

test("keeps exponential backoff and jitter inside configured bounds", () => {
  const options = {
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0.2,
  };

  assert.equal(computeBackoffMs(0, { ...options, random: () => 0 }), 1_000);
  assert.equal(computeBackoffMs(3, { ...options, random: () => 0 }), 6_400);
  assert.equal(computeBackoffMs(3, { ...options, random: () => 1 }), 8_000);
  assert.equal(computeBackoffMs(20, { ...options, random: () => 1 }), 30_000);
  assert.equal(computeBackoffMs(20, { ...options, random: () => 0 }), 24_000);
});

test("resets the reconnect sequence after a stable connection", () => {
  const backoff = new ReconnectBackoff({
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitterRatio: 0,
    random: () => 1,
  });

  assert.equal(backoff.nextDelayMs(), 1_000);
  assert.equal(backoff.nextDelayMs(), 2_000);
  backoff.reset();
  assert.equal(backoff.nextDelayMs(), 1_000);
});
