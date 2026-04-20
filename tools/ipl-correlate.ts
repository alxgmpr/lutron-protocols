#!/usr/bin/env npx tsx

/**
 * Correlate IPL events in an ipl-nucleo-capture.ndjson file with the raw
 * radio packets that occurred around the same time.
 *
 * Uses `mono_ns` (monotonic host hrtime since capture start, ns resolution)
 * as the correlation axis when available, falling back to `ts * 1_000_000`
 * for legacy events that only have epoch-ms precision.
 *
 * For each IPL Command / Event / Telemetry, prints:
 *   - The decoded IPL line (op name, object IDs, hex body)
 *   - Every sniff / cca / ccx / ccx_raw packet within [T - pre, T + post]
 *     sorted by monotonic time, with signed µs delta from the IPL event
 *
 * Usage:
 *   npx tsx tools/ipl-correlate.ts capture.ndjson
 *   npx tsx tools/ipl-correlate.ts capture.ndjson --pre 50 --post 50   # µs window
 *   npx tsx tools/ipl-correlate.ts capture.ndjson --op 13              # GoToLevel only
 *   npx tsx tools/ipl-correlate.ts capture.ndjson --msg Command
 *   npx tsx tools/ipl-correlate.ts capture.ndjson --sources sniff,ccx
 *   npx tsx tools/ipl-correlate.ts capture.ndjson --ns                 # display ns
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
  process.stderr.write("usage: ipl-correlate.ts <capture.ndjson> [options]\n");
  process.exit(1);
}

// IPL lags RF by tens of ms (processor-generated), so default window looks
// backward more than forward. Values are in milliseconds for ergonomics.
const PRE_MS = Number.parseInt(getArg("--pre") ?? "300", 10);
const POST_MS = Number.parseInt(getArg("--post") ?? "50", 10);
const OP_FILTER = getArg("--op");
const MSG_FILTER = getArg("--msg");
const SOURCES = new Set(
  (getArg("--sources") ?? "sniff,ccx,ccx_raw,cca")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const SHOW_NS = hasFlag("--ns");

const MS_NS = 1_000_000n;
const PRE_NS = BigInt(PRE_MS) * MS_NS;
const POST_NS = BigInt(POST_MS) * MS_NS;

type Ev = {
  t: bigint; // wall-clock ns on unified axis
  ts: number; // wall-clock epoch ms (for display)
  src: string;
  raw: Record<string, unknown>;
  precision: "hw" | "mono" | "ms"; // hw = pcap hardware timestamp, mono = hrtime, ms = fallback
};

// ---------- Load ----------
//
// Unify all events on a wall-clock ns axis:
//   - sniff events with `epoch_ns` (pcap hardware time) → use directly
//   - events with `mono_ns` (capture-tool hrtime ns) → convert to wall ns via
//     an offset derived from the first event that has BOTH `ts` (wall ms) and
//     `mono_ns`. On a local machine over a short capture the two clocks are
//     stable to ~µs, which is good enough for this correlator.
//   - legacy events (only `ts`) → `ts * 1_000_000` (ms resolution)

const lines = readFileSync(FILE, "utf8").split("\n");
const parsed: Array<{
  o: any;
  ts: number;
  src: string;
  monoNs?: bigint;
  epochNs?: bigint;
}> = [];
let wallOffsetNs: bigint | null = null; // wall_ns = mono_ns + wallOffsetNs

for (const l of lines) {
  if (!l) continue;
  let o: any;
  try {
    o = JSON.parse(l);
  } catch {
    continue;
  }
  if (typeof o.ts !== "number" || typeof o.src !== "string") continue;
  const entry: (typeof parsed)[number] = { o, ts: o.ts, src: o.src };
  if (typeof o.mono_ns === "string") entry.monoNs = BigInt(o.mono_ns);
  if (typeof o.epoch_ns === "string") entry.epochNs = BigInt(o.epoch_ns);
  if (wallOffsetNs === null && entry.monoNs !== undefined) {
    wallOffsetNs = BigInt(entry.ts) * MS_NS - entry.monoNs;
  }
  parsed.push(entry);
}

const events: Ev[] = parsed.map((e) => {
  if (e.epochNs !== undefined) {
    return { t: e.epochNs, ts: e.ts, src: e.src, raw: e.o, precision: "hw" };
  }
  if (e.monoNs !== undefined && wallOffsetNs !== null) {
    return {
      t: e.monoNs + wallOffsetNs,
      ts: e.ts,
      src: e.src,
      raw: e.o,
      precision: "mono",
    };
  }
  return {
    t: BigInt(e.ts) * MS_NS,
    ts: e.ts,
    src: e.src,
    raw: e.o,
    precision: "ms",
  };
});

events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

const rawEvents = events.filter((e) => SOURCES.has(e.src));
const iplEvents = events.filter((e) => e.src === "ipl");

const prec = { hw: 0, mono: 0, ms: 0 };
for (const e of events) prec[e.precision]++;
process.stderr.write(
  `loaded ${events.length} events  (ipl=${iplEvents.length} raw=${rawEvents.length})  ` +
    `precision: hw=${prec.hw} mono=${prec.mono} ms=${prec.ms}  window=[-${PRE_MS}ms, +${POST_MS}ms]\n\n`,
);

// ---------- Binary search on ns axis ----------

const rawT = rawEvents.map((e) => e.t);

function lowerBound(arr: bigint[], target: bigint): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------- Format helpers ----------

function iplMatches(e: Ev): boolean {
  if (MSG_FILTER && e.raw.msgType !== MSG_FILTER) return false;
  if (OP_FILTER && String(e.raw.op) !== OP_FILTER) return false;
  return true;
}

function fmtDelta(deltaNs: bigint, worstPrec: "hw" | "mono" | "ms"): string {
  const sign = deltaNs >= 0n ? "+" : "-";
  const mag = deltaNs < 0n ? -deltaNs : deltaNs;
  if (SHOW_NS) return `${sign}${mag.toString().padStart(12)}ns`;
  if (worstPrec === "ms") {
    const ms = Number(mag) / 1_000_000;
    return `${sign}${ms.toFixed(3).padStart(11)}ms`;
  }
  // hw or mono — show µs with 3 decimals (ns resolution)
  const us = Number(mag) / 1000;
  return `${sign}${us.toFixed(3).padStart(12)}µs`;
}

function worstPrecision(
  a: Ev["precision"],
  b: Ev["precision"],
): Ev["precision"] {
  if (a === "ms" || b === "ms") return "ms";
  if (a === "mono" || b === "mono") return "mono";
  return "hw";
}

function fmtIpl(e: Ev): string {
  const r = e.raw as any;
  const op = r.op !== undefined ? `${r.opName}(${r.op})` : "";
  const body = r.body_len > 0 ? ` body[${r.body_len}]=${r.body_hex}` : "";
  return `${r.msgType}/${r.receiverProcessing} sys=${r.systemId} s=${r.senderId}→${r.receiverId} seq=${r.messageId} ${op}${body}`;
}

function fmtRaw(e: Ev, dt: string): string {
  const r = e.raw as any;
  if (e.src === "sniff") {
    const kind = r.type ?? "?";
    const src = r.srcAddr ? ` ${r.srcAddr}` : "";
    const dst = r.dstAddr ? `→${r.dstAddr}` : "";
    const path = r.path ? ` ${r.path}` : "";
    const code = r.code ? ` ${r.code}` : "";
    const pay = r.payload
      ? ` payload=${r.payload.slice(0, 60)}${r.payload.length > 60 ? "…" : ""}`
      : "";
    const cbor = r.decoded
      ? ` cbor=${JSON.stringify(r.decoded).slice(0, 120)}`
      : "";
    return `  ${dt} sniff ${kind}${src}${dst}${path}${code}${pay}${cbor}`;
  }
  const hex = String(r.data_hex ?? "");
  const shown = hex.length > 96 ? `${hex.slice(0, 96)}…` : hex;
  const tx = r.tx ? " TX" : "";
  const rssi = r.rssi !== undefined ? ` rssi=${r.rssi}` : "";
  return `  ${dt} ${e.src.padEnd(8)}${tx}${rssi} [${r.data_len}B] ${shown}`;
}

// ---------- Main correlation loop ----------

for (const ipl of iplEvents) {
  if (!iplMatches(ipl)) continue;

  const lo = lowerBound(rawT, ipl.t - PRE_NS);
  const hi = lowerBound(rawT, ipl.t + POST_NS);

  if (hi === lo) continue;

  const time = new Date(ipl.ts).toISOString().slice(11, 23);
  console.log(`\n[${time}] IPL ${fmtIpl(ipl)}`);
  for (let i = lo; i < hi; i++) {
    const ev = rawEvents[i];
    const dt = fmtDelta(
      ev.t - ipl.t,
      worstPrecision(ipl.precision, ev.precision),
    );
    console.log(fmtRaw(ev, dt));
  }
}
