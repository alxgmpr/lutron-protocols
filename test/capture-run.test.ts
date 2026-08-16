/**
 * Capture run analysis — per-sender loss, RSSI, and the RF-vs-code verdict.
 *
 * The layer between raw frames and a bench verdict. Pure: no radio, no
 * sockets, no processor. Everything here is what the harness will conclude
 * from a run, so it is worth being able to state it without hardware.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeCapture,
  compareCapture,
  diagnose,
  diffStatus,
  type FrameObservation,
} from "../lib/capture-run";
import type { NucleoStatus } from "../lib/nucleo-status";

function frame(over: Partial<FrameObservation> = {}): FrameObservation {
  return {
    band: "cca",
    sender: "a1b2c3d4",
    seq: 0,
    rssi: -50,
    isTx: false,
    ...over,
  };
}

/** A run of frames from one sender at one signal level. */
function run(
  sender: string,
  seqs: number[],
  over: Partial<FrameObservation> = {},
): FrameObservation[] {
  return seqs.map((seq) => frame({ sender, seq, ...over }));
}

function status(over: Partial<NucleoStatus> = {}): NucleoStatus {
  return {
    uptimeMs: 1_000_000,
    ccaRx: 100,
    ccaTx: 0,
    ccaDrop: 0,
    ccaCrcFail: 0,
    ccaN81Err: 0,
    cc1101Overflow: 0,
    cc1101Runt: 0,
    ccxRx: 50,
    ccxTx: 0,
    ccxThreadJoined: true,
    ccxThreadRole: 2,
    ethLinkUp: true,
    numClients: 1,
    heapFree: 40_000,
    radio: {
      rxRestartTimeout: 0,
      rxRestartOverflow: 0,
      rxRestartManual: 0,
      rxRestartPacket: 0,
      syncHit: 100,
      syncMiss: 0,
      ringMaxOccupancy: 10,
      ringBytesIn: 5000,
      ringBytesDropped: 0,
      ccaAck: 0,
      ccaCrcOptional: 0,
      ccaIrq: 100,
      isrLatencyMinUs: 5,
      isrLatencyP95Us: 20,
      isrLatencyMaxUs: 40,
      isrLatencySamples: 100,
    },
    ...over,
  };
}

describe("analyzeCapture", () => {
  it("keeps each sender's sequence separate", () => {
    // Two senders interleaved on the air, stepping at different rates.
    // Merged into one stream the GCD collapses to 2 and invents gaps at every
    // even number A never used; split by sender, only B's missing 40 remains.
    const frames = [
      ...run("aaaa", [2, 4, 6, 8]),
      ...run("bbbb", [10, 20, 30, 50]),
    ];

    const a = analyzeCapture(frames);

    assert.equal(a.runs.length, 2);
    const byId = new Map(a.runs.map((r) => [r.sender, r]));
    assert.equal(byId.get("aaaa")?.sequence.step, 2);
    assert.equal(byId.get("aaaa")?.sequence.lossPct, 0);
    assert.equal(byId.get("bbbb")?.sequence.step, 10);
    assert.deepEqual(byId.get("bbbb")?.sequence.missing, [40]);
  });

  it("orders runs by how much traffic they carried", () => {
    const frames = [...run("quiet", [2, 4]), ...run("loud", [2, 4, 6, 8])];

    const a = analyzeCapture(frames);

    assert.deepEqual(
      a.runs.map((r) => r.sender),
      ["loud", "quiet"],
    );
  });

  it("summarizes RSSI over the frames actually received", () => {
    const frames = [
      frame({ seq: 2, rssi: -40 }),
      frame({ seq: 4, rssi: -60 }),
      frame({ seq: 6, rssi: -80 }),
    ];

    const a = analyzeCapture(frames);

    assert.deepEqual(a.runs[0].rssi, {
      min: -80,
      median: -60,
      max: -40,
      samples: 3,
    });
  });

  it("does not attribute TX frames to a sender run", () => {
    // Our own transmissions are not evidence about reception.
    const frames = [...run("aaaa", [2, 4, 6]), frame({ isTx: true, seq: 99 })];

    const a = analyzeCapture(frames);

    assert.equal(a.txFrames, 1);
    assert.equal(a.runs.length, 1);
    assert.equal(a.runs[0].frames, 3);
  });

  it("counts frames it cannot attribute rather than inventing a sender", () => {
    const frames = [...run("aaaa", [2, 4]), frame({ sender: null, seq: 7 })];

    const a = analyzeCapture(frames);

    assert.equal(a.unattributed, 1);
    assert.equal(a.runs.length, 1);
  });

  it("keeps the same id on different bands apart", () => {
    // A CCA device id and a CCX address could collide as strings; band is
    // part of the identity.
    const frames = [
      ...run("1234", [2, 4, 6]),
      ...run("1234", [2, 6], { band: "ccx", rssi: null }),
    ];

    const a = analyzeCapture(frames);

    assert.equal(a.runs.length, 2);
    assert.equal(a.byBand.cca.senders, 1);
    assert.equal(a.byBand.ccx.senders, 1);
  });

  it("pools per-band loss over expected frames, not over runs", () => {
    // One long clean run and one short lossy one. Averaging the two runs'
    // percentages would report 25%; pooling over expected frames reports the
    // loss an operator would actually have felt.
    const frames = [
      ...run("long", [2, 4, 6, 8, 10, 12, 14, 16, 18]),
      ...run("short", [2, 4, 8]),
    ];

    const a = analyzeCapture(frames);

    // 9 of 9 plus 3 of 4 → 1 missing out of 13 expected. Averaging the two
    // runs' percentages would have said 12.5%.
    assert.equal(a.byBand.cca.lossPct?.toFixed(1), "7.7");
    assert.equal(a.byBand.ccx.lossPct, null);
  });

  it("keeps a sender's message types on separate counters", () => {
    // One plug-in dimmer answering a RAISE hold sends DEVICE_CTRL on a
    // counter running 7..67 and DIM_STEP on one running 135..195, interleaved.
    // Pooled into a single stream, each hand-off between types reads as a
    // burst restart or a huge stride — measured at 48% invented loss.
    const frames = [
      frame({ sender: "aaaa", type: "DEVICE_CTRL", seq: 7 }),
      frame({ sender: "aaaa", type: "DIM_STEP", seq: 135 }),
      frame({ sender: "aaaa", type: "DEVICE_CTRL", seq: 13 }),
      frame({ sender: "aaaa", type: "DIM_STEP", seq: 141 }),
      frame({ sender: "aaaa", type: "DEVICE_CTRL", seq: 19 }),
      frame({ sender: "aaaa", type: "DIM_STEP", seq: 147 }),
    ];

    const a = analyzeCapture(frames);

    assert.equal(a.runs.length, 2);
    for (const r of a.runs) {
      assert.equal(r.bursts, 1, `${r.type} should be one burst`);
      assert.equal(r.sequence.lossPct, 0, `${r.type} should be clean`);
    }
  });

  it("counts distinct senders, not sender-and-type pairs", () => {
    // One device sending two message types is one device. Counting runs here
    // would make a chatty sender look like a crowd.
    const frames = [
      frame({ sender: "aaaa", type: "DEVICE_CTRL", seq: 7 }),
      frame({ sender: "aaaa", type: "DIM_STEP", seq: 135 }),
      frame({ sender: "bbbb", type: "DIM_STEP", seq: 135 }),
    ];

    const a = analyzeCapture(frames);

    assert.equal(a.byBand.cca.senders, 2);
    assert.equal(a.byBand.cca.runs, 3);
  });

  it("splits a CCA sender's frames into bursts at each restart", () => {
    // The byte at offset 1 is a repeat slot within one transmission, not a
    // stream counter: every command restarts it. Read as one stream, the
    // restart looks like a counter rollover and the span explodes.
    const frames = run("aaaa", [135, 141, 147, 135, 141, 147]);

    const a = analyzeCapture(frames);

    assert.equal(a.runs[0].bursts, 2);
    assert.equal(a.runs[0].sequence.expected, 6);
    assert.equal(a.runs[0].sequence.lossPct, 0);
  });

  it("finds a repeat missing from one burst", () => {
    const frames = run("aaaa", [135, 141, 147, 135, 147]);

    const a = analyzeCapture(frames);

    assert.equal(a.runs[0].sequence.step, 6);
    assert.equal(a.runs[0].sequence.expected, 6);
    assert.deepEqual(a.runs[0].sequence.missing, [141]);
    assert.equal(a.runs[0].sequence.lossPct?.toFixed(1), "16.7");
  });

  it("carries the step learned from long bursts into short ones", () => {
    // The second burst holds two numbers, which on its own reveals no step
    // and so no gap. The sender's other bursts already showed the stride.
    const frames = run("aaaa", [135, 141, 147, 153, 135, 147]);

    const a = analyzeCapture(frames);

    assert.equal(a.runs[0].sequence.step, 6);
    assert.deepEqual(a.runs[0].sequence.missing, [141]);
  });

  it("is not derailed by a sequence number off the lattice", () => {
    // A real capture had a stray 166 in a 6-step run. Inferring per burst,
    // the GCD drops to 1 and expected inflates sixfold.
    const frames = run("aaaa", [135, 141, 147, 153, 159, 165, 166, 171]);

    const a = analyzeCapture(frames);

    assert.equal(a.runs[0].sequence.step, 6);
    assert.equal(a.runs[0].sequence.expected, 7);
  });

  it("treats a CCX sender as one stream, not as bursts", () => {
    // CCX sequence numbers are not the CCA repeat slot and carry no known
    // restart behaviour, so segmenting them would invent burst boundaries.
    const frames = run("fd00::1", [2, 4, 8], { band: "ccx", rssi: null });

    const a = analyzeCapture(frames);

    assert.equal(a.runs[0].bursts, 1);
    assert.deepEqual(a.runs[0].sequence.missing, [6]);
  });
});

describe("diffStatus", () => {
  it("reports the change in each counter across the run", () => {
    const before = status({ ccaRx: 100, ccaCrcFail: 2 });
    const after = status({ uptimeMs: 1_060_000, ccaRx: 350, ccaCrcFail: 9 });

    const d = diffStatus(before, after);

    assert.equal(d.rebooted, false);
    assert.equal(d.elapsedMs, 60_000);
    assert.equal(d.counters?.ccaRx, 250);
    assert.equal(d.counters?.ccaCrcFail, 7);
  });

  it("diffs the radio telemetry too", () => {
    const before = status();
    const after = status({
      uptimeMs: 1_060_000,
      radio: { ...status().radio!, syncMiss: 12, ringBytesDropped: 40 },
    });

    const d = diffStatus(before, after);

    assert.equal(d.counters?.syncMiss, 12);
    assert.equal(d.counters?.ringBytesDropped, 40);
  });

  it("refuses to diff across a reboot", () => {
    // Uptime going backwards means the counters restarted from zero. Any
    // delta computed across that is fiction, and a small one reads as calm.
    const before = status({ uptimeMs: 5_000_000, ccaRx: 90_000 });
    const after = status({ uptimeMs: 4_000, ccaRx: 120 });

    const d = diffStatus(before, after);

    assert.equal(d.rebooted, true);
    assert.equal(d.counters, null);
  });

  it("reports no radio counters when the firmware predates them", () => {
    const before = status({ radio: null });
    const after = status({ uptimeMs: 1_060_000, ccaRx: 350, radio: null });

    const d = diffStatus(before, after);

    assert.equal(d.rebooted, false);
    assert.equal(d.counters?.ccaRx, 250);
    assert.equal(d.hasRadioTelemetry, false);
    assert.equal(d.counters?.syncMiss, undefined);
  });
});

describe("diagnose", () => {
  const clean = diffStatus(status(), status({ uptimeMs: 1_060_000 }));

  it("calls a run with no gaps clean", () => {
    const a = analyzeCapture(run("aaaa", [2, 4, 6, 8, 10]));

    assert.equal(diagnose(a, clean).verdict, "clean");
  });

  it("refuses to call a capture clean when nothing was measurable", () => {
    // Three senders, one frame each. No sender has two sequence numbers, so
    // there is no span to measure loss inside. Every run reports null loss,
    // which is not the same as zero — reading it as zero is how a board that
    // is dropping almost everything reports a clean bill of health.
    const a = analyzeCapture([
      ...run("aaaa", [4]),
      ...run("bbbb", [9]),
      ...run("cccc", [2]),
    ]);

    const d = diagnose(a, clean);

    assert.equal(d.verdict, "inconclusive");
    assert.match(d.reasons.join(" "), /measurable/i);
  });

  it("still reports counters that moved when the measured runs look clean", () => {
    // A clean measurement over the senders we could follow does not mean the
    // radio had a quiet time. ccaDrop counts strong frames the decoder threw
    // away, and burying that under "clean" loses the only trace of them.
    const a = analyzeCapture(run("aaaa", [2, 4, 6, 8, 10]));
    const noisy = diffStatus(
      status(),
      status({ uptimeMs: 1_060_000, ccaDrop: 330 }),
    );

    const d = diagnose(a, noisy);

    assert.equal(d.verdict, "clean");
    assert.match(d.reasons.join(" "), /ccaDrop \+330/);
  });

  it("blames RF when the loss is all on weak signal", () => {
    const a = analyzeCapture(run("far", [2, 4, 8, 10], { rssi: -92 }));

    const d = diagnose(a, clean);

    assert.equal(d.verdict, "rf");
    assert.match(d.reasons.join(" "), /-92|weak/i);
  });

  it("blames our RX path when strong frames go missing and counters moved", () => {
    // Loud sender, gaps anyway, and the CC1101 says it saw and lost them.
    const a = analyzeCapture(run("near", [2, 4, 8, 10], { rssi: -38 }));
    const delta = diffStatus(
      status(),
      status({
        uptimeMs: 1_060_000,
        radio: { ...status().radio!, syncMiss: 30 },
      }),
    );

    const d = diagnose(a, delta);

    assert.equal(d.verdict, "local");
    assert.match(d.reasons.join(" "), /syncMiss/);
  });

  it("says unexplained when strong frames vanish with the counters clean", () => {
    // Nothing in our path admits to dropping anything, and the signal was
    // strong. That is a real finding, not a clean bill of health.
    const a = analyzeCapture(run("near", [2, 4, 8, 10], { rssi: -38 }));

    const d = diagnose(a, clean);

    assert.equal(d.verdict, "unexplained");
  });

  it("refuses a verdict when the board rebooted mid-run", () => {
    const a = analyzeCapture(run("near", [2, 4, 8, 10], { rssi: -38 }));
    const rebooted = diffStatus(
      status({ uptimeMs: 5_000_000 }),
      status({ uptimeMs: 4_000 }),
    );

    const d = diagnose(a, rebooted);

    assert.equal(d.verdict, "inconclusive");
    assert.match(d.reasons.join(" "), /reboot/i);
  });

  it("names a lossy run it could not place, rather than staying silent", () => {
    // CCA RSSI arrives truncated to five bits, so the harness reports it as
    // absent. A lossy run with no signal level cannot be sorted into RF or
    // not-RF, and the reasons must say which run that was.
    const a = analyzeCapture(run("blind", [2, 4, 8, 10], { rssi: null }));
    const delta = diffStatus(
      status(),
      status({ uptimeMs: 1_060_000, ccaDrop: 40 }),
    );

    const d = diagnose(a, delta);

    assert.equal(d.verdict, "local");
    assert.match(d.reasons.join(" "), /blind/);
    assert.match(d.reasons.join(" "), /no usable signal level/i);
  });

  it("refuses a verdict when nothing was heard at all", () => {
    const d = diagnose(analyzeCapture([]), clean);

    assert.equal(d.verdict, "inconclusive");
  });

  it("cannot separate local from unexplained without radio telemetry", () => {
    // v1 firmware has no syncMiss/ring counters, so the evidence that would
    // convict our RX path is simply absent. Guessing "clean" would be worse.
    const a = analyzeCapture(run("near", [2, 4, 8, 10], { rssi: -38 }));
    const noRadio = diffStatus(
      status({ radio: null }),
      status({ uptimeMs: 1_060_000, radio: null }),
    );

    const d = diagnose(a, noRadio);

    assert.equal(d.verdict, "inconclusive");
    assert.match(d.reasons.join(" "), /telemetry/i);
  });
});

describe("compareCapture", () => {
  const baseline = { cca: 2, ccx: 0 };

  it("passes a run that matches the baseline", () => {
    const v = compareCapture({ cca: 2.4, ccx: 0 }, baseline, 5);

    assert.equal(v.ok, true);
    assert.deepEqual(v.regressions, []);
  });

  it("passes a run that lost less than the baseline", () => {
    // Improvement is never a regression, however large.
    const v = compareCapture({ cca: 0, ccx: 0 }, baseline, 5);

    assert.equal(v.ok, true);
  });

  it("fails a run that lost more than the tolerance allows", () => {
    const v = compareCapture({ cca: 9, ccx: 0 }, baseline, 5);

    assert.equal(v.ok, false);
    assert.equal(v.regressions.length, 1);
    assert.match(v.regressions[0], /cca/);
  });

  it("compares in percentage points, not relative to the baseline", () => {
    // A 0%-loss baseline has no relative headroom at all; a relative band
    // would make every band that starts clean impossible to keep.
    const v = compareCapture({ cca: 2, ccx: 4 }, baseline, 5);

    assert.equal(v.ok, true);
  });

  it("treats a band with no measurement as unknown, not as passing", () => {
    // Hearing nothing on a band it used to hear is not a clean run.
    const v = compareCapture({ cca: null, ccx: 0 }, baseline, 5);

    assert.equal(v.ok, false);
    assert.match(v.regressions.join(" "), /cca/);
  });

  it("ignores a band the baseline never measured", () => {
    const v = compareCapture({ cca: 2, ccx: 30 }, { cca: 2, ccx: null }, 5);

    assert.equal(v.ok, true);
  });
});
