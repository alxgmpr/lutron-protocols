#!/usr/bin/env npx tsx

/**
 * RTL-SDR CCA Firmware-OTA Decoder
 *
 * Decodes Lutron CCA OTA traffic from a raw rtl_sdr IQ capture. Pairs with
 * `lib/cca-ota-codec.ts` (byte-level framing) and `lib/cca-ota-demod.ts`
 * (DSP, bit-clock recovery).
 *
 * RF parameters per docs/firmware-re/cca-ota-live-capture.md:
 *   Carrier   : ~433.566 MHz (single channel; 36 kHz below runtime CCA)
 *   Modulation: GFSK (handled as 2-FSK in demod — close enough for decode)
 *   Data rate : ~62.5 kbps (empirical)
 *   Deviation : ~38 kHz
 *
 * Pipeline:
 *   uint8 IQ → complex → mix to DC → burst detection → per-burst symbol-sync
 *   demodulation → byte alignment via FA DE → CRC-checked packet extraction.
 *
 * Usage:
 *   npx tsx tools/cca/rtlsdr-ota-decode.ts \
 *     --rate 2560000 --mix 36500 \
 *     --start-sec 35 --duration-sec 10 \
 *     data/captures/cca-ota-20260428-190439.rf.bin
 *
 *   # Process the entire file in chunks (slower):
 *   npx tsx tools/cca/rtlsdr-ota-decode.ts --rate 2560000 --mix 36500 capture.bin
 *
 *   # Show 0x41 (TransferData) too — by default they're collapsed to a count:
 *   npx tsx tools/cca/rtlsdr-ota-decode.ts ... --show-transfer
 */

import { closeSync, openSync, readSync, statSync } from "fs";
import {
  bytesToBits,
  extractPacketsFromBits,
  type OtaExtracted,
  SYNC_WORD,
} from "../../lib/cca-ota-codec";
import {
  complexFromUint8,
  demodulateFskFromSample,
  findPatternOffsets,
  instantaneousFrequency,
  mix,
} from "../../lib/cca-ota-demod";

const DATA_RATE_HZ = 62_500;
const DEVIATION_HZ = 38_000;
const DEFAULT_RATE_HZ = 2_560_000;
const DEFAULT_MIX_HZ = 36_500;
// Cap a single chunk read at 256 MB to keep the JS heap manageable.
const CHUNK_BYTES_MAX = 256 * 1024 * 1024;
// Burst detection: 100-sample windows, threshold = 1.6× noise floor median,
// minimum 60 bits (~1 ms at 62.5 kbps) — short enough to grab even
// QueryDevice (5-byte body = ~110 bits) but long enough to filter glitches.
const BURST_WIN = 100;
const BURST_THRESH_MULT = 1.6;
const BURST_MIN_BITS = 60;

interface Args {
  file: string;
  sampleRateHz: number;
  mixHz: number;
  startSec: number;
  durationSec: number | null;
  showTransfer: boolean;
  debug: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(name);
  const positional = argv.filter((a, i) => {
    if (a.startsWith("--")) return false;
    const prev = argv[i - 1];
    return !(
      prev === "--rate" ||
      prev === "--mix" ||
      prev === "--start-sec" ||
      prev === "--duration-sec"
    );
  });
  if (positional.length !== 1 || has("--help")) {
    console.error(
      "Usage: rtlsdr-ota-decode.ts [--rate N] [--mix N] [--start-sec N] [--duration-sec N] [--show-transfer] [--debug] <file.bin>",
    );
    process.exit(1);
  }
  return {
    file: positional[0],
    sampleRateHz: Number(get("--rate") ?? DEFAULT_RATE_HZ),
    mixHz: Number(get("--mix") ?? DEFAULT_MIX_HZ),
    startSec: Number(get("--start-sec") ?? 0),
    durationSec: get("--duration-sec") ? Number(get("--duration-sec")) : null,
    showTransfer: has("--show-transfer"),
    debug: has("--debug"),
  };
}

interface Burst {
  startSample: number;
  endSample: number;
  peakRms: number;
}

/**
 * Amplitude-based burst detection on a complex IQ stream. Computes mean RMS
 * over fixed-size sample windows, sets threshold above the noise-floor median,
 * groups contiguous above-threshold windows into bursts, drops anything
 * shorter than `BURST_MIN_BITS` bit periods.
 *
 * Returns burst sample bounds in the input IQ — the caller slices and demodulates.
 */
function findBursts(iq: Float32Array, samplesPerBit: number): Burst[] {
  const nSamples = iq.length / 2;
  const ampWindows: number[] = [];
  for (let s = 0; s < nSamples; s += BURST_WIN) {
    let sum = 0;
    const end = Math.min(s + BURST_WIN, nSamples);
    for (let i = s; i < end; i++) {
      const ii = iq[2 * i];
      const qq = iq[2 * i + 1];
      sum += Math.sqrt(ii * ii + qq * qq);
    }
    ampWindows.push(sum / (end - s));
  }
  if (ampWindows.length === 0) return [];
  const sorted = [...ampWindows].sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.5)];
  const threshold = Math.max(noise * BURST_THRESH_MULT, 1);
  const bursts: Burst[] = [];
  let inBurst = false;
  let burstStart = 0;
  let peak = 0;
  for (let i = 0; i < ampWindows.length; i++) {
    const a = ampWindows[i];
    if (a > threshold && !inBurst) {
      inBurst = true;
      burstStart = i;
      peak = a;
    } else if (inBurst) {
      if (a > peak) peak = a;
      if (a < threshold * 0.7) {
        inBurst = false;
        const startSample = burstStart * BURST_WIN;
        const endSample = Math.min(i * BURST_WIN, nSamples);
        const durBits = (endSample - startSample) / samplesPerBit;
        if (durBits >= BURST_MIN_BITS) {
          bursts.push({ startSample, endSample, peakRms: peak });
        }
      }
    }
  }
  // Tail-end burst that ran into EOF
  if (inBurst) {
    const startSample = burstStart * BURST_WIN;
    const endSample = nSamples;
    const durBits = (endSample - startSample) / samplesPerBit;
    if (durBits >= BURST_MIN_BITS) {
      bursts.push({ startSample, endSample, peakRms: peak });
    }
  }
  return bursts;
}

interface DecodeStats {
  burstCount: number;
  packetCount: number;
  opcodeCounts: Map<number, number>;
  op32Body0: Map<number, number>;
}

const OPCODE_NAMES: Record<number, string> = {
  0x2a: "BeginTransfer",
  0x32: "Control",
  0x36: "CodeRevision",
  0x41: "TransferData",
  0x58: "QueryDevice",
};

function opcodeName(op: number): string {
  return OPCODE_NAMES[op] ?? `0x${op.toString(16).padStart(2, "0")}`;
}

function fmtHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

function formatPacket(p: OtaExtracted, tMs: number): string {
  return `@${tMs.toFixed(1)}ms op=0x${p.opcode.toString(16).padStart(2, "0")} ${opcodeName(p.opcode).padEnd(13)} len=${p.body.length} body=[${fmtHex(p.body)}]`;
}

// FA DE bit pattern (LSB-first), pre-computed for the per-burst sync search.
const FADE_PATTERN = bytesToBits(new Uint8Array([SYNC_WORD[0], SYNC_WORD[1]]));
// Maximum bits a packet can occupy: FA DE (16) + LEN (8) + max-len OP+BODY+CRC.
// LEN is u8 → max body 254 + OP(1) + CRC(2) = 257 bytes from LEN onward.
// Total: 2 (sync) + 1 (LEN) + 257 = 260 bytes = 2080 bits.
const MAX_PACKET_BITS = 2080;

/**
 * Demodulate one burst by brute-force scanning every sample offset for an
 * EXACT FA DE bit-level match (with up to 1 bit of Hamming tolerance for
 * RX noise). Cross-correlation in alternating-rich signals (preamble +
 * runtime CCA's N81-encoded `0x55` traffic) yields false-positive peaks; the
 * brute-force scan only accepts offsets that demodulate to a recognizable
 * FA DE pattern. For each candidate, we demod forward and parse — CRC-valid
 * packets are returned.
 *
 * Cost: O(N · samplesPerBit) per burst (~200k ops at 2.56 MHz / 62.5 kbps).
 */
function demodBurst(
  burstIq: Float32Array,
  sampleRateHz: number,
): OtaExtracted[] {
  const params = {
    sampleRateHz,
    dataRateHz: DATA_RATE_HZ,
    deviationHz: DEVIATION_HZ,
  };
  const spb = sampleRateHz / DATA_RATE_HZ;
  const freq = instantaneousFrequency(burstIq, sampleRateHz);
  const candidates = findPatternOffsets(freq, FADE_PATTERN, params);
  const found = new Map<string, OtaExtracted>();
  for (const cand of candidates) {
    const numBits = Math.min(
      MAX_PACKET_BITS,
      Math.floor((freq.length - cand.sampleOffset) / spb),
    );
    if (numBits < 32) continue;
    let bits = demodulateFskFromSample(
      burstIq,
      params,
      cand.sampleOffset,
      numBits,
    );
    if (cand.polarity === -1) {
      const flipped = new Uint8Array(bits.length);
      for (let i = 0; i < bits.length; i++) flipped[i] = 1 - bits[i];
      bits = flipped;
    }
    const packets = extractPacketsFromBits(bits);
    for (const p of packets) {
      // Dedupe identical packets (same opcode + body) found at neighbor offsets
      const key = `${p.opcode}:${Array.from(p.body).join(",")}`;
      if (!found.has(key)) found.set(key, p);
    }
  }
  return [...found.values()];
}

function processChunk(
  raw: Uint8Array,
  args: Args,
  chunkOffsetSec: number,
  stats: DecodeStats,
) {
  const samplesPerBit = args.sampleRateHz / DATA_RATE_HZ;
  const iq = complexFromUint8(raw);
  const mixed = mix(iq, args.mixHz, args.sampleRateHz);
  const bursts = findBursts(mixed, samplesPerBit);
  stats.burstCount += bursts.length;
  if (args.debug) {
    console.error(
      `  ${bursts.length} bursts (chunk @ ${chunkOffsetSec.toFixed(2)}s)`,
    );
  }
  for (const burst of bursts) {
    const burstIq = mixed.subarray(2 * burst.startSample, 2 * burst.endSample);
    const packets = demodBurst(burstIq, args.sampleRateHz);
    for (const p of packets) {
      stats.packetCount++;
      stats.opcodeCounts.set(
        p.opcode,
        (stats.opcodeCounts.get(p.opcode) ?? 0) + 1,
      );
      if (p.opcode === 0x32 && p.body.length > 0) {
        stats.op32Body0.set(
          p.body[0],
          (stats.op32Body0.get(p.body[0]) ?? 0) + 1,
        );
      }
      const tMs =
        chunkOffsetSec * 1000 + (burst.startSample / args.sampleRateHz) * 1000;
      if (args.showTransfer || p.opcode !== 0x41) {
        console.log(formatPacket(p, tMs));
      }
    }
  }
}

function main() {
  const args = parseArgs();
  if (!Number.isFinite(args.sampleRateHz) || args.sampleRateHz <= 0) {
    console.error(`bad --rate: ${args.sampleRateHz}`);
    process.exit(1);
  }
  const fileSize = statSync(args.file).size;
  const startByte = Math.floor(args.startSec * args.sampleRateHz) * 2;
  if (startByte >= fileSize) {
    console.error(
      `--start-sec ${args.startSec} past EOF (file is ${(fileSize / 1e6).toFixed(0)} MB at ${args.sampleRateHz} Hz)`,
    );
    process.exit(1);
  }
  const remaining = fileSize - startByte;
  const totalBytes =
    args.durationSec !== null
      ? Math.min(
          remaining,
          Math.floor(args.durationSec * args.sampleRateHz) * 2,
        )
      : remaining;

  console.error(
    `Decoding ${args.file}: rate=${args.sampleRateHz} Hz, mix=${args.mixHz} Hz, ` +
      `start=${args.startSec}s, duration=${(totalBytes / args.sampleRateHz / 2).toFixed(1)}s ` +
      `(${(totalBytes / 1e6).toFixed(1)} MB)`,
  );

  const fd = openSync(args.file, "r");
  try {
    const stats: DecodeStats = {
      burstCount: 0,
      packetCount: 0,
      opcodeCounts: new Map(),
      op32Body0: new Map(),
    };
    let consumedBytes = 0;
    while (consumedBytes < totalBytes) {
      const wantBytes = Math.min(CHUNK_BYTES_MAX, totalBytes - consumedBytes);
      const buf = new Uint8Array(wantBytes);
      const got = readSync(fd, buf, 0, wantBytes, startByte + consumedBytes);
      if (got === 0) break;
      const chunk = got < wantBytes ? buf.subarray(0, got) : buf;
      const chunkOffsetSec =
        args.startSec + consumedBytes / 2 / args.sampleRateHz;
      processChunk(chunk, args, chunkOffsetSec, stats);
      consumedBytes += got;
      if (args.debug) {
        console.error(
          `  progress: ${(consumedBytes / 1e6).toFixed(0)}/${(totalBytes / 1e6).toFixed(0)} MB ` +
            `(${stats.packetCount} packets so far)`,
        );
      }
    }

    console.log("");
    console.log("--- Summary ---");
    console.log(`bursts: ${stats.burstCount}`);
    console.log(`packets: ${stats.packetCount}`);
    const opcodes = [...stats.opcodeCounts.entries()].sort(
      (a, b) => a[0] - b[0],
    );
    for (const [op, count] of opcodes) {
      console.log(
        `  op=0x${op.toString(16).padStart(2, "0")} (${opcodeName(op).padEnd(13)}): ${count}`,
      );
    }
    if (stats.op32Body0.size > 0) {
      console.log("");
      console.log("--- 0x32 (Control) sub-opcode (body[0]) distribution ---");
      const sub = [...stats.op32Body0.entries()].sort((a, b) => a[0] - b[0]);
      for (const [b0, count] of sub) {
        console.log(
          `  body[0]=0x${b0.toString(16).padStart(2, "0")}: ${count}`,
        );
      }
    }
  } finally {
    closeSync(fd);
  }
}

main();
