/**
 * Benchmark harness — sampling and regression logic.
 *
 * The timing itself can't be unit tested, but everything that decides whether
 * a run is a regression can, and that is the part that would otherwise fail
 * silently or flakily in CI.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareBench, median, normalize, summarize } from "../lib/bench";

describe("median", () => {
  it("takes the middle of an odd sample count", () => {
    assert.equal(median([5, 1, 3]), 3);
  });

  it("averages the middle pair of an even sample count", () => {
    assert.equal(median([1, 3, 5, 7]), 4);
  });

  it("is unmoved by a single wild outlier", () => {
    // The reason for median over mean: one descheduled iteration on a shared
    // CI runner must not decide whether the build passes.
    assert.equal(median([10, 10, 10, 10, 100000]), 10);
  });
});

describe("summarize", () => {
  it("discards warmup samples before measuring", () => {
    // First two are cold; the steady state is 10.
    const s = summarize([500, 400, 10, 10, 10], { warmup: 2 });

    assert.equal(s.median, 10);
    assert.equal(s.samples, 3);
  });

  it("keeps every sample when no warmup is requested", () => {
    const s = summarize([1, 2, 3], { warmup: 0 });

    assert.equal(s.samples, 3);
    assert.equal(s.median, 2);
  });

  it("refuses to summarize when warmup would consume every sample", () => {
    assert.throws(() => summarize([1, 2], { warmup: 2 }), /warmup/i);
  });
});

describe("normalize", () => {
  it("expresses each result as a ratio to the reference", () => {
    const ratios = normalize(
      { reference: 100, decode: 250, parse: 50 },
      "reference",
    );

    assert.equal(ratios.decode, 2.5);
    assert.equal(ratios.parse, 0.5);
  });

  it("drops the reference from its own results", () => {
    const ratios = normalize({ reference: 100, decode: 250 }, "reference");

    assert.equal("reference" in ratios, false);
  });

  it("fails loudly when the reference is missing", () => {
    assert.throws(() => normalize({ decode: 1 }, "reference"), /reference/);
  });

  it("fails loudly on a zero reference rather than dividing by it", () => {
    assert.throws(
      () => normalize({ reference: 0, decode: 1 }, "reference"),
      /reference/,
    );
  });
});

describe("compareBench", () => {
  const baseline = { decode: 2.0, parse: 1.0 };

  it("passes when every ratio sits inside the tolerance band", () => {
    const v = compareBench({ decode: 2.2, parse: 0.9 }, baseline, 30);

    assert.equal(v.ok, true);
    assert.deepEqual(v.regressions, []);
  });

  it("fails a ratio that exceeds the tolerance band", () => {
    const v = compareBench({ decode: 2.7, parse: 1.0 }, baseline, 30);

    assert.equal(v.ok, false);
    assert.equal(v.regressions.length, 1);
    assert.equal(v.regressions[0].name, "decode");
    assert.equal(v.regressions[0].baseline, 2.0);
    assert.equal(v.regressions[0].current, 2.7);
  });

  it("treats the band edge as passing", () => {
    const v = compareBench({ decode: 2.6, parse: 1.0 }, baseline, 30);

    assert.equal(v.ok, true);
  });

  it("reports a large improvement without failing the run", () => {
    // Getting faster is not a build failure, but it should prompt a refresh
    // or the band silently widens against a stale baseline.
    const v = compareBench({ decode: 1.0, parse: 1.0 }, baseline, 30);

    assert.equal(v.ok, true);
    assert.deepEqual(
      v.improvements.map((i) => i.name),
      ["decode"],
    );
  });

  it("fails when a benchmark the baseline covers has disappeared", () => {
    const v = compareBench({ decode: 2.0 }, baseline, 30);

    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, ["parse"]);
  });

  it("reports a benchmark with no baseline as new without failing", () => {
    const v = compareBench({ decode: 2.0, parse: 1.0, fresh: 5 }, baseline, 30);

    assert.equal(v.ok, true);
    assert.deepEqual(v.added, ["fresh"]);
  });
});
