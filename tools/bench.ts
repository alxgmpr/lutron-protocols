#!/usr/bin/env npx tsx
/**
 * bench — decode-path performance regression gate.
 *
 * Absolute timings cannot be committed: a GitHub runner is not the machine a
 * baseline was taken on. Each case is therefore measured as a ratio against a
 * fixed reference workload run in the same process.
 *
 * That is necessary but NOT sufficient, which the first CI run proved: every
 * case read 39-51% "faster" on the x86 runner than on an arm64 laptop. The
 * reference is integer-ALU work while the decode paths are allocation- and
 * branch-heavy, and the two architectures differ in how those relate. Using
 * one of our own decode paths as the reference does not fix it either —
 * ccx.decodeAndParse still shifts ~50% between the two.
 *
 * So the gate runs in one environment. The baseline is generated on CI and
 * enforced on CI; a local run reports the same numbers but does not fail,
 * because they are not comparable to a baseline taken on other hardware.
 * Compare local runs against each other instead.
 *
 * Inputs are the committed corpora, so the work is identical every run.
 *
 * Run:   npm run bench            report; gate only when CI is set
 *        npm run bench -- --write rewrite the baseline from this run
 *        npm run bench -- --gate  force gating locally (expect false alarms)
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
const REPS = 15;
const WARMUP = 5;
/**
 * How much slower than baseline counts as a regression.
 *
 * Wide enough to absorb variation between the CPU models GitHub hands out
 * and the noise of a shared runner; narrow enough that the regressions this
 * exists to catch — an accidentally quadratic loop, a lookup table rebuilt
 * per packet — are several times larger.
 */
const TOLERANCE_PCT = 40;

/**
 * Cases needing a wider band than the default, with why.
 *
 * Empty, and that is a result rather than an oversight: bridge.dispatch once
 * needed 80% because it drifted 28% between identical CI runs, but that was
 * under the old ALU reference. With a decode-shaped reference its drift fell
 * to 12% and the override stopped being justified. Kept as a mechanism
 * because paths do differ in volatility — stream.parseFrame is now the
 * twitchiest at 28% — and one band will not always serve them all.
 */
const PER_CASE_TOLERANCE_PCT: Record<string, number> = {};

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
 * Fixed workload standing in for "a decode path", used to normalize away
 * machine speed.
 *
 * Deliberately NOT a tight arithmetic loop. The first version was, and it
 * failed: pure integer ALU work relates differently to allocation-heavy code
 * on arm64 than on x86, so the ratios moved 39-51% between a laptop and a CI
 * runner. This mixes the primitives the decoders actually spend their time
 * on — buffer reads, short-lived object literals, Map lookups, small array
 * iteration, hex formatting — so that a machine which is fast or slow at
 * decoding is fast or slow at the reference in the same proportion.
 *
 * It must not call any code under test, or the ratios move when that code
 * changes and the baseline stops meaning anything.
 */
function referenceWorkload(): void {
  const scratch = Buffer.alloc(32);
  const table = new Map<number, string>();
  for (let i = 0; i < 256; i++) table.set(i, `type_${i.toString(16)}`);

  let sink = 0;
  for (let i = 0; i < 120_000; i++) {
    scratch.writeUInt32BE((i * 2654435761) >>> 0, 0);
    scratch.writeUInt32LE((i * 40503) >>> 0, 4);

    const typeByte = scratch[0];
    const name = table.get(typeByte) ?? "unknown";

    const fields = [
      { offset: 0, size: 4, value: scratch.readUInt32BE(0) },
      { offset: 4, size: 4, value: scratch.readUInt32LE(4) },
      { offset: 8, size: 2, value: scratch.readUInt16BE(8) },
    ];

    let parsed = 0;
    for (const f of fields) {
      if (f.offset + f.size > scratch.length) continue;
      parsed += f.value & 0xff;
    }

    const record = { name, parsed, seq: i & 0xff, raw: scratch[1] };
    sink = (sink + record.parsed + record.seq + record.raw) >>> 0;

    if ((i & 0x3fff) === 0)
      sink = (sink + scratch.toString("hex").length) >>> 0;
  }
  if (sink === 1) throw new Error("unreachable — keeps the loop live");
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

  if (write && !process.env.CI) {
    console.error(
      "\nRefusing to write a baseline off CI — the gate runs on CI, and numbers\n" +
        "from this machine do not transfer. Take them from a CI run's log.",
    );
    process.exit(1);
  }

  if (write) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          note: "Ratios vs the reference workload — machine-independent. Regenerate with: npm run bench -- --write",
          tolerancePct: TOLERANCE_PCT,
          perCaseTolerancePct: PER_CASE_TOLERANCE_PCT,
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
  const verdict = compareBench(
    ratios,
    baseline.ratios,
    baseline.tolerancePct,
    baseline.perCaseTolerancePct ?? {},
  );

  // The baseline is CI-derived. Enforcing it on other hardware produces
  // confident nonsense, so a local run reports and stops there.
  const gating = Boolean(process.env.CI) || process.argv.includes("--gate");
  if (!gating) {
    console.log(
      "\nReport only — the baseline was taken on CI and does not transfer to\n" +
        "this machine. Compare successive local runs instead, or --gate to force.",
    );
    return;
  }

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
