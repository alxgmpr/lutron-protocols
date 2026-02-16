#!/usr/bin/env bun
/**
 * CCA slot analyzer.
 *
 * Validates the relationship between CCA sequence byte deltas and packet timing.
 * Supports:
 *   1) capture CSV files (timestamp,direction,rssi,raw_hex)
 *   2) `cli/nucleo.ts` console logs with `#<seq>` and `+<delta>ms`
 *
 * Usage:
 *   bun run tools/cca-slot-analyzer.ts --file captures/cca-sessions/foo.csv
 *   bun run tools/cca-slot-analyzer.ts --file tmp/nucleo.log --format nucleo
 */

import { readFileSync } from "fs";
import { resolve } from "path";

type InputFormat = "auto" | "csv" | "nucleo";

interface CliOptions {
  file: string;
  format: InputFormat;
  direction: "rx" | "tx" | "*";
  slotMs: number;
  maxGapMs: number;
  maxSeqStep: number;
  minFlowSamples: number;
  includeTypes?: Set<number>;
}

interface PacketRow {
  tsMs: number;
  lineNo: number;
  direction: "rx" | "tx";
  typeByte?: number;
  typeLabel: string;
  seq: number;
  devKey: string;
}

interface PairSample {
  key: string;
  dtMs: number;
  dSeq: number;
  ratio: number;
  errorMs: number;
}

function usageAndExit(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    [
      "CCA Slot Analyzer",
      "",
      "Usage:",
      "  bun run tools/cca-slot-analyzer.ts --file <path> [options]",
      "",
      "Options:",
      "  --file <path>            Input file (required)",
      "  --format <auto|csv|nucleo>  Input format (default: auto)",
      "  --direction <rx|tx|*>    Direction filter (default: rx)",
      "  --slot-ms <n>            Slot hypothesis in ms (default: 12.5)",
      "  --max-gap-ms <n>         Max dt for pairing samples (default: 400)",
      "  --max-seq-step <n>       Max dSeq for pairing samples (default: 32)",
      "  --min-flow-samples <n>   Show per-flow stats at/above this count (default: 6)",
      "  --include-types <list>   Comma list of packet types (e.g. 81,82,83 or 0x81,0x83)",
      "",
      "Examples:",
      "  bun run tools/cca-slot-analyzer.ts --file captures/cca-sessions/5btn-off-press_2026-02-09T20-52-59.csv",
      "  bun run tools/cca-slot-analyzer.ts --file tmp/nucleo.log --format nucleo --include-types 0x81,0x82,0x83",
    ].join("\n"),
  );
  process.exit(1);
}

function parseTypeList(raw: string): Set<number> {
  const out = new Set<number>();
  for (const tok of raw.split(",")) {
    const t = tok.trim();
    if (!t) continue;
    const val = t.toLowerCase().startsWith("0x")
      ? Number.parseInt(t, 16)
      : Number.parseInt(t, 16);
    if (!Number.isFinite(val) || val < 0 || val > 0xff) {
      usageAndExit(`Invalid type byte in --include-types: ${t}`);
    }
    out.add(val);
  }
  if (out.size === 0) usageAndExit("--include-types produced no valid values");
  return out;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let file = "";
  let format: InputFormat = "auto";
  let direction: "rx" | "tx" | "*" = "rx";
  let slotMs = 12.5;
  let maxGapMs = 400;
  let maxSeqStep = 32;
  let minFlowSamples = 6;
  let includeTypes: Set<number> | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--file":
        file = args[++i] || "";
        break;
      case "--format": {
        const v = (args[++i] || "").toLowerCase();
        if (v !== "auto" && v !== "csv" && v !== "nucleo") {
          usageAndExit("Invalid --format (must be auto|csv|nucleo)");
        }
        format = v;
        break;
      }
      case "--direction": {
        const v = (args[++i] || "").toLowerCase();
        if (v !== "rx" && v !== "tx" && v !== "*") {
          usageAndExit("Invalid --direction (must be rx|tx|*)");
        }
        direction = v;
        break;
      }
      case "--slot-ms":
        slotMs = Number(args[++i] || "12.5");
        break;
      case "--max-gap-ms":
        maxGapMs = Number(args[++i] || "400");
        break;
      case "--max-seq-step":
        maxSeqStep = Number(args[++i] || "32");
        break;
      case "--min-flow-samples":
        minFlowSamples = Number(args[++i] || "6");
        break;
      case "--include-types":
        includeTypes = parseTypeList(args[++i] || "");
        break;
      case "--help":
      case "-h":
        usageAndExit();
        break;
      default:
        usageAndExit(`Unknown argument: ${a}`);
    }
  }

  if (!file) usageAndExit("Missing --file");
  if (!Number.isFinite(slotMs) || slotMs <= 0)
    usageAndExit("Invalid --slot-ms");
  if (!Number.isFinite(maxGapMs) || maxGapMs <= 0)
    usageAndExit("Invalid --max-gap-ms");
  if (!Number.isFinite(maxSeqStep) || maxSeqStep <= 0)
    usageAndExit("Invalid --max-seq-step");
  if (!Number.isFinite(minFlowSamples) || minFlowSamples < 1) {
    usageAndExit("Invalid --min-flow-samples");
  }

  return {
    file: resolve(file),
    format,
    direction,
    slotMs,
    maxGapMs,
    maxSeqStep,
    minFlowSamples,
    includeTypes,
  };
}

function detectFormat(text: string): Exclude<InputFormat, "auto"> {
  const firstLine = text.split(/\r?\n/, 1)[0]?.toLowerCase() ?? "";
  if (
    firstLine.includes("timestamp") &&
    firstLine.includes("direction") &&
    firstLine.includes("raw_hex")
  ) {
    return "csv";
  }
  return "nucleo";
}

function normalizeHexByte(token: string): number | null {
  if (!token) return null;
  const val = Number.parseInt(token, 16);
  if (!Number.isFinite(val) || val < 0 || val > 0xff) return null;
  return val;
}

function parseCsvRows(text: string): PacketRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idxTimestamp = header.indexOf("timestamp");
  const idxDirection = header.indexOf("direction");
  const idxRawHex = header.indexOf("raw_hex");

  if (idxTimestamp < 0 || idxRawHex < 0) {
    throw new Error("CSV missing required columns: timestamp/raw_hex");
  }

  const out: PacketRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(",");
    if (parts.length === 0) continue;

    const tsIso = (parts[idxTimestamp] || "").trim();
    const tsMs = Date.parse(tsIso);
    if (!Number.isFinite(tsMs)) continue;

    const direction = (idxDirection >= 0 ? parts[idxDirection] : "rx")
      .trim()
      .toLowerCase();
    if (direction !== "rx" && direction !== "tx") continue;

    const rawHex = (parts[idxRawHex] || "").trim();
    if (!rawHex) continue;
    const bytes = rawHex
      .split(/\s+/)
      .map(normalizeHexByte)
      .filter((v): v is number => v !== null);
    if (bytes.length < 2) continue;

    const typeByte = bytes[0];
    const seq = bytes[1];
    const devKey =
      bytes.length >= 6
        ? bytes
            .slice(2, 6)
            .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
            .join("")
        : "NA";

    out.push({
      tsMs,
      lineNo: i + 1,
      direction,
      typeByte,
      typeLabel: `0x${typeByte.toString(16).toUpperCase().padStart(2, "0")}`,
      seq,
      devKey,
    });
  }
  return out;
}

const TYPE_NAME_TO_BYTE: Record<string, number> = {
  STATE_RPT_81: 0x81,
  STATE_RPT_82: 0x82,
  STATE_RPT_83: 0x83,
};

function parseNucleoRows(text: string): PacketRow[] {
  const rawLines = text.split(/\r?\n/);
  const parsed: Array<{
    lineNo: number;
    direction: "rx" | "tx";
    typeLabel: string;
    typeByte?: number;
    seq: number;
    devKey: string;
    deltaMs?: number;
    absTsMs?: number;
  }> = [];

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = rawLines[i];
    if (!line || !line.includes("#")) continue;

    const dirMatch = line.match(/\b(RX|TX)\b/);
    if (!dirMatch) continue;
    const direction = dirMatch[1].toLowerCase() as "rx" | "tx";

    const typeMatch = line.match(/\b(?:RX|TX)\s+([^\s]+)/);
    if (!typeMatch) continue;
    const typeLabel = typeMatch[1];

    const seqMatch = line.match(/#\s*(\d+)/);
    if (!seqMatch) continue;
    const seq = Number.parseInt(seqMatch[1], 10);
    if (!Number.isFinite(seq) || seq < 0 || seq > 255) continue;

    const devMatch = line.match(/dev=([0-9A-Fa-f]+)/);
    const devKey = devMatch ? devMatch[1].toUpperCase() : "NO_DEV";

    const deltaMatch = line.match(/\+(\d+)ms\b/);
    const deltaMs = deltaMatch ? Number.parseInt(deltaMatch[1], 10) : undefined;

    const tsMatch = line.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
    let absTsMs: number | undefined;
    if (tsMatch) {
      const h = Number.parseInt(tsMatch[1], 10);
      const m = Number.parseInt(tsMatch[2], 10);
      const s = Number.parseInt(tsMatch[3], 10);
      const ms = Number.parseInt(tsMatch[4], 10);
      absTsMs = ((h * 60 + m) * 60 + s) * 1000 + ms;
    }

    let typeByte: number | undefined;
    if (/^0x[0-9a-f]{2}$/i.test(typeLabel)) {
      typeByte = Number.parseInt(typeLabel, 16);
    } else if (typeLabel in TYPE_NAME_TO_BYTE) {
      typeByte = TYPE_NAME_TO_BYTE[typeLabel];
    }

    parsed.push({
      lineNo,
      direction,
      typeLabel,
      typeByte,
      seq,
      devKey,
      deltaMs,
      absTsMs,
    });
  }

  if (parsed.length === 0) return [];

  // Prefer cumulative `+Nms` deltas when available (better than truncated wall-clock).
  const hasDeltas = parsed.some((p) => p.deltaMs !== undefined);

  const out: PacketRow[] = [];
  let tsMs = hasDeltas ? 0 : (parsed[0].absTsMs ?? 0);
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (hasDeltas) {
      if (i === 0) {
        tsMs = 0;
      } else {
        tsMs += p.deltaMs ?? 0;
      }
    } else {
      tsMs = p.absTsMs ?? tsMs;
    }

    out.push({
      tsMs,
      lineNo: p.lineNo,
      direction: p.direction,
      typeByte: p.typeByte,
      typeLabel: p.typeLabel,
      seq: p.seq,
      devKey: p.devKey,
    });
  }

  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function stats(vals: number[]) {
  if (vals.length === 0) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    n: sorted.length,
    mean,
    p10: percentile(sorted, 0.1),
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
  };
}

function modPositive(x: number, m: number): number {
  const r = x % m;
  return r < 0 ? r + m : r;
}

function hexByte(v: number): string {
  return `0x${v.toString(16).toUpperCase().padStart(2, "0")}`;
}

function main() {
  const opts = parseArgs();
  const text = readFileSync(opts.file, "utf-8");
  const format = opts.format === "auto" ? detectFormat(text) : opts.format;

  const rawRows = format === "csv" ? parseCsvRows(text) : parseNucleoRows(text);
  let rows = rawRows.filter(
    (r) => opts.direction === "*" || r.direction === opts.direction,
  );

  if (opts.includeTypes && opts.includeTypes.size > 0) {
    rows = rows.filter(
      (r) => r.typeByte !== undefined && opts.includeTypes?.has(r.typeByte),
    );
  }

  if (rows.length < 2) {
    console.log("Not enough rows after filtering.");
    process.exit(0);
  }

  const byFlow = new Map<string, PacketRow[]>();
  for (const r of rows) {
    const typePart =
      r.typeByte !== undefined
        ? hexByte(r.typeByte)
        : r.typeLabel.toUpperCase();
    const key = `${r.devKey}|${typePart}`;
    const arr = byFlow.get(key) || [];
    arr.push(r);
    byFlow.set(key, arr);
  }
  for (const arr of byFlow.values()) {
    arr.sort((a, b) => a.tsMs - b.tsMs);
  }

  const samples: PairSample[] = [];
  const samplesByDseq = new Map<number, number[]>();
  const flowPairCounts = new Map<string, number>();
  const flowRatios = new Map<string, number[]>();
  const flowAbsErrors = new Map<string, number[]>();
  const flowPhases = new Map<string, number[]>();
  const flowStrideCount = new Map<string, Map<number, number>>();

  for (const [key, arr] of byFlow) {
    if (arr.length < 2) continue;

    const phases: number[] = [];
    for (const r of arr) {
      phases.push(modPositive(r.tsMs - r.seq * opts.slotMs, opts.slotMs));
    }
    flowPhases.set(key, phases);

    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1];
      const b = arr[i];
      const dtMs = b.tsMs - a.tsMs;
      if (dtMs <= 0 || dtMs > opts.maxGapMs) continue;

      const dSeq = (b.seq - a.seq + 256) % 256;
      if (dSeq === 0 || dSeq > opts.maxSeqStep) continue;

      const ratio = dtMs / dSeq;
      const errorMs = dtMs - opts.slotMs * dSeq;
      samples.push({ key, dtMs, dSeq, ratio, errorMs });

      const dseqVals = samplesByDseq.get(dSeq) || [];
      dseqVals.push(dtMs);
      samplesByDseq.set(dSeq, dseqVals);

      flowPairCounts.set(key, (flowPairCounts.get(key) || 0) + 1);

      const ratios = flowRatios.get(key) || [];
      ratios.push(ratio);
      flowRatios.set(key, ratios);

      const absErr = flowAbsErrors.get(key) || [];
      absErr.push(Math.abs(errorMs));
      flowAbsErrors.set(key, absErr);

      const stride = flowStrideCount.get(key) || new Map<number, number>();
      stride.set(dSeq, (stride.get(dSeq) || 0) + 1);
      flowStrideCount.set(key, stride);
    }
  }

  if (samples.length === 0) {
    console.log("No valid (dt,dSeq) samples after filtering.");
    process.exit(0);
  }

  const ratioStats = stats(samples.map((s) => s.ratio));
  const absErrStats = stats(samples.map((s) => Math.abs(s.errorMs)));
  const estSlotMs = ratioStats?.p50 ?? 0;
  const estAbsErrStats = stats(
    samples.map((s) => Math.abs(s.dtMs - estSlotMs * s.dSeq)),
  );

  console.log("CCA Slot Analyzer");
  console.log(`file=${opts.file}`);
  console.log(
    `format=${format} rows=${rows.length} flows=${byFlow.size} samples=${samples.length}`,
  );
  console.log(
    `filters: direction=${opts.direction} slot_ms=${opts.slotMs} max_gap_ms=${opts.maxGapMs} max_seq_step=${opts.maxSeqStep}`,
  );
  if (opts.includeTypes && opts.includeTypes.size > 0) {
    const typeList = [...opts.includeTypes]
      .sort((a, b) => a - b)
      .map(hexByte)
      .join(",");
    console.log(`include_types=${typeList}`);
  }
  console.log("");

  if (ratioStats && absErrStats && estAbsErrStats) {
    console.log(
      `empirical_slot_ms (median dt/dseq) = ${ratioStats.p50.toFixed(3)} (p10=${ratioStats.p10.toFixed(3)} p90=${ratioStats.p90.toFixed(3)})`,
    );
    console.log(
      `fit_error_ms vs ${opts.slotMs.toFixed(3)}ms: |dt-slot*dseq| p50=${absErrStats.p50.toFixed(3)} p90=${absErrStats.p90.toFixed(3)} mean=${absErrStats.mean.toFixed(3)}`,
    );
    console.log(
      `fit_error_ms vs empirical ${estSlotMs.toFixed(3)}ms: |dt-slot*dseq| p50=${estAbsErrStats.p50.toFixed(3)} p90=${estAbsErrStats.p90.toFixed(3)} mean=${estAbsErrStats.mean.toFixed(3)}`,
    );
    console.log("");
  }

  console.log("dseq histogram (top):");
  const dseqLines = [...samplesByDseq.entries()]
    .map(([dSeq, dtVals]) => {
      const st = stats(dtVals)!;
      return {
        dSeq,
        n: st.n,
        p50: st.p50,
        p10: st.p10,
        p90: st.p90,
        slotP50: st.p50 / dSeq,
      };
    })
    .sort((a, b) => b.n - a.n || a.dSeq - b.dSeq)
    .slice(0, 12);

  for (const r of dseqLines) {
    console.log(
      `  dseq=${String(r.dSeq).padStart(2)} n=${String(r.n).padStart(4)} dt[p10,p50,p90]=${r.p10.toFixed(1)},${r.p50.toFixed(1)},${r.p90.toFixed(1)} slot@p50=${r.slotP50.toFixed(3)}ms`,
    );
  }
  console.log("");

  console.log(
    `per-flow summary (flows with >=${opts.minFlowSamples} samples):`,
  );
  const flowLines = [...flowPairCounts.entries()]
    .filter(([, n]) => n >= opts.minFlowSamples)
    .map(([key, n]) => {
      const ratioSt = stats(flowRatios.get(key) || []);
      const errSt = stats(flowAbsErrors.get(key) || []);
      const phaseSt = stats(flowPhases.get(key) || []);
      const stride = flowStrideCount.get(key) || new Map<number, number>();
      const strideTop = [...stride.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, 3)
        .map(([d, c]) => `${d}(${c})`)
        .join(" ");
      return {
        key,
        n,
        ratioP50: ratioSt?.p50 ?? 0,
        errP50: errSt?.p50 ?? 0,
        phaseP50: phaseSt?.p50 ?? 0,
        phaseSpan: (phaseSt?.p90 ?? 0) - (phaseSt?.p10 ?? 0),
        strideTop,
      };
    })
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));

  if (flowLines.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of flowLines) {
      console.log(
        `  ${r.key} n=${r.n} slot@p50=${r.ratioP50.toFixed(3)}ms err_p50=${r.errP50.toFixed(2)}ms phase_p50=${r.phaseP50.toFixed(2)}ms phase_span=${r.phaseSpan.toFixed(2)}ms stride=${r.strideTop}`,
      );
    }
  }
}

main();
