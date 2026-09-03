/**
 * Capture run analysis — per-sender loss, signal strength, and the verdict.
 *
 * GLAB-108's question was whether missing CCA frames are a code regression or
 * ambient RF. Nothing in a single loss percentage answers that, so this layer
 * keeps the two pieces of evidence that do: the signal strength of the frames
 * that *did* arrive, and what the CC1101's own counters admit to having
 * dropped. Loss on weak signal is the air. Loss on strong signal with our
 * counters ticking is us. Loss on strong signal with the counters silent is
 * neither, and saying so is the point.
 *
 * Pure — no radio, no sockets. The harness supplies frames and two status
 * snapshots; everything here is arithmetic over those.
 */

import { median } from "./bench";
import { analyzeSequence, type SequenceAnalysis } from "./capture-metrics";
import type { NumberLookup } from "./data-values";
import type { NucleoStatus } from "./nucleo-status";

/**
 * The CCA byte at offset 1 is a *repeat slot within one transmission*, not a
 * stream counter.
 *
 * A single processor command puts one burst on the air — measured on the
 * bench rig, slots 135,141,…,189 stepping by 6 — and the next command starts
 * over at 135. So the counter going backwards is a new burst, not a rollover,
 * and each burst is its own little span to look for gaps inside. Reading a
 * sender's frames as one continuous stream turns every restart into a
 * 256-wide rollover: a real 18-second capture of 174 frames reported 96.5%
 * loss against 4,925 "expected" arrivals that were never sent.
 *
 * Loss between bursts is not measurable at all — nothing in the frame says
 * how many commands there should have been — so it is not counted.
 */
function segmentBursts(seqs: number[]): number[][] {
  const bursts: number[][] = [];
  let current: number[] = [];
  for (const s of seqs) {
    if (current.length > 0 && s < current[current.length - 1]) {
      bursts.push(current);
      current = [];
    }
    current.push(s);
  }
  if (current.length > 0) bursts.push(current);
  return bursts;
}

/**
 * The sender's stride, taken as the most common forward delta across every
 * burst it sent.
 *
 * Pooling beats per-burst inference twice over: a two-frame burst reveals no
 * stride on its own, and one number off the lattice — a stray 166 in a 6-step
 * run, seen on the rig — drags a per-burst GCD to 1 and inflates the expected
 * count sixfold. The mode ignores both.
 */
function inferStep(bursts: number[][]): number | undefined {
  const counts = new Map<number, number>();
  for (const burst of bursts) {
    for (let i = 1; i < burst.length; i++) {
      const delta = burst[i] - burst[i - 1];
      if (delta > 0) counts.set(delta, (counts.get(delta) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;

  let best = 0;
  let bestCount = 0;
  for (const [delta, count] of counts) {
    // Ties go to the smaller delta: a burst missing every other slot shows
    // 12 as often as 6, and the smaller stride is the one that finds gaps.
    if (count > bestCount || (count === bestCount && delta < best)) {
      best = delta;
      bestCount = count;
    }
  }
  return best;
}

/** Pool the gaps found inside each burst into one figure for the sender. */
interface BurstAnalysis {
  sequence: SequenceAnalysis;
  burstSlots: number[][];
}

function analyzeBursts(seqs: number[]): BurstAnalysis {
  const bursts = segmentBursts(seqs);
  const step = inferStep(bursts);

  let received = 0;
  let duplicates = 0;
  let expected = 0;
  let measured = false;
  const missing: number[] = [];

  for (const burst of bursts) {
    const a = analyzeSequence(burst, step ? { step } : {});
    received += a.received;
    duplicates += a.duplicates;
    if (a.expected === null) continue;
    measured = true;
    expected += a.expected;
    missing.push(...a.missing);
  }

  return {
    burstSlots: bursts,
    sequence: {
      step: step ?? null,
      received,
      duplicates,
      expected: measured ? expected : null,
      missing,
      lossPct:
        measured && expected > 0 ? (missing.length / expected) * 100 : null,
    },
  };
}

/**
 * Below this, loss needs no further explanation — the frame was at the edge
 * of the link budget. Chosen well under the CC1101's usable floor so that
 * calling something "RF" is a positive claim, not a shrug.
 */
export const WEAK_RSSI_DBM = -85;

/** Loss under this is jitter in the accounting, not a finding. */
export const LOSS_PCT_THRESHOLD = 1;

export type Band = "cca" | "ccx";

export interface FrameObservation {
  band: Band;
  /**
   * Stable sender key — CCA device id, CCX source address. Null when the
   * frame carries nothing that identifies its origin, which is a fact worth
   * counting rather than papering over with a synthetic key.
   */
  sender: string | null;
  /**
   * Message type. Part of the identity, not just a label: each type a sender
   * uses runs its own slot counter, so mixing them under one key destroys the
   * burst structure the loss measurement depends on.
   */
  type?: string | null;
  /** Per-sender counter. Null when the frame is too short to carry one. */
  seq: number | null;
  /** dBm, negative. Null on CCX, which has no per-frame RSSI in the stream. */
  rssi: number | null;
  isTx: boolean;
}

export interface RssiStats {
  min: number;
  median: number;
  max: number;
  samples: number;
}

export interface SenderRun {
  band: Band;
  sender: string;
  /** Message type this run covers, or null when the frames carried none. */
  type: string | null;
  frames: number;
  /** Transmission bursts this sender's frames fell into. Always 1 on CCX. */
  bursts: number;
  /**
   * The slot values of each burst, in arrival order. Kept because dispersion
   * asks *where* a miss landed, which a count of bursts cannot answer.
   */
  burstSlots: number[][];
  /** Gaps pooled across the sender's bursts. */
  sequence: SequenceAnalysis;
  /** Null when no frame in the run reported a signal level. */
  rssi: RssiStats | null;
}

export interface BandSummary {
  frames: number;
  /** Distinct devices heard on the band. */
  senders: number;
  /** Sender-and-type pairs, each with its own slot counter. */
  runs: number;
  /**
   * Loss pooled over expected frames across every run on the band, not the
   * mean of the runs' percentages — one three-frame run should not weigh the
   * same as a thousand-frame one. Null when no run had a measurable span.
   */
  lossPct: number | null;
  missing: number;
  expected: number;
}

export interface CaptureAnalysis {
  /** Sender runs, busiest first. */
  runs: SenderRun[];
  /** Received frames carrying no sender identity. */
  unattributed: number;
  /** Our own transmissions — not evidence about reception. */
  txFrames: number;
  byBand: Record<Band, BandSummary>;
}

export function analyzeCapture(frames: FrameObservation[]): CaptureAnalysis {
  const groups = new Map<
    string,
    {
      band: Band;
      sender: string;
      type: string | null;
      frames: FrameObservation[];
    }
  >();
  let unattributed = 0;
  let txFrames = 0;

  for (const f of frames) {
    if (f.isTx) {
      txFrames++;
      continue;
    }
    if (f.sender === null) {
      unattributed++;
      continue;
    }
    // Band is part of the identity too: a CCA device id and a CCX address are
    // different namespaces that can collide as strings.
    const type = f.type ?? null;
    const key = `${f.band}/${f.sender}/${type ?? ""}`;
    const group = groups.get(key);
    if (group) group.frames.push(f);
    else groups.set(key, { band: f.band, sender: f.sender, type, frames: [f] });
  }

  const runs: SenderRun[] = [];
  for (const { band, sender, type, frames: group } of groups.values()) {
    const seqs = group.map((f) => f.seq).filter((s): s is number => s !== null);
    // Only CCA is known to burst. A CCX sequence carries no documented
    // restart behaviour, so segmenting it would invent burst boundaries.
    const { sequence, burstSlots } =
      band === "cca"
        ? analyzeBursts(seqs)
        : { sequence: analyzeSequence(seqs), burstSlots: [seqs] };
    runs.push({
      band,
      sender,
      type,
      frames: group.length,
      bursts: burstSlots.length,
      burstSlots,
      sequence,
      rssi: rssiStats(group),
    });
  }
  runs.sort(
    (a, b) =>
      b.frames - a.frames ||
      a.sender.localeCompare(b.sender) ||
      (a.type ?? "").localeCompare(b.type ?? ""),
  );

  return {
    runs,
    unattributed,
    txFrames,
    byBand: {
      cca: summarizeBand(runs, "cca"),
      ccx: summarizeBand(runs, "ccx"),
    },
  };
}

function rssiStats(group: FrameObservation[]): RssiStats | null {
  const values = group
    .map((f) => f.rssi)
    .filter((r): r is number => r !== null);
  if (values.length === 0) return null;
  return {
    min: Math.min(...values),
    median: median(values),
    max: Math.max(...values),
    samples: values.length,
  };
}

function summarizeBand(runs: SenderRun[], band: Band): BandSummary {
  const onBand = runs.filter((r) => r.band === band);
  let missing = 0;
  let expected = 0;
  for (const r of onBand) {
    if (r.sequence.expected === null) continue;
    missing += r.sequence.missing.length;
    expected += r.sequence.expected;
  }
  return {
    frames: onBand.reduce((n, r) => n + r.frames, 0),
    senders: new Set(onBand.map((r) => r.sender)).size,
    runs: onBand.length,
    lossPct: expected === 0 ? null : (missing / expected) * 100,
    missing,
    expected,
  };
}

/** Every counter the status blob carries, flattened to one namespace. */
export type StatusCounters = Record<string, number>;

export interface StatusDelta {
  /** Uptime went backwards — the counters restarted, so no delta is real. */
  rebooted: boolean;
  elapsedMs: number | null;
  /** Null when the board rebooted mid-run. */
  counters: StatusCounters | null;
  /** False on firmware predating the v2 blob's radio counters. */
  hasRadioTelemetry: boolean;
}

/**
 * Counters that mean "the radio saw something and we lost it", as opposed to
 * a frame that never arrived at all. `ccaCrcFail` and `cc1101Runt` can still
 * have an RF cause — a corrupted frame is a received frame — but they put the
 * loss inside our reception path, which is exactly the line being drawn.
 */
const LOSS_IMPLICATING_COUNTERS = [
  "ccaDrop",
  "ccaCrcFail",
  "ccaN81Err",
  "cc1101Overflow",
  "cc1101Runt",
  "syncMiss",
  "ringBytesDropped",
  "rxRestartOverflow",
  "rxRestartTimeout",
] as const;

const CORE_STATUS_COUNTERS = [
  "ccaRx",
  "ccaTx",
  "ccaDrop",
  "ccaCrcFail",
  "ccaN81Err",
  "cc1101Overflow",
  "cc1101Runt",
  "ccxRx",
  "ccxTx",
  "ccxThreadRole",
  "numClients",
  "heapFree",
] as const satisfies readonly (keyof NucleoStatus)[];

const RADIO_STATUS_COUNTERS = [
  "rxRestartTimeout",
  "rxRestartOverflow",
  "rxRestartManual",
  "rxRestartPacket",
  "syncHit",
  "syncMiss",
  "ringMaxOccupancy",
  "ringBytesIn",
  "ringBytesDropped",
  "ccaAck",
  "ccaCrcOptional",
  "ccaIrq",
  "isrLatencyMinUs",
  "isrLatencyP95Us",
  "isrLatencyMaxUs",
  "isrLatencySamples",
] as const;

export function diffStatus(
  before: NucleoStatus,
  after: NucleoStatus,
): StatusDelta {
  const hasRadioTelemetry = before.radio !== null && after.radio !== null;

  if (after.uptimeMs < before.uptimeMs) {
    return {
      rebooted: true,
      elapsedMs: null,
      counters: null,
      hasRadioTelemetry,
    };
  }

  const counters: StatusCounters = {};
  for (const key of CORE_STATUS_COUNTERS) {
    counters[key] = after[key] - before[key];
  }
  if (before.radio && after.radio) {
    for (const key of RADIO_STATUS_COUNTERS) {
      counters[key] = after.radio[key] - before.radio[key];
    }
  }

  return {
    rebooted: false,
    elapsedMs: after.uptimeMs - before.uptimeMs,
    counters,
    hasRadioTelemetry,
  };
}

/** A run is a sender and a message type — both are needed to name it. */
function runLabel(r: SenderRun): string {
  return r.type ? `${r.sender} ${r.type}` : r.sender;
}

export type LossVerdict =
  | "clean"
  | "rf"
  | "local"
  | "unexplained"
  | "inconclusive";

export interface Diagnosis {
  verdict: LossVerdict;
  reasons: string[];
  /** Runs whose loss exceeded the threshold, busiest first. */
  lossyRuns: SenderRun[];
}

export interface DiagnoseOptions {
  /**
   * Counter deltas from an idle window in the same session, used to tell an
   * ambient counter from an implicated one. Without it, counters are reported
   * but never decide — see the comment on `excessCounters`.
   */
  control?: StatusDelta;
  /** Where in each burst the misses landed. */
  dispersion?: SlotDispersion;
}

/**
 * A counter has to beat its idle rate by this much before it means anything.
 * Ambient rates wander a little between windows; 1.5x is comfortably outside
 * the run-to-run wobble measured on the rig without hiding a real doubling.
 */
const COUNTER_EXCESS_FACTOR = 1.5;

/** ...and by at least this many events, so small counts cannot trip it. */
const COUNTER_EXCESS_MIN_EVENTS = 3;

/**
 * Counters whose rate during the run exceeded their rate while idle.
 *
 * The distinction matters more than it looks. `ccaDrop` was measured at
 * 6.86/s with no stimulus at all and 4.4-6.0/s while 24 frames/s were being
 * driven — it is a background process, uncorrelated with our traffic. Reading
 * "it moved" as "it ate our frames" made the verdict LOCAL on every run
 * regardless of what happened (GLAB-116).
 */
function excessCounters(
  delta: StatusDelta,
  control: StatusDelta,
): { name: string; runRate: number; idleRate: number; excess: number }[] {
  const runSec = (delta.elapsedMs ?? 0) / 1000;
  const idleSec = (control.elapsedMs ?? 0) / 1000;
  if (runSec <= 0 || idleSec <= 0 || !delta.counters || !control.counters) {
    return [];
  }

  const out: {
    name: string;
    runRate: number;
    idleRate: number;
    excess: number;
  }[] = [];
  for (const name of LOSS_IMPLICATING_COUNTERS) {
    const runCount = delta.counters[name] ?? 0;
    if (runCount <= 0) continue;
    const runRate = runCount / runSec;
    const idleRate = (control.counters[name] ?? 0) / idleSec;
    const excess = (runRate - idleRate) * runSec;
    if (
      runRate > idleRate * COUNTER_EXCESS_FACTOR &&
      excess >= COUNTER_EXCESS_MIN_EVENTS
    ) {
      out.push({ name, runRate, idleRate, excess });
    }
  }
  return out;
}

/**
 * Attribute a capture's loss, or decline to.
 *
 * Three independent lines of evidence, in order of how directly they speak:
 *
 * 1. **Signal strength** — weak frames going missing needs no other
 *    explanation. Unavailable while the streamed RSSI is truncated
 *    (GLAB-115), so today this almost never fires.
 * 2. **Slot dispersion** — only something synchronised to the burst can
 *    prefer a slot position, so clustering is ours and scatter is not.
 * 3. **Counter excess over idle** — the CC1101 admitting to dropping more
 *    than it drops when nothing is happening.
 *
 * Counter evidence is board-wide rather than per sender, which is why it is
 * ranked last and why it is measured against an idle control rather than
 * against zero.
 */
export function diagnose(
  analysis: CaptureAnalysis,
  delta: StatusDelta,
  opts: DiagnoseOptions = {},
): Diagnosis {
  const reasons: string[] = [];
  const lossyRuns = analysis.runs.filter(
    (r) => (r.sequence.lossPct ?? 0) > LOSS_PCT_THRESHOLD,
  );

  if (analysis.runs.length === 0) {
    return {
      verdict: "inconclusive",
      reasons: ["no frames attributed to any sender"],
      lossyRuns,
    };
  }

  if (delta.rebooted) {
    return {
      verdict: "inconclusive",
      reasons: ["board rebooted mid-run — counter deltas are not real"],
      lossyRuns,
    };
  }

  // Counters that moved are worth stating whatever the verdict turns out to
  // be. `ccaDrop` in particular counts strong frames the decoder threw away,
  // and those never reach a sequence analysis at all — folding them into a
  // "clean" line is how they go unnoticed. Reporting is not the same as
  // implicating, though: see `excess` below.
  const moved = delta.counters
    ? LOSS_IMPLICATING_COUNTERS.filter((c) => (delta.counters?.[c] ?? 0) > 0)
    : [];
  const counterReasons = moved.map(
    (c) => `${c} +${delta.counters?.[c]} during the run`,
  );

  const excess = opts.control ? excessCounters(delta, opts.control) : [];
  const excessReasons = excess.map(
    (e) =>
      `${e.name} ran at ${e.runRate.toFixed(1)}/s vs ${e.idleRate.toFixed(1)}/s idle (+${Math.round(e.excess)} beyond ambient)`,
  );
  if (opts.control && moved.length > 0 && excess.length === 0) {
    counterReasons.push(
      "every counter that moved was at or below its idle rate — ambient, not this run",
    );
  }
  if (!opts.control && moved.length > 0) {
    counterReasons.push(
      "no idle control window, so counter movement cannot be told from ambient and does not decide the verdict",
    );
  }

  // A run of one frame has no span for loss to hide in, so its null loss is
  // an absence of measurement, not a measurement of zero. If no run has a
  // span, there is nothing to be clean about.
  const measurable = analysis.runs.filter((r) => r.sequence.expected !== null);
  if (measurable.length === 0) {
    return {
      verdict: "inconclusive",
      reasons: [
        `no run had a measurable sequence span (${analysis.runs.length} senders, all too short)`,
        ...counterReasons,
      ],
      lossyRuns,
    };
  }

  if (lossyRuns.length === 0) {
    return {
      verdict: "clean",
      reasons: [
        `${measurable.length} of ${analysis.runs.length} runs measurable, all under ${LOSS_PCT_THRESHOLD}% loss`,
        ...counterReasons,
      ],
      lossyRuns,
    };
  }

  const strong = lossyRuns.filter(
    (r) => r.rssi !== null && r.rssi.median > WEAK_RSSI_DBM,
  );
  const weak = lossyRuns.filter(
    (r) => r.rssi !== null && r.rssi.median <= WEAK_RSSI_DBM,
  );
  // No signal level at all: CCX never carries one, and CCA's is truncated to
  // five bits by the firmware so the harness withholds it (GLAB-115). These
  // runs cannot be sorted into RF or not-RF, which is worth saying out loud
  // rather than letting them vanish from the reasons.
  const unplaceable = lossyRuns.filter((r) => r.rssi === null);
  const unplaceableReasons = unplaceable.map(
    (r) =>
      `${runLabel(r)}: ${r.sequence.lossPct?.toFixed(1)}% loss, no usable signal level to attribute it with`,
  );

  // "RF" is a positive claim, so it needs every lossy run to be explained by
  // weak signal. One strong or one unplaceable run is enough to withhold it.
  if (weak.length > 0 && strong.length === 0 && unplaceable.length === 0) {
    for (const r of weak) {
      reasons.push(
        `${runLabel(r)}: ${r.sequence.lossPct?.toFixed(1)}% loss at median ${r.rssi?.median} dBm (weak, at or below ${WEAK_RSSI_DBM})`,
      );
    }
    return {
      verdict: "rf",
      reasons: [...reasons, ...counterReasons],
      lossyRuns,
    };
  }

  for (const r of strong) {
    reasons.push(
      `${runLabel(r)}: ${r.sequence.lossPct?.toFixed(1)}% loss at median ${r.rssi?.median} dBm (strong)`,
    );
  }
  reasons.push(...unplaceableReasons);

  // Only something synchronised to the burst can prefer a slot position, and
  // the air is not synchronised to anything of ours.
  const dispersion = opts.dispersion;
  if (dispersion?.result === "clustered") {
    return {
      verdict: "local",
      reasons: [...reasons, dispersion.detail, ...counterReasons],
      lossyRuns,
    };
  }

  if (excess.length > 0) {
    // How much of the loss the excess could actually be. A CRC failure or an
    // N81 error is a frame we heard and threw away, so it shows up as a
    // missing slot — but naming the RX path without this ratio implies the
    // counters explain the loss when they may explain a fraction of it.
    const missingFrames = lossyRuns.reduce(
      (n, r) => n + r.sequence.missing.length,
      0,
    );
    const accounted = Math.round(excess.reduce((n, e) => n + e.excess, 0));
    const accounting =
      missingFrames > 0
        ? `counter excess accounts for at most ${accounted} of ${missingFrames} missing frames` +
          (accounted < missingFrames
            ? ` — the remaining ${missingFrames - accounted} are unaccounted for`
            : "")
        : null;

    return {
      verdict: "local",
      reasons: [
        ...reasons,
        ...excessReasons,
        ...(accounting ? [accounting] : []),
        ...counterReasons,
      ],
      lossyRuns,
    };
  }

  // Scatter is not proof of RF — there is no signal level to check — but it is
  // positive evidence against a mechanism of ours, which "unexplained" does
  // not convey. Only claimed when the counters are also at ambient, so the two
  // lines of evidence have to agree.
  if (dispersion?.result === "uniform" && opts.control) {
    return {
      verdict: "rf",
      reasons: [
        ...reasons,
        dispersion.detail,
        "nothing in our RX path exceeded its idle rate",
        ...counterReasons,
      ],
      lossyRuns,
    };
  }

  if (!delta.hasRadioTelemetry) {
    reasons.push(
      "no radio telemetry on this firmware — cannot rule the RX path in or out",
    );
    return { verdict: "inconclusive", reasons, lossyRuns };
  }

  if (dispersion && dispersion.result === "insufficient") {
    reasons.push(`slot dispersion: ${dispersion.detail}`);
  }
  return {
    verdict: "unexplained",
    reasons: [...reasons, ...counterReasons],
    lossyRuns,
  };
}

/** Per-band loss, the shape that gets committed as a baseline. */
export type LossBaseline = Record<Band, number | null>;

export interface CaptureComparison {
  ok: boolean;
  regressions: string[];
}

/**
 * Compare a fresh run's loss against a committed baseline.
 *
 * The tolerance is in *percentage points*, not relative: a band whose
 * baseline is 0% has no relative headroom at all, so a relative band would
 * make any band that starts clean impossible to hold. Absolute points also
 * match how the number is read — "two percent worse than last time".
 *
 * A band the baseline measured but this run did not is a regression, not a
 * pass. Hearing nothing at all is the most complete form of packet loss and
 * it is the one an "unknown → skip" rule would wave through.
 */
export function compareCapture(
  current: LossBaseline,
  baseline: LossBaseline,
  tolerancePoints: number,
): CaptureComparison {
  const regressions: string[] = [];

  for (const band of ["cca", "ccx"] as const) {
    const base = baseline[band];
    if (base === null) continue;
    const now = current[band];

    if (now === null) {
      regressions.push(
        `${band}: no measurable traffic this run (baseline ${base.toFixed(1)}% loss)`,
      );
      continue;
    }
    if (now > base + tolerancePoints) {
      regressions.push(
        `${band}: ${now.toFixed(1)}% loss vs baseline ${base.toFixed(1)}% (+${(now - base).toFixed(1)}pp, tolerance ${tolerancePoints}pp)`,
      );
    }
  }

  return { ok: regressions.length === 0, regressions };
}

export type DispersionResult = "uniform" | "clustered" | "insufficient";

/** One sender's bursts, all on the same repeat lattice. */
export interface DispersionInput {
  step: number;
  bursts: number[][];
}

export interface SlotDispersion {
  result: DispersionResult;
  /** Widest lattice seen, in slot positions. */
  positions: number;
  /** Frames missing from a position that was on offer. */
  missing: number;
  /** Misses at each slot position, index 0 first. */
  byPosition: number[];
  /** Bursts that actually had each position in their lattice. */
  opportunities: number[];
  chiSquare: number;
  degreesOfFreedom: number;
  criticalValue: number;
  detail: string;
}

/**
 * Expected misses per position below which a goodness-of-fit test says
 * nothing. The textbook rule for chi-square, and worth honouring: with three
 * misses over eight positions any pattern at all looks significant.
 */
const MIN_EXPECTED_PER_POSITION = 5;

/**
 * Critical chi-square values at p = 0.05, indexed by degrees of freedom.
 * Above these, "the misses fell evenly" stops being a believable explanation.
 * A table rather than an incomplete-gamma implementation — burst lengths here
 * are small and fixed, and a table is checkable by eye.
 */
const CHI2_CRITICAL_P05: NumberLookup<number> = {
  1: 3.84,
  2: 5.99,
  3: 7.81,
  4: 9.49,
  5: 11.07,
  6: 12.59,
  7: 14.07,
  8: 15.51,
  9: 16.92,
  10: 18.31,
  11: 19.68,
  12: 21.03,
  13: 22.36,
  14: 23.68,
  15: 25.0,
};

/**
 * Where in a burst do frames go missing?
 *
 * Measured by *position within the burst*, not by raw slot value: senders sit
 * on different lattices — one runs 135,141,… and another 7,13,… — and keyed
 * on value their losses look like unrelated singletons instead of one
 * pattern.
 *
 * A clustered result is evidence for a mechanism of ours, since only
 * something synchronised to the burst can prefer a position. A uniform result
 * is evidence against one; it does not prove the loss is RF, but it does say
 * the RX path is not eating a particular repeat. That distinction is the only
 * RF-vs-code test available while the streamed RSSI is unusable (GLAB-115).
 *
 * Each sender's lattice origin is the lowest slot value it was ever seen to
 * send, so a burst that lost its own first frame still lands on the right
 * positions. Positions are weighted by how many bursts actually had them on
 * offer, so a sender with a shorter lattice does not make the tail positions
 * look suspiciously clean.
 */
export function slotDispersion(inputs: DispersionInput[]): SlotDispersion {
  const byPosition: number[] = [];
  const opportunities: number[] = [];
  let missing = 0;

  for (const { step, bursts } of inputs) {
    if (step <= 0) continue;
    const values = bursts.flat();
    if (values.length === 0) continue;

    const origin = Math.min(...values);
    const at = (v: number) => Math.round((v - origin) / step);

    for (const burst of bursts) {
      if (burst.length < 2) continue;
      const seen = new Set(burst.map(at));
      const firstPos = at(burst[0]);
      const lastPos = at(burst[burst.length - 1]);

      // Strictly interior only. A burst's own first and last arrivals define
      // its span, and a frame lost at either edge is indistinguishable from a
      // sender that simply started late or stopped early — the same rule
      // analyzeSequence follows. Counting the edges made every burst that did
      // not reach the widest observed lattice look like it lost both ends: on
      // the rig that read as 38 misses at slot 0 and a CLUSTERED verdict for
      // loss that is nothing of the sort.
      for (let i = firstPos + 1; i < lastPos; i++) {
        opportunities[i] = (opportunities[i] ?? 0) + 1;
        byPosition[i] = byPosition[i] ?? 0;
        if (!seen.has(i)) {
          byPosition[i]++;
          missing++;
        }
      }
    }
  }

  // Positions nothing ever had a chance to lose carry no information.
  const bins: number[] = [];
  for (let i = 0; i < opportunities.length; i++) {
    if ((opportunities[i] ?? 0) > 0) bins.push(i);
  }

  const positions = bins.length;
  const degreesOfFreedom = Math.max(0, positions - 1);
  const criticalValue =
    CHI2_CRITICAL_P05[degreesOfFreedom] ?? Number.POSITIVE_INFINITY;
  const dense = bins.map((i) => byPosition[i] ?? 0);
  const denseOpportunities = bins.map((i) => opportunities[i] ?? 0);

  if (positions < 2) {
    return {
      result: "insufficient",
      positions,
      missing,
      byPosition: dense,
      opportunities: denseOpportunities,
      chiSquare: 0,
      degreesOfFreedom,
      criticalValue,
      detail: "no burst wide enough to have interior slot positions",
    };
  }

  if (missing / positions < MIN_EXPECTED_PER_POSITION) {
    return {
      result: "insufficient",
      positions,
      missing,
      byPosition: dense,
      opportunities: denseOpportunities,
      chiSquare: 0,
      degreesOfFreedom,
      criticalValue,
      detail:
        missing === 0
          ? "nothing went missing from an interior slot"
          : `${missing} missing over ${positions} interior positions — too few to judge, want ${MIN_EXPECTED_PER_POSITION} per position`,
    };
  }

  // Expected misses at a position are proportional to how often that position
  // was on offer, not simply missing/positions.
  const totalOpportunities = denseOpportunities.reduce((a, b) => a + b, 0);
  let chiSquare = 0;
  for (let i = 0; i < positions; i++) {
    const expected = (missing * denseOpportunities[i]) / totalOpportunities;
    if (expected <= 0) continue;
    chiSquare += (dense[i] - expected) ** 2 / expected;
  }

  if (chiSquare > criticalValue) {
    const worstBin = dense.indexOf(Math.max(...dense));
    return {
      result: "clustered",
      positions,
      missing,
      byPosition: dense,
      opportunities: denseOpportunities,
      chiSquare,
      degreesOfFreedom,
      criticalValue,
      detail: `misses concentrate at slot position ${bins[worstBin]} (${dense[worstBin]} of ${missing}); chi2 ${chiSquare.toFixed(1)} > ${criticalValue} at ${degreesOfFreedom} df`,
    };
  }

  return {
    result: "uniform",
    positions,
    missing,
    byPosition: dense,
    opportunities: denseOpportunities,
    chiSquare,
    degreesOfFreedom,
    criticalValue,
    detail: `misses spread evenly over ${positions} interior slot positions; chi2 ${chiSquare.toFixed(1)} <= ${criticalValue} at ${degreesOfFreedom} df`,
  };
}

/**
 * Dispersion inputs for every run that has a lattice worth measuring.
 *
 * CCA only: the CCX sequence has no known burst structure, so its "bursts"
 * are the whole stream and a position within one means nothing.
 */
export function dispersionInputs(analysis: CaptureAnalysis): DispersionInput[] {
  return analysis.runs.flatMap((run) => {
    if (run.band !== "cca" || run.sequence.step === null) return [];
    return [{ step: run.sequence.step, bursts: run.burstSlots }];
  });
}
