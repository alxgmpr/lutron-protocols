#!/usr/bin/env npx tsx

/**
 * pff-parse — Inspect Lutron Pegasus Firmware Format (.pff) files.
 *
 * Verified layout (see docs/devices/coprocessor-firmware.md §"PFF File Format"):
 *   0x000   4   Header layout version (BE u32) — 1 → 0x134 header, 0 → 0x130 header
 *   0x004   4   Constant (BE u32)              — always 1
 *   0x008  64   Per-file unique field          — likely ECDSA-P256 sig or HMAC-SHA512
 *   0x048 192   Reserved (all-zero, universal)
 *   0x108   2   Flags (BE u16)                 — 1 on secondary-MCU sub-images
 *   0x10A   2   Image kind (BE u16)            — 2 = boot, 3 = app
 *   0x10C   4   Revision                       — major, minor, patch, label
 *   0x114   4   DeviceClass (BE u32)           — firmware-space class (0x04630201 = DVRF-6L)
 *   0x118   4   ImageType (BE u32)             — always 1
 *   0x11C   4   Ciphertext length (BE u32)     — exact: size - headerLen
 *   0x120   4   Target flash addr/size (BE u32) — layout 1 only
 *     —    16   IV                             — 16 bytes immediately before the body
 *   0x134 var   Encrypted body                 — AES-CBC, per-device-model key
 *                                                (0x130 on layout 0)
 *
 * Usage:
 *   npx tsx tools/pff-parse.ts <file.pff> [<file.pff> ...]
 *   npx tsx tools/pff-parse.ts --chi <file.pff>     # also report chi-square on body
 *   npx tsx tools/pff-parse.ts --json <file.pff>    # JSON output
 */

import { pathToFileURL } from "node:url";
import { readFileSync, statSync } from "fs";

const HDR_SIG_OFFSET = 8;
const HDR_SIG_SIZE = 64;
const HDR_RESERVED_OFFSET = 72;
const HDR_RESERVED_SIZE = 192; // 0x048..0x107
const HDR_FLAGS_OFFSET = 0x108;
const HDR_KIND_OFFSET = 0x10a;
const HDR_REVISION_OFFSET = 0x10c;
const HDR_DEVCLASS_OFFSET = 0x114;
const HDR_IMAGETYPE_OFFSET = 0x118;
const HDR_CTLEN_OFFSET = 0x11c;
const HDR_FLASHADDR_OFFSET = 0x120; // layout 1 only
const IV_SIZE = 16;

// Header length is selected by the layout version at 0x000. Layout 1 carries the
// extra target-flash field at 0x120; layout 0 does not. In both cases the final
// 16 header bytes are the AES-CBC IV, and the ciphertext length at 0x11C equals
// (file size - header length) exactly — that is what pins the body offset, since
// 0x124 and 0x134 differ by one AES block and both look "block-aligned".
const HEADER_LEN_BY_LAYOUT = new Map([
  [0, 0x130],
  [1, 0x134],
]);

export type ParseResult = {
  path: string;
  size: number;
  layoutVersion: number;
  headerLen: number;
  kind: string;
  flags: number;
  revision: string;
  sigHex: string;
  deviceClass: string;
  imageType: number;
  targetFlashAddr: string | null;
  ivHex: string;
  reservedAllZero: boolean;
  bodyOffset: number;
  bodySize: number;
  declaredCtLen: number;
  ctLenMatches: boolean;
  bodyBlockAligned: boolean;
  chi2?: number;
  uniformLikely?: boolean;
};

export function parse(path: string, withChi: boolean): ParseResult {
  const data = readFileSync(path);

  const layoutVersion = data.length >= 4 ? data.readUInt32BE(0) : -1;
  const headerLen = HEADER_LEN_BY_LAYOUT.get(layoutVersion);
  if (headerLen === undefined) {
    throw new Error(
      `${path}: unknown header layout version ${layoutVersion} at 0x000 (expected 0 or 1)`,
    );
  }
  if (data.length < headerLen + 16) {
    throw new Error(`${path}: too small (${data.length} < ${headerLen + 16})`);
  }

  const sig = data.subarray(HDR_SIG_OFFSET, HDR_SIG_OFFSET + HDR_SIG_SIZE);
  const reserved = data.subarray(
    HDR_RESERVED_OFFSET,
    HDR_RESERVED_OFFSET + HDR_RESERVED_SIZE,
  );
  const body = data.subarray(headerLen);
  const declaredCtLen = data.readUInt32BE(HDR_CTLEN_OFFSET);
  const kindRaw = data.readUInt16BE(HDR_KIND_OFFSET);
  const rev = data.subarray(HDR_REVISION_OFFSET, HDR_REVISION_OFFSET + 4);

  const result: ParseResult = {
    path,
    size: data.length,
    layoutVersion,
    headerLen,
    kind: kindRaw === 2 ? "boot" : kindRaw === 3 ? "app" : `?(${kindRaw})`,
    flags: data.readUInt16BE(HDR_FLAGS_OFFSET),
    revision: `${rev[0]}.${rev[1]}.${rev[2]}r${rev[3]}`,
    sigHex: sig.toString("hex"),
    deviceClass: data
      .readUInt32BE(HDR_DEVCLASS_OFFSET)
      .toString(16)
      .padStart(8, "0"),
    imageType: data.readUInt32BE(HDR_IMAGETYPE_OFFSET),
    targetFlashAddr:
      layoutVersion === 1
        ? data.readUInt32BE(HDR_FLASHADDR_OFFSET).toString(16).padStart(8, "0")
        : null,
    ivHex: data.subarray(headerLen - IV_SIZE, headerLen).toString("hex"),
    reservedAllZero: reserved.every((b) => b === 0),
    bodyOffset: headerLen,
    bodySize: body.length,
    declaredCtLen,
    ctLenMatches: body.length === declaredCtLen,
    bodyBlockAligned: body.length % 16 === 0,
  };

  if (withChi) {
    const hist = Array<number>(256).fill(0);
    for (const b of body) hist[b]++;
    const expected = body.length / 256;
    let chi2 = 0;
    for (let i = 0; i < 256; i++) {
      const d = hist[i] - expected;
      chi2 += (d * d) / expected;
    }
    result.chi2 = chi2;
    // Threshold for "distinguishable from uniform" at p<0.01, df=255 ≈ 310
    result.uniformLikely = chi2 < 310;
  }

  return result;
}

function formatHuman(r: ParseResult): string {
  const sigPreview = `${r.sigHex.slice(0, 24)}…${r.sigHex.slice(-8)}`;
  const lines = [
    `${r.path}`,
    `  size            : ${r.size} bytes`,
    `  header layout   : v${r.layoutVersion} (${r.headerLen} bytes)`,
    `  kind / revision : ${r.kind}  ${r.revision}${r.flags ? `  [flags=0x${r.flags.toString(16)}]` : ""}`,
    `  signature [64B] : ${sigPreview}`,
    `  DeviceClass     : 0x${r.deviceClass}  (ImageType ${r.imageType})`,
    `  target flash    : ${r.targetFlashAddr ? `0x${r.targetFlashAddr}` : "— (absent on layout 0)"}`,
    `  IV [16B]        : ${r.ivHex}`,
    `  reserved 0-fill : ${r.reservedAllZero ? "OK (192 zeros)" : "non-zero — expected only on secondary-MCU sub-images"}`,
    `  body            : offset 0x${r.bodyOffset.toString(16)}, ${r.bodySize} bytes${r.bodyBlockAligned ? " (16-aligned)" : " — NOT 16-aligned!"}`,
    `  declared ct len : ${r.declaredCtLen}${r.ctLenMatches ? " (matches)" : " — MISMATCH, header model wrong for this file!"}`,
  ];
  if (r.chi2 !== undefined) {
    lines.push(
      `  body chi²       : ${r.chi2.toFixed(1)}  (uniform exp 255, threshold 310 — ${r.uniformLikely ? "looks encrypted/random" : "structured!"})`,
    );
  }
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const withChi = args.includes("--chi");
  const asJson = args.includes("--json");
  const files = args.filter((a) => !a.startsWith("--"));

  if (files.length === 0) {
    console.error(
      "usage: pff-parse [--chi] [--json] <file.pff> [<file.pff>...]",
    );
    process.exit(1);
  }

  const results: ParseResult[] = [];
  for (const f of files) {
    try {
      statSync(f);
    } catch {
      console.error(`${f}: not found`);
      process.exit(1);
    }
    results.push(parse(f, withChi));
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) console.log(formatHuman(r));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
