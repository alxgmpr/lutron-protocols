/**
 * CCA Firmware-OTA RF demodulator — IQ samples → bits.
 *
 * Pairs with `lib/cca-ota-codec.ts` (which handles bytes/bits → packets).
 * RF parameters per `docs/protocols/cca.md` §9.2 + the 2026-04-28 live capture:
 *
 *   Modulation : GFSK
 *   Data rate  : ~62.5 kbps (empirically: peak-to-peak in 1010 preamble = 31µs
 *                = 2 bits, NOT the 30.49 kbps the static-RE register decode
 *                claimed; runtime CCA's data rate is reused on a different
 *                channel/modulation)
 *   Deviation  : ~38 kHz (CC1101 register math gives ~38 kHz, observed ±48 kHz
 *                10/90 percentiles consistent with that)
 *   BW         : ~80 kHz (matches MDMCFG4 = 0x9C → ~162 kHz channel BW)
 *   Center     : ~433.566 MHz (single channel; offset −36 kHz from runtime CCA)
 *
 * IQ representation in this module: a flat `Float32Array` of interleaved
 * I/Q pairs `[I0, Q0, I1, Q1, …]`. This matches what an FFT/DSP pipeline
 * naturally produces and lets us index `2*n` / `2*n+1` for sample n.
 *
 * The rtl_sdr `.bin` file format is a `Uint8Array` of interleaved I/Q at
 * 0..255 centered on 127.5; conversion is in this module's helpers.
 *
 * Status: synth → demod round-trip passes 13 tests on synthesized signals.
 * Real-capture decode produces recognizable preamble + 0xFF sync delimiter
 * but accumulates bit errors that prevent full FA-DE-aligned packet recovery
 * — needs symbol synchronization (clock recovery from preamble) which isn't
 * implemented yet. See `docs/firmware-re/cca-ota-live-capture.md`.
 */

/**
 * Convert an rtl_sdr-format uint8 IQ buffer to a Float32Array of complex
 * samples (interleaved I/Q). rtl_sdr writes bytes centered on 127.5.
 */
export function complexFromUint8(raw: Uint8Array): Float32Array {
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] - 127.5;
  return out;
}

/**
 * Inverse of `complexFromUint8`. Clamps to [0, 255]. Round-trip is lossy
 * by ±1 LSB because 127.5 isn't representable in uint8.
 */
export function uint8FromComplex(iq: Float32Array): Uint8Array {
  const out = new Uint8Array(iq.length);
  for (let i = 0; i < iq.length; i++) {
    const v = Math.round(iq[i] + 127.5);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

export interface FskParams {
  /** IQ sample rate in Hz */
  sampleRateHz: number;
  /** Bit rate in Hz (e.g. ~62_500 for OTA, empirically) */
  dataRateHz: number;
  /** Frequency deviation in Hz (e.g. ~38_000 for OTA) */
  deviationHz: number;
}

/**
 * Synthesize a continuous-phase 2-FSK signal from a bit array. Used for
 * round-trip testing the demod (and as a building block for any future
 * TX builder).
 *
 * Bits map to instantaneous frequency:
 *   bit=1 → +deviationHz, bit=0 → −deviationHz
 *
 * Phase is integrated continuously across bit transitions (CPFSK), giving
 * constant amplitude |z[n]| = 1. No Gaussian filtering — first-iteration
 * synth for testing only. Real OTA uses GFSK; the demod must handle both.
 */
export function synthesizeFsk(
  bits: Uint8Array,
  params: FskParams,
): Float32Array {
  const { sampleRateHz, dataRateHz, deviationHz } = params;
  const samplesPerBit = sampleRateHz / dataRateHz;
  const totalSamples = Math.round(bits.length * samplesPerBit);
  const out = new Float32Array(totalSamples * 2);
  const phaseStepPos = (2 * Math.PI * deviationHz) / sampleRateHz;
  const phaseStepNeg = -phaseStepPos;
  let phase = 0;
  for (let n = 0; n < totalSamples; n++) {
    const bitIdx = Math.min(bits.length - 1, Math.floor(n / samplesPerBit));
    phase += bits[bitIdx] ? phaseStepPos : phaseStepNeg;
    out[2 * n] = Math.cos(phase);
    out[2 * n + 1] = Math.sin(phase);
  }
  return out;
}

/**
 * Demodulate a 2-FSK / GFSK signal back to bits.
 *
 * Pipeline:
 *   1. Compute instantaneous frequency
 *   2. For each bit period, AVERAGE the freq samples over the middle 50%
 *      of the bit (skipping transition smear at edges) — this is a poor-
 *      man's matched filter that's robust to small clock drift and noise.
 *   3. Slice: avg > 0 → bit 1, avg ≤ 0 → bit 0
 *
 * No symbol synchronization yet — assumes bit boundaries align with sample 0.
 * The codec layer (`findBitSync`) handles byte-level alignment to the FA DE
 * sync word, so a small alignment offset at the bit level is corrected
 * downstream.
 *
 * Returns one bit per element (Uint8Array of 0/1) — same format as
 * `bytesToBits` in `cca-ota-codec.ts`.
 */
export function demodulateFsk(iq: Float32Array, params: FskParams): Uint8Array {
  const freq = instantaneousFrequency(iq, params.sampleRateHz);
  const samplesPerBit = params.sampleRateHz / params.dataRateHz;
  const maxBits = Math.floor(freq.length / samplesPerBit);
  const out = new Uint8Array(maxBits);
  // Average the middle 50% of each bit's samples — skip 25% on each side
  // where transition smear can be large.
  const windowStart = samplesPerBit * 0.25;
  const windowEnd = samplesPerBit * 0.75;
  for (let k = 0; k < maxBits; k++) {
    const bitStartSample = k * samplesPerBit;
    const lo = Math.floor(bitStartSample + windowStart);
    const hi = Math.min(freq.length, Math.floor(bitStartSample + windowEnd));
    let sum = 0;
    let n = 0;
    for (let i = lo; i < hi; i++) {
      sum += freq[i];
      n++;
    }
    out[k] = n > 0 && sum / n > 0 ? 1 : 0;
  }
  return out;
}

/**
 * Recover the bit-clock phase from an instantaneous-frequency array containing
 * an alternating preamble (`0x55…` LSB-first = `1010…`). Returns the sample
 * offset within `[0, samplesPerBit)` where the next clean bit boundary lies.
 *
 * Algorithm: slide an alternating ±1 reference (period = 2 bits) past `freq`
 * at sub-sample resolution. For each candidate phase φ, sum
 *   Σ_k (-1)^k · freq[round(φ + (k+0.5)·spb)]
 * over the first `preambleBits` bit periods. Return the φ that maximizes the
 * absolute score. The polarity sign is implicit in `score`'s sign — `findBitSync`
 * absorbs a 1-bit cursor shift, so the demod doesn't need to act on it directly.
 *
 * Caller must pre-scope `freq` to start at-or-near the preamble (no leading
 * silence). For multi-burst captures, run an upstream burst detector and pass
 * each burst's freq slice in.
 */
export function recoverBitPhase(
  freq: Float32Array,
  params: FskParams,
  opts: { preambleBits?: number; phiStep?: number } = {},
): number {
  const preambleBits = opts.preambleBits ?? 20;
  const phiStep = opts.phiStep ?? 0.25;
  const spb = params.sampleRateHz / params.dataRateHz;
  const halfSpb = 0.5 * spb;
  let bestPhi = 0;
  let bestAbs = -Infinity;
  for (let phi = 0; phi < spb; phi += phiStep) {
    let score = 0;
    let counted = 0;
    for (let k = 0; k < preambleBits; k++) {
      const idx = Math.round(phi + halfSpb + k * spb);
      if (idx < 0 || idx >= freq.length) break;
      score += (k % 2 === 0 ? 1 : -1) * freq[idx];
      counted++;
    }
    if (counted < 4) break;
    const absScore = Math.abs(score);
    if (absScore > bestAbs) {
      bestAbs = absScore;
      bestPhi = phi;
    }
  }
  return bestPhi;
}

/**
 * Like `demodulateFsk`, but recovers bit-clock phase from the preamble first
 * via `recoverBitPhase`. Bit boundaries are tracked at fractional-sample
 * resolution — the matched-filter window for bit k spans
 *   `[ φ + k·spb + 0.25·spb,  φ + k·spb + 0.75·spb )`
 * with `Math.floor()` on each side to land on integer freq indices.
 *
 * Suitable for real captures where the burst starts mid-bit and `demodulateFsk`'s
 * implicit phi=0 assumption would smear bit decisions across boundaries.
 *
 * Real captures often have a per-burst carrier offset (the SDR isn't tuned
 * exactly on the OTA carrier). The median of the burst's freq array sits at
 * that offset for a balanced FSK signal — we use it as the slicing threshold,
 * which lets the demod tolerate a couple-kHz tuning error without bias.
 * Pass `opts.removeDc=false` to slice at zero (clean synth signals already
 * sit on DC). Caller can override the threshold via `opts.thresholdHz`.
 *
 * Polarity is not corrected here — if the FSK convention is inverted (e.g., a
 * receiver that flips IQ), the caller bit-flips the output before running it
 * through `extractPacketsFromBits`.
 */
export function demodulateFskWithSync(
  iq: Float32Array,
  params: FskParams,
  opts: { removeDc?: boolean; thresholdHz?: number } = {},
): Uint8Array {
  const removeDc = opts.removeDc ?? true;
  const freq = instantaneousFrequency(iq, params.sampleRateHz);
  const spb = params.sampleRateHz / params.dataRateHz;
  const phi = recoverBitPhase(freq, params);
  let threshold = opts.thresholdHz ?? 0;
  if (opts.thresholdHz === undefined && removeDc && freq.length > 0) {
    // Median is the best estimate of carrier offset for balanced FSK.
    const sorted = Float32Array.from(freq);
    sorted.sort();
    threshold = sorted[Math.floor(sorted.length / 2)];
  }
  const winLo = 0.25 * spb;
  const winHi = 0.75 * spb;
  const maxBits = Math.max(0, Math.floor((freq.length - phi) / spb));
  const out = new Uint8Array(maxBits);
  for (let k = 0; k < maxBits; k++) {
    const bitStart = phi + k * spb;
    const lo = Math.floor(bitStart + winLo);
    const hi = Math.min(freq.length, Math.floor(bitStart + winHi));
    let sum = 0;
    let n = 0;
    for (let i = lo; i < hi; i++) {
      sum += freq[i];
      n++;
    }
    out[k] = n > 0 && sum / n > threshold ? 1 : 0;
  }
  return out;
}

/**
 * Locate a known bit pattern in an instantaneous-frequency array via sliding
 * cross-correlation. The pattern is sample-expanded to ±1 (each bit lasts
 * `samplesPerBit` samples), then made zero-mean and convolved against `freq`.
 * Zero-mean reference is a matched filter: any DC offset in `freq` is
 * automatically rejected (Σ zero_mean_ref · constant = 0), so per-burst
 * carrier offset doesn't bias the peak location.
 *
 * Returns the sample offset where the FIRST bit of the pattern starts. The
 * `polarity` field is `1` when the sliced bits will match `pattern` directly,
 * `-1` when the receiver inverted the FSK sense (caller bit-flips). Returns
 * `null` when the correlation peak's |score| / RMS is below `opts.minSnr`.
 *
 * Use this to anchor packet decoding on a transition-rich sync word (e.g.
 * `FA DE`), bypassing the bit-clock drift that accumulates through long
 * constant regions like the 8-bit `0xFF` sync delimiter.
 */
export function findSyncOffset(
  freq: Float32Array,
  pattern: Uint8Array,
  params: FskParams,
  opts: { minSnr?: number } = {},
): { sampleOffset: number; correlation: number; polarity: 1 | -1 } | null {
  if (pattern.length === 0 || freq.length === 0) return null;
  const minSnr = opts.minSnr ?? 5;
  const spb = params.sampleRateHz / params.dataRateHz;
  const refLen = Math.round(pattern.length * spb);
  if (refLen > freq.length) return null;
  const ref = new Float32Array(refLen);
  for (let i = 0; i < refLen; i++) {
    const k = Math.floor(i / spb);
    ref[i] = pattern[k] === 1 ? 1 : -1;
  }
  // Zero-mean the reference — this kills any DC component in freq automatically.
  let refMean = 0;
  for (let i = 0; i < refLen; i++) refMean += ref[i];
  refMean /= refLen;
  for (let i = 0; i < refLen; i++) ref[i] -= refMean;
  // Compute RMS of freq's *deviation from its mean* — this is the meaningful
  // signal energy. A pure-DC freq has zero "interesting" energy and we
  // shouldn't return a sync-found result.
  let freqMean = 0;
  for (let i = 0; i < freq.length; i++) freqMean += freq[i];
  freqMean /= freq.length;
  let energy = 0;
  for (let i = 0; i < freq.length; i++) {
    const d = freq[i] - freqMean;
    energy += d * d;
  }
  const rms = Math.sqrt(energy / freq.length);
  if (rms === 0) return null;
  let bestAbs = -Infinity;
  let bestOff = -1;
  let bestCorr = 0;
  for (let n = 0; n + refLen <= freq.length; n++) {
    let c = 0;
    for (let k = 0; k < refLen; k++) c += ref[k] * freq[n + k];
    const ac = Math.abs(c);
    if (ac > bestAbs) {
      bestAbs = ac;
      bestOff = n;
      bestCorr = c;
    }
  }
  const snr = bestAbs / (rms * Math.sqrt(refLen));
  if (snr < minSnr) return null;
  return {
    sampleOffset: bestOff,
    correlation: bestCorr,
    polarity: bestCorr >= 0 ? 1 : -1,
  };
}

/**
 * Locate every sample offset in `freq` where the matched-filter demodulation
 * of `numBits` bits (using `pattern.length` bits of `pattern`) lies within
 * `maxHamming` bit errors of `pattern` (or its complement). Returns one
 * candidate per offset where the criterion is met. The polarity field is
 * `1` for direct match, `-1` for inverted.
 *
 * Designed to bypass false positives from cross-correlation in alternating-
 * rich signals: by computing the actual demodulated bits at each candidate
 * offset and comparing exactly, partial-pattern matches in preamble or N81
 * runtime traffic are rejected. The cost is O(N · samplesPerBit) per burst
 * (5000 × 40 ≈ 200k ops at 2.56 MHz / 62.5 kbps — trivially fast).
 *
 * The threshold for slicing defaults to the median of `freq` (per-burst DC).
 */
export function findPatternOffsets(
  freq: Float32Array,
  pattern: Uint8Array,
  params: FskParams,
  opts: { maxHamming?: number; thresholdHz?: number } = {},
): { sampleOffset: number; polarity: 1 | -1 }[] {
  if (pattern.length === 0 || freq.length === 0) return [];
  const maxHamming = opts.maxHamming ?? 1;
  const spb = params.sampleRateHz / params.dataRateHz;
  const refLen = Math.ceil(pattern.length * spb);
  if (refLen > freq.length) return [];
  let threshold = opts.thresholdHz ?? 0;
  if (opts.thresholdHz === undefined) {
    const sorted = Float32Array.from(freq);
    sorted.sort();
    threshold = sorted[Math.floor(sorted.length / 2)];
  }
  const winLo = 0.25 * spb;
  const winHi = 0.75 * spb;
  const results: { sampleOffset: number; polarity: 1 | -1 }[] = [];
  const lastSample = freq.length - refLen;
  for (let s = 0; s <= lastSample; s++) {
    let hamPos = 0;
    let hamNeg = 0;
    let earlyOut = false;
    for (let k = 0; k < pattern.length; k++) {
      const bitStart = s + k * spb;
      const lo = Math.floor(bitStart + winLo);
      const hi = Math.min(freq.length, Math.floor(bitStart + winHi));
      let sum = 0;
      let n = 0;
      for (let i = lo; i < hi; i++) {
        sum += freq[i];
        n++;
      }
      const bit = n > 0 && sum / n > threshold ? 1 : 0;
      if (bit !== pattern[k]) hamPos++;
      if (bit !== 1 - pattern[k]) hamNeg++;
      // Early termination — if both Hammings exceed maxHamming, this offset
      // can't be a match for either polarity.
      if (hamPos > maxHamming && hamNeg > maxHamming) {
        earlyOut = true;
        break;
      }
    }
    if (earlyOut) continue;
    if (hamPos <= maxHamming) {
      results.push({ sampleOffset: s, polarity: 1 });
    } else if (hamNeg <= maxHamming) {
      results.push({ sampleOffset: s, polarity: -1 });
    }
  }
  return results;
}

/**
 * Demodulate `numBits` bits from `iq` starting at `startSample`, using a fixed
 * bit clock (no phase recovery — the caller anchors the start sample, e.g. via
 * `findSyncOffset`). Bit k spans samples `[startSample + k·spb, +(k+1)·spb)`,
 * with a matched-filter average over the middle 50%.
 *
 * Use this when bit-clock drift through a long constant region would mis-align
 * a preamble-recovered phi: the sync correlation gives a transition-anchored
 * sample offset that this function consumes directly.
 *
 * The slicing threshold defaults to the median of the burst's freq array
 * (per-burst DC offset removal). Pass `opts.thresholdHz` to override.
 */
export function demodulateFskFromSample(
  iq: Float32Array,
  params: FskParams,
  startSample: number,
  numBits: number,
  opts: { thresholdHz?: number } = {},
): Uint8Array {
  const freq = instantaneousFrequency(iq, params.sampleRateHz);
  const spb = params.sampleRateHz / params.dataRateHz;
  let threshold = opts.thresholdHz ?? 0;
  if (opts.thresholdHz === undefined && freq.length > 0) {
    const sorted = Float32Array.from(freq);
    sorted.sort();
    threshold = sorted[Math.floor(sorted.length / 2)];
  }
  const winLo = 0.25 * spb;
  const winHi = 0.75 * spb;
  const out = new Uint8Array(numBits);
  for (let k = 0; k < numBits; k++) {
    const bitStart = startSample + k * spb;
    const lo = Math.max(0, Math.floor(bitStart + winLo));
    const hi = Math.min(freq.length, Math.floor(bitStart + winHi));
    let sum = 0;
    let n = 0;
    for (let i = lo; i < hi; i++) {
      sum += freq[i];
      n++;
    }
    out[k] = n > 0 && sum / n > threshold ? 1 : 0;
  }
  return out;
}

/**
 * Frequency-shift (mix) a complex IQ stream by `freqShiftHz`.
 *
 *   y[n] = x[n] * exp(j * 2π * freqShiftHz * n / sampleRate)
 *
 * Use a NEGATIVE shift to move a tone at +f_carrier down to DC (e.g.
 * `mix(iq, -36_000, fs)` shifts the OTA carrier from −36 kHz offset to DC).
 */
export function mix(
  iq: Float32Array,
  freqShiftHz: number,
  sampleRateHz: number,
): Float32Array {
  const nSamples = iq.length / 2;
  const out = new Float32Array(iq.length);
  const omega = (2 * Math.PI * freqShiftHz) / sampleRateHz;
  for (let n = 0; n < nSamples; n++) {
    const c = Math.cos(omega * n);
    const s = Math.sin(omega * n);
    const i = iq[2 * n];
    const q = iq[2 * n + 1];
    // (i + jq) * (c + js) = (ic - qs) + j(is + qc)
    out[2 * n] = i * c - q * s;
    out[2 * n + 1] = i * s + q * c;
  }
  return out;
}

/**
 * Compute instantaneous frequency (Hz) sample-by-sample from a complex
 * IQ stream using the phase-difference discriminator.
 *
 * For each pair (z[n-1], z[n]):
 *   f[n-1] = atan2( Im(z[n] * conj(z[n-1])), Re(z[n] * conj(z[n-1])) )
 *            × sampleRate / (2π)
 *
 * Output length is `len(iq)/2 - 1` (we lose one sample to the diff).
 * Robust to amplitude — the conjugate product cancels |z|² magnitude.
 */
export function instantaneousFrequency(
  iq: Float32Array,
  sampleRateHz: number,
): Float32Array {
  const nSamples = iq.length / 2;
  if (nSamples < 2) return new Float32Array(0);
  const out = new Float32Array(nSamples - 1);
  const k = sampleRateHz / (2 * Math.PI);
  for (let n = 1; n < nSamples; n++) {
    const i0 = iq[2 * (n - 1)];
    const q0 = iq[2 * (n - 1) + 1];
    const i1 = iq[2 * n];
    const q1 = iq[2 * n + 1];
    // z[n] * conj(z[n-1]) = (i1+jq1)(i0-jq0) = (i1*i0 + q1*q0) + j(q1*i0 - i1*q0)
    const re = i1 * i0 + q1 * q0;
    const im = q1 * i0 - i1 * q0;
    out[n - 1] = Math.atan2(im, re) * k;
  }
  return out;
}
