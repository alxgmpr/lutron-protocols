#!/usr/bin/env npx tsx

/**
 * OTA TX replay + diff — emulate a captured OTA session and align our
 * transmission against the original recording.
 *
 * Reads a captured JSONL (e.g. cca-ota-20260428-190439.packets.jsonl),
 * filters to OTA-orchestrator packets matching a given subnet/serial
 * (default: the captured DVRF-6L target — subnet 0xEFFD, serial 0x06FE8020),
 * and replays the first N packets byte-verbatim through our path
 * (STREAM_CMD_TX_RAW_CCA). Captures TX echoes during the replay and saves
 * them as a replay JSONL.
 *
 * After replay, anchors both sequences on their first BeginTransfer
 * (sub-op 06 00) and reports per-packet timing + byte deltas. Surfaces
 * missing packets, ordering issues, and our transmission jitter.
 *
 * The captured DVRF-6L is offline — replaying its addresses is safe.
 *
 * Usage:
 *   # Replay first 30 packets and diff against the original:
 *   npx tsx tools/cca/ota-tx-replay.ts \
 *     --original data/captures/cca-ota-20260428-190439.packets.jsonl \
 *     --limit 30
 *
 *   # Diff a previously-saved replay capture without re-transmitting:
 *   npx tsx tools/cca/ota-tx-replay.ts \
 *     --original <orig.jsonl> --diff-only /tmp/replay-12345.jsonl
 *
 *   # Use a different cadence (default 150ms ≈ captured Caseta inter-arrival):
 *   npx tsx tools/cca/ota-tx-replay.ts --original <jsonl> --cadence-ms 75
 */

import { createSocket, type Socket } from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../../lib/config";

// --- Stream protocol ---
const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_TX_RAW_CCA = 0x01;
const STREAM_FLAG_TX = 0x80;
const STREAM_FLAG_CCX = 0x40;
const STREAM_HEARTBEAT = 0xff;
const STREAM_RESP_TEXT = 0xfd;
const PORT = 9433;

// --- CLI args ---
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(name);

function parseHex(s: string): number {
  return Number.parseInt(s.replace(/^0x/i, ""), 16);
}

interface CapturedPacket {
  tMs: number;
  hex: string;
  bytes: Uint8Array;
}

function bytesFromHex(hex: string): Uint8Array {
  return new Uint8Array(hex.split(" ").map((b) => parseInt(b, 16)));
}

function hexFromBytes(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join(" ");
}

/* Strip the trailing 2-byte CRC from a captured wire packet — our builders
 * are pre-CRC, so for byte-equal comparison and replay we drop it. */
function stripCrc(b: Uint8Array): Uint8Array {
  return b.slice(0, -2);
}

/* Match the OTA orchestrator subset: subnet/serial address match and
 * sub-opcode marker 0x06 at byte 14 (sub-op nn at byte 15: 00 BeginTransfer,
 * 01 ChangeAddrOff, 02 TransferData). Excludes 03 (Device-poll), bridge
 * beacons (0xC1+), and dimmer ACKs (0x0B). */
function isOtaOrchestrator(
  pkt: Uint8Array,
  subnet: number,
  targetSerial: number,
): boolean {
  if (pkt.length < 16) return false;
  const t = pkt[0];
  const isShort = t === 0x91 || t === 0x92;
  const isLong = t >= 0xb1 && t <= 0xb3;
  if (!isShort && !isLong) return false;
  const subnetByte = (pkt[3] << 8) | pkt[4];
  if (subnetByte !== (subnet & 0xffff)) return false;
  const serialByte =
    (pkt[9] * 0x1000000 + pkt[10] * 0x10000 + pkt[11] * 0x100 + pkt[12]) >>> 0;
  if (serialByte !== targetSerial >>> 0) return false;
  if (pkt[14] !== 0x06) return false;
  const subOp = pkt[15];
  return subOp === 0x00 || subOp === 0x01 || subOp === 0x02;
}

function loadJsonlPackets(path: string): CapturedPacket[] {
  const txt = readFileSync(path, "utf-8");
  const out: CapturedPacket[] = [];
  for (const line of txt.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as { tMs: number; hex: string };
      out.push({ tMs: obj.tMs, hex: obj.hex, bytes: bytesFromHex(obj.hex) });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function labelOf(
  pkt: Uint8Array,
  _idx: number,
  runningChunk: { i: number },
): string {
  const t = pkt[0];
  const subOp = pkt[15];
  if (t === 0x92 && subOp === 0x00) return "BeginTransfer";
  if (t === 0x91 && subOp === 0x01) return "ChangeAddrOff";
  if (t >= 0xb1 && t <= 0xb3 && subOp === 0x02) {
    const lbl = `TransferData[${runningChunk.i}]`;
    runningChunk.i++;
    return lbl;
  }
  return `?(0x${t.toString(16)}/06${subOp.toString(16).padStart(2, "0")})`;
}

function packetsEqualIgnoringSeq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (i === 1) continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sendStream(
  sock: Socket,
  host: string,
  cmd: number,
  data: Uint8Array,
): void {
  const frame = Buffer.alloc(2 + data.length);
  frame[0] = cmd;
  frame[1] = data.length;
  if (data.length > 0) Buffer.from(data).copy(frame, 2);
  sock.send(frame, 0, frame.length, PORT, host);
}

function parseTxEcho(msg: Buffer): Uint8Array | null {
  if (msg.length < 2) return null;
  const flags = msg[0];
  if (flags === STREAM_HEARTBEAT) return null;
  if (flags === STREAM_RESP_TEXT) return null;
  if ((flags & STREAM_FLAG_TX) === 0) return null;
  if ((flags & STREAM_FLAG_CCX) !== 0) return null;
  if (msg.length < 10) return null;
  const len = msg[1];
  if (msg.length < 10 + len) return null;
  return new Uint8Array(msg.subarray(10, 10 + len));
}

interface ReplayEntry {
  tMs: number;
  hex: string;
}

async function runReplay(
  expected: CapturedPacket[],
  host: string,
  cadenceMs: number,
): Promise<ReplayEntry[]> {
  console.log(
    `[replay] Connecting to ${host}, replaying ${expected.length} packets at ${cadenceMs}ms cadence`,
  );
  const sock = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(0, () => resolve());
  });

  const echoes: ReplayEntry[] = [];
  const startHi = process.hrtime.bigint();
  sock.on("message", (msg) => {
    const e = parseTxEcho(msg);
    if (!e) return;
    const tMs = Number(process.hrtime.bigint() - startHi) / 1_000_000;
    echoes.push({ tMs, hex: hexFromBytes(e) });
  });

  sendStream(sock, host, STREAM_CMD_KEEPALIVE, new Uint8Array(0));
  await sleep(150);

  for (const p of expected) {
    sendStream(sock, host, STREAM_CMD_TX_RAW_CCA, stripCrc(p.bytes));
    await sleep(cadenceMs);
  }

  // Grace period for last echoes / TDMA retx.
  await sleep(2500);
  sock.close();
  return echoes;
}

interface DiffRow {
  idx: number;
  label: string;
  origDeltaMs: number;
  replayDeltaMs: number;
  bytesOk: boolean;
  matched: boolean;
}

function diff(original: CapturedPacket[], replay: ReplayEntry[]): DiffRow[] {
  if (original.length === 0) return [];
  const origAnchor = original[0].tMs;

  // Find first BeginTransfer (sub-op 06 00, type 0x92) in replay echoes.
  let replayAnchor = -1;
  for (const e of replay) {
    const b = bytesFromHex(e.hex);
    if (b.length >= 16 && b[0] === 0x92 && b[14] === 0x06 && b[15] === 0x00) {
      replayAnchor = e.tMs;
      break;
    }
  }

  const out: DiffRow[] = [];
  const replayUsed = new Array(replay.length).fill(false);
  const lblCounter = { i: 0 };

  for (let i = 0; i < original.length; i++) {
    const orig = original[i];
    const label = labelOf(orig.bytes, i, lblCounter);
    const origDelta = orig.tMs - origAnchor;

    // Find the earliest replay echo that matches this original packet (by
    // bytes, ignoring seq) and hasn't been used.
    let matchIdx = -1;
    for (let r = 0; r < replay.length; r++) {
      if (replayUsed[r]) continue;
      const eb = bytesFromHex(replay[r].hex);
      if (packetsEqualIgnoringSeq(stripCrc(orig.bytes), eb)) {
        matchIdx = r;
        break;
      }
    }

    if (matchIdx >= 0) {
      replayUsed[matchIdx] = true;
      const replayDelta =
        replayAnchor >= 0 ? replay[matchIdx].tMs - replayAnchor : NaN;
      out.push({
        idx: i,
        label,
        origDeltaMs: origDelta,
        replayDeltaMs: replayDelta,
        bytesOk: true,
        matched: true,
      });
    } else {
      out.push({
        idx: i,
        label,
        origDeltaMs: origDelta,
        replayDeltaMs: NaN,
        bytesOk: false,
        matched: false,
      });
    }
  }
  return out;
}

function summarise(diff: DiffRow[], totalReplay: number): void {
  const matched = diff.filter((r) => r.matched);
  const missing = diff.length - matched.length;
  const extra = totalReplay - matched.length;

  const timeDeltas = matched
    .filter((r) => Number.isFinite(r.replayDeltaMs))
    .map((r) => r.replayDeltaMs - r.origDeltaMs);
  const sortedAbs = [...timeDeltas].map(Math.abs).sort((a, b) => a - b);
  const mean = timeDeltas.length
    ? timeDeltas.reduce((s, x) => s + x, 0) / timeDeltas.length
    : 0;
  const p95 = sortedAbs.length
    ? sortedAbs[Math.floor(sortedAbs.length * 0.95)]
    : 0;
  const maxAbs = sortedAbs.length ? sortedAbs[sortedAbs.length - 1] : 0;

  console.log("\n--- Diff summary ---");
  console.log(`  Original packets:    ${diff.length}`);
  console.log(`  Replay echoes:       ${totalReplay}`);
  console.log(`  Matched:             ${matched.length}`);
  console.log(`  Missing in replay:   ${missing}`);
  console.log(`  Extra in replay:     ${extra}  (TDMA retx + stray traffic)`);
  console.log(
    `  Timing offset (replay - original):  mean=${mean.toFixed(1)}ms  p95|abs|=${p95.toFixed(1)}ms  max|abs|=${maxAbs.toFixed(1)}ms`,
  );
}

function printTable(diff: DiffRow[], maxRows: number): void {
  console.log("\n--- Per-packet diff ---");
  console.log(
    "  idx | label                | orig.Δms | rep.Δms  | offset    | bytes",
  );
  for (let i = 0; i < Math.min(diff.length, maxRows); i++) {
    const r = diff[i];
    const offset =
      r.matched && Number.isFinite(r.replayDeltaMs)
        ? `${(r.replayDeltaMs - r.origDeltaMs >= 0 ? "+" : "") + (r.replayDeltaMs - r.origDeltaMs).toFixed(1)}ms`
        : "—";
    const bytes = r.matched ? "OK" : "MISS";
    console.log(
      `  ${r.idx.toString().padStart(3)} | ${r.label.padEnd(20)} | ${r.origDeltaMs.toFixed(1).padStart(7)}  | ${
        Number.isFinite(r.replayDeltaMs)
          ? r.replayDeltaMs.toFixed(1).padStart(7)
          : "    —  "
      }  | ${offset.padStart(8)}  | ${bytes}`,
    );
  }
  if (diff.length > maxRows) {
    console.log(
      `  … (${diff.length - maxRows} more rows; pass --full-table to see all)`,
    );
  }
}

async function main(): Promise<void> {
  const originalPath = getArg("--original");
  const subnet = parseHex(getArg("--subnet") ?? "0xeffd");
  const serial = parseHex(getArg("--serial") ?? "0x06fe8020");
  const limit = parseInt(getArg("--limit") ?? "30", 10);
  const cadenceMs = parseInt(getArg("--cadence-ms") ?? "150", 10);
  const host = getArg("--host") ?? config.openBridge;
  const out = getArg("--out") ?? `/tmp/ota-replay-${Date.now()}.jsonl`;
  const diffOnly = getArg("--diff-only");
  const fullTable = hasFlag("--full-table");

  if (!originalPath) {
    console.error(
      "Usage: npx tsx tools/cca/ota-tx-replay.ts --original <jsonl> [--subnet 0xeffd] [--serial 06fe8020] [--limit 30] [--cadence-ms 150] [--out <jsonl>] [--diff-only <replay.jsonl>]",
    );
    process.exit(1);
  }

  console.log(
    `[replay] subnet=0x${subnet.toString(16)} serial=0x${serial.toString(16)} limit=${limit}`,
  );

  const originalAll = loadJsonlPackets(originalPath);
  console.log(`[replay] Original capture: ${originalAll.length} total packets`);
  const originalOta = originalAll
    .filter((p) => isOtaOrchestrator(p.bytes, subnet, serial))
    .sort((a, b) => a.tMs - b.tMs)
    .slice(0, limit);
  console.log(
    `[replay] Filtered to ${originalOta.length} orchestrator packets (sub-ops 00/01/02)`,
  );

  let replay: ReplayEntry[];
  if (diffOnly) {
    console.log(`[replay] --diff-only: loading replay from ${diffOnly}`);
    const r = loadJsonlPackets(diffOnly);
    replay = r.map((p) => ({ tMs: p.tMs, hex: p.hex }));
  } else {
    replay = await runReplay(originalOta, host, cadenceMs);
    writeFileSync(out, replay.map((e) => JSON.stringify(e)).join("\n") + "\n");
    console.log(`[replay] Wrote ${replay.length} replay echoes to ${out}`);
  }

  const rows = diff(originalOta, replay);
  printTable(rows, fullTable ? rows.length : 40);
  summarise(rows, replay.length);

  const allMatched = rows.every((r) => r.matched);
  process.exit(allMatched ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
