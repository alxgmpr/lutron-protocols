/**
 * Benchmark harness — sampling and regression logic.
 *
 * Wall-clock numbers are worthless as a committed baseline: a shared CI
 * runner is not the machine the baseline was taken on, and the difference is
 * larger than any regression worth catching. So nothing here compares
 * absolute times. Each benchmark is expressed as a *ratio* to a fixed
 * reference workload measured in the same process, and the ratios are what
 * get committed. Machine speed cancels.
 *
 * The rest is about not crying wolf: median over mean so one descheduled
 * iteration cannot fail a build, warmup samples discarded so JIT warmup is
 * not measured, and a relative tolerance band rather than an exact match.
 */

export interface SummarizeOptions {
  /** Leading samples to discard — JIT warmup, cold caches. */
  warmup: number;
}

export interface SampleSummary {
  median: number;
  min: number;
  max: number;
  /** How many samples remained after warmup was discarded. */
  samples: number;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function summarize(
  samples: number[],
  opts: SummarizeOptions,
): SampleSummary {
  if (opts.warmup >= samples.length) {
    throw new Error(
      `warmup (${opts.warmup}) would discard all ${samples.length} samples`,
    );
  }

  const measured = samples.slice(opts.warmup);
  return {
    median: median(measured),
    min: Math.min(...measured),
    max: Math.max(...measured),
    samples: measured.length,
  };
}

/**
 * Convert raw timings into ratios against the reference workload.
 *
 * The reference must be code that does not change when the code under test
 * does, or the ratios move for reasons unrelated to any regression.
 */
export interface BenchmarkValues {
  [name: string]: number;
}

export function normalize(
  timings: BenchmarkValues,
  referenceName: string,
): BenchmarkValues {
  const reference = timings[referenceName];
  if (reference === undefined) {
    throw new Error(`reference benchmark "${referenceName}" did not run`);
  }
  if (reference <= 0) {
    throw new Error(
      `reference benchmark "${referenceName}" measured ${reference} — cannot normalize`,
    );
  }

  const ratios: BenchmarkValues = {};
  for (const [name, value] of Object.entries(timings)) {
    if (name === referenceName) continue;
    ratios[name] = value / reference;
  }
  return ratios;
}

/** Slack for band-edge comparisons, in percentage points. */
const EDGE_EPSILON = 1e-9;

export interface BenchDelta {
  name: string;
  baseline: number;
  current: number;
  /** Positive means slower than baseline. */
  changePct: number;
}

export interface BenchVerdict {
  ok: boolean;
  regressions: BenchDelta[];
  improvements: BenchDelta[];
  /** In the baseline but absent from this run — a deleted benchmark. */
  missing: string[];
  /** In this run but absent from the baseline — needs a baseline refresh. */
  added: string[];
}

/**
 * Compare this run's ratios against the committed ones.
 *
 * Slower than the band fails. Faster does not — but it is reported, because
 * an unrefreshed baseline quietly widens the band until it catches nothing.
 *
 * A case may override the default band. Paths differ in how much they drift
 * between identical runs — an allocation-heavy one at the mercy of GC timing
 * moves several times more than a tight parse loop — and holding them all to
 * one number means either false alarms on the noisy ones or no gate at all on
 * the quiet ones.
 */
export function compareBench(
  current: Record<string, number>,
  baseline: Record<string, number>,
  tolerancePct: number,
  perCaseTolerancePct: Record<string, number> = {},
): BenchVerdict {
  const regressions: BenchDelta[] = [];
  const improvements: BenchDelta[] = [];

  for (const [name, baseValue] of Object.entries(baseline)) {
    const value = current[name];
    if (value === undefined) continue;

    const changePct = ((value - baseValue) / baseValue) * 100;
    const band = perCaseTolerancePct[name] ?? tolerancePct;
    const delta: BenchDelta = {
      name,
      baseline: baseValue,
      current: value,
      changePct,
    };

    // Compare with slack: a ratio exactly on the band edge computes to
    // 30.000000000000004, and a build must not fail on float error.
    if (changePct > band + EDGE_EPSILON) regressions.push(delta);
    else if (changePct < -band - EDGE_EPSILON) improvements.push(delta);
  }

  const missing = Object.keys(baseline).filter((n) => !(n in current));
  const added = Object.keys(current).filter((n) => !(n in baseline));

  return {
    ok: regressions.length === 0 && missing.length === 0,
    regressions,
    improvements,
    missing,
    added,
  };
}
