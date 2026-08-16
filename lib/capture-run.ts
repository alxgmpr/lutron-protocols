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
function analyzeBursts(seqs: number[]): {
  sequence: SequenceAnalysis;
  bursts: number;
} {
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
    bursts: bursts.length,
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
    const { sequence, bursts } =
      band === "cca"
        ? analyzeBursts(seqs)
        : { sequence: analyzeSequence(seqs), bursts: 1 };
    runs.push({
      band,
      sender,
      type,
      frames: group.length,
      bursts,
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
  const priorCore = before as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(after)) {
    if (typeof value !== "number" || key === "uptimeMs") continue;
    counters[key] = value - (priorCore[key] as number);
  }
  if (before.radio && after.radio) {
    const priorRadio = before.radio as unknown as Record<string, number>;
    for (const [key, value] of Object.entries(after.radio)) {
      counters[key] = value - priorRadio[key];
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

/**
 * Attribute a capture's loss, or decline to.
 *
 * The counter evidence is board-wide, not per sender, so it is only ever used
 * to explain loss that the RSSI evidence has already failed to explain. That
 * ordering matters: a weak-signal run and a busy neighbour ticking `syncMiss`
 * would otherwise convict our RX path for the air's mistake.
 */
export function diagnose(
  analysis: CaptureAnalysis,
  delta: StatusDelta,
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
  // "clean" line is how they go unnoticed.
  const implicated = delta.counters
    ? LOSS_IMPLICATING_COUNTERS.filter((c) => (delta.counters?.[c] ?? 0) > 0)
    : [];
  const counterReasons = implicated.map(
    (c) => `${c} +${delta.counters?.[c]} during the run`,
  );

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

  if (implicated.length > 0) {
    return {
      verdict: "local",
      reasons: [...reasons, ...counterReasons],
      lossyRuns,
    };
  }

  if (!delta.hasRadioTelemetry) {
    reasons.push(
      "no radio telemetry on this firmware — cannot rule the RX path in or out",
    );
    return { verdict: "inconclusive", reasons, lossyRuns };
  }

  reasons.push("every loss-implicating counter stayed at zero");
  return { verdict: "unexplained", reasons, lossyRuns };
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
