/**
 * Capture metrics — sequence-gap loss and decode coverage.
 *
 * Pure accounting over observed frames: no radio, no sockets. The bench
 * harness feeds it live frames and the replay tool feeds it a committed
 * corpus, so both report the same numbers the same way.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeSequence, summarizeDecode } from "../lib/capture-metrics";

describe("analyzeSequence", () => {
  it("reports no loss for a complete run", () => {
    const a = analyzeSequence([6, 12, 18, 24, 30]);

    assert.equal(a.step, 6);
    assert.equal(a.received, 5);
    assert.equal(a.expected, 5);
    assert.deepEqual(a.missing, []);
    assert.equal(a.lossPct, 0);
  });

  it("finds the gaps in the capture that prompted GLAB-108", () => {
    // RAISE PRESS arrived 6,18,24,30,36,48,54,66 — 12, 42 and 60 never landed.
    const a = analyzeSequence([6, 18, 24, 30, 36, 48, 54, 66]);

    assert.equal(a.step, 6);
    assert.equal(a.received, 8);
    assert.equal(a.expected, 11);
    assert.deepEqual(a.missing, [12, 42, 60]);
    assert.equal(a.lossPct.toFixed(1), "27.3");
  });

  it("unwraps a byte-wide counter rolling over", () => {
    // CCA carries its sequence in one byte, so a long run wraps 255 → 0.
    const a = analyzeSequence([246, 252, 2, 8, 14], { modulus: 256 });

    assert.equal(a.step, 6);
    assert.equal(a.received, 5);
    assert.equal(a.expected, 5);
    assert.deepEqual(a.missing, []);
    assert.equal(a.lossPct, 0);
  });

  it("reports a gap that straddles the rollover", () => {
    const a = analyzeSequence([246, 252, 8, 14], { modulus: 256 });

    assert.equal(a.expected, 5);
    assert.equal(a.received, 4);
    assert.deepEqual(a.missing, [2]);
  });

  it("counts a retransmitted sequence number once", () => {
    // Thread retransmits; the same seq arriving twice is not extra coverage.
    const a = analyzeSequence([6, 6, 6, 12, 18]);

    assert.equal(a.received, 3);
    assert.equal(a.duplicates, 2);
    assert.equal(a.expected, 3);
    assert.equal(a.lossPct, 0);
  });

  it("refuses to guess a step from a single observation", () => {
    const a = analyzeSequence([6]);

    assert.equal(a.step, null);
    assert.equal(a.received, 1);
    assert.equal(a.expected, null);
    assert.equal(a.lossPct, null);
  });

  it("reports nothing for an empty capture", () => {
    const a = analyzeSequence([]);

    assert.equal(a.received, 0);
    assert.equal(a.expected, null);
    assert.equal(a.lossPct, null);
  });
});

describe("summarizeDecode", () => {
  it("separates frames we could not decode from frames we could not identify", () => {
    const s = summarizeDecode([
      {
        band: "ccx",
        decoded: true,
        identified: true,
        typeName: "LEVEL_CONTROL",
      },
      {
        band: "ccx",
        decoded: true,
        identified: true,
        typeName: "BUTTON_PRESS",
      },
      // Decoded fine, but the type byte means nothing to us yet. CCA names
      // these by their type byte ("0x5F"), so only the flag is reliable.
      { band: "cca", decoded: true, identified: false, typeName: "0x5F" },
      // Never got as far as a type — decrypt or framing failed.
      { band: "ccx", decoded: false, identified: false, typeName: null },
    ]);

    assert.equal(s.frames, 4);
    assert.equal(s.decoded, 3);
    assert.equal(s.decodePct, 75);
    assert.equal(s.identified, 2);
    assert.equal(s.unidentified, 1);
    assert.equal(s.identifiedPct, 50);
  });

  it("totals unconsumed CBOR keys across frames", () => {
    const s = summarizeDecode([
      {
        band: "ccx",
        decoded: true,
        identified: true,
        typeName: "LEVEL_CONTROL",
        unknownKeys: 2,
      },
      {
        band: "ccx",
        decoded: true,
        identified: true,
        typeName: "LEVEL_CONTROL",
      },
      {
        band: "ccx",
        decoded: true,
        identified: true,
        typeName: "DIM_HOLD",
        unknownKeys: 1,
      },
    ]);

    assert.equal(s.unknownKeyTotal, 3);
    assert.equal(s.framesWithUnknownKeys, 2);
  });

  it("counts what was seen per message type", () => {
    const s = summarizeDecode([
      {
        band: "ccx",
        decoded: true,
        identified: true,
        typeName: "LEVEL_CONTROL",
      },
      {
        band: "ccx",
        decoded: true,
        identified: true,
        typeName: "LEVEL_CONTROL",
      },
      { band: "cca", decoded: true, identified: false, typeName: "0x5F" },
    ]);

    assert.deepEqual(s.byType, { LEVEL_CONTROL: 2, "0x5F": 1 });
  });

  it("reports zeros rather than NaN for an empty capture", () => {
    const s = summarizeDecode([]);

    assert.equal(s.frames, 0);
    assert.equal(s.decodePct, 0);
    assert.equal(s.identifiedPct, 0);
    assert.deepEqual(s.byType, {});
  });
});

describe("analyzeSequence with a forced step", () => {
  it("uses the given step instead of inferring one", () => {
    // Two numbers cannot reveal a step, so inference reads 135→147 as one
    // clean stride. Told the step is 6, the missing 141 shows up.
    const inferred = analyzeSequence([135, 147]);
    const forced = analyzeSequence([135, 147], { step: 6 });

    assert.equal(inferred.step, 12);
    assert.deepEqual(inferred.missing, []);
    assert.equal(forced.step, 6);
    assert.deepEqual(forced.missing, [141]);
  });

  it("survives a value off the lattice without collapsing the step", () => {
    // A stray 166 among a 6-step run drags the GCD to 1 and inflates
    // `expected` by six. With the step supplied, it is just an extra arrival.
    const collapsed = analyzeSequence([135, 141, 147, 166, 171]);
    const forced = analyzeSequence([135, 141, 147, 166, 171], { step: 6 });

    assert.equal(collapsed.step, 1);
    assert.equal(forced.step, 6);
    assert.equal(forced.expected, 7);
  });
});

describe("analyzeSequence expected count", () => {
  it("counts whole slots when the span does not divide by the step", () => {
    // 135 → 166 is not a whole number of 6-wide slots. `expected` has to
    // agree with the slots the gap scan actually visits, or a capture reports
    // a fractional number of frames it was waiting for.
    const a = analyzeSequence([135, 141, 147, 166], { step: 6 });

    assert.equal(a.expected, 6);
    assert.ok(Number.isInteger(a.expected));
    assert.deepEqual(a.missing, [153, 159, 165]);
  });

  it("keeps expected consistent with the slots scanned", () => {
    for (const last of [160, 161, 162, 163, 164, 165, 166]) {
      const a = analyzeSequence([135, last], { step: 6 });
      assert.equal(
        a.expected,
        a.missing.length +
          [135, last].filter((v) => (v - 135) % 6 === 0).length,
        `span 135..${last}`,
      );
    }
  });
});
