#!/usr/bin/env npx tsx
/**
 * bench — decode-path performance regression gate.
 *
 * Absolute timings cannot be committed: a GitHub runner is not the machine a
 * baseline was taken on, and the spread between them dwarfs any regression
 * worth catching. So every case is measured as a ratio against a fixed
 * reference workload run in the same process, and the ratios are what ship in
 * bench-baseline.json. Machine speed cancels out.
 *
 * Inputs are the committed corpora, so the work is identical every run.
 *
 * Run:   npm run bench            report and gate against the baseline
 *        npm run bench -- --write rewrite the baseline from this run
 *
 * Not covered: lib/frame-pipeline. Benchmarking it needs valid encrypted
 * Thread frames, and lib/thread-crypto only exports the decrypt half, so
 * there is no honest way to synthesize input without hand-rolling AES-CCM
 * nonce construction. Its decode half is covered by ccx.decodeAndParse.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeAndParse } from "../ccx/decoder";
import type { CCXPacket } from "../ccx/types";
import { compareBench, normalize, summarize } from "../lib/bench";
import { DeviceModel } from "../lib/bridge/model";
import { CcxSource } from "../lib/bridge/sources/ccx";
import { decodeCcaFrame } from "../lib/cca-decode-adapter";
import {
  FLAG_CCX,
  FRAME_HEADER_LEN,
  parseStreamPacketFrame,
} from "../lib/stream-frame";
import { identifyPacket } from "../protocol/protocol-ui";
import { CCX_HEX_CORPUS } from "../test/fixtures/ccx-corpus";

const BASELINE_PATH = fileURLToPath(
  new URL("../test/fixtures/bench-baseline.json", import.meta.url),
);

/** Reps per case, including warmup. Odd so the median is a real sample. */
const REPS = 11;
const WARMUP = 3;
/** How much slower than baseline is a regression, in percent. */
const TOLERANCE_PCT = 30;

const REFERENCE = "reference";

// ── Inputs ───────────────────────────────────────────────

const ccaFrames: Buffer[] = readFileSync(
  fileURLToPath(new URL("../test/fixtures/cca-corpus.jsonl", import.meta.url)),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => Buffer.from(JSON.parse(line).hex, "hex"));

/** Stream datagrams built once, so framing cost is measured and not alloc. */
const streamFrames: Buffer[] = Array.from({ length: 20_000 }, (_, i) => {
  const payload = Buffer.from(
    "8200a300a20019feff03010182101903c105185c",
    "hex",
  );
  const frame = Buffer.alloc(FRAME_HEADER_LEN + payload.length);
  frame[0] = FLAG_CCX;
  frame[1] = payload.length;
  frame.writeUInt32LE(i * 75, 2);
  frame.writeUInt32LE(i * 1000, 6);
  payload.copy(frame, FRAME_HEADER_LEN);
  return frame;
});

/** Decoded CCX packets for the bridge dispatch case. */
const ccxPackets: CCXPacket[] = Array.from({ length: 4000 }, (_, i) => ({
  timestamp: "2026-08-16T00:00:00.000Z",
  srcAddr: "fd00::1",
  dstAddr: "ff03::1",
  srcEui64: "",
  dstEui64: "",
  msgType: 0,
  body: {},
  rawHex: "",
  parsed: {
    type: "LEVEL_CONTROL",
    level: 0xfeff,
    levelPercent: 100,
    zoneType: 16,
    zoneId: 961,
    fade: 1,
    delay: 0,
    // Distinct per packet, or the model dedups and the case measures nothing.
    sequence: i,
    rawBody: { 0: { 0: 0xfeff, 3: 1 }, 1: [16, 961], 5: i },
  },
}));

function makeBridge() {
  const model = new DeviceModel({
    watchedZones: new Set([961]),
    presetZones: new Map(),
    resolveZoneName: (id) => `Zone ${id}`,
    autoTick: false,
    reportDelayMs: 2000,
    now: () => 0,
  });
  return new CcxSource({ model, log: () => {} });
}

// ── Cases ────────────────────────────────────────────────

interface BenchCase {
  name: string;
  run: () => void;
}

/**
 * Fixed arithmetic workload. Must not touch any code under test, or the
 * ratios move when that code changes and the baseline means nothing.
 */
function referenceWorkload(): void {
  let x = 123456789;
  let acc = 0;
  for (let i = 0; i < 8_000_000; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    acc = (acc + (x & 0xffff)) >>> 0;
  }
  if (acc === 1) throw new Error("unreachable — keeps the loop live");
}

const CASES: BenchCase[] = [
  { name: REFERENCE, run: referenceWorkload },
  {
    name: "cca.identifyPacket",
    run: () => {
      for (let i = 0; i < 5; i++) {
        for (const frame of ccaFrames) identifyPacket(frame);
      }
    },
  },
  {
    name: "cca.decodeFrame",
    run: () => {
      for (const frame of ccaFrames) decodeCcaFrame(frame);
    },
  },
  {
    name: "stream.parseFrame",
    run: () => {
      // 200k parses: a single sweep of the array runs in under a millisecond,
      // which is too short to measure against timer noise.
      for (let i = 0; i < 10; i++) {
        for (const frame of streamFrames) parseStreamPacketFrame(frame);
      }
    },
  },
  {
    name: "ccx.decodeAndParse",
    run: () => {
      for (let i = 0; i < 500; i++) {
        for (const hex of CCX_HEX_CORPUS) decodeAndParse(hex);
      }
    },
  },
  {
    name: "bridge.dispatch",
    run: () => {
      const source = makeBridge();
      for (const pkt of ccxPackets) source.handlePacket(pkt);
    },
  },
];

// ── Run ──────────────────────────────────────────────────

function timeOnce(run: () => void): number {
  const started = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - started);
}

function main() {
  const write = process.argv.includes("--write");

  const timings: Record<string, number> = {};
  for (const bench of CASES) {
    const samples = Array.from({ length: REPS }, () => timeOnce(bench.run));
    const summary = summarize(samples, { warmup: WARMUP });
    timings[bench.name] = summary.median;

    // Noise approaching the band means the verdict is a coin flip. Say so
    // rather than letting the run look authoritative.
    const spreadPct = ((summary.max - summary.min) / summary.median) * 100;
    const noisy = spreadPct > TOLERANCE_PCT / 2;
    console.log(
      `${bench.name.padEnd(20)} ${(summary.median / 1e6).toFixed(2).padStart(9)} ms` +
        `   spread ${spreadPct.toFixed(0)}%${noisy ? "  ← NOISY, verdict unreliable" : ""}`,
    );
  }

  const ratios = normalize(timings, REFERENCE);
  console.log("\nratios vs reference:");
  for (const [name, ratio] of Object.entries(ratios)) {
    console.log(`  ${name.padEnd(20)} ${ratio.toFixed(4)}`);
  }

  if (write) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          note: "Ratios vs the reference workload — machine-independent. Regenerate with: npm run bench -- --write",
          tolerancePct: TOLERANCE_PCT,
          ratios,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nBaseline written to ${BASELINE_PATH}`);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const verdict = compareBench(ratios, baseline.ratios, baseline.tolerancePct);

  for (const r of verdict.regressions) {
    console.error(
      `\nREGRESSION ${r.name}: ${r.baseline.toFixed(4)} → ${r.current.toFixed(4)} ` +
        `(+${r.changePct.toFixed(1)}%, band ${baseline.tolerancePct}%)`,
    );
  }
  for (const name of verdict.missing) {
    console.error(`\nMISSING ${name}: in the baseline but not in this run`);
  }
  for (const i of verdict.improvements) {
    console.log(
      `\nfaster: ${i.name} ${i.baseline.toFixed(4)} → ${i.current.toFixed(4)} ` +
        `(${i.changePct.toFixed(1)}%) — rerun with --write to refresh`,
    );
  }
  for (const name of verdict.added) {
    console.log(`\nnew: ${name} has no baseline — rerun with --write`);
  }

  if (!verdict.ok) process.exit(1);
  console.log("\nAll benchmarks within tolerance.");
}

main();
