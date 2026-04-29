#!/usr/bin/env npx tsx
/**
 * pff-parse — Inspect Lutron Pegasus Firmware Format (.pff) files.
 *
 * Verified layout (see docs/firmware-re/coproc.md §"PFF File Format"):
 *   0x000   4   Version Major (BE u32)        — 0 = boot, 1 = app
 *   0x004   4   Version Minor (BE u32)        — 1
 *   0x008  64   Per-file unique field         — likely ECDSA-P256 sig or HMAC-SHA512
 *   0x048 195   Reserved (all-zero, universal)
 *   0x10B var   Encrypted body                — AES, per-device-model key
 *
 * Usage:
 *   npx tsx tools/pff-parse.ts <file.pff> [<file.pff> ...]
 *   npx tsx tools/pff-parse.ts --chi <file.pff>     # also report chi-square on body
 *   npx tsx tools/pff-parse.ts --json <file.pff>    # JSON output
 */

import { readFileSync, statSync } from "fs";

const HDR_SIG_OFFSET = 8;
const HDR_SIG_SIZE = 64;
const HDR_RESERVED_OFFSET = 72;
const HDR_RESERVED_SIZE = 195;
const BODY_OFFSET = HDR_RESERVED_OFFSET + HDR_RESERVED_SIZE; // 267

type ParseResult = {
  path: string;
  size: number;
  major: number;
  minor: number;
  sigHex: string;
  reservedAllZero: boolean;
  bodyOffset: number;
  bodySize: number;
  chi2?: number;
  uniformLikely?: boolean;
};

function parse(path: string, withChi: boolean): ParseResult {
  const data = readFileSync(path);
  if (data.length < BODY_OFFSET) {
    throw new Error(`${path}: too small (${data.length} < ${BODY_OFFSET})`);
  }

  const major = data.readUInt32BE(0);
  const minor = data.readUInt32BE(4);
  const sig = data.subarray(HDR_SIG_OFFSET, HDR_SIG_OFFSET + HDR_SIG_SIZE);
  const reserved = data.subarray(
    HDR_RESERVED_OFFSET,
    HDR_RESERVED_OFFSET + HDR_RESERVED_SIZE,
  );
  const body = data.subarray(BODY_OFFSET);

  const result: ParseResult = {
    path,
    size: data.length,
    major,
    minor,
    sigHex: sig.toString("hex"),
    reservedAllZero: reserved.every((b) => b === 0),
    bodyOffset: BODY_OFFSET,
    bodySize: body.length,
  };

  if (withChi) {
    const hist = new Array(256).fill(0);
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
  const variant =
    r.major === 0 ? "boot" : r.major === 1 ? "app" : `?(${r.major})`;
  const sigPreview = `${r.sigHex.slice(0, 24)}…${r.sigHex.slice(-8)}`;
  const lines = [
    `${r.path}`,
    `  size            : ${r.size} bytes`,
    `  version         : ${r.major}.${r.minor}  (${variant})`,
    `  signature [64B] : ${sigPreview}`,
    `  reserved 0-fill : ${r.reservedAllZero ? "OK (195 zeros)" : "FAIL — non-zero bytes in reserved field!"}`,
    `  body            : offset 0x${r.bodyOffset.toString(16)}, ${r.bodySize} bytes`,
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

main();
