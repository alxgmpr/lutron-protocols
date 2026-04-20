#!/usr/bin/env npx tsx

/**
 * Build a single ordered timeline from a capture.ndjson using the best-available
 * clock per source:
 *
 *   - sniff:    `epoch_ns`           — pcap hardware timestamp on the dongle
 *   - cca,ccx:  `radioTs` (ms)       — firmware HAL_GetTick() at RX/TX moment,
 *                                      linearly fit to host wall clock
 *   - ipl,leap: host `ts` (ms)       — Node socket-callback arrival stamp
 *
 * Why: host `ts` on cca/ccx records reflects Node event-loop batching, not
 * real RF arrival order. Example from capture.ndjson:
 *     line 20: ts=171421 radioTs=1841263
 *     line 21: ts=171422 radioTs=1841275
 * Host says these are 1 ms apart; firmware says 12 ms. Firmware wins.
 *
 * Also reports:
 *   - Nucleo → host clock offset + drift (from radioTs vs ts linear fit)
 *   - Event-loop batching magnitude (how much radioTs order diverges from ts order)
 *
 * Usage:
 *   npx tsx tools/capture-timeline.ts capture.ndjson
 *   npx tsx tools/capture-timeline.ts capture.ndjson --no-heartbeat
 *   npx tsx tools/capture-timeline.ts capture.ndjson --around 171411 --window 3000
 *   npx tsx tools/capture-timeline.ts capture.ndjson --stats
 */

import { readFileSync } from "fs";

const args = process.argv.slice(2);
const getArg = (n: string) => {
  const i = args.indexOf(n);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (n: string) => args.includes(n);

const FILE = args.find((a) => !a.startsWith("--"));
if (!FILE) {
  process.stderr.write(
    "usage: capture-timeline.ts <capture.ndjson> [--no-heartbeat] [--stats]\n" +
      "                               [--around <ts_ms>] [--window <ms>]\n" +
      "                               [--sources cca,ccx,ipl,leap,sniff]\n",
  );
  process.exit(1);
}

const NO_HEARTBEAT = hasFlag("--no-heartbeat");
const STATS_ONLY = hasFlag("--stats");
const AROUND = getArg("--around");
const WINDOW_MS = Number.parseInt(getArg("--window") ?? "2000", 10);
const SOURCES = new Set(
  (getArg("--sources") ?? "cca,ccx,ccx_raw,ipl,leap,sniff")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const MS_NS = 1_000_000n;

type Raw = Record<string, unknown>;
type Record_ = {
  ts: number; // host wall-clock ms (callback-arrival)
  monoNs: bigint | null; // host hrtime since capture start (ns)
  radioTsMs: number | null; // firmware HAL_GetTick ms (cca/ccx only)
  radioCyc: number | null; // firmware DWT cycle count (cca/ccx only, ~1.82 ns)
  epochNs: bigint | null; // pcap hardware ns-since-epoch (sniff only)
  src: string;
  raw: Raw;
};

/* CPU clock for DWT cycle → ns conversion. STM32H723 SYSCLK = 548 MHz,
 * CPU divider = 1, so DWT ticks at 548 MHz. Update if firmware clock config
 * changes (firmware/src/bsp/clock.c). */
const CPU_HZ = 548_000_000;

// ---------- Load ----------

const lines = readFileSync(FILE, "utf8").split("\n");
const records: Record_[] = [];

for (const l of lines) {
  if (!l) continue;
  let o: any;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  if (typeof o.ts !== "number" || typeof o.src !== "string") continue;
  records.push({
    ts: o.ts,
    monoNs: typeof o.mono_ns === "string" ? BigInt(o.mono_ns) : null,
    radioTsMs: typeof o.radioTs === "number" ? o.radioTs : null,
    radioCyc: typeof o.radioCyc === "number" ? o.radioCyc : null,
    epochNs: typeof o.epoch_ns === "string" ? BigInt(o.epoch_ns) : null,
    src: o.src,
    raw: o,
  });
}

// ---------- Discipline Nucleo radioTs to host wall clock ----------
//
// Linear fit: host_ts_ms ≈ A * radioTs_ms + B
// Use per-source fits (cca and ccx are stamped from the same STM32 but keeping
// them split lets us detect if they diverge — they shouldn't).

/* Unwrap a 32-bit monotonic counter into a 64-bit sequence using the
 * provided ordering (records in host-arrival order). Assumes no reorderings
 * larger than a wrap — true for our capture rates. */
function unwrap32(values: number[]): bigint[] {
  const out: bigint[] = new Array(values.length);
  let high = 0n;
  const WRAP = 1n << 32n;
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < prev - 0x8000_0000)
      high += WRAP; // forward wrap
    else if (v > prev + 0x8000_0000) high -= WRAP; // (shouldn't happen) rewind
    out[i] = high + BigInt(v >>> 0);
    prev = v;
  }
  return out;
}

type Fit = { a: number; b: number; n: number; rmsMs: number };

function linfit(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  if (n < 2) return { a: 1, b: 0, n, rmsMs: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const b = (sy - a * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (a * xs[i] + b);
    ss += e * e;
  }
  return { a, b, n, rmsMs: Math.sqrt(ss / n) };
}

function fitFor(src: string): Fit {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of records) {
    if (r.src === src && r.radioTsMs !== null) {
      xs.push(r.radioTsMs);
      ys.push(r.ts);
    }
  }
  return linfit(xs, ys);
}

const fits: Record<string, Fit> = {};
for (const s of ["cca", "ccx", "ccx_raw"]) {
  const f = fitFor(s);
  if (f.n >= 2) fits[s] = f;
}

/* Per-source cycle-based high-resolution time.
 * For each source that has radioCyc, unwrap the 32-bit counter into a
 * monotonic ns value and linearly fit to host ts to get sub-µs resolution.
 * Stored as a Map from record index → disciplined host_ns (bigint). */
const cycNsByRecordIdx = new Map<number, bigint>();
for (const src of ["cca", "ccx", "ccx_raw"]) {
  const indices: number[] = [];
  const cycs: number[] = [];
  const hosts: number[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.src === src && r.radioCyc !== null) {
      indices.push(i);
      cycs.push(r.radioCyc);
      hosts.push(r.ts);
    }
  }
  if (cycs.length < 2) continue;
  const cyc64 = unwrap32(cycs);
  // Fit: host_ms ≈ a * cyc_ns + b, where cyc_ns = cyc64 * 1e9 / CPU_HZ
  // Work in seconds to keep numbers sane.
  const xs = cyc64.map((c) => Number(c) / CPU_HZ); // seconds since first
  const x0 = xs[0];
  const xRel = xs.map((x) => x - x0);
  const fit = linfit(xRel, hosts);
  for (let j = 0; j < indices.length; j++) {
    const disciplined_ms = fit.a * xRel[j] + fit.b;
    cycNsByRecordIdx.set(indices[j], BigInt(Math.round(disciplined_ms * 1e6)));
  }
}

// ---------- Assign best-available timestamp (ns, host-epoch-anchored) ----------

type Ev = {
  bestNs: bigint; // unified ordering axis
  clock: "radio-cyc" | "radio-ms" | "sniffer-hw" | "host-ms";
  jitter_ms: number; // residual for radio; 0 for sniffer-hw; unknown for host-ms
  record: Record_;
};

const events: Ev[] = [];
for (let i = 0; i < records.length; i++) {
  const r = records[i];
  const cycNs = cycNsByRecordIdx.get(i);
  if (cycNs !== undefined) {
    events.push({ bestNs: cycNs, clock: "radio-cyc", jitter_ms: 0, record: r });
  } else if (r.radioTsMs !== null && fits[r.src]) {
    const f = fits[r.src];
    const disciplined_ms = f.a * r.radioTsMs + f.b;
    events.push({
      bestNs: BigInt(Math.round(disciplined_ms * 1e6)),
      clock: "radio-ms",
      jitter_ms: f.rmsMs,
      record: r,
    });
  } else if (r.epochNs !== null) {
    events.push({
      bestNs: r.epochNs,
      clock: "sniffer-hw",
      jitter_ms: 0,
      record: r,
    });
  } else {
    events.push({
      bestNs: BigInt(r.ts) * MS_NS,
      clock: "host-ms",
      jitter_ms: 0,
      record: r,
    });
  }
}
events.sort((a, b) => (a.bestNs < b.bestNs ? -1 : a.bestNs > b.bestNs ? 1 : 0));

// ---------- Batching diagnostic ----------
//
// For cca/ccx, compare host-ts order with radioTs order. Any disagreement is
// event-loop batching on the host.

function batchingReport(): string {
  const lines: string[] = [];
  for (const src of Object.keys(fits)) {
    const recs = records.filter((r) => r.src === src && r.radioTsMs !== null);
    if (recs.length < 2) continue;
    // pair up successive records, compare delta ts vs delta radioTs
    let pairs = 0;
    let violations = 0;
    let maxDivergenceMs = 0;
    const byHost = recs.slice().sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < byHost.length; i++) {
      const dTs = byHost[i].ts - byHost[i - 1].ts;
      const dR = byHost[i].radioTsMs! - byHost[i - 1].radioTsMs!;
      pairs++;
      if (dR < 0) violations++; // host-order disagrees with radio-order
      const div = Math.abs(dR - dTs);
      if (div > maxDivergenceMs) maxDivergenceMs = div;
    }
    lines.push(
      `  ${src.padEnd(8)} n=${recs.length.toString().padStart(4)}  ` +
        `order-violations=${violations}/${pairs}  ` +
        `max |Δradio − Δhost|=${maxDivergenceMs}ms`,
    );
  }
  return lines.join("\n");
}

function fitReport(): string {
  const out: string[] = [];
  for (const [src, f] of Object.entries(fits)) {
    const ppm = (f.a - 1) * 1e6;
    out.push(
      `  ${src.padEnd(8)} host_ms ≈ ${f.a.toFixed(9)} * radioTs + ${f.b.toFixed(3)}   ` +
        `drift=${ppm.toFixed(1)}ppm  rms=${f.rmsMs.toFixed(3)}ms  n=${f.n}`,
    );
  }
  return out.join("\n");
}

// ---------- Formatters ----------

function isHeartbeat(r: Raw): boolean {
  return r.src === "ipl" && r.msgTypeId === 5 && r.op === 1;
}

function summary(r: Raw): string {
  const src = r.src as string;
  if (src === "ipl") {
    const t = r.msgType ?? "?";
    const op = r.opName ? `${r.opName}(${r.op})` : `op=${r.op}`;
    const body = r.body_len
      ? ` body[${r.body_len}]=${String(r.body_hex).slice(0, 40)}`
      : "";
    return `${t} ${op}${body}`;
  }
  if (src === "cca" || src === "ccx" || src === "ccx_raw") {
    const dir = r.tx ? "TX" : "RX";
    const rssi = r.rssi !== undefined ? ` rssi=${r.rssi}` : "";
    const data = r.data_hex ? ` data=${String(r.data_hex).slice(0, 48)}` : "";
    return `${dir} radioTs=${r.radioTs}${rssi}${data}`;
  }
  if (src === "sniff") {
    const p = (r.parsed as any) ?? {};
    const t = p.type ?? "?";
    const seq = p.sequence !== undefined ? ` seq=${p.sequence}` : "";
    const extra = p.sceneId
      ? ` scene=${p.sceneId}`
      : p.buttonZone !== undefined
        ? ` btn=${p.buttonZone}`
        : "";
    return `${t}${seq}${extra} via ${(r.srcEui64 as string)?.slice(0, 17) ?? "?"}`;
  }
  if (src === "leap") {
    return `${r.communiqueType ?? "?"} ${r.url ?? ""} ${r.statusCode ?? ""}`;
  }
  return "";
}

function clockBadge(c: Ev["clock"]): string {
  if (c === "radio-cyc") return "[C]";
  if (c === "radio-ms") return "[R]";
  if (c === "sniffer-hw") return "[H]";
  return "[h]"; // host-ms
}

// ---------- Output ----------

if (STATS_ONLY) {
  process.stdout.write(
    `records: ${records.length}\n` +
      `sources: ${Array.from(new Set(records.map((r) => r.src)))
        .sort()
        .join(", ")}\n\n` +
      `Nucleo↔host clock fit (radioTs ms → host ts ms):\n${fitReport()}\n\n` +
      `Event-loop batching (per source):\n${batchingReport()}\n`,
  );
  process.exit(0);
}

let aroundFilter: { lo: bigint; hi: bigint } | null = null;
if (AROUND) {
  const a = BigInt(Math.round(Number.parseFloat(AROUND) * 1e6));
  const w = BigInt(WINDOW_MS) * MS_NS;
  aroundFilter = { lo: a - w, hi: a + w };
}

process.stderr.write(
  `timeline: ${records.length} records, ` +
    `sources ${Array.from(new Set(records.map((r) => r.src)))
      .sort()
      .join("/")}\n`,
);
if (Object.keys(fits).length) {
  process.stderr.write(`clock fit:\n${fitReport()}\n`);
  process.stderr.write(`batching:\n${batchingReport()}\n`);
}
process.stderr.write(
  `legend: [C]=radio-cyc (DWT ns)  [R]=radio-ms (HAL tick)  [H]=sniffer hardware  [h]=host-ms\n\n`,
);

let prevNs: bigint | null = null;
let shown = 0;
let skippedHb = 0;
for (const e of events) {
  if (!SOURCES.has(e.record.src)) continue;
  if (NO_HEARTBEAT && isHeartbeat(e.record.raw)) {
    skippedHb++;
    continue;
  }
  if (aroundFilter) {
    if (e.bestNs < aroundFilter.lo || e.bestNs > aroundFilter.hi) continue;
  }

  const tsMs = Number(e.bestNs / 1000n) / 1000; // ms with µs precision
  const dNs = prevNs === null ? 0n : e.bestNs - prevNs;
  prevNs = e.bestNs;

  const dSign = dNs < 0n ? "-" : "+";
  const dMag = dNs < 0n ? -dNs : dNs;
  const dMs = Number(dMag) / 1e6;
  const dStr =
    prevNs === null ? "       " : `${dSign}${dMs.toFixed(3).padStart(9)}ms`;

  process.stdout.write(
    `${tsMs.toFixed(3)}  ${dStr}  ${clockBadge(e.clock)} ${e.record.src.padEnd(7)} ${summary(e.record.raw)}\n`,
  );
  shown++;
}

process.stderr.write(
  `\nshown: ${shown}` +
    (NO_HEARTBEAT ? `  (skipped ${skippedHb} heartbeats)` : "") +
    "\n",
);
