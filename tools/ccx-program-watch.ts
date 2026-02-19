#!/usr/bin/env bun

/**
 * CCX Programming Watcher - live CoAP/CBOR decode for /cg/db programming traffic.
 *
 * Usage:
 *   bun run tools/ccx-program-watch.ts --live
 *   bun run tools/ccx-program-watch.ts --live --iface /dev/cu.usbmodem201401 --channel 25
 *   bun run tools/ccx-program-watch.ts --file /tmp/capture.pcapng
 *
 * Notes:
 *   - Assumes Wireshark/tshark has Thread decryption configured (same as existing tooling).
 *   - Uses Decode-As udp.port 5683 -> coap.
 */

import { Decoder } from "cbor-x";
import { spawn } from "child_process";
import { CCX_CONFIG } from "../ccx/config";

const decoder = new Decoder({ mapsAsObjects: false });
const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function usage() {
  console.log(`
CCX Programming Watcher (real-time CoAP + CBOR)

Usage:
  bun run tools/ccx-program-watch.ts --live
  bun run tools/ccx-program-watch.ts --file <capture.pcapng>

Options:
  --live                 Live capture from nRF sniffer (default if --file omitted)
  --file <path>          Read packets from pcap/pcapng
  --iface <device>       Capture interface (default: /dev/cu.usbmodem201401)
  --channel <n>          802.15.4 channel for extcap (default: ${CCX_CONFIG.channel || 25})
  --duration <sec>       Stop after duration when in --live mode
  --all                  Show all CoAP on UDP/5683 (default: focus on /cg/db*)
  --json                 JSON output (one event per line)

Examples:
  bun run tools/ccx-program-watch.ts --live --iface /dev/cu.usbmodem201401 --channel 25
  bun run tools/ccx-program-watch.ts --file /tmp/lutron-sniff/live/lutron-thread-ch25_00001_20260217235133.pcapng
`);
}

const fileMode = getArg("--file");
const liveMode = hasFlag("--live") || !fileMode;
const iface = getArg("--iface") ?? "/dev/cu.usbmodem201401";
const channel = Number.parseInt(
  getArg("--channel") ?? String(CCX_CONFIG.channel || 25),
  10,
);
const duration = getArg("--duration");
const allCoap = hasFlag("--all");
const json = hasFlag("--json");

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

if (!Number.isFinite(channel)) {
  console.error("Invalid --channel");
  process.exit(1);
}

function detectExtcapKey(ifaceName: string): string {
  return ifaceName.replace(/[^A-Za-z0-9]/g, "_");
}

function codeToString(code: number): string {
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

function typeToString(type: number): string {
  if (type === 0) return "CON";
  if (type === 1) return "NON";
  if (type === 2) return "ACK";
  if (type === 3) return "RST";
  return `TYPE(${type})`;
}

function normalizeDecoded(x: unknown): unknown {
  if (x instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of x.entries()) {
      out[String(k)] = normalizeDecoded(v);
    }
    return out;
  }
  if (Array.isArray(x)) return x.map(normalizeDecoded);
  if (x instanceof Uint8Array) return Buffer.from(x).toString("hex");
  return x;
}

function decodeCbor(hex: string): unknown | null {
  const clean = hex.replace(/[:\s]/g, "");
  if (!clean) return null;
  try {
    return normalizeDecoded(decoder.decode(Buffer.from(clean, "hex")));
  } catch {
    return null;
  }
}

function pct(v: number): string {
  return `${((v / 65279) * 100).toFixed(1)}%`;
}

function annotation(path: string, decoded: unknown): string | null {
  if (!Array.isArray(decoded) || decoded.length < 2) return null;
  const op = decoded[0];
  const body = decoded[1];
  if (typeof op !== "number" || typeof body !== "object" || body == null) {
    return null;
  }
  const m = body as Record<string, unknown>;

  if (path === "/cg/db/ct/c/AAI" && op === 3) {
    const hi = typeof m["2"] === "number" ? (m["2"] as number) : null;
    const lo = typeof m["3"] === "number" ? (m["3"] as number) : null;
    const profile = typeof m["8"] === "number" ? (m["8"] as number) : null;
    const parts: string[] = [];
    if (hi != null) parts.push(`high=${hi} (${pct(hi)})`);
    if (lo != null) parts.push(`low=${lo} (${pct(lo)})`);
    if (profile != null) parts.push(`k8=${profile}`);
    return parts.length ? `trim ${parts.join(", ")}` : null;
  }

  if (path === "/cg/db/ct/c/AHA" && op === 108) {
    const k4 = typeof m["4"] === "number" ? (m["4"] as number) : null;
    const k5 = typeof m["5"] === "number" ? (m["5"] as number) : null;
    if (k4 != null || k5 != null) {
      return `status-led activated=${k4 ?? "?"} deactivated=${k5 ?? "?"}`;
    }
  }

  return null;
}

function shortTime(epochSec: string): string {
  const epoch = Number.parseFloat(epochSec);
  if (!Number.isFinite(epoch)) return "??:??:??.???";
  const d = new Date(epoch * 1000);
  return d.toISOString().slice(11, 23);
}

function buildTsharkArgs(): string[] {
  const out: string[] = [];
  if (fileMode) {
    out.push("-r", fileMode);
  } else if (liveMode) {
    out.push("-i", iface);
    const extcapKey = detectExtcapKey(iface);
    out.push("-o", `extcap.${extcapKey}.channel:${channel}`);
    out.push("-o", `extcap.${extcapKey}.metadata:ieee802154-tap`);
    if (duration) out.push("-a", `duration:${duration}`);
  }

  out.push("-l");
  out.push("-d", "udp.port==5683,coap");
  out.push("-Y", "udp.port==5683 && coap");
  out.push(
    "-T",
    "fields",
    "-e",
    "frame.time_epoch",
    "-e",
    "frame.number",
    "-e",
    "ipv6.src",
    "-e",
    "ipv6.dst",
    "-e",
    "coap.type",
    "-e",
    "coap.code",
    "-e",
    "coap.mid",
    "-e",
    "coap.token",
    "-e",
    "coap.opt.uri_path_recon",
    "-e",
    "data",
    "-E",
    "separator=\t",
    "-E",
    "occurrence=f",
  );
  return out;
}

const tokenPath = new Map<string, string>();

function shouldShow(path: string | null): boolean {
  if (allCoap) return true;
  return !!path && path.startsWith("/cg/db");
}

function processLine(line: string) {
  if (!line.trim()) return;
  const f = line.split("\t");
  if (f.length < 10) return;

  const [
    epoch,
    frameNo,
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

  const isRequest = Number.isFinite(code) && code >= 1 && code <= 4;
  if (isRequest && token && path) {
    tokenPath.set(token, path);
  }
  if (!path && token && tokenPath.has(token)) {
    path = tokenPath.get(token) ?? "";
  }

  if (!shouldShow(path || null)) return;

  const decoded = payloadHex ? decodeCbor(payloadHex) : null;
  const note = path ? annotation(path, decoded) : null;

  const event = {
    t: shortTime(epoch),
    frame: Number(frameNo),
    src,
    dst,
    type: typeToString(type),
    code: codeToString(code),
    mid: Number.isFinite(Number(midStr)) ? Number(midStr) : null,
    token: token || null,
    path: path || null,
    payloadHex: payloadHex || null,
    cbor: decoded,
    note,
  };

  if (json) {
    console.log(JSON.stringify(event));
    return;
  }

  const header = `${event.t} #${event.frame} ${event.type} ${event.code} ${event.src} -> ${event.dst}${event.path ? ` ${event.path}` : ""}${event.token ? ` tok=${event.token}` : ""}${event.mid != null ? ` mid=${event.mid}` : ""}`;
  console.log(header);
  if (event.payloadHex) console.log(`  payload=${event.payloadHex}`);
  if (event.cbor != null) console.log(`  cbor=${JSON.stringify(event.cbor)}`);
  if (event.note) console.log(`  note=${event.note}`);
}

async function main() {
  const tsharkArgs = buildTsharkArgs();
  if (!json) {
    console.log(
      `Watching ${fileMode ? `file=${fileMode}` : `live iface=${iface} channel=${channel}`} (filter: udp 5683 coap${allCoap ? "" : ", /cg/db*"})`,
    );
  }

  const p = spawn("tshark", tsharkArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";

  p.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });

  p.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (!msg) return;
    if (
      msg.includes("Capturing on") ||
      msg.includes("packets captured") ||
      msg.includes("File:")
    ) {
      if (!json) console.error(`[tshark] ${msg}`);
      return;
    }
    console.error(`[tshark] ${msg}`);
  });

  p.on("error", (err) => {
    console.error(`Failed to start tshark: ${(err as Error).message}`);
    process.exit(1);
  });

  p.on("close", (code) => {
    if (!json) console.log(`tshark exited (${code ?? 0})`);
  });

  process.on("SIGINT", () => {
    p.kill("SIGTERM");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
