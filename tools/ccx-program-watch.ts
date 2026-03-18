#!/usr/bin/env -S npx tsx

/**
 * CCX Programming Watcher - live CoAP/CBOR decode for /cg/db programming traffic.
 *
 * Decodes all known CoAP programming paths:
 *   /cg/db              DELETE  Database clear
 *   /cg/db/pr/c/AAI     POST   Preset/scene level assignments
 *   /cg/db/mc/c/AAI     POST   Device→zone multicast group membership
 *   /cg/db/ct/c/AAI     PUT    Dimmer trim levels (opcode 3)
 *   /cg/db/ct/c/AHA     PUT    Status LED brightness (opcode 108)
 *   /cg/db/ct/c/AFE+    PUT    LED link indices for keypad buttons (opcode 107)
 *
 * Usage:
 *   npx tsx tools/ccx-program-watch.ts --live
 *   npx tsx tools/ccx-program-watch.ts --live --iface /dev/cu.usbmodem201401 --channel 25
 *   npx tsx tools/ccx-program-watch.ts --file /tmp/capture.pcapng
 *
 * Notes:
 *   - Assumes Wireshark/tshark has Thread decryption configured (same as existing tooling).
 *   - Uses Decode-As udp.port 5683 -> coap.
 */

import { Decoder } from "cbor-x";
import { spawn } from "child_process";
import {
  CCX_CONFIG,
  getDeviceName,
  getPresetInfo,
  getSceneName,
  getZoneName,
} from "../ccx/config";

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
  npx tsx tools/ccx-program-watch.ts --live
  npx tsx tools/ccx-program-watch.ts --file <capture.pcapng>

Options:
  --live                 Live capture from nRF sniffer (default if --file omitted)
  --file <path>          Read packets from pcap/pcapng
  --iface <device>       Capture interface (default: /dev/cu.usbmodem201401)
  --channel <n>          802.15.4 channel for extcap (default: ${CCX_CONFIG.channel || 25})
  --duration <sec>       Stop after duration when in --live mode
  --all                  Show all CoAP on UDP/5683 (default: focus on /cg/db*)
  --json                 JSON output (one event per line)

Known programming paths:
  /cg/db              DELETE  Clear device database before transfer
  /cg/db/pr/c/AAI     POST   Preset assignments: [72, {0: level, 3?: fade}]
  /cg/db/mc/c/AAI     POST   Zone membership: [<5-byte zone-id>]
  /cg/db/ct/c/AAI     PUT    Dimmer trim: [3, {2: high, 3: low, 8: profile}]
  /cg/db/ct/c/AHA     PUT    Status LED: [108, {4: active, 5: inactive}]
  /cg/db/ct/c/AF*     PUT    LED link: [107, {0: button_index}]

Examples:
  npx tsx tools/ccx-program-watch.ts --live --channel 25
  npx tsx tools/ccx-program-watch.ts --file captures/ccx-full-transfer.pcapng
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

// ── Rich annotation for all known /cg/db paths ─────────────────────

function annotation(
  path: string,
  code: number,
  decoded: unknown,
  dst: string,
): string | null {
  // DELETE /cg/db — database clear
  if (path === "/cg/db" && code === 4) {
    const devName = getDeviceName(dst);
    return devName ? `DB_CLEAR → ${devName}` : "DB_CLEAR";
  }

  // Preset assignments: /cg/db/pr/c/AAI POST
  if (path === "/cg/db/pr/c/AAI" && code === 2) {
    return annotatePresetAssignment(decoded, dst);
  }

  // Zone membership: /cg/db/mc/c/AAI POST
  if (path === "/cg/db/mc/c/AAI" && code === 2) {
    return annotateZoneMembership(decoded, dst);
  }

  // Configuration tables: /cg/db/ct/c/<bucket> PUT
  if (path.startsWith("/cg/db/ct/c/") && code === 3) {
    const bucket = path.slice("/cg/db/ct/c/".length);
    return annotateConfigTable(bucket, decoded, dst);
  }

  // CoAP ACK responses
  if (code > 31) {
    const devName = getDeviceName(dst);
    if (devName) return `→ ${devName}`;
  }

  return null;
}

/** Annotate /cg/db/pr/c/AAI — preset level assignments */
function annotatePresetAssignment(
  decoded: unknown,
  dst: string,
): string | null {
  if (typeof decoded !== "object" || decoded == null) return null;
  const m = decoded as Record<string, unknown>;

  // CBOR map: {<4-byte-key-hex>: [72, {0: level16, 3?: fade_qs}]}
  const parts: string[] = [];
  const devName = getDeviceName(dst);

  for (const [keyHex, value] of Object.entries(m)) {
    if (typeof keyHex !== "string" || keyHex.length < 8) continue;

    // Extract preset ID from 4-byte key (bytes 0-1 = BE uint16)
    const presetId = parseInt(keyHex.slice(0, 4), 16);

    if (!Array.isArray(value) || value.length < 2) continue;
    const opcode = value[0];
    const body = value[1];
    if (opcode !== 72 || typeof body !== "object" || body == null) continue;

    const bodyMap = body as Record<string, unknown>;
    const level16 = typeof bodyMap["0"] === "number" ? bodyMap["0"] : undefined;
    const fadeQs = typeof bodyMap["3"] === "number" ? bodyMap["3"] : undefined;

    // Resolve preset name from LEAP data
    const presetInfo = getPresetInfo(presetId);
    const sceneName = getSceneName(presetId);
    const nameStr = presetInfo
      ? `"${presetInfo.name}" [${presetInfo.device}]`
      : sceneName
        ? `"${sceneName}"`
        : `preset=${presetId}`;

    const levelStr =
      level16 !== undefined ? `level=${pct(level16 as number)}` : "";
    const fadeStr =
      fadeQs !== undefined ? ` fade=${(fadeQs as number) / 4}s` : "";

    parts.push(`${nameStr} ${levelStr}${fadeStr}`);
  }

  if (parts.length === 0) return null;
  const target = devName ? ` → ${devName}` : "";
  return `PRESET ${parts.join("; ")}${target}`;
}

/** Annotate /cg/db/mc/c/AAI — multicast group / zone membership */
function annotateZoneMembership(decoded: unknown, dst: string): string | null {
  if (!Array.isArray(decoded)) return null;

  const parts: string[] = [];
  const devName = getDeviceName(dst);

  for (const item of decoded) {
    if (typeof item !== "string") continue;
    // 5-byte hex: first 4 bytes = zone ID (various encodings), last byte = 0xef
    const hex = item as string;
    if (hex.length < 10) continue;

    // Try parsing zone ID from middle bytes (observed: bytes 2-5 = BE uint32 zone ID)
    const zoneId = parseInt(hex.slice(4, 8), 16);
    const zoneName = getZoneName(zoneId);
    parts.push(
      zoneName ? `zone=${zoneId} "${zoneName}"` : `zone=0x${hex.slice(0, 8)}`,
    );
  }

  if (parts.length === 0) return null;
  const target = devName ? ` → ${devName}` : "";
  return `ZONE_MAP ${parts.join(", ")}${target}`;
}

/** Annotate /cg/db/ct/c/<bucket> — configuration table writes */
function annotateConfigTable(
  bucket: string,
  decoded: unknown,
  dst: string,
): string | null {
  if (!Array.isArray(decoded) || decoded.length < 2) return null;
  const op = decoded[0];
  const body = decoded[1];
  if (typeof op !== "number" || typeof body !== "object" || body == null) {
    return null;
  }
  const m = body as Record<string, unknown>;
  const devName = getDeviceName(dst);
  const target = devName ? ` → ${devName}` : "";

  // AAI bucket, opcode 3 = dimmer trim
  if (bucket === "AAI" && op === 3) {
    const hi = typeof m["2"] === "number" ? (m["2"] as number) : null;
    const lo = typeof m["3"] === "number" ? (m["3"] as number) : null;
    const profile = typeof m["8"] === "number" ? (m["8"] as number) : null;
    const parts: string[] = [];
    if (hi != null) parts.push(`high=${pct(hi)}`);
    if (lo != null) parts.push(`low=${pct(lo)}`);
    if (profile != null) parts.push(`profile=${profile}`);
    return parts.length ? `TRIM ${parts.join(", ")}${target}` : null;
  }

  // AHA bucket, opcode 108 = status LED brightness
  if (bucket === "AHA" && op === 108) {
    const k4 = typeof m["4"] === "number" ? (m["4"] as number) : null;
    const k5 = typeof m["5"] === "number" ? (m["5"] as number) : null;
    if (k4 != null || k5 != null) {
      return `STATUS_LED active=${k4 ?? "?"}/255 inactive=${k5 ?? "?"}/255${target}`;
    }
  }

  // AFE/AFI/AFM/AFQ buckets, opcode 107 = LED link index
  if (bucket.startsWith("AF") && op === 107) {
    const btnIdx = typeof m["0"] === "number" ? (m["0"] as number) : null;
    if (btnIdx != null) {
      return `LED_LINK ${bucket} button=${btnIdx}${target}`;
    }
  }

  // Opcode 9 — observed in captures, purpose partially known
  if (op === 9) {
    const k1 = typeof m["1"] === "number" ? (m["1"] as number) : null;
    const k7 = typeof m["7"] === "number" ? (m["7"] as number) : null;
    const k10 = typeof m["10"] === "number" ? (m["10"] as number) : null;
    const parts: string[] = [`op=9`];
    if (k1 != null) parts.push(`k1=${k1}`);
    if (k7 != null) parts.push(`k7=${k7}`);
    if (k10 != null) parts.push(`k10=${k10}`);
    return `CONFIG ${bucket} ${parts.join(", ")}${target}`;
  }

  // Opcode 57 — observed in captures
  if (op === 57) {
    const k1 = typeof m["1"] === "number" ? (m["1"] as number) : null;
    return `CONFIG ${bucket} op=57${k1 != null ? ` k1=${k1}` : ""}${target}`;
  }

  // Opcode 92/94 — observed with empty body
  if (op === 92 || op === 94) {
    return `CONFIG ${bucket} op=${op}${target}`;
  }

  // Generic fallback for unknown opcodes
  return `CONFIG ${bucket} op=${op}${target}`;
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

// ── Statistics tracking ─────────────────────────────────────────────

const stats = {
  total: 0,
  byPath: new Map<string, number>(),
  presetCount: 0,
  zoneMapCount: 0,
  configCount: 0,
  dbClearCount: 0,
};

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

  stats.total++;
  if (path) {
    stats.byPath.set(path, (stats.byPath.get(path) ?? 0) + 1);
  }
  if (path === "/cg/db" && code === 4) stats.dbClearCount++;
  if (path === "/cg/db/pr/c/AAI" && code === 2) stats.presetCount++;
  if (path === "/cg/db/mc/c/AAI" && code === 2) stats.zoneMapCount++;
  if (path.startsWith("/cg/db/ct/c/") && code === 3) stats.configCount++;

  const decoded = payloadHex ? decodeCbor(payloadHex) : null;
  const note = path ? annotation(path, code, decoded, dst) : null;

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
  if (event.note) console.log(`  ${event.note}`);
  else if (event.payloadHex) console.log(`  payload=${event.payloadHex}`);
  if (event.cbor != null && !event.note)
    console.log(`  cbor=${JSON.stringify(event.cbor)}`);
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
    if (!json && stats.total > 0) {
      console.log(`\n${stats.total} CoAP packets decoded.`);
      if (stats.dbClearCount > 0)
        console.log(`  DB clears: ${stats.dbClearCount}`);
      if (stats.presetCount > 0)
        console.log(`  Preset assignments: ${stats.presetCount}`);
      if (stats.zoneMapCount > 0)
        console.log(`  Zone mappings: ${stats.zoneMapCount}`);
      if (stats.configCount > 0)
        console.log(`  Config writes: ${stats.configCount}`);
    }
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
