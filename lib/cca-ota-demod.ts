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
