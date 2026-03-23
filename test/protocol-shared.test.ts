import assert from "node:assert/strict";
import test from "node:test";
import {
  LEVEL_MAX_16,
  level16ToPercent,
  percentToLevel16,
  qsToSeconds,
  secondsToQs,
} from "../protocol/shared";

test("percentToLevel16 maps endpoints correctly", () => {
  assert.equal(percentToLevel16(0), 0);
  assert.equal(percentToLevel16(100), LEVEL_MAX_16);
  assert.equal(percentToLevel16(50), Math.round(LEVEL_MAX_16 / 2));
});

test("level16ToPercent round-trips representative values", () => {
  const input = 37;
  const encoded = percentToLevel16(input);
  assert.ok(Math.abs(level16ToPercent(encoded) - input) < 0.1);
});

test("quarter-second conversion round-trips", () => {
  assert.equal(secondsToQs(2.5), 10);
  assert.equal(qsToSeconds(10), 2.5);
});
