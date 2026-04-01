import assert from "node:assert/strict";
import test from "node:test";
import {
  evalWarmDimCurve,
  generateWarmDimTable,
  getWarmDimCurve,
  WARM_DIM_CURVES,
} from "../lib/warm-dim";

test("getWarmDimCurve falls back to default", () => {
  assert.equal(getWarmDimCurve("missing"), WARM_DIM_CURVES.default);
});

test("warm dim evaluation stays within native coefficient bounds", () => {
  const curve = WARM_DIM_CURVES.default;
  const values = [0, 25, 50, 75, 100].map((pct) =>
    evalWarmDimCurve(curve, pct),
  );

  assert.ok(values.every((value) => value >= 1800 && value <= 2800));
  assert.ok(values[0] <= values[values.length - 1]);
});

test("generateWarmDimTable remaps to requested output range", () => {
  const table = generateWarmDimTable(WARM_DIM_CURVES.default, 2000, 3000);

  assert.equal(table.length, 101);
  assert.ok(Math.min(...table) >= 2000);
  assert.ok(Math.max(...table) <= 3000);
});
