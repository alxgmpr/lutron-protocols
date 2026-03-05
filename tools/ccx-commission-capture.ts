#!/usr/bin/env bun

/**
 * CCX Commission Capture — specialized tool for capturing Sunnata/device commissioning.
 *
 * Listens on both planes simultaneously:
 *   - Runtime: UDP:9190 multicast (LEVEL_CONTROL, PRESENCE, STATUS, DEVICE_REPORT, etc.)
 *   - Programming: UDP:5683 CoAP via tshark (DELETE /cg/db, PUT /cg/db/ct/c/*, POST /cg/db/pr/c/*, etc.)
 *
 * Features:
 *   - Detects new IPv6 addresses (first-seen during session)
 *   - Timestamps relative to capture start
 *   - Annotates known message types
 *   - Saves structured JSON log for post-capture analysis
 *   - Correlates messages by device IPv6
 *
 * Usage:
 *   bun run tools/ccx-commission-capture.ts --live
 *   bun run tools/ccx-commission-capture.ts --live --output /tmp/commission-capture.jsonl
 *   bun run tools/ccx-commission-capture.ts --live --iface /dev/cu.usbmodem201401 --channel 25
 */

import { Decoder } from "cbor-x";
import { spawn } from "child_process";
import { createWriteStream, type WriteStream } from "fs";
import { createSocket, type Socket } from "dgram";
import { CCX_CONFIG, getZoneName } from "../ccx/config";
import { decodeBytes, formatMessage, getMessageTypeName } from "../ccx/decoder";
import { decode as cborDecode } from "cbor-x";

const decoder = new Decoder({ mapsAsObjects: false });
const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

const iface = getArg("--iface") ?? "/dev/cu.usbmodem201401";
const channel = Number.parseInt(
  getArg("--channel") ?? String(CCX_CONFIG.channel || 25),
  10,
);
const threadIface = getArg("--thread-iface") ?? "utun8";
const outputPath = getArg("--output");
const jsonMode = hasFlag("--json");
const PORT = CCX_CONFIG.udpPort;
const MULTICAST_ADDR = "ff03::1";

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`
CCX Commission Capture — dual-plane commissioning event recorder

Usage:
  bun run tools/ccx-commission-capture.ts --live
  bun run tools/ccx-commission-capture.ts --live --output /tmp/capture.jsonl

Options:
  --live                 Live capture (default)
  --iface <device>       802.15.4 sniffer interface (default: /dev/cu.usbmodem201401)
  --channel <n>          802.15.4 channel (default: ${CCX_CONFIG.channel || 25})
  --thread-iface <name>  Thread network interface for runtime listener (default: utun8)
  --output <path>        Save events to JSONL file
  --json                 JSON output to stdout (one event per line)

Captures:
  - Runtime plane (UDP:${PORT}): LEVEL_CONTROL, PRESENCE, STATUS, DEVICE_REPORT, etc.
  - Programming plane (UDP:5683): CoAP /cg/db/* programming traffic via tshark
  - Detects new IPv6 addresses appearing during capture
`);
  process.exit(0);
}

// --- State ---

const startTime = Date.now();
const knownAddresses = new Set<string>();
let outputStream: WriteStream | null = null;
let eventCount = 0;

interface CaptureEvent {
  t: number; // ms since start
  ts: string; // ISO timestamp
  plane: "runtime" | "programming";
  type: string; // message type name
  src: string;
  dst: string;
  newDevice: boolean; // true if src was first seen this session
  detail: string; // human-readable summary
  raw?: unknown; // parsed CBOR/message for JSON mode
}

function relativeMs(): number {
  return Date.now() - startTime;
}

function shortTs(): string {
  return new Date().toISOString().slice(11, 23);
}

function normalizeIpv6(addr: string): string {
  return addr.replace(/%.*/, "").toLowerCase();
}

function checkNewDevice(addr: string): boolean {
  const norm = normalizeIpv6(addr);
  if (knownAddresses.has(norm)) return false;
  knownAddresses.add(norm);
  return true;
}

function emitEvent(event: CaptureEvent) {
  eventCount++;

  if (outputStream) {
    outputStream.write(JSON.stringify(event) + "\n");
  }

  if (jsonMode) {
    console.log(JSON.stringify(event));
    return;
  }

  const prefix = `+${(event.t / 1000).toFixed(3).padStart(8)}s`;
  const plane = event.plane === "runtime" ? "RT " : "PRG";
  const newTag = event.newDevice ? " [NEW]" : "";
  console.log(`${prefix} ${plane} ${event.type.padEnd(16)} ${event.src} → ${event.dst}${newTag}`);
  console.log(`         ${event.detail}`);
}

// --- Runtime plane listener (UDP:9190) ---

function startRuntimeListener(): Socket {
  const sock = createSocket({ type: "udp6", reuseAddr: true });

  sock.on("message", (msg, rinfo) => {
    const src = normalizeIpv6(rinfo.address);
    const isNew = checkNewDevice(src);

    try {
      const parsed = decodeBytes(msg);
      const rawArr = cborDecode(msg) as unknown[];
      const typeName = getMessageTypeName(rawArr[0] as number);
      const formatted = formatMessage(parsed);

      let annotation = "";
      if (parsed.type === "LEVEL_CONTROL") {
        const zoneName = getZoneName(parsed.zoneId);
        if (zoneName) annotation = ` [${zoneName}]`;
      }

      emitEvent({
        t: relativeMs(),
        ts: shortTs(),
        plane: "runtime",
        type: typeName,
        src,
        dst: MULTICAST_ADDR,
        newDevice: isNew,
        detail: `${formatted}${annotation}`,
        raw: jsonMode ? { msgType: rawArr[0], body: rawArr[1] } : undefined,
      });
    } catch (err) {
      emitEvent({
        t: relativeMs(),
        ts: shortTs(),
        plane: "runtime",
        type: "DECODE_ERROR",
        src,
        dst: MULTICAST_ADDR,
        newDevice: isNew,
        detail: `${(err as Error).message}: ${msg.toString("hex").slice(0, 80)}`,
      });
    }
  });

  sock.bind(PORT, () => {
    sock.addMembership(MULTICAST_ADDR, `::%${threadIface}`);
    console.log(`Runtime listener: ${threadIface} port ${PORT} (multicast ${MULTICAST_ADDR})`);
  });

  sock.on("error", (err) => {
    console.error(`Runtime listener error: ${err.message}`);
  });

  return sock;
}

// --- Programming plane (tshark on UDP:5683) ---

function detectExtcapKey(ifaceName: string): string {
  return ifaceName.replace(/[^A-Za-z0-9]/g, "_");
}

function coapCodeStr(code: number): string {
  if (!Number.isFinite(code)) return "?";
  if (code === 0) return "0.00";
  if (code <= 31) {
    if (code === 1) return "GET";
    if (code === 2) return "POST";
    if (code === 3) return "PUT";
    if (code === 4) return "DELETE";
    return `REQ(${code})`;
  }
  const cls = code >> 5;
  const detail = code & 0x1f;
  return `${cls}.${detail.toString().padStart(2, "0")}`;
}

function coapTypeStr(type: number): string {
  if (type === 0) return "CON";
  if (type === 1) return "NON";
  if (type === 2) return "ACK";
  if (type === 3) return "RST";
  return `TYPE(${type})`;
}

function decodeCbor(hex: string): unknown | null {
  const clean = hex.replace(/[:\s]/g, "");
  if (!clean) return null;
  try {
    const v = decoder.decode(Buffer.from(clean, "hex"));
    const norm = (x: unknown): unknown => {
      if (x instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [k, vv] of x.entries()) out[String(k)] = norm(vv);
        return out;
      }
      if (Array.isArray(x)) return x.map(norm);
      if (x instanceof Uint8Array) return Buffer.from(x).toString("hex");
      return x;
    };
    return norm(v);
  } catch {
    return null;
  }
}

const tokenPath = new Map<string, string>();

function startProgrammingWatcher(): ReturnType<typeof spawn> {
  const extcapKey = detectExtcapKey(iface);

  const tsharkArgs = [
    "-i", iface,
    "-o", `extcap.${extcapKey}.channel:${channel}`,
    "-o", `extcap.${extcapKey}.metadata:ieee802154-tap`,
    "-l",
    "-d", "udp.port==5683,coap",
    "-Y", "udp.port==5683 && coap",
    "-T", "fields",
    "-e", "frame.time_epoch",
    "-e", "frame.number",
    "-e", "ipv6.src",
    "-e", "ipv6.dst",
    "-e", "coap.type",
    "-e", "coap.code",
    "-e", "coap.mid",
    "-e", "coap.token",
    "-e", "coap.opt.uri_path_recon",
    "-e", "data",
    "-E", "separator=\t",
    "-E", "occurrence=f",
  ];

  const p = spawn("tshark", tsharkArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";

  p.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) processTsharkLine(line);
  });

  p.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (!msg) return;
    if (
      msg.includes("Capturing on") ||
      msg.includes("packets captured") ||
      msg.includes("File:")
    ) {
      console.error(`[tshark] ${msg}`);
      return;
    }
    console.error(`[tshark] ${msg}`);
  });

  p.on("error", (err) => {
    console.error(`Failed to start tshark: ${(err as Error).message}`);
    console.error("Programming plane capture unavailable — runtime-only mode");
  });

  p.on("close", (code) => {
    console.log(`tshark exited (${code ?? 0})`);
  });

  return p;
}

function processTsharkLine(line: string) {
  if (!line.trim()) return;
  const f = line.split("\t");
  if (f.length < 10) return;

  const [
    _epoch,
    _frameNo,
    src,
    dst,
    typeStr,
    codeStr,
    midStr,
    tokenRaw,
    pathRaw,
    dataRaw,
  ] = f;

  const type = Number.parseInt(typeStr || "", 10);
  const code = Number.parseInt(codeStr || "", 10);
  const token = (tokenRaw ?? "").replace(/:/g, "").toLowerCase();
  let path = pathRaw || "";
  const payloadHex = (dataRaw ?? "").replace(/[:\s]/g, "").toLowerCase();

  // Track token→path for response correlation
  const isRequest = Number.isFinite(code) && code >= 1 && code <= 4;
  if (isRequest && token && path) {
    tokenPath.set(token, path);
  }
  if (!path && token && tokenPath.has(token)) {
    path = tokenPath.get(token) ?? "";
  }

  const srcNorm = normalizeIpv6(src || "");
  const dstNorm = normalizeIpv6(dst || "");
  const srcNew = srcNorm ? checkNewDevice(srcNorm) : false;
  if (dstNorm) checkNewDevice(dstNorm);

  const coapCode = coapCodeStr(code);
  const coapType = coapTypeStr(type);
  const decoded = payloadHex ? decodeCbor(payloadHex) : null;

  // Build detail string
  const parts: string[] = [];
  parts.push(`${coapType} ${coapCode}`);
  if (path) parts.push(path);
  if (midStr) parts.push(`mid=${midStr}`);
  if (decoded != null) parts.push(`cbor=${JSON.stringify(decoded)}`);
  else if (payloadHex) parts.push(`payload=${payloadHex.slice(0, 60)}`);

  // Classify the event type
  let eventType = "COAP";
  if (path.startsWith("/cg/db")) {
    if (code === 4) eventType = "DB_DELETE";
    else if (code === 3) eventType = "DB_PUT";
    else if (code === 2) eventType = "DB_POST";
    else if (code === 1) eventType = "DB_GET";
    else eventType = `DB_${coapCode}`;
  }

  emitEvent({
    t: relativeMs(),
    ts: shortTs(),
    plane: "programming",
    type: eventType,
    src: srcNorm,
    dst: dstNorm,
    newDevice: srcNew,
    detail: parts.join(" "),
    raw: jsonMode ? { type, code, mid: midStr, token, path, cbor: decoded } : undefined,
  });
}

// --- Main ---

async function main() {
  console.log("CCX Commission Capture");
  console.log("======================");
  console.log(`Start time: ${new Date().toISOString()}`);
  console.log(`802.15.4 sniffer: ${iface} channel ${channel}`);
  console.log(`Thread interface: ${threadIface}`);

  if (outputPath) {
    outputStream = createWriteStream(outputPath, { flags: "a" });
    console.log(`Output file: ${outputPath}`);
  }

  console.log("");
  console.log("Waiting for commissioning events... (Ctrl+C to stop)");
  console.log("");

  const runtimeSock = startRuntimeListener();
  const tsharkProc = startProgrammingWatcher();

  const cleanup = () => {
    console.log(`\n--- Capture complete: ${eventCount} events, ${knownAddresses.size} unique addresses ---`);
    console.log("Addresses seen:");
    for (const addr of knownAddresses) {
      console.log(`  ${addr}`);
    }
    tsharkProc.kill("SIGTERM");
    runtimeSock.close();
    if (outputStream) {
      outputStream.end();
      console.log(`Events saved to: ${outputPath}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
