/**
 * Slot dispersion — is the loss deterministic or scattered?
 *
 * The one RF-vs-code test that works without a usable RSSI (GLAB-115). Loss
 * inside a burst falls on the sender's repeat lattice, so we can ask *where*
 * frames go missing. A mechanism in our own RX path — restart latency, a FIFO
 * flush, a TDMA handler — lands on particular slot positions. The air does
 * not care which slot it eats.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slotDispersion } from "../lib/capture-run";

/**
 * `count` bursts on a `slots`-wide lattice starting at `origin`, each missing
 * the positions named by the next entry of `missingPositions`.
 */
function sender(
  slots: number,
  count: number,
  missingPositions: number[][],
  origin = 0,
  step = 1,
) {
  const bursts: number[][] = [];
  for (let b = 0; b < count; b++) {
    const gone = new Set(missingPositions[b % missingPositions.length]);
    const burst: number[] = [];
    for (let i = 0; i < slots; i++) {
      if (!gone.has(i)) burst.push(origin + i * step);
    }
    bursts.push(burst);
  }
  return { step, bursts };
}

/**
 * One sender losing `counts[i]` frames at interior position i+1 of an
 * 11-slot burst. Index 0 of `counts` is slot position 1, since position 0 is
 * an edge and can never be observed missing.
 */
function withCounts(counts: number[]) {
  const bursts: number[][] = [];
  const all = Array.from({ length: counts.length + 2 }, (_, i) => i);
  for (let i = 0; i < counts.length; i++) {
    for (let n = 0; n < counts[i]; n++) {
      bursts.push(all.filter((v) => v !== i + 1));
    }
  }
  // Clean bursts keep every position's opportunity count equal.
  for (let i = 0; i < 20; i++) bursts.push([...all]);
  return { step: 1, bursts };
}

describe("slotDispersion", () => {
  it("calls loss spread evenly across positions uniform", () => {
    const d = slotDispersion([sender(8, 60, [[1], [2], [3], [4], [5], [6]])]);

    assert.equal(d.result, "uniform");
    assert.equal(d.missing, 60);
    assert.equal(d.positions, 6);
    assert.deepEqual(d.byPosition, [10, 10, 10, 10, 10, 10]);
  });

  it("does not count a miss at the edge of a burst", () => {
    // A burst that lost its own first frame is indistinguishable from one the
    // sender started late. Counting it made a whole run read as CLUSTERED at
    // slot 0 on the rig, for loss that was nothing of the sort.
    const d = slotDispersion([sender(8, 40, [[0], [7]])]);

    assert.equal(d.missing, 0);
    assert.equal(d.result, "insufficient");
  });

  it("calls loss concentrated on one position clustered", () => {
    // Position 3 eats every miss. A restart-latency bug looks like this.
    const d = slotDispersion([sender(8, 40, [[3]])]);

    assert.equal(d.result, "clustered");
    assert.equal(d.missing, 40);
    assert.match(d.detail, /position 3/);
  });

  it("refuses a call when there is too little loss to judge", () => {
    // Three misses over eight positions tells us nothing; the standard
    // goodness-of-fit rule wants an expected count of 5 per bin.
    const d = slotDispersion([sender(8, 3, [[2]])]);

    assert.equal(d.result, "insufficient");
    assert.match(d.detail, /too few/i);
  });

  it("refuses a call when nothing went missing", () => {
    const d = slotDispersion([sender(8, 20, [[]])]);

    assert.equal(d.result, "insufficient");
    assert.equal(d.missing, 0);
  });

  it("ignores a sender whose bursts are too short to have a lattice", () => {
    const d = slotDispersion([{ step: 6, bursts: [[135], [135], [135]] }]);

    assert.equal(d.result, "insufficient");
  });

  it("pools senders sitting on different lattices", () => {
    // One sender runs 135,141,… and another 7,13,…, both losing position 2.
    // Keyed on raw slot value these look like unrelated singletons; keyed on
    // position within the burst they are one clear cluster.
    const d = slotDispersion([
      sender(8, 20, [[2]], 135, 6),
      sender(8, 20, [[2]], 7, 6),
    ]);

    assert.equal(d.result, "clustered");
    assert.equal(d.missing, 40);
    assert.match(d.detail, /position 2/);
  });

  it("weights positions by how often they were actually on offer", () => {
    // A sender with a shorter lattice never had position 7 to lose. Treating
    // every position as equally exposed would read the shortfall there as a
    // suspiciously clean slot and drag the fit around.
    const short = sender(4, 30, [[1]]);
    const long = sender(8, 30, [[1]]);

    const d = slotDispersion([short, long]);

    assert.equal(d.result, "clustered");
    assert.match(d.detail, /position 1/);
  });

  it("matches the dispersion measured on the bench rig", () => {
    // Pooled misses per slot position from two 40-cycle runs on the rig:
    // 45 misses over 9 positions. This is the observation GLAB-116 rests on,
    // and it must not quietly flip to "clustered" if the test changes.
    const d = slotDispersion([withCounts([1, 7, 4, 5, 7, 7, 5, 7, 2])]);

    assert.equal(d.missing, 45);
    assert.equal(d.positions, 9);
    assert.equal(d.result, "uniform");
    assert.ok(d.chiSquare < d.criticalValue, `${d.chiSquare}`);
  });
});
