#!/usr/bin/env bun
/**
 * CCA reliability analyzer.
 *
 * Compares a "truth" capture against a DUT capture and reports packet recall,
 * misses, and extras by packet type.
 *
 * Usage:
 *   bun run tools/cca-reliability.ts --truth <truth.csv> --dut <dut.csv>
 *   bun run tools/cca-reliability.ts --truth a.csv --dut b.csv --window-ms 40
 */

import { readFileSync } from "fs";
import { resolve } from "path";

interface PacketRow {
  tsMs: number;
  tsIso: string;
  direction: string;
  rawHex: string;
  typeByte: string;
  seqHex: string;
  lineNo: number;
}

interface MatchBucketEntry {
  pkt: PacketRow;
  used: boolean;
}

function usageAndExit(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    [
      "CCA Reliability Analyzer",
      "",
      "Usage:",
      "  bun run tools/cca-reliability.ts --truth <truth.csv> --dut <dut.csv> [--window-ms 35] [--direction rx]",
      "",
      "Options:",
      "  --truth <path>       Ground-truth capture CSV",
      "  --dut <path>         Device-under-test capture CSV",
      "  --window-ms <n>      Timestamp match tolerance (default: 35)",
      "  --direction <dir>    Filter by direction (default: rx)",
      "  --show-misses <n>    Print first N misses (default: 20)",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let truth = "";
  let dut = "";
  let windowMs = 35;
  let direction = "rx";
  let showMisses = 20;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--truth":
        truth = args[++i] || "";
        break;
      case "--dut":
        dut = args[++i] || "";
        break;
      case "--window-ms":
        windowMs = Number(args[++i] || "35");
        break;
      case "--direction":
        direction = (args[++i] || "rx").toLowerCase();
        break;
      case "--show-misses":
        showMisses = Number(args[++i] || "20");
        break;
      case "--help":
      case "-h":
        usageAndExit();
        break;
      default:
        usageAndExit(`Unknown argument: ${a}`);
    }
  }

  if (!truth) usageAndExit("Missing --truth");
  if (!dut) usageAndExit("Missing --dut");
  if (!Number.isFinite(windowMs) || windowMs < 0) usageAndExit("Invalid --window-ms");
  if (!Number.isFinite(showMisses) || showMisses < 0) usageAndExit("Invalid --show-misses");

  return {
    truth: resolve(truth),
    dut: resolve(dut),
    windowMs,
    direction,
    showMisses,
  };
}

function normalizeRawHex(raw: string): string | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const bytes: string[] = [];
  for (const t of tokens) {
    const val = Number.parseInt(t, 16);
    if (!Number.isFinite(val) || val < 0 || val > 255) return null;
    bytes.push(val.toString(16).toUpperCase().padStart(2, "0"));
  }
  return bytes.join(" ");
}

function parseCsv(filePath: string, directionFilter: string): PacketRow[] {
  const text = readFileSync(filePath, "utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idxTimestamp = header.indexOf("timestamp");
  const idxDirection = header.indexOf("direction");
  const idxRawHex = header.indexOf("raw_hex");
  const fallbackRawIdx = header.length - 1;

  if (idxTimestamp < 0) {
    throw new Error(`${filePath}: missing 'timestamp' column`);
  }

  const out: PacketRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(",");
    if (parts.length < 2) continue;

    const tsIso = (parts[idxTimestamp] || "").trim();
    const tsMs = Date.parse(tsIso);
    if (!Number.isFinite(tsMs)) continue;

    const direction = (idxDirection >= 0 ? parts[idxDirection] : "rx").trim().toLowerCase();
    if (directionFilter !== "*" && direction !== directionFilter) continue;

    const rawField = (idxRawHex >= 0 ? parts[idxRawHex] : parts[fallbackRawIdx]) || "";
    const rawHex = normalizeRawHex(rawField);
    if (!rawHex) continue;

    const tokens = rawHex.split(" ");
    const typeByte = tokens[0] || "??";
    const seqHex = tokens.length > 1 ? tokens[1] : "??";

    out.push({
      tsMs,
      tsIso,
      direction,
      rawHex,
      typeByte,
      seqHex,
      lineNo: i + 1,
    });
  }

  out.sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

function pct(n: number, d: number): string {
  if (d <= 0) return "0.0%";
  return `${((n * 100) / d).toFixed(1)}%`;
}

function typeKey(t: string): string {
  return `0x${t.toUpperCase()}`;
}

function main() {
  const opts = parseArgs();
  const truth = parseCsv(opts.truth, opts.direction);
  const dut = parseCsv(opts.dut, opts.direction);

  if (truth.length === 0) {
    console.log("No packets in truth capture after filtering.");
    process.exit(0);
  }
  if (dut.length === 0) {
    console.log("No packets in DUT capture after filtering.");
    process.exit(0);
  }

  const dutByRaw = new Map<string, MatchBucketEntry[]>();
  for (const p of dut) {
    const arr = dutByRaw.get(p.rawHex) || [];
    arr.push({ pkt: p, used: false });
    dutByRaw.set(p.rawHex, arr);
  }

  const matchedTruth = new Set<number>();
  const missedTruth: PacketRow[] = [];
  const matchedPairs: Array<{ truth: PacketRow; dut: PacketRow; deltaMs: number }> = [];

  for (let i = 0; i < truth.length; i++) {
    const t = truth[i];
    const candidates = dutByRaw.get(t.rawHex);
    if (!candidates || candidates.length === 0) {
      missedTruth.push(t);
      continue;
    }

    let bestIdx = -1;
    let bestAbsDelta = Number.POSITIVE_INFINITY;
    for (let j = 0; j < candidates.length; j++) {
      const c = candidates[j];
      if (c.used) continue;
      const delta = c.pkt.tsMs - t.tsMs;
      const absDelta = Math.abs(delta);
      if (absDelta > opts.windowMs) continue;
      if (absDelta < bestAbsDelta) {
        bestAbsDelta = absDelta;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0) {
      candidates[bestIdx].used = true;
      matchedTruth.add(i);
      matchedPairs.push({
        truth: t,
        dut: candidates[bestIdx].pkt,
        deltaMs: candidates[bestIdx].pkt.tsMs - t.tsMs,
      });
    } else {
      missedTruth.push(t);
    }
  }

  const unmatchedDut: PacketRow[] = [];
  for (const entries of dutByRaw.values()) {
    for (const e of entries) {
      if (!e.used) unmatchedDut.push(e.pkt);
    }
  }

  const perType = new Map<string, { expected: number; matched: number; extras: number }>();
  for (const p of truth) {
    const k = typeKey(p.typeByte);
    const rec = perType.get(k) || { expected: 0, matched: 0, extras: 0 };
    rec.expected++;
    perType.set(k, rec);
  }
  for (const m of matchedPairs) {
    const k = typeKey(m.truth.typeByte);
    const rec = perType.get(k) || { expected: 0, matched: 0, extras: 0 };
    rec.matched++;
    perType.set(k, rec);
  }
  for (const p of unmatchedDut) {
    const k = typeKey(p.typeByte);
    const rec = perType.get(k) || { expected: 0, matched: 0, extras: 0 };
    rec.extras++;
    perType.set(k, rec);
  }

  const truthUnique = new Set(truth.map((p) => p.rawHex));
  const dutUnique = new Set(dut.map((p) => p.rawHex));
  let uniqueMatched = 0;
  for (const raw of truthUnique) {
    if (dutUnique.has(raw)) uniqueMatched++;
  }

  const meanAbsDelta =
    matchedPairs.length > 0
      ? matchedPairs.reduce((s, p) => s + Math.abs(p.deltaMs), 0) / matchedPairs.length
      : 0;

  console.log("\n=== CCA Reliability Report ===");
  console.log(`truth: ${opts.truth}`);
  console.log(`dut:   ${opts.dut}`);
  console.log(`direction=${opts.direction} window=${opts.windowMs}ms`);
  console.log("");
  console.log(`frames expected: ${truth.length}`);
  console.log(`frames matched:  ${matchedPairs.length} (${pct(matchedPairs.length, truth.length)})`);
  console.log(`frames missed:   ${missedTruth.length} (${pct(missedTruth.length, truth.length)})`);
  console.log(`dut extras:      ${unmatchedDut.length}`);
  console.log(`|Δt| mean:       ${meanAbsDelta.toFixed(1)}ms`);
  console.log("");
  console.log(`unique truth frames:   ${truthUnique.size}`);
  console.log(`unique dut frames:     ${dutUnique.size}`);
  console.log(`unique matched frames: ${uniqueMatched} (${pct(uniqueMatched, truthUnique.size)})`);

  const rows = [...perType.entries()].sort((a, b) => {
    if (b[1].expected !== a[1].expected) return b[1].expected - a[1].expected;
    return a[0].localeCompare(b[0]);
  });

  console.log("\nBy type:");
  console.log("type   expected  matched  missed  recall  extras");
  for (const [k, r] of rows) {
    const missed = r.expected - r.matched;
    const line = [
      k.padEnd(6),
      String(r.expected).padStart(8),
      String(r.matched).padStart(8),
      String(missed).padStart(7),
      pct(r.matched, r.expected).padStart(7),
      String(r.extras).padStart(7),
    ].join(" ");
    console.log(line);
  }

  if (opts.showMisses > 0 && missedTruth.length > 0) {
    console.log(`\nFirst ${Math.min(opts.showMisses, missedTruth.length)} misses:`);
    for (const m of missedTruth.slice(0, opts.showMisses)) {
      console.log(
        `${m.tsIso} type=0x${m.typeByte} seq=0x${m.seqHex} raw=${m.rawHex}`
      );
    }
  }
}

main();
