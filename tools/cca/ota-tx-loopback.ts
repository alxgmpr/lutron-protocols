#!/usr/bin/env npx tsx

/**
 * OTA TX path validator — sends a small synthetic OTA burst against a bogus
 * subnet/serial and confirms what came back matches what we built.
 *
 * Three observation channels:
 *   1. Expected packets — built locally via lib/cca-ota-tx-builder.walkOtaPackets
 *   2. TX echoes — the Nucleo's stream protocol broadcasts every TX frame
 *      it puts on the wire (FLAG_TX bit set). Confirms that the firmware
 *      accepted the packet, framed it, and handed it to the CC1101.
 *   3. SDR off-air decode (optional) — confirms RF actually went out.
 *      Reads an IQ file and runs tools/cca/rtlsdr-cca-decode.ts --jsonl,
 *      filters for our subnet/serial, and three-way matches.
 *
 * Bogus subnet 0xDEAD + bogus serial 0xDEADBEEF means no real device on the
 * channel reacts. Synthetic body is deterministic, so the expected packet
 * sequence is exactly reproducible.
 *
 * Usage:
 *   # Track 2 (host-side path) UDP-only:
 *   npx tsx tools/cca/ota-tx-loopback.ts --track 2
 *
 *   # Track 1 (firmware-side orchestrator):
 *   npx tsx tools/cca/ota-tx-loopback.ts --track 1
 *
 *   # Add SDR validation against a pre-recorded IQ:
 *   npx tsx tools/cca/ota-tx-loopback.ts --track 2 --sdr-iq /tmp/cap.iq
 *
 *   # Capture IQ live during the test (requires rtl_sdr in PATH):
 *   npx tsx tools/cca/ota-tx-loopback.ts --track 2 --rtl-sdr
 *
 *   # Tweak the synthetic body size:
 *   npx tsx tools/cca/ota-tx-loopback.ts --chunks 8
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { existsSync, unlinkSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type OtaPacket,
  packetsEqualIgnoringSeq,
  walkOtaPackets,
} from "../../lib/cca-ota-tx-builder";
import { config } from "../../lib/config";

// --- Stream protocol constants (mirror firmware/src/net/stream.h) ---
const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_TX_RAW_CCA = 0x01;
const STREAM_CMD_OTA_UPLOAD_START = 0x18;
const STREAM_CMD_OTA_UPLOAD_CHUNK = 0x19;
const STREAM_CMD_OTA_UPLOAD_END = 0x1a;
const STREAM_CMD_TEXT = 0x20;
const STREAM_FLAG_TX = 0x80;
const STREAM_FLAG_CCX = 0x40;
const STREAM_RESP_TEXT = 0xfd;
const STREAM_HEARTBEAT = 0xff;
const PORT = 9433;
const CCA_FREQ = 433_602_844;

// --- CLI arg parsing ---
const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(name);

function parseHex(s: string): number {
  return Number.parseInt(s.replace(/^0x/i, ""), 16);
}

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join(" ");
}

// --- Synthetic body generator (deterministic, no LDF needed) ---
function synthBody(numChunks: number): Uint8Array {
  const body = new Uint8Array(numChunks * 31);
  for (let i = 0; i < body.length; i++) {
    // Deterministic, reasonably-distributed pattern.
    body[i] = (i * 0x9e + 0x37) & 0xff;
  }
  return body;
}

// --- Stream framing ---
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

/** Parse one stream datagram. Returns null for heartbeats and non-CCA frames. */
function parseTxEcho(msg: Buffer): Uint8Array | null {
  if (msg.length < 2) return null;
  const flags = msg[0];
  if (flags === STREAM_HEARTBEAT) return null;
  if (flags === STREAM_RESP_TEXT) return null;
  // We want CCA TX echoes only: TX bit set (0x80), CCX bit clear.
  if ((flags & STREAM_FLAG_TX) === 0) return null;
  if ((flags & STREAM_FLAG_CCX) !== 0) return null;
  // Wire: [FLAGS:1][LEN:1][TS_MS:4][TS_CYC:4][DATA:N]
  if (msg.length < 10) return null;
  const len = msg[1];
  if (msg.length < 10 + len) return null;
  return new Uint8Array(msg.subarray(10, 10 + len));
}

// --- Filtering: only consider packets addressed to our bogus subnet+serial ---
function isOurOtaPacket(
  pkt: Uint8Array,
  subnet: number,
  targetSerial: number,
): boolean {
  if (pkt.length < 16) return false;
  const subnetByte = (pkt[3] << 8) | pkt[4];
  if (subnetByte !== (subnet & 0xffff)) return false;
  const serialByte =
    (pkt[9] * 0x1000000 + pkt[10] * 0x10000 + pkt[11] * 0x100 + pkt[12]) >>> 0;
  if (serialByte !== targetSerial >>> 0) return false;
  // Sub-opcode at offset 14 must be 0x06 (OTA on-air sub-op marker).
  if (pkt[14] !== 0x06) return false;
  return true;
}

// --- Match expected packets against a bag of received packets ---
interface MatchSummary {
  expectedCount: number;
  matched: boolean[];
  matchCounts: number[];
  unmatchedReceivedCount: number;
}

function matchPackets(
  expected: OtaPacket[],
  received: Uint8Array[],
): MatchSummary {
  const matched = new Array(expected.length).fill(false);
  const matchCounts = new Array(expected.length).fill(0);
  const recvUsed = new Array(received.length).fill(false);
  for (let r = 0; r < received.length; r++) {
    for (let e = 0; e < expected.length; e++) {
      if (packetsEqualIgnoringSeq(expected[e].pkt, received[r])) {
        matched[e] = true;
        matchCounts[e]++;
        recvUsed[r] = true;
        break; // count once per received packet
      }
    }
  }
  const unmatchedReceivedCount = recvUsed.filter((u) => !u).length;
  return {
    expectedCount: expected.length,
    matched,
    matchCounts,
    unmatchedReceivedCount,
  };
}

function printMatchTable(
  channel: string,
  expected: OtaPacket[],
  summary: MatchSummary,
): void {
  console.log(`\n--- ${channel} match table ---`);
  for (let i = 0; i < expected.length; i++) {
    const status = summary.matched[i] ? "OK" : "MISS";
    const count = summary.matchCounts[i];
    console.log(
      `  [${status.padStart(4)}] ${expected[i].label.padEnd(20)} (×${count})  ${hex(expected[i].pkt).slice(0, 80)}…`,
    );
  }
  if (summary.unmatchedReceivedCount > 0) {
    console.log(
      `  + ${summary.unmatchedReceivedCount} ${channel.toLowerCase()} packet(s) did not match any expected (likely retransmit-counter mismatch or stray traffic on the bogus addr — investigate if non-zero with --debug)`,
    );
  }
}

// --- Main flows ---

async function runTrack2(
  expected: OtaPacket[],
  host: string,
  cadenceMs: number,
): Promise<Uint8Array[]> {
  console.log(
    `[loopback] Track 2 (host-side path): sending ${expected.length} packets via STREAM_CMD_TX_RAW_CCA`,
  );
  const sock = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(0, () => resolve());
  });

  const echoes: Uint8Array[] = [];
  sock.on("message", (msg) => {
    const e = parseTxEcho(msg);
    if (e) echoes.push(e);
  });

  // Register as a stream client.
  sendStream(sock, host, STREAM_CMD_KEEPALIVE, new Uint8Array(0));
  await sleep(150);

  for (const { pkt } of expected) {
    sendStream(sock, host, STREAM_CMD_TX_RAW_CCA, pkt);
    await sleep(cadenceMs);
  }

  // Grace period for echoes (TDMA retx + lwIP forwarding).
  await sleep(2000);
  sock.close();
  return echoes;
}

async function runTrack1(
  body: Uint8Array,
  subnet: number,
  serial: number,
  host: string,
  expected: OtaPacket[],
): Promise<Uint8Array[]> {
  console.log(
    `[loopback] Track 1 (firmware-side orchestrator): uploading ${body.length} bytes + cca ota-tx ${subnet.toString(16)} ${serial.toString(16)}`,
  );
  const sock = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(0, () => resolve());
  });

  const echoes: Uint8Array[] = [];
  sock.on("message", (msg) => {
    const e = parseTxEcho(msg);
    if (e) echoes.push(e);
  });

  sendStream(sock, host, STREAM_CMD_KEEPALIVE, new Uint8Array(0));
  await sleep(150);

  // 1. Upload START
  const startData = new Uint8Array(4);
  new DataView(startData.buffer).setUint32(0, body.length, true);
  sendStream(sock, host, STREAM_CMD_OTA_UPLOAD_START, startData);
  await sleep(50);

  // 2. Upload CHUNKS (240-byte windows; firmware computes offset = idx * 240).
  const CHUNK_BYTES = 240;
  const numChunks = Math.ceil(body.length / CHUNK_BYTES);
  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    const off = chunkIdx * CHUNK_BYTES;
    const slice = body.subarray(off, Math.min(off + CHUNK_BYTES, body.length));
    const data = new Uint8Array(2 + slice.length);
    data[0] = (chunkIdx >> 8) & 0xff;
    data[1] = chunkIdx & 0xff;
    data.set(slice, 2);
    sendStream(sock, host, STREAM_CMD_OTA_UPLOAD_CHUNK, data);
    if ((chunkIdx & 0x0f) === 0x0f) await sleep(5);
  }
  await sleep(80);

  // 3. Upload END
  sendStream(sock, host, STREAM_CMD_OTA_UPLOAD_END, new Uint8Array(0));
  await sleep(100);

  // 4. Trigger orchestrator via shell text command.
  const cmd = `cca ota-tx ${subnet.toString(16).padStart(4, "0")} ${serial.toString(16).padStart(8, "0")}`;
  sendStream(sock, host, STREAM_CMD_TEXT, Buffer.from(cmd, "utf-8"));

  // 5. Wait for the orchestrator: 75 ms cadence × expected packets, with margin.
  const orchestratorMs = expected.length * 75 + 3000;
  console.log(
    `[loopback] Awaiting orchestrator output (${(orchestratorMs / 1000).toFixed(1)}s)…`,
  );
  await sleep(orchestratorMs);
  sock.close();
  return echoes;
}

// --- SDR validation ---
async function decodeIqJsonl(iqPath: string): Promise<Uint8Array[]> {
  console.log(
    `[loopback] Decoding IQ via rtlsdr-cca-decode --jsonl: ${iqPath}`,
  );
  const result = spawnSync(
    "npx",
    ["tsx", "tools/cca/rtlsdr-cca-decode.ts", "--jsonl", iqPath],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    console.error(`[loopback] rtlsdr-cca-decode failed: ${result.stderr}`);
    return [];
  }
  const packets: Uint8Array[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as { hex: string };
      const bytes = obj.hex.split(" ").map((b) => parseInt(b, 16));
      // The hex includes the 2-byte CRC; strip it (builders are pre-CRC).
      if (bytes.length < 4) continue;
      packets.push(new Uint8Array(bytes.slice(0, -2)));
    } catch {
      // skip malformed
    }
  }
  return packets;
}

async function captureRtlSdr(
  outFile: string,
  durationSec: number,
): Promise<ChildProcess> {
  console.log(
    `[loopback] Starting rtl_sdr capture for ${durationSec}s -> ${outFile}`,
  );
  const proc = spawn(
    "rtl_sdr",
    [
      "-f",
      String(CCA_FREQ),
      "-s",
      "2000000",
      "-g",
      "40",
      "-n",
      String(2_000_000 * durationSec),
      outFile,
    ],
    { stdio: "ignore" },
  );
  // Give rtl_sdr a moment to settle on frequency.
  await sleep(500);
  return proc;
}

// --- Main ---
async function main(): Promise<void> {
  const track = parseInt(getArg("--track") ?? "2", 10);
  const subnet = parseHex(getArg("--subnet") ?? "0xDEAD");
  const serial = parseHex(getArg("--serial") ?? "DEADBEEF");
  const numChunks = parseInt(getArg("--chunks") ?? "5", 10);
  const cadenceMs = parseInt(getArg("--cadence-ms") ?? "75", 10);
  const host = getArg("--host") ?? config.openBridge;
  const sdrIq = getArg("--sdr-iq");
  const useRtlSdr = hasFlag("--rtl-sdr");
  const keepIq = hasFlag("--keep-iq");

  if (track !== 1 && track !== 2) {
    console.error("--track must be 1 or 2");
    process.exit(2);
  }

  console.log(
    `[loopback] mode=track${track} subnet=0x${subnet.toString(16)} serial=0x${serial.toString(16)} chunks=${numChunks}`,
  );

  // Build expected packet sequence (BeginTransfer + N TransferData with carrier rotation).
  const body = synthBody(numChunks);
  const expected = [...walkOtaPackets(body, subnet, serial)];
  console.log(`[loopback] Expected ${expected.length} packets:`);
  for (const e of expected)
    console.log(`  ${e.label.padEnd(20)} ${hex(e.pkt)}`);

  // Optional: spawn rtl_sdr to capture during the test.
  let sdrProc: ChildProcess | null = null;
  let sdrOutFile = sdrIq;
  if (useRtlSdr && !sdrIq) {
    sdrOutFile = `/tmp/ota-loopback-${Date.now()}.iq`;
    const orchestratorMs =
      track === 1
        ? expected.length * 75 + 3000
        : expected.length * cadenceMs + 2000;
    sdrProc = await captureRtlSdr(
      sdrOutFile,
      Math.ceil(orchestratorMs / 1000) + 2,
    );
  }

  // Run the chosen track.
  let echoes: Uint8Array[] = [];
  if (track === 2) {
    echoes = await runTrack2(expected, host, cadenceMs);
  } else {
    echoes = await runTrack1(body, subnet, serial, host, expected);
  }

  // Wait for rtl_sdr to finish writing.
  if (sdrProc) {
    await new Promise<void>((resolve) => {
      sdrProc!.once("exit", () => resolve());
      sdrProc!.once("close", () => resolve());
      // Fail-safe: rtl_sdr -n exits on its own when sample count reached.
      sleep(5000).then(() => {
        try {
          sdrProc!.kill();
        } catch {
          /* ignored */
        }
        resolve();
      });
    });
  }

  // Filter and report TX echoes.
  const ourEchoes = echoes.filter((e) => isOurOtaPacket(e, subnet, serial));
  console.log(
    `[loopback] TX echoes: ${ourEchoes.length} addressed to our bogus target (${echoes.length} total received)`,
  );
  const echoSummary = matchPackets(expected, ourEchoes);
  printMatchTable("TX echo", expected, echoSummary);

  let sdrSummary: MatchSummary | null = null;
  if (sdrOutFile) {
    if (!existsSync(sdrOutFile)) {
      console.error(`[loopback] SDR IQ file not found: ${sdrOutFile}`);
    } else {
      const sdrPackets = await decodeIqJsonl(sdrOutFile);
      const ourSdr = sdrPackets.filter((p) =>
        isOurOtaPacket(p, subnet, serial),
      );
      console.log(
        `[loopback] SDR decoded: ${ourSdr.length} addressed to our bogus target (${sdrPackets.length} total CRC-OK)`,
      );
      sdrSummary = matchPackets(expected, ourSdr);
      printMatchTable("SDR off-air", expected, sdrSummary);
      if (useRtlSdr && !keepIq) {
        try {
          unlinkSync(sdrOutFile);
        } catch {
          /* ignored */
        }
      }
    }
  }

  // Final verdict.
  console.log("\n--- Verdict ---");
  const echoOk = echoSummary.matched.every((m) => m);
  console.log(`  TX echo:    ${echoOk ? "PASS" : "FAIL"}`);
  if (sdrSummary) {
    const sdrOk = sdrSummary.matched.every((m) => m);
    console.log(`  SDR off-air: ${sdrOk ? "PASS" : "FAIL"}`);
    process.exit(echoOk && sdrOk ? 0 : 1);
  } else {
    console.log(
      "  SDR off-air: SKIPPED (pass --sdr-iq <file> or --rtl-sdr to enable)",
    );
    process.exit(echoOk ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
