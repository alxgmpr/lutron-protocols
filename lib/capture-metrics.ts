/**
 * Capture metrics — how much of what was sent did we hear, and how much of
 * what we heard did we understand.
 *
 * Pure accounting over observed frames. The bench harness feeds it live
 * frames and the replay tool feeds it a committed corpus, so a loss figure
 * from the bench and one from CI mean the same thing.
 */

export interface SequenceOptions {
  /**
   * Counter width, when the sequence field wraps. CCA carries its sequence in
   * a single byte, so a run of any length rolls over at 256.
   */
  modulus?: number;
}

export interface SequenceAnalysis {
  /** Inferred spacing between consecutive numbers, or null if unknowable. */
  step: number | null;
  /** Distinct sequence numbers seen. */
  received: number;
  /** Repeat arrivals of a number already counted (Thread retransmits). */
  duplicates: number;
  /** How many should have arrived across the observed span. */
  expected: number | null;
  /** Numbers inside the span that never arrived, in counter space. */
  missing: number[];
  lossPct: number | null;
}

const EMPTY: SequenceAnalysis = {
  step: null,
  received: 0,
  duplicates: 0,
  expected: null,
  missing: [],
  lossPct: null,
};

/**
 * Infer the sender's sequence step and report what went missing between the
 * first and last number actually seen.
 *
 * Loss is only ever measured *inside* the observed span — a run that starts
 * late or is cut off short is not loss, and counting it as such would make
 * every capture look lossy at its edges.
 *
 * `seqs` must be in arrival order: rollover is detected by the counter going
 * backwards, so sorting first would destroy the information. Genuinely
 * out-of-order arrival reads as a rollover, which is why this is only applied
 * when a modulus is given.
 *
 * The step is the GCD of the observed deltas, so it stays right when packets
 * are missing. It can still overestimate if every gap happens to be a common
 * multiple — 12 and 24 with a true step of 6 reads as 12 — which understates
 * loss rather than inventing it.
 */
export function analyzeSequence(
  seqs: number[],
  opts: SequenceOptions = {},
): SequenceAnalysis {
  if (seqs.length === 0) return EMPTY;

  const unwrapped = opts.modulus ? unwrap(seqs, opts.modulus) : seqs;
  const unique = [...new Set(unwrapped)].sort((a, b) => a - b);
  const duplicates = unwrapped.length - unique.length;

  // One number tells us nothing about spacing, so it tells us nothing about
  // loss either. Reporting 0% here would read as a clean run.
  if (unique.length < 2) {
    return { ...EMPTY, received: unique.length, duplicates };
  }

  const first = unique[0];
  const last = unique[unique.length - 1];
  const step = unique
    .slice(1)
    .reduce((acc, s, i) => gcd(acc, s - unique[i]), 0);

  const seen = new Set(unique);
  const missing: number[] = [];
  for (let s = first; s <= last; s += step) {
    if (!seen.has(s)) missing.push(rewrap(s, opts.modulus));
  }

  const expected = (last - first) / step + 1;
  return {
    step,
    received: unique.length,
    duplicates,
    expected,
    missing,
    lossPct: (missing.length / expected) * 100,
  };
}

/** Make a wrapping counter monotonic by adding the modulus at each rollover. */
function unwrap(seqs: number[], modulus: number): number[] {
  let offset = 0;
  const out: number[] = [seqs[0]];
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] < seqs[i - 1]) offset += modulus;
    out.push(seqs[i] + offset);
  }
  return out;
}

/** Map an unwrapped number back into counter space for reporting. */
function rewrap(value: number, modulus?: number): number {
  return modulus ? ((value % modulus) + modulus) % modulus : value;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export interface DecodedFrame {
  band: "cca" | "ccx";
  /** Did the pipeline get as far as a message at all. */
  decoded: boolean;
  /**
   * Do we actually recognize the message type. Set by the per-band adapter,
   * not inferred from the name: CCA labels an unrecognized packet with its
   * own type byte ("0x5F"), which reads like a real name.
   */
  identified: boolean;
  /** Message type as reported, or null when never decoded. */
  typeName: string | null;
  /** Unconsumed CBOR keys on the decoded message. */
  unknownKeys?: number;
}

export interface DecodeSummary {
  frames: number;
  /** Frames that produced a message — decrypt, framing and CBOR all held. */
  decoded: number;
  decodePct: number;
  /** Decoded frames whose type we actually recognize. */
  identified: number;
  /** Decoded, but the type means nothing to us yet. */
  unidentified: number;
  identifiedPct: number;
  unknownKeyTotal: number;
  framesWithUnknownKeys: number;
  byType: Record<string, number>;
}

/**
 * Aggregate decode depth over a capture.
 *
 * Three distinct failures, kept apart because they have different causes:
 * a frame we could not decode at all (crypto, framing), one we decoded but
 * cannot name (`UNKNOWN` type), and one we named but whose body still holds
 * keys we ignore. A refactor that quietly stops parsing a field moves the
 * third number without touching the first two.
 */
export function summarizeDecode(frames: DecodedFrame[]): DecodeSummary {
  const byType: Record<string, number> = {};
  let decoded = 0;
  let identified = 0;
  let unidentified = 0;
  let unknownKeyTotal = 0;
  let framesWithUnknownKeys = 0;

  for (const f of frames) {
    if (!f.decoded) continue;
    decoded++;

    if (f.typeName) byType[f.typeName] = (byType[f.typeName] ?? 0) + 1;
    if (f.identified) identified++;
    else unidentified++;

    if (f.unknownKeys) {
      unknownKeyTotal += f.unknownKeys;
      framesWithUnknownKeys++;
    }
  }

  return {
    frames: frames.length,
    decoded,
    decodePct: pct(decoded, frames.length),
    identified,
    unidentified,
    identifiedPct: pct(identified, frames.length),
    unknownKeyTotal,
    framesWithUnknownKeys,
    byType,
  };
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : (part / whole) * 100;
}
