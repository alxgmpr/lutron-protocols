#!/usr/bin/env bun
/**
 * RTL-SDR CCA Packet Decoder
 *
 * Demodulates 2-FSK from raw IQ captures and decodes Lutron CCA packets.
 * No dependency on rtl_433 - full custom demodulation pipeline.
 *
 * RF Parameters:
 *   Frequency: 433.602844 MHz
 *   Modulation: 2-FSK
 *   Data rate: 62.5 kBaud
 *   Deviation: ±41.2 kHz
 *
 * On-air framing:
 *   [Preamble 32 bits raw 0xAA][Sync 0xFF N81][Prefix 0xFA 0xDE N81][Payload N81][Trailing zeros]
 *
 * Pipeline: IQ → amplitude burst detect → FM discriminator → preamble correlation →
 *           clock/polarity lock → bit slice → sync detect → N81 decode → CRC verify
 *
 * Usage:
 *   # Capture 10 seconds of IQ at 1 MHz sample rate:
 *   rtl_sdr -f 433602844 -s 1000000 -n 10000000 capture.bin
 *
 *   # Decode packets:
 *   bun run tools/rtlsdr-cca-decode.ts capture.bin
 *
 *   # Live capture + decode:
 *   bun run tools/rtlsdr-cca-decode.ts --live [--duration 30]
 *
 *   # Debug mode (show signal details):
 *   bun run tools/rtlsdr-cca-decode.ts --debug capture.bin
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

// --- RF Constants ---
let SAMPLE_RATE = 2_000_000; // 2 MHz default (32 samples/bit for better clock recovery)
const DATA_RATE = 62_500; // 62.5 kBaud
let SAMPLES_PER_BIT = SAMPLE_RATE / DATA_RATE; // 32
const CCA_FREQ = 433_602_844;

function setSampleRate(rate: number) {
  SAMPLE_RATE = rate;
  SAMPLES_PER_BIT = SAMPLE_RATE / DATA_RATE;
}

// Burst detection: minimum amplitude increase over noise floor
const BURST_AMP_FACTOR = 1.5;
const BURST_WINDOW = 100; // samples per amplitude window
const MIN_BURST_BITS = 100; // minimum burst length in bits

// --- CRC-16 with poly 0xCA0F ---
const CRC_TABLE: number[] = [];
for (let i = 0; i < 256; i++) {
  let crc = i << 8;
  for (let j = 0; j < 8; j++) {
    crc = crc & 0x8000 ? ((crc << 1) ^ 0xca0f) & 0xffff : (crc << 1) & 0xffff;
  }
  CRC_TABLE.push(crc);
}

function calcCrc(data: number[]): number {
  let crc = 0;
  for (const byte of data) {
    const upper = (crc >> 8) & 0xff;
    crc = (((crc << 8) & 0xff00) + byte) ^ CRC_TABLE[upper];
  }
  return crc;
}

function findCrcBoundary(bytes: number[]): number | null {
  if (bytes.length < 10) return null;
  let crcReg = 0;
  for (let i = 0; i < Math.min(8, bytes.length); i++) {
    const upper = (crcReg >> 8) & 0xff;
    crcReg = (((crcReg << 8) & 0xff00) + bytes[i]) ^ CRC_TABLE[upper];
  }
  for (let len = 10; len <= bytes.length; len++) {
    const off = len - 2;
    const received = (bytes[off] << 8) | bytes[off + 1];
    if (crcReg === received) return len;
    if (len < bytes.length) {
      const b = bytes[len - 2];
      const upper = (crcReg >> 8) & 0xff;
      crcReg = (((crcReg << 8) & 0xff00) + b) ^ CRC_TABLE[upper];
    }
  }
  return null;
}

// --- Step 1: Amplitude-based burst detection ---
interface Burst {
  start: number; // sample index
  end: number;
  peakAmp: number;
}

function findBursts(iq: Uint8Array): Burst[] {
  const numSamples = Math.floor(iq.length / 2);
  const amplitudes: number[] = [];

  // Compute windowed RMS amplitude
  for (let i = 0; i < numSamples; i += BURST_WINDOW) {
    let sum = 0;
    const end = Math.min(i + BURST_WINDOW, numSamples);
    for (let j = i; j < end; j++) {
      const iv = iq[j * 2] - 127.5;
      const qv = iq[j * 2 + 1] - 127.5;
      sum += Math.sqrt(iv * iv + qv * qv);
    }
    amplitudes.push(sum / (end - i));
  }

  // Find noise floor (peak of amplitude histogram)
  const sorted = [...amplitudes].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.5)]; // median
  const threshold = noiseFloor * BURST_AMP_FACTOR;

  const bursts: Burst[] = [];
  let inBurst = false;
  let burstStart = 0;

  for (let i = 0; i < amplitudes.length; i++) {
    if (amplitudes[i] > threshold && !inBurst) {
      inBurst = true;
      burstStart = i;
    } else if (amplitudes[i] < threshold * 0.8 && inBurst) {
      inBurst = false;
      const startSample = burstStart * BURST_WINDOW;
      const endSample = i * BURST_WINDOW;
      const durationBits = (endSample - startSample) / SAMPLES_PER_BIT;
      if (durationBits >= MIN_BURST_BITS) {
        let peak = 0;
        for (let j = burstStart; j <= i && j < amplitudes.length; j++) {
          if (amplitudes[j] > peak) peak = amplitudes[j];
        }
        bursts.push({ start: startSample, end: endSample, peakAmp: peak });
      }
    }
  }

  return bursts;
}

// --- Step 2: FM discriminator for a burst region ---
function fmDiscriminateBurst(iq: Uint8Array, start: number, end: number): Float32Array {
  const margin = Math.round(SAMPLES_PER_BIT * 20); // generous margin for preamble + filter settling
  const s = Math.max(0, start - margin);
  const e = Math.min(Math.floor(iq.length / 2), end + margin);
  const len = e - s;

  const freq = new Float32Array(len - 1);
  let prevI = (iq[s * 2] - 127.5) / 127.5;
  let prevQ = (iq[s * 2 + 1] - 127.5) / 127.5;

  for (let n = 1; n < len; n++) {
    const idx = (s + n) * 2;
    const curI = (iq[idx] - 127.5) / 127.5;
    const curQ = (iq[idx + 1] - 127.5) / 127.5;
    const prodI = curI * prevI + curQ * prevQ;
    const prodQ = curQ * prevI - curI * prevQ;
    freq[n - 1] = Math.atan2(prodQ, prodI);
    prevI = curI;
    prevQ = curQ;
  }

  // Low-pass filter (moving average, ~0.5 bit width)
  const taps = Math.max(3, Math.round(SAMPLES_PER_BIT * 0.5));
  const filtered = new Float32Array(freq.length);
  const halfTaps = Math.floor(taps / 2);
  let sum = 0;
  for (let i = 0; i < taps && i < freq.length; i++) sum += freq[i];
  for (let i = 0; i < freq.length; i++) {
    filtered[i] = sum / taps;
    const ri = i - halfTaps;
    const ai = i + halfTaps + 1;
    if (ri >= 0) sum -= freq[ri];
    if (ai < freq.length) sum += freq[ai];
  }

  // Remove DC offset (critical for frequency-hopped retransmissions that are off-center)
  let dcSum = 0;
  for (let i = 0; i < filtered.length; i++) dcSum += filtered[i];
  const dc = dcSum / filtered.length;
  for (let i = 0; i < filtered.length; i++) filtered[i] -= dc;

  return filtered;
}

// --- Step 3: Preamble correlation to find clock phase and polarity ---
interface PreambleResult {
  bitOffset: number; // sample offset of the first bit center in the burst FM data
  inverted: boolean; // whether polarity is inverted
  threshold: number; // decision threshold
}

function findPreamble(fm: Float32Array): PreambleResult | null {
  // Generate reference preamble: alternating +1/-1 at SAMPLES_PER_BIT rate
  // 16 bits of alternating pattern
  const refLen = Math.round(16 * SAMPLES_PER_BIT);
  const ref = new Float32Array(refLen);
  for (let i = 0; i < refLen; i++) {
    const bitIdx = Math.floor(i / SAMPLES_PER_BIT);
    ref[i] = (bitIdx % 2 === 0) ? 1.0 : -1.0;
  }

  // Compute signal energy for normalization
  let sigEnergy = 0;
  for (let i = 0; i < fm.length; i++) sigEnergy += fm[i] * fm[i];
  const rmsLevel = Math.sqrt(sigEnergy / fm.length);

  // Cross-correlate with FM signal, keeping top candidates
  const candidates: { offset: number; corr: number }[] = [];
  const searchEnd = Math.min(fm.length - refLen, Math.round(100 * SAMPLES_PER_BIT));

  for (let n = 0; n < searchEnd; n++) {
    let corr = 0;
    for (let k = 0; k < refLen; k++) {
      corr += ref[k] * fm[n + k];
    }
    // Normalize by reference length and signal RMS
    const normCorr = corr / (refLen * Math.max(rmsLevel, 0.01));
    if (Math.abs(normCorr) > 0.15) {
      candidates.push({ offset: n, corr: normCorr });
      // Skip ahead to avoid duplicate peaks
      n += Math.round(SAMPLES_PER_BIT * 0.5);
    }
  }

  if (candidates.length === 0) return null;

  // Sort by absolute correlation strength
  candidates.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));

  // Try the best candidate(s) and validate
  for (const cand of candidates.slice(0, 3)) {
    const inverted = cand.corr < 0;
    const bitOffset = cand.offset + Math.round(SAMPLES_PER_BIT / 2);

    // Compute threshold from the preamble region
    let posSum = 0, posCount = 0, negSum = 0, negCount = 0;
    for (let i = cand.offset; i < cand.offset + refLen && i < fm.length; i++) {
      if (fm[i] > 0.01) { posSum += fm[i]; posCount++; }
      else if (fm[i] < -0.01) { negSum += fm[i]; negCount++; }
    }
    const threshold = (posCount > 0 && negCount > 0) ? (posSum / posCount + negSum / negCount) / 2 : 0;

    // Validate: sample bits and check for alternating pattern
    for (const tryInverted of [inverted, !inverted]) {
      let alternatingCount = 0;
      let totalChecked = 0;
      for (let i = 0; i < 16 && bitOffset + i * SAMPLES_PER_BIT < fm.length; i++) {
        const sampleIdx = Math.round(bitOffset + i * SAMPLES_PER_BIT);
        if (sampleIdx >= fm.length) break;
        let bit = fm[sampleIdx] > threshold ? 1 : 0;
        if (tryInverted) bit = 1 - bit;
        const expected = (i % 2 === 0) ? 1 : 0; // 0xAA starts with 1
        if (bit === expected) alternatingCount++;
        totalChecked++;
      }

      if (totalChecked >= 12 && alternatingCount >= totalChecked * 0.75) {
        return { bitOffset, inverted: tryInverted, threshold };
      }
    }
  }

  return null;
}

// --- Step 3b: Find ALL preambles in a burst (for multi-retransmission decoding) ---
function findAllPreambles(fm: Float32Array): PreambleResult[] {
  const results: PreambleResult[] = [];
  const refLen = Math.round(16 * SAMPLES_PER_BIT);
  const ref = new Float32Array(refLen);
  for (let i = 0; i < refLen; i++) {
    const bitIdx = Math.floor(i / SAMPLES_PER_BIT);
    ref[i] = (bitIdx % 2 === 0) ? 1.0 : -1.0;
  }

  let sigEnergy = 0;
  for (let i = 0; i < fm.length; i++) sigEnergy += fm[i] * fm[i];
  const rmsLevel = Math.sqrt(sigEnergy / fm.length);

  // Each CCA retransmission is ~600 bits; skip at least 500 bits after finding one
  const minRetxSpacing = Math.round(500 * SAMPLES_PER_BIT);
  // Coarse stride for scanning (half a bit period - fast but won't miss peaks)
  const stride = Math.max(1, Math.round(SAMPLES_PER_BIT * 0.5));
  const searchEnd = fm.length - refLen;

  for (let n = 0; n < searchEnd; n += stride) {
    let corr = 0;
    for (let k = 0; k < refLen; k++) {
      corr += ref[k] * fm[n + k];
    }
    const normCorr = corr / (refLen * Math.max(rmsLevel, 0.01));

    if (Math.abs(normCorr) <= 0.15) continue;

    // Refine: check neighboring samples for peak correlation
    let bestN = n;
    let bestCorr = normCorr;
    for (let dn = -stride; dn <= stride; dn++) {
      const nn = n + dn;
      if (nn < 0 || nn >= searchEnd) continue;
      let c = 0;
      for (let k = 0; k < refLen; k++) c += ref[k] * fm[nn + k];
      const nc = c / (refLen * Math.max(rmsLevel, 0.01));
      if (Math.abs(nc) > Math.abs(bestCorr)) {
        bestCorr = nc;
        bestN = nn;
      }
    }

    const inverted = bestCorr < 0;
    const bitOffset = bestN + Math.round(SAMPLES_PER_BIT / 2);

    // Compute local threshold from preamble region (handles per-retx DC offset)
    let posSum = 0, posCount = 0, negSum = 0, negCount = 0;
    for (let i = bestN; i < bestN + refLen && i < fm.length; i++) {
      if (fm[i] > 0.01) { posSum += fm[i]; posCount++; }
      else if (fm[i] < -0.01) { negSum += fm[i]; negCount++; }
    }
    const threshold = (posCount > 0 && negCount > 0)
      ? (posSum / posCount + negSum / negCount) / 2 : 0;

    // Validate: check for alternating preamble pattern
    let found = false;
    for (const tryInverted of [inverted, !inverted]) {
      let ok = 0, total = 0;
      for (let i = 0; i < 16 && bitOffset + i * SAMPLES_PER_BIT < fm.length; i++) {
        const idx = Math.round(bitOffset + i * SAMPLES_PER_BIT);
        if (idx >= fm.length) break;
        let bit = fm[idx] > threshold ? 1 : 0;
        if (tryInverted) bit = 1 - bit;
        if (bit === ((i % 2 === 0) ? 1 : 0)) ok++;
        total++;
      }
      if (total >= 12 && ok >= total * 0.75) {
        results.push({ bitOffset, inverted: tryInverted, threshold });
        found = true;
        break;
      }
    }

    if (found) {
      n += minRetxSpacing - stride; // skip past this retransmission
    }
    // If not found, normal stride continues
  }

  return results;
}

// --- Step 4: Bit slicing with locked clock ---
function sliceBitsLocked(fm: Float32Array, startSample: number, threshold: number, inverted: boolean): number[] {
  const bits: number[] = [];
  let pos = startSample;

  while (pos < fm.length - 1) {
    const idx = Math.round(pos);
    if (idx >= fm.length) break;

    let bit = fm[idx] > threshold ? 1 : 0;
    if (inverted) bit = 1 - bit;
    bits.push(bit);

    // Simple clock tracking: nudge toward transitions
    const earlyIdx = Math.round(pos - SAMPLES_PER_BIT * 0.25);
    const lateIdx = Math.round(pos + SAMPLES_PER_BIT * 0.25);
    if (earlyIdx >= 0 && lateIdx < fm.length) {
      const earlyDist = Math.abs(fm[earlyIdx] - threshold);
      const lateDist = Math.abs(fm[lateIdx] - threshold);
      // Small nudge toward the transition (where distance to threshold is small)
      const adjust = (earlyDist - lateDist) * 0.15;
      pos += SAMPLES_PER_BIT + adjust;
    } else {
      pos += SAMPLES_PER_BIT;
    }
  }

  return bits;
}

// --- Step 5: Find sync/prefix and extract N81 payload ---
interface PacketResult {
  bytes: number[];
  crcBoundary: number | null;
  preambleBits: number;
}

function extractPacket(bits: number[]): PacketResult | null {
  // On-air framing: [Preamble 0xAA...][Sync 0xFF N81][Prefix 0xFA 0xDE N81][Payload N81]
  // N81 0xFF = 0_11111111_1 (start=0, data LSB-first=all ones, stop=1)
  // N81 0xFA = 0_01011111_1 (start=0, data LSB-first=01011111, stop=1)
  // N81 0xDE = 0_01111011_1 (start=0, data LSB-first=01111011, stop=1)
  //
  // Full sync+prefix pattern (30 bits):
  // 0 11111111 1  0 01011111 1  0 01111011 1
  const syncPrefix = [0,1,1,1,1,1,1,1,1,1, 0,0,1,0,1,1,1,1,1,1, 0,0,1,1,1,1,0,1,1,1];

  // Search entire bitstream for the sync+prefix pattern (with error tolerance)
  let bestMatch = -1;
  let bestErrors = 999;
  const maxSearch = Math.min(bits.length - 30, 200);

  for (let pos = 0; pos < maxSearch; pos++) {
    let errors = 0;
    for (let j = 0; j < 30; j++) {
      if (bits[pos + j] !== syncPrefix[j]) {
        errors++;
        if (errors > 3) break; // early exit
      }
    }
    if (errors < bestErrors) {
      bestErrors = errors;
      bestMatch = pos;
    }
  }

  // Accept if at most 2 bit errors in the 30-bit sync+prefix
  if (bestMatch >= 0 && bestErrors <= 2) {
    const payloadStart = bestMatch + 30;
    const bytes = decodeN81(bits, payloadStart, 60);
    if (bytes.length >= 3) {
      const crcBoundary = findCrcBoundary(bytes);
      return { bytes, crcBoundary, preambleBits: bestMatch };
    }
  }

  // Fallback: scan for N81 0xFF sync only (no prefix check), then try decoding
  for (let pos = 0; pos < maxSearch; pos++) {
    if (bits[pos] !== 0) continue;
    // Check for 0xFF: start(0) + 8 ones + stop(1)
    let allOnes = true;
    for (let j = 1; j <= 8; j++) {
      if (bits[pos + j] !== 1) { allOnes = false; break; }
    }
    if (!allOnes) continue;
    if (pos + 9 < bits.length && bits[pos + 9] !== 1) continue;

    // Try decoding from after the 0xFF sync
    const afterSync = pos + 10;

    // Check if next bytes are 0xFA 0xDE
    const faByte = decodeN81Byte(bits, afterSync);
    if (faByte === 0xFA) {
      const deByte = decodeN81Byte(bits, afterSync + 10);
      if (deByte === 0xDE) {
        const bytes = decodeN81(bits, afterSync + 20, 60);
        if (bytes.length >= 3) {
          const crcBoundary = findCrcBoundary(bytes);
          return { bytes, crcBoundary, preambleBits: pos };
        }
      }
    }

    // Try decoding directly after sync (maybe prefix is corrupted)
    if (faByte !== null) {
      const testBytes = [faByte, ...decodeN81(bits, afterSync + 10, 59)];
      if (testBytes.length >= 5 && testBytes[0] >= 0x80) {
        const crcBoundary = findCrcBoundary(testBytes);
        if (crcBoundary) return { bytes: testBytes, crcBoundary, preambleBits: pos };
      }
    }
  }

  // Last resort: scan for any N81 byte that looks like a CCA type, verify with CRC
  for (let pos = 10; pos < Math.min(bits.length - 100, 250); pos++) {
    if (bits[pos] !== 0) continue;
    const bytes = decodeN81(bits, pos, 60);
    if (bytes.length < 10) continue;
    if (bytes[0] < 0x80 || bytes[0] > 0xDF) continue;
    const crcBoundary = findCrcBoundary(bytes);
    if (crcBoundary) return { bytes, crcBoundary, preambleBits: pos };
  }

  return null;
}

function decodeN81Byte(bits: number[], offset: number): number | null {
  if (offset + 10 > bits.length) return null;
  if (bits[offset] !== 0) return null; // start bit
  if (bits[offset + 9] !== 1) return null; // stop bit

  let byte = 0;
  for (let i = 0; i < 8; i++) {
    byte |= (bits[offset + 1 + i] & 1) << i;
  }
  return byte;
}

function decodeN81(bits: number[], startBit: number, maxBytes: number): number[] {
  const bytes: number[] = [];
  let pos = startBit;

  while (pos + 10 <= bits.length && bytes.length < maxBytes) {
    if (bits[pos] !== 0) {
      // Try to resync within 2 bits
      let found = false;
      for (let skip = 1; skip <= 2 && pos + skip + 10 <= bits.length; skip++) {
        if (bits[pos + skip] === 0) {
          pos += skip;
          found = true;
          break;
        }
      }
      if (!found) break;
    }

    let byte = 0;
    for (let i = 0; i < 8; i++) {
      byte |= (bits[pos + 1 + i] & 1) << i;
    }

    if (bits[pos + 9] !== 1) {
      // Bad stop bit - still record but flag
      bytes.push(byte);
      pos += 10;
      continue;
    }

    bytes.push(byte);
    pos += 10;
  }

  return bytes;
}

// --- Packet formatting ---
function hexByte(b: number): string {
  return b.toString(16).padStart(2, "0");
}

function getTypeName(type: number): string {
  const names: Record<number, string> = {
    0x88: "BTN_SHORT_A",
    0x89: "BTN_LONG_A",
    0x8a: "BTN_SHORT_B",
    0x8b: "BTN_LONG_B",
    0x8c: "STATE_RPT",
    0x8d: "RETX_8D",
    0x8e: "BTN_RELEASE",
    0x93: "BEACON_93",
    0x99: "RETX_99",
    0x9f: "RETX_9F",
    0xa5: "RETX_A5",
    0xa9: "CFG_A9",
    0xaa: "CFG_AA",
    0xab: "CFG_AB",
    0xb0: "PAIR_B0",
    0xb1: "PAIR_B1",
    0xb8: "VIVE_DEV_REQ",
    0xb9: "VIVE_ACCEPT",
    0xba: "VIVE_BEACON",
    0xbb: "VIVE_BB",
  };
  return names[type] || "0x" + hexByte(type);
}

function formatPacket(bytes: number[], crcBoundary: number | null): string {
  const hex = bytes.map(hexByte).join(" ");
  const type = bytes[0];
  const typeStr = getTypeName(type);
  const crcStatus = crcBoundary ? "CRC OK at " + crcBoundary : "NO CRC (" + bytes.length + " bytes)";
  return typeStr + " | " + crcStatus + " | " + hex;
}

// --- Main decode pipeline ---
function decodeIQ(iq: Uint8Array, debug: boolean) {
  const numSamples = Math.floor(iq.length / 2);
  const durationSec = numSamples / SAMPLE_RATE;

  console.log("Samples: " + numSamples.toLocaleString() + " (" + durationSec.toFixed(2) + "s)");

  // Step 1: Find signal bursts
  console.log("\nStep 1: Burst detection...");
  const bursts = findBursts(iq);
  console.log("  Bursts found: " + bursts.length);

  if (bursts.length === 0) {
    console.log("  No signal detected. Ensure the capture contains CCA transmissions.");
    return;
  }

  if (debug) {
    for (const b of bursts) {
      const t = (b.start / SAMPLE_RATE * 1000).toFixed(1);
      const dur = ((b.end - b.start) / SAMPLE_RATE * 1000).toFixed(1);
      console.log("    @ " + t + "ms  dur=" + dur + "ms  peak=" + b.peakAmp.toFixed(1));
    }
  }

  // Step 2-5: Decode each burst (processing ALL retransmissions per burst)
  console.log("\nStep 2: Demodulating bursts (multi-retransmission mode)...\n");
  console.log("=== DECODED PACKETS ===\n");

  let totalRetx = 0;
  let decoded = 0;
  let crcOk = 0;

  for (let bi = 0; bi < bursts.length; bi++) {
    const burst = bursts[bi];
    const burstTimeMs = (burst.start / SAMPLE_RATE * 1000).toFixed(1);

    // FM demodulate this burst
    const fm = fmDiscriminateBurst(iq, burst.start, burst.end);

    // Find ALL preambles in this burst (one per retransmission)
    const preambles = findAllPreambles(fm);

    if (preambles.length === 0) {
      // Fallback to single preamble search (for short/weak bursts)
      const single = findPreamble(fm);
      if (single) preambles.push(single);
    }

    if (preambles.length === 0) {
      if (debug) console.log("#" + bi + " @ " + burstTimeMs + "ms: no preamble detected");
      continue;
    }

    totalRetx += preambles.length;
    if (debug) {
      console.log("#" + bi + " @ " + burstTimeMs + "ms: " + preambles.length + " retransmissions found");
    }

    // Track unique CRC-valid packets for this burst (deduplicate retransmissions)
    const burstCrcPackets: Map<string, { bytes: number[]; crcBoundary: number; count: number }> = new Map();
    let burstDecoded = 0;
    let burstNoCrc: { bytes: number[] }[] = [];

    for (let ri = 0; ri < preambles.length; ri++) {
      const preamble = preambles[ri];

      if (debug) {
        console.log("  retx " + ri + ": sample " + preamble.bitOffset +
          " inv=" + preamble.inverted + " thresh=" + preamble.threshold.toFixed(4));
      }

      // Slice bits with locked clock
      const bits = sliceBitsLocked(fm, preamble.bitOffset, preamble.threshold, preamble.inverted);

      if (bits.length < 50) {
        if (debug) console.log("    Too few bits: " + bits.length);
        continue;
      }

      // Extract packet (find sync, prefix, decode N81)
      const packet = extractPacket(bits);

      if (!packet) {
        if (debug) console.log("    Could not extract packet from " + bits.length + " bits");
        continue;
      }

      burstDecoded++;
      decoded++;

      if (packet.crcBoundary) {
        crcOk++;
        const packetBytes = packet.bytes.slice(0, packet.crcBoundary);
        const key = packetBytes.map(hexByte).join(" ");
        const existing = burstCrcPackets.get(key);
        if (existing) {
          existing.count++;
        } else {
          burstCrcPackets.set(key, { bytes: packetBytes, crcBoundary: packet.crcBoundary, count: 1 });
        }
      } else {
        // Keep first few non-CRC packets for debug
        if (burstNoCrc.length < 2) {
          burstNoCrc.push({ bytes: packet.bytes });
        }
      }
    }

    // Output: show unique CRC-valid packets for this burst
    for (const [key, { bytes, crcBoundary, count }] of burstCrcPackets) {
      const type = bytes[0];
      const typeStr = getTypeName(type);
      const countStr = count > 1 ? " (" + count + "x)" : "";
      console.log("#" + bi + " @ " + burstTimeMs + "ms: " + typeStr + " | CRC OK at " +
        crcBoundary + countStr + " | " + key);
    }

    // If no CRC-valid packets, show first non-CRC decode
    if (burstCrcPackets.size === 0 && burstNoCrc.length > 0) {
      const p = burstNoCrc[0];
      console.log("#" + bi + " @ " + burstTimeMs + "ms: " +
        formatPacket(p.bytes, null) +
        " [" + burstDecoded + "/" + preambles.length + " decoded, 0 CRC]");
    } else if (burstCrcPackets.size === 0 && burstDecoded === 0) {
      if (debug) console.log("#" + bi + " @ " + burstTimeMs + "ms: " +
        preambles.length + " preambles but no packets decoded");
    }
  }

  console.log("\n--- Summary ---");
  console.log("  Bursts: " + bursts.length);
  console.log("  Retransmissions found: " + totalRetx);
  console.log("  Decoded: " + decoded);
  console.log("  CRC OK: " + crcOk);
}

// --- Live capture ---
async function captureLive(durationSec: number, debug: boolean) {
  const numSamples = SAMPLE_RATE * durationSec;
  const tmpFile = "/tmp/rtl_cca_" + Date.now() + ".bin";

  console.log("Capturing " + durationSec + "s of IQ @ 1 MHz...");
  console.log("Frequency: " + (CCA_FREQ / 1e6).toFixed(6) + " MHz");
  console.log("Output: " + tmpFile);
  console.log("");

  try {
    execSync(
      "rtl_sdr -f " + CCA_FREQ + " -s " + SAMPLE_RATE + " -n " + numSamples + " " + tmpFile,
      { stdio: "inherit", timeout: (durationSec + 5) * 1000 }
    );
  } catch {
    if (!existsSync(tmpFile)) {
      console.error("Capture failed.");
      process.exit(1);
    }
  }

  console.log("\nDecoding...\n");
  const iq = new Uint8Array(readFileSync(tmpFile));
  decodeIQ(iq, debug);
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");

  // Parse --rate option
  const rateIdx = args.indexOf("--rate");
  if (rateIdx >= 0 && args[rateIdx + 1]) {
    setSampleRate(parseInt(args[rateIdx + 1]));
  }

  const filteredArgs = args.filter((a, i) =>
    a !== "--debug" && a !== "--rate" && (i === 0 || args[i - 1] !== "--rate")
  );

  if (filteredArgs[0] === "--live") {
    const durIdx = filteredArgs.indexOf("--duration");
    const duration = durIdx >= 0 ? parseInt(filteredArgs[durIdx + 1]) || 10 : 10;
    await captureLive(duration, debug);
    return;
  }

  if (filteredArgs.length === 0 || filteredArgs[0] === "--help") {
    console.log("RTL-SDR CCA Packet Decoder");
    console.log("");
    console.log("Usage:");
    console.log("  bun run tools/rtlsdr-cca-decode.ts <capture.bin>              Decode from file");
    console.log("  bun run tools/rtlsdr-cca-decode.ts --live [--duration N]      Live capture");
    console.log("  bun run tools/rtlsdr-cca-decode.ts --debug <capture.bin>      Debug mode");
    console.log("  bun run tools/rtlsdr-cca-decode.ts --rate 1000000 <file.bin>  Set sample rate");
    console.log("");
    console.log("Capture (always use 2 MHz):");
    console.log("  rtl_sdr -f 433602844 -s 2000000 -g 40 capture.bin      # until ctrl-c");
    console.log("  rtl_sdr -f 433602844 -s 2000000 -g 40 -n 20000000 c.bin  # 10 seconds");
    process.exit(0);
  }

  const filename = filteredArgs[0];
  if (!existsSync(filename)) {
    console.error("File not found: " + filename);
    process.exit(1);
  }

  console.log("Reading " + filename + "...");
  console.log("Sample rate: " + (SAMPLE_RATE / 1e6).toFixed(1) + " MHz (" + SAMPLES_PER_BIT + " samples/bit)");
  const iq = new Uint8Array(readFileSync(filename));
  decodeIQ(iq, debug);
}

main().catch(console.error);
