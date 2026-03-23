#!/usr/bin/env npx tsx
/**
 * cca-capture — Headless CCA packet capture with interactive commands
 *
 * Connects to Nucleo stream (UDP:9433), decodes and logs all CCA packets.
 * Outputs decoded packets to stdout and saves raw CSV to captures/cca-sessions/.
 * Supports sending shell commands to the Nucleo (type and press Enter).
 *
 * Usage:
 *   npx tsx tools/cca-capture.ts [name]               # capture only
 *   npx tsx tools/cca-capture.ts dvrf-test --raw       # include raw hex in stdout
 *
 * While running, type any Nucleo shell command and press Enter:
 *   cca beacon 00000001 60    — start 60s discovery beacon
 *   cca pair bridge ...       — bridge pairing
 *   status                    — query Nucleo status
 *   rx on                     — ensure CCA RX is active
 */

import { createSocket } from "dgram";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { identifyPacket, parseFieldValue } from "../protocol/protocol-ui";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(name);

const host = getArg("--host") ?? process.env.NUCLEO_HOST ?? "10.0.0.3";
const showRaw = hasFlag("--raw");
const sessionName =
  args.find((a) => !a.startsWith("--") && a !== getArg("--host")) || "capture";

// Stream protocol constants
const UDP_PORT = 9433;
const CMD_KEEPALIVE = 0x00;
const CMD_TEXT = 0x20;
const RESP_TEXT = 0xfd;
const FLAG_TX = 0x80;
const FLAG_CCX = 0x40;
const FLAG_RSSI_MASK = 0x3f;

// ANSI colors
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const WHITE = "\x1b[37m";

// Output file setup
const CAPTURES_DIR = join(
  new URL(".", import.meta.url).pathname,
  "../captures/cca-sessions",
);
mkdirSync(CAPTURES_DIR, { recursive: true });
const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, "_");
const csvFile = join(CAPTURES_DIR, `${safeName}_${ts}.csv`);
writeFileSync(
  csvFile,
  "timestamp,direction,type,category,device_id,rssi,fields,raw_hex\n",
);

let packetCount = 0;
let connected = false;
const startTime = Date.now();

function readU32LE(buf: Buffer, off: number): number {
  return (
    buf[off] |
    (buf[off + 1] << 8) |
    (buf[off + 2] << 16) |
    ((buf[off + 3] << 24) >>> 0)
  );
}

function buildCmd(cmd: number, data?: Uint8Array | number[]): Buffer {
  const d = data ? new Uint8Array(data) : new Uint8Array(0);
  const frame = Buffer.alloc(2 + d.length);
  frame[0] = cmd;
  frame[1] = d.length;
  frame.set(d, 2);
  return frame;
}

function sendText(text: string) {
  const textBytes = new TextEncoder().encode(text);
  sock.send(
    buildCmd(CMD_TEXT, textBytes),
    0,
    2 + textBytes.length,
    UDP_PORT,
    host,
  );
}

// Decode and display a CCA packet
function handleCcaPacket(data: Buffer, flags: number, _radioTs: number) {
  const isTx = !!(flags & FLAG_TX);
  const rssi = isTx ? 0 : -(flags & FLAG_RSSI_MASK);
  const direction = isTx ? "TX" : "RX";

  try {
    const identified = identifyPacket(data);
    const typeName = identified.typeName;
    const category = identified.category;
    const seq = data.length > 1 ? data[1] : 0;
    const now = new Date().toISOString();
    const timeStr = now.slice(11, 23);

    const hexBytes = Array.from(data).map((b) =>
      b.toString(16).padStart(2, "0"),
    );
    const rawHex = hexBytes.join(" ");

    // Build field summary
    let deviceId = "";
    const fieldParts: string[] = [];
    for (const field of identified.fields) {
      if (field.name === "type" || field.name === "seq" || field.name === "crc")
        continue;
      const parsed = parseFieldValue(
        hexBytes,
        field.offset,
        field.size,
        field.format,
      );
      const val = parsed.decoded ?? parsed.raw;
      if (
        field.name === "device_id" ||
        field.name === "target_id" ||
        field.name === "hub_id"
      ) {
        if (!deviceId) deviceId = val;
      }
      fieldParts.push(`${field.name}=${val}`);
    }

    const catColor: Record<string, string> = {
      BUTTON: GREEN,
      STATE: BLUE,
      BEACON: YELLOW,
      PAIRING: MAGENTA,
      CONFIG: CYAN,
      HANDSHAKE: RED,
    };
    const typeColor = catColor[category] || WHITE;
    const dirColor = isTx ? MAGENTA : GREEN;

    const parts = [
      `${DIM}${timeStr}${RESET}`,
      `${dirColor}${direction}${RESET}`,
      `${typeColor}${typeName.padEnd(16)}${RESET}`,
      `seq=${seq.toString().padStart(3)}`,
      `rssi=${rssi.toString().padStart(3)}`,
    ];
    if (deviceId) parts.push(`dev=${deviceId}`);
    if (fieldParts.length > 0) parts.push(fieldParts.join(" "));
    if (showRaw) parts.push(`${DIM}${rawHex}${RESET}`);

    console.log(parts.join("  "));

    // CSV
    const csvFields = fieldParts.join("; ");
    const csvLine = `${now},${direction},${typeName},${category},${deviceId},${rssi},"${csvFields}",${rawHex}\n`;
    appendFileSync(csvFile, csvLine);
    packetCount++;
  } catch (err: any) {
    // Fallback: show raw hex if decoder fails
    const rawHex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    console.log(
      `${DIM}${new Date().toISOString().slice(11, 23)}${RESET}  ${direction}  ${RED}DECODE_ERR${RESET}  ${rawHex}`,
    );
    appendFileSync(
      csvFile,
      `${new Date().toISOString()},${direction},RAW_ERROR,,,${rssi},"${err.message}",${rawHex}\n`,
    );
    packetCount++;
  }
}

// UDP socket
const sock = createSocket("udp4");

sock.on("message", (msg: Buffer) => {
  if (msg.length < 2) return;

  const flags = msg[0];
  const len = msg[1];

  if (!connected) {
    connected = true;
    console.log(`${GREEN}Connected to Nucleo at ${host}:${UDP_PORT}${RESET}`);
    console.log(`Recording to: ${csvFile}`);
    console.log(
      `Type commands and press Enter (e.g. "cca beacon 00000001 60")`,
    );
    console.log(`${"—".repeat(80)}`);
  }

  // Heartbeat
  if (flags === 0xff && len === 0x00) return;

  // Text response
  if (flags === RESP_TEXT) {
    const text = msg.subarray(1).toString("utf-8").trim();
    if (text) console.log(`${DIM}> ${text}${RESET}`);
    return;
  }

  // Status response (0xFE)
  if (flags === 0xfe) return;

  // Packet frames: [FLAGS:1][LEN:1][TS_MS:4 LE][DATA:N]
  if (msg.length < 6 + len) return;

  const radioTs = readU32LE(msg, 2);
  const data = msg.subarray(6, 6 + len);
  const isCcx = !!(flags & FLAG_CCX);

  if (!isCcx) {
    handleCcaPacket(data, flags, radioTs);
  }
  // Silently skip CCX packets (focus on CCA)
});

sock.on("error", (err: Error) => {
  console.error(`${RED}UDP error: ${err.message}${RESET}`);
});

sock.bind(() => {
  console.log(
    `${YELLOW}Connecting to Nucleo at ${host}:${UDP_PORT}...${RESET}`,
  );

  // Register with stream server
  sock.send(buildCmd(CMD_KEEPALIVE), 0, 2, UDP_PORT, host);

  // Ensure CCA RX is on
  setTimeout(() => sendText("rx on"), 500);

  // Keepalive timer
  setInterval(() => {
    sock.send(buildCmd(CMD_KEEPALIVE), 0, 2, UDP_PORT, host);
  }, 5000);
});

// Interactive command input — only when stdin is a TTY
if (process.stdin.isTTY) {
  import("readline").then(({ createInterface }) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed === "quit" || trimmed === "exit") {
        cleanup();
        return;
      }
      console.log(`${CYAN}→ ${trimmed}${RESET}`);
      sendText(trimmed);
    });
  });
}

// Clean shutdown
function cleanup() {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n${YELLOW}Stopped. ${packetCount} packets in ${elapsed}s → ${csvFile}${RESET}`,
  );
  sock.close();
  process.exit(0);
}

process.on("SIGINT", cleanup);
