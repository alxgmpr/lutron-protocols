#!/usr/bin/env npx tsx

/**
 * ota-extract — Reassemble OTA firmware payload from an rtl_sdr capture.
 *
 * Pipeline:
 *   1. Slice the IQ capture into 60-second windows.
 *   2. For each window, run `tools/cca/rtlsdr-cca-decode.ts` to N81-decode every
 *      CCA packet (uses runtime CCA framing; the OTA traffic shares the
 *      runtime CCA channel and framing — see docs/firmware-re/cca-ota-live-capture.md).
 *   3. Filter to long packets (`0xB1`/`0xB2`/`0xB3`) carrying TransferData.
 *      Per-packet layout (53 bytes total):
 *        [0]    type       0xB1/B2/B3
 *        [1]    0x01
 *        [2..4] a1 ef fd   (hub-ish addressing prefix)
 *        [5..8] 00 21 2b 00
 *        [9..12] device serial (4 bytes, BE)
 *        [13]   0xfe
 *        [14..15] 06 02   (sub-opcode = TransferData)
 *        [16]   sub-counter (0..0x3F, cycles)
 *        [17..18] chunk address (16-bit BE, low bits of file offset)
 *        [19]   0x1F     (chunk size = 31)
 *        [20..50] 31 bytes of PFF firmware payload at file_offset
 *        [51..52] CRC-16 / poly 0xCA0F, BE
 *   4. Match each chunk against the supplied PFF file at offsets
 *      `chunkAddr + page * 0x10000` for page = 0, 1, 2 — the page indicator
 *      isn't in the B1/B2/B3 header (set by a separate control packet) so
 *      we use the firmware bytes themselves to disambiguate.
 *   5. Reassemble matched chunks into a partial PFF and report coverage.
 *
 * Usage:
 *   ota-extract.ts --capture <file.bin> --firmware <file.pff>
 *                  [--start-sec N] [--duration-sec N]
 *                  [--rate Hz] [--out <file.bin>]
 *
 *   # Example: validate the 2026-04-28 OTA capture against the v3.021 PFF.
 *   tools/cca/ota-extract.ts \
 *     --capture data/captures/cca-ota-20260428-190439.rf.bin \
 *     --firmware data/firmware/dvrf6l-v3.021.pff \
 *     --start-sec 37 --duration-sec 1093
 *
 * The decoder leans on `tools/cca/rtlsdr-cca-decode.ts` for FM-discriminate +
 * N81-decode + CRC verify; this tool only handles the OTA-layer extraction.
 */

import { execSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const DEFAULT_RATE = 2_560_000;
const SLICE_SEC = 60;
const CHUNK_SIZE = 31;

interface Args {
  capture: string;
  firmware: string;
  startSec: number;
  durationSec: number | null;
  rate: number;
  outFile: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const i = argv.indexOf(n);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const capture = get("--capture");
  const firmware = get("--firmware");
  if (!capture || !firmware || argv.includes("--help")) {
    console.error(
      "Usage: ota-extract.ts --capture <file.bin> --firmware <file.pff> [--start-sec N] [--duration-sec N] [--rate Hz] [--out <file>]",
    );
    process.exit(1);
  }
  return {
    capture,
    firmware,
    startSec: Number(get("--start-sec") ?? 0),
    durationSec: get("--duration-sec") ? Number(get("--duration-sec")) : null,
    rate: Number(get("--rate") ?? DEFAULT_RATE),
    outFile: get("--out") ?? null,
  };
}

interface Chunk {
  tMs: number;
  type: number;
  addrLo: number;
  payload: Uint8Array;
  crcOk: boolean;
}

const PACKET_RE =
  /^#\d+ @ ([\d.]+)ms: (0x[0-9a-f]+) \| (CRC OK at \d+|NO CRC \(\d+ bytes\)) \| (([0-9a-f]{2} )+[0-9a-f]{2})/;

function decodeWindow(
  capture: string,
  startSec: number,
  durSec: number,
  rate: number,
): Chunk[] {
  const fd = openSync(capture, "r");
  const startByte = Math.floor(startSec * rate) * 2;
  const numBytes = Math.floor(durSec * rate) * 2;
  const raw = new Uint8Array(numBytes);
  readSync(fd, raw, 0, numBytes, startByte);
  closeSync(fd);
  const sliceFile = `/tmp/ota-extract-${process.pid}.bin`;
  const decodedFile = `/tmp/ota-extract-${process.pid}.txt`;
  writeFileSync(sliceFile, raw);
  try {
    execSync(
      `npx tsx tools/cca/rtlsdr-cca-decode.ts --rate ${rate} ${sliceFile} > ${decodedFile} 2>&1`,
      { stdio: "ignore" },
    );
  } catch {
    /* decoder errors per-burst are common; the output file still has good packets */
  }
  const text = readFileSync(decodedFile, "utf-8");
  const out: Chunk[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(PACKET_RE);
    if (!m) continue;
    const type = parseInt(m[2], 16);
    if (type !== 0xb1 && type !== 0xb2 && type !== 0xb3) continue;
    const hex = m[4].split(" ").map((s) => parseInt(s, 16));
    if (hex.length < 51 || hex[19] !== 0x1f) continue;
    out.push({
      tMs: parseFloat(m[1]) + startSec * 1000,
      type,
      addrLo: (hex[17] << 8) | hex[18],
      payload: new Uint8Array(hex.slice(20, 20 + CHUNK_SIZE)),
      crcOk: m[3].startsWith("CRC OK"),
    });
  }
  unlinkSync(sliceFile);
  unlinkSync(decodedFile);
  return out;
}

function matchChunkPage(c: Chunk, fw: Buffer): number | null {
  for (let page = 0; page < 4; page++) {
    const off = c.addrLo + page * 0x10000;
    if (off + CHUNK_SIZE > fw.length) break;
    let ok = true;
    for (let i = 0; i < CHUNK_SIZE; i++) {
      if (fw[off + i] !== c.payload[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return page;
  }
  return null;
}

function main() {
  const args = parseArgs();
  if (!existsSync(args.capture))
    throw new Error(`capture not found: ${args.capture}`);
  if (!existsSync(args.firmware))
    throw new Error(`firmware not found: ${args.firmware}`);
  const fw = readFileSync(args.firmware);
  console.log(
    `Capture: ${args.capture}\nFirmware: ${args.firmware} (${fw.length} bytes, 0x${fw.length.toString(16)})\n`,
  );

  const all: Chunk[] = [];
  let s = args.startSec;
  const end =
    args.durationSec === null ? Infinity : args.startSec + args.durationSec;
  while (s < end) {
    const dur = Math.min(SLICE_SEC, end - s);
    const t0 = Date.now();
    const chunks = decodeWindow(args.capture, s, dur, args.rate);
    all.push(...chunks);
    console.log(
      `  t=${s.toFixed(0)}s..${(s + dur).toFixed(0)}s: +${chunks.length} long packets (running ${all.length}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    s += dur;
  }

  // Match each chunk against the firmware using page-aware lookup
  const matched: { c: Chunk; fwOffset: number }[] = [];
  let mismatched = 0;
  for (const c of all) {
    const page = matchChunkPage(c, fw);
    if (page === null) {
      mismatched++;
      continue;
    }
    matched.push({ c, fwOffset: c.addrLo + page * 0x10000 });
  }

  console.log(`\n--- Match results ---`);
  console.log(
    `Long packets:   ${all.length} (CRC OK: ${all.filter((c) => c.crcOk).length})`,
  );
  console.log(
    `Matched in PFF: ${matched.length} (${((matched.length / all.length) * 100).toFixed(1)}%)`,
  );
  console.log(`Mismatched (likely bit errors): ${mismatched}`);

  // Coverage of the firmware file
  const out = Buffer.alloc(fw.length);
  const coveredAny = new Uint8Array(fw.length);
  for (const { c, fwOffset } of matched) {
    out.set(c.payload, fwOffset);
    for (let i = 0; i < CHUNK_SIZE; i++) coveredAny[fwOffset + i] = 1;
  }
  let coveredBytes = 0;
  for (let i = 0; i < fw.length; i++) if (coveredAny[i]) coveredBytes++;
  console.log(
    `Coverage: ${coveredBytes} / ${fw.length} bytes (${((coveredBytes / fw.length) * 100).toFixed(1)}%)`,
  );

  // Sanity: matched bytes match the source file
  let identical = 0;
  for (let i = 0; i < fw.length; i++)
    if (coveredAny[i] && out[i] === fw[i]) identical++;
  console.log(
    `Verification: ${identical}/${coveredBytes} matched bytes are byte-identical to source PFF`,
  );
  if (identical !== coveredBytes) {
    console.log(
      `  WARNING: ${coveredBytes - identical} mismatched bytes — bug in match logic.`,
    );
  }

  if (args.outFile) {
    // Fill uncovered bytes with 0x00 (caller can compare for missing regions)
    writeFileSync(args.outFile, out);
    console.log(
      `\nWrote reassembled image to ${args.outFile} (${fw.length} bytes, uncovered = 0x00)`,
    );
  }
}

main();
