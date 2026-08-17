#!/usr/bin/env npx tsx
/**
 * capture-rate — how much of what the radios sent did this board actually hear.
 *
 * GLAB-113. Packet loss at the CC1101 is a property of the physical board and
 * the air around it, so no CI runner can reproduce it and no CI job should
 * pretend to. This runs by hand, against the bench rig, before and after
 * firmware changes that touch the CCA RX path.
 *
 * What it does:
 *   1. Snapshots the Nucleo's counters (0xFE status query).
 *   2. Drives a known stimulus from the processor over LEAP.
 *   3. Counts what arrived, per sender, by sequence gap.
 *   4. Snapshots the counters again and diffs.
 *   5. Says whether the loss was the air, our RX path, or neither.
 *
 * The verdict is the point. A loss percentage on its own has never settled an
 * argument about whether a regression is real — see lib/capture-run.ts for how
 * signal strength and the CC1101's own counters are used to attribute it.
 *
 * Note that the RSSI half of that is currently unavailable: the firmware packs
 * |RSSI| into five bits of the flags byte, so it aliases past -31 dBm and this
 * harness withholds it rather than feed the discriminator a made-up number.
 * Until GLAB-115 lands, attribution rests on the counters alone.
 *
 * Usage:
 *   npx tsx tools/cca/capture-rate.ts --zone "Office Lamp"
 *   npx tsx tools/cca/capture-rate.ts --stimulus raise --cycles 5
 *   npx tsx tools/cca/capture-rate.ts --stimulus none --duration 120
 *   npx tsx tools/cca/capture-rate.ts --zone 73 --gate       # vs the baseline
 *   npx tsx tools/cca/capture-rate.ts --zone 73 --write-baseline
 *
 * The stimulus drives a real load. Point it at a plug-in dimmer, not
 * something hardwired: --stimulus levels hammers the zone for the length of
 * the run. Whatever level the zone was at is read first and restored after,
 * including when the run fails partway.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { type CapturedFrame, FrameCollector } from "../../lib/capture-collect";
import { summarizeDecode } from "../../lib/capture-metrics";
import {
  analyzeCapture,
  type CaptureAnalysis,
  compareCapture,
  diagnose,
  diffStatus,
  dispersionInputs,
  type LossBaseline,
  slotDispersion,
} from "../../lib/capture-run";
import { config, defaultHost } from "../../lib/config";
import { hrefId, LeapConnection } from "../../lib/leap-client";
import type { NucleoStatus } from "../../lib/nucleo-status";
import {
  OPENLUTRON_UDP_PORT,
  OpenlutronStream,
} from "../../lib/openlutron-stream";

const STATUS_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 8000;
const KEEPALIVE_MS = 5000;

/**
 * Loss tolerance against the baseline, in percentage points.
 *
 * Sized from measurement, not taste: seven identical 20-cycle runs against
 * the bench rig in one sitting reported 3.4, 6.6, 7.1, 7.3, 8.2, 9.3 and 9.9%
 * loss — a 6.5-point spread with nothing changed between them. A tolerance
 * under that cries wolf every other run. What it can still catch is a step
 * change in the RX path, which is what this harness is for.
 */
const TOLERANCE_POINTS = 8;

const __dir = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(__dir, "capture-rate-baseline.json");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: "string" },
    processor: { type: "string", default: defaultHost },
    zone: { type: "string" },
    stimulus: { type: "string", default: "levels" },
    cycles: { type: "string", default: "10" },
    duration: { type: "string" },
    settle: { type: "string", default: "3000" },
    control: { type: "string", default: "20" },
    out: { type: "string" },
    save: { type: "string" },
    gate: { type: "boolean", default: false },
    "write-baseline": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(
    [
      "capture-rate — CCA/CCX capture-rate bench harness (hardware, on demand)",
      "",
      "  --host <ip>          Nucleo bridge (default: config.openBridge)",
      "  --processor <ip>     LEAP processor (default: first in config.json)",
      "  --zone <id|name>     Zone to drive. Use a plug-in dimmer.",
      "  --stimulus <kind>    levels | raise | none   (default: levels)",
      "  --cycles <n>         Stimulus repetitions (default: 10)",
      "  --duration <sec>     Capture window for --stimulus none (default: 60)",
      "  --settle <ms>        Quiet period before the closing snapshot",
      "  --control <sec>      Idle window measured before the stimulus (default: 20)",
      "  --out <file>         Write the JSON report here",
      "  --save <file>        Append captured CCA frames as JSONL for corpus use",
      "  --gate               Exit 1 if loss regressed past the baseline",
      "  --write-baseline     Record this run as the new baseline",
    ].join("\n"),
  );
  process.exit(0);
}

const host = values.host ?? config.openBridge;
const cycles = Number.parseInt(values.cycles!, 10);
const settleMs = Number.parseInt(values.settle!, 10);
const durationSec = Number.parseInt(values.duration ?? "60", 10);
const controlSec = Number.parseInt(values.control!, 10);
const stimulus = values.stimulus!;

if (!["levels", "raise", "none"].includes(stimulus)) {
  console.error(`Unknown --stimulus ${stimulus}. Use levels, raise or none.`);
  process.exit(1);
}
if (stimulus !== "none" && !values.zone) {
  console.error(`--stimulus ${stimulus} needs --zone. Use a plug-in dimmer.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Capture session
// ---------------------------------------------------------------------------

/**
 * The stream client plus the collecting window.
 *
 * The socket, keepalive and status plumbing this used to hand-roll now live in
 * lib/openlutron-stream.ts, and what counts as an observation lives in
 * lib/capture-collect.ts — where, unlike here, it can be tested without the
 * bench rig. What remains is the part that is specific to a measurement run.
 */
class CaptureSession {
  private readonly stream: OpenlutronStream;
  private readonly collector = new FrameCollector();

  constructor(host: string) {
    this.stream = new OpenlutronStream({ host, keepaliveMs: KEEPALIVE_MS });
    this.stream.on("frame", (frame) => this.collector.handleFrame(frame));
    // A measurement run is attended and short. A socket that dies mid-run
    // invalidates the numbers, so it is reported rather than absorbed.
    this.stream.on("error", (err) =>
      console.error(`  stream error: ${err.message}`),
    );
  }

  get frames(): CapturedFrame[] {
    return this.collector.frames;
  }

  async connect(): Promise<void> {
    await this.stream.connect();
    // The board only streams to registered clients, so the first datagram
    // back is the proof the registration took.
    await this.stream.ready(CONNECT_TIMEOUT_MS);
    this.stream.sendText("rx on");
  }

  status(): Promise<NucleoStatus> {
    return this.stream.requestStatus(STATUS_TIMEOUT_MS);
  }

  startCollecting(): void {
    this.collector.start();
  }

  stopCollecting(): void {
    this.collector.stop();
  }

  close(): void {
    this.stream.close();
  }
}

// ---------------------------------------------------------------------------
// Stimulus
// ---------------------------------------------------------------------------

interface ZoneTarget {
  id: number;
  name: string;
  /** Level to put the zone back to when the run is over. */
  restoreLevel: number | null;
}

async function findZone(
  conn: LeapConnection,
  search: string,
): Promise<ZoneTarget> {
  const body = await conn.readBody("/zone");
  const zones = body?.Zones ?? [];
  const asNum = Number.parseInt(search, 10);
  const match = !Number.isNaN(asNum)
    ? zones.find((z: any) => hrefId(z.href) === asNum)
    : zones.find((z: any) =>
        (z.Name ?? "").toLowerCase().includes(search.toLowerCase()),
      );
  if (!match) {
    const names = zones
      .map((z: any) => `  ${hrefId(z.href)}: ${z.Name}`)
      .join("\n");
    throw new Error(`No zone matching "${search}". Available:\n${names}`);
  }

  const id = hrefId(match.href);
  const status = await conn.readBody(`/zone/${id}/status`);
  const level = status?.ZoneStatus?.Level;
  return {
    id,
    name: match.Name,
    restoreLevel: typeof level === "number" ? level : null,
  };
}

async function setLevel(
  conn: LeapConnection,
  zoneId: number,
  level: number,
): Promise<void> {
  await conn.create(`/zone/${zoneId}/commandprocessor`, {
    Command: {
      CommandType: "GoToDimmedLevel",
      DimmedLevelParameters: { Level: level },
    },
  });
}

async function command(
  conn: LeapConnection,
  zoneId: number,
  type: string,
): Promise<void> {
  await conn.create(`/zone/${zoneId}/commandprocessor`, {
    Command: { CommandType: type },
  });
}

/**
 * Levels chosen to be visibly distinct and to avoid the endpoints, so every
 * step is a real dim transition rather than a switch event the load may
 * short-circuit.
 */
const LEVEL_SEQUENCE = [20, 80, 35, 65, 50];

async function driveStimulus(
  conn: LeapConnection,
  zone: ZoneTarget,
): Promise<void> {
  if (stimulus === "levels") {
    for (let c = 0; c < cycles; c++) {
      const level = LEVEL_SEQUENCE[c % LEVEL_SEQUENCE.length];
      await setLevel(conn, zone.id, level);
      await sleep(700);
    }
    return;
  }

  // The RAISE-hold case that prompted GLAB-108: a burst of repeats from one
  // sender, which is exactly where a gap becomes visible.
  for (let c = 0; c < cycles; c++) {
    await setLevel(conn, zone.id, 20);
    await sleep(500);
    await command(conn, zone.id, "Raise");
    await sleep(2500);
    await command(conn, zone.id, "Stop");
    await sleep(800);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function main(): Promise<number> {
  const stream = new CaptureSession(host);
  let leap: LeapConnection | null = null;
  let zone: ZoneTarget | null = null;

  try {
    console.log(`Connecting to openlutron ${host}:${OPENLUTRON_UDP_PORT} ...`);
    await stream.connect();

    const before = await stream.status();
    console.log(
      `  uptime ${(before.uptimeMs / 1000).toFixed(0)}s, ccaRx=${before.ccaRx}, ccxRx=${before.ccxRx}` +
        (before.radio ? "" : "  (no radio telemetry on this firmware)"),
    );

    if (stimulus !== "none") {
      leap = new LeapConnection({ host: values.processor! });
      await leap.connect();
      zone = await findZone(leap, values.zone!);
      console.log(
        `Zone ${zone.id}: ${zone.name} (currently ${zone.restoreLevel ?? "?"}%)`,
      );
    }

    // Idle control window. Without it there is no way to tell a counter that
    // ate our frames from one that ticks along at the same rate whatever we
    // do — ccaDrop runs at ~6/s on this rig with nothing happening at all,
    // and reading that as evidence pinned the verdict to LOCAL forever.
    console.log(`Idle control window: ${controlSec}s ...`);
    await sleep(controlSec * 1000);
    const afterControl = await stream.status();
    const control = diffStatus(before, afterControl);
    const idleDrop = control.counters?.ccaDrop ?? 0;
    console.log(
      `  ambient: ccaDrop ${(idleDrop / controlSec).toFixed(2)}/s, ccaRx ${((control.counters?.ccaRx ?? 0) / controlSec).toFixed(2)}/s`,
    );

    stream.startCollecting();
    const startedAt = Date.now();

    if (leap && zone) {
      console.log(`Driving ${stimulus} × ${cycles} ...`);
      await driveStimulus(leap, zone);
    } else {
      console.log(`Listening for ${durationSec}s ...`);
      await sleep(durationSec * 1000);
    }

    // Let the tail of the burst land before the counters are read, or the
    // last frames get attributed to the next run instead of this one.
    await sleep(settleMs);
    stream.stopCollecting();
    const elapsedMs = Date.now() - startedAt;

    const after = await stream.status();
    const delta = diffStatus(afterControl, after);
    const analysis = analyzeCapture(stream.frames.map((f) => f.observation));
    const decode = summarizeDecode(
      stream.frames
        .filter((f) => !f.observation.isTx)
        .map((f) => ({
          band: f.observation.band,
          decoded: f.decoded,
          identified: f.identified,
          typeName: f.typeName,
        })),
    );
    const dispersion = slotDispersion(dispersionInputs(analysis));
    const verdict = diagnose(analysis, delta, { control, dispersion });

    report(analysis, delta, decode, verdict, dispersion, control, elapsedMs);

    const current: LossBaseline = {
      cca: analysis.byBand.cca.lossPct,
      ccx: analysis.byBand.ccx.lossPct,
    };

    const output = {
      capturedAt: new Date().toISOString(),
      host,
      processor: stimulus === "none" ? null : values.processor,
      zone: zone ? { id: zone.id, name: zone.name } : null,
      stimulus: { kind: stimulus, cycles, durationSec, settleMs, controlSec },
      elapsedMs,
      loss: current,
      analysis,
      dispersion,
      counters: delta,
      control,
      decode,
      diagnosis: verdict,
    };

    if (values.out) {
      writeFileSync(values.out, `${JSON.stringify(output, null, 2)}\n`);
      console.log(`\nReport → ${values.out}`);
    }
    if (values.save) {
      const lines = stream.frames
        .filter((f) => f.hex !== null && !f.observation.isTx)
        .map((f) => JSON.stringify({ hex: f.hex }))
        .join("\n");
      writeFileSync(values.save, lines ? `${lines}\n` : "");
      console.log(`Raw CCA frames → ${values.save}`);
    }

    if (values["write-baseline"]) {
      return writeBaseline(current, verdict.verdict);
    }
    if (values.gate) {
      return gate(current);
    }
    return 0;
  } finally {
    // Whatever happened, the lights go back where they were and nothing is
    // left holding a socket open.
    if (leap && zone && zone.restoreLevel !== null) {
      try {
        await setLevel(leap, zone.id, zone.restoreLevel);
        console.log(`\nRestored zone ${zone.id} to ${zone.restoreLevel}%`);
      } catch (err) {
        console.error(
          `\nFAILED to restore zone ${zone.id} to ${zone.restoreLevel}%: ${(err as Error).message}`,
        );
      }
    }
    leap?.close();
    stream.close();
  }
}

function report(
  analysis: CaptureAnalysis,
  delta: ReturnType<typeof diffStatus>,
  decode: ReturnType<typeof summarizeDecode>,
  verdict: ReturnType<typeof diagnose>,
  dispersion: ReturnType<typeof slotDispersion>,
  control: ReturnType<typeof diffStatus>,
  elapsedMs: number,
): void {
  const line = "—".repeat(72);
  console.log(`\n${line}`);
  console.log(`Capture: ${(elapsedMs / 1000).toFixed(1)}s`);

  for (const band of ["cca", "ccx"] as const) {
    const b = analysis.byBand[band];
    const loss =
      b.lossPct === null
        ? "no measurable sequence span"
        : `${b.lossPct.toFixed(1)}% loss (${b.missing}/${b.expected} missing)`;
    console.log(
      `  ${band.toUpperCase()}: ${b.frames} frames, ${b.senders} senders, ${b.runs} counters — ${loss}`,
    );
  }
  console.log(
    `  ${analysis.txFrames} TX, ${analysis.unattributed} unattributed`,
  );
  console.log(
    "  RSSI withheld: the firmware truncates |RSSI| to 5 bits, so it aliases past -31 dBm (GLAB-115)",
  );

  console.log(
    `\nDecode: ${decode.decoded}/${decode.frames} decoded, ${decode.identified} identified (${decode.identifiedPct.toFixed(1)}%)`,
  );

  const busiest = analysis.runs.slice(0, 10);
  if (busiest.length > 0) {
    console.log("\nBusiest counters (one per sender and message type):");
    for (const r of busiest) {
      const loss =
        r.sequence.lossPct === null
          ? "  —  "
          : `${r.sequence.lossPct.toFixed(1)}%`;
      console.log(
        `  ${r.band} ${r.sender.padEnd(20)} ${(r.type ?? "?").padEnd(14)} ${String(r.frames).padStart(4)} frames  ${String(r.bursts).padStart(3)} bursts  step=${String(r.sequence.step ?? "?").padStart(3)}  loss=${loss.padStart(6)}`,
      );
    }
  }

  if (dispersion.result === "insufficient") {
    console.log(`\nSlot dispersion: ${dispersion.detail}`);
  } else {
    console.log(
      `\nSlot dispersion: ${dispersion.result.toUpperCase()} — ${dispersion.detail}`,
    );
    const peak = Math.max(...dispersion.byPosition, 1);
    for (let i = 0; i < dispersion.byPosition.length; i++) {
      const n = dispersion.byPosition[i];
      const bar = "█".repeat(Math.round((n / peak) * 32));
      console.log(
        `  slot ${String(i).padStart(2)}  ${String(n).padStart(4)}  ${bar}`,
      );
    }
  }

  // Rates, not raw deltas: a counter that ticks along at the same rate whether
  // or not we are driving traffic has told us nothing about this run.
  const runSec = (delta.elapsedMs ?? 0) / 1000;
  const idleSec = (control.elapsedMs ?? 0) / 1000;
  if (delta.counters && runSec > 0) {
    const moved = Object.entries(delta.counters)
      .filter(([, v]) => v !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    console.log(
      `\nCounters (${runSec.toFixed(0)}s run vs ${idleSec.toFixed(0)}s idle control):`,
    );
    console.log(
      `  ${"counter".padEnd(22)} ${"delta".padStart(7)} ${"run/s".padStart(8)} ${"idle/s".padStart(8)}`,
    );
    for (const [k, v] of moved) {
      const runRate = v / runSec;
      const idle = control.counters?.[k];
      const idleRate =
        idle !== undefined && idleSec > 0 ? idle / idleSec : null;
      const flag =
        idleRate !== null &&
        runRate > idleRate * 1.5 &&
        v - idleRate * runSec >= 3
          ? "  <-- above ambient"
          : "";
      console.log(
        `  ${k.padEnd(22)} ${(v > 0 ? `+${v}` : String(v)).padStart(7)} ${runRate.toFixed(2).padStart(8)} ${(idleRate === null ? "—" : idleRate.toFixed(2)).padStart(8)}${flag}`,
      );
    }
  } else {
    console.log("\nCounters: unavailable (board rebooted mid-run)");
  }

  console.log(`\nVerdict: ${verdict.verdict.toUpperCase()}`);
  for (const r of verdict.reasons) console.log(`  · ${r}`);
  console.log(line);
}

function readBaseline(): LossBaseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  return parsed.loss ?? null;
}

function writeBaseline(current: LossBaseline, verdict: string): number {
  // A baseline recorded from a run we could not explain would bake the
  // unexplained loss in as normal, and every later run would compare clean.
  if (verdict === "inconclusive") {
    console.error(
      "\nRefusing to write a baseline from an inconclusive run — fix the run first.",
    );
    return 1;
  }
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        note: "Bench rig only. Re-record after any change to the physical setup.",
        verdict,
        loss: current,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nBaseline written → ${BASELINE_PATH}`);
  return 0;
}

function gate(current: LossBaseline): number {
  const baseline = readBaseline();
  if (!baseline) {
    console.error(
      `\n--gate needs a baseline. Run with --write-baseline first (${BASELINE_PATH}).`,
    );
    return 1;
  }
  const cmp = compareCapture(current, baseline, TOLERANCE_POINTS);
  if (cmp.ok) {
    console.log(`\nGATE PASS (tolerance ${TOLERANCE_POINTS}pp)`);
    return 0;
  }
  console.error("\nGATE FAIL");
  for (const r of cmp.regressions) console.error(`  · ${r}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
