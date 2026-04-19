#!/usr/bin/env npx tsx

/**
 * Live IPL stream decoder. Connects to an RA3 processor's IPL endpoint
 * (TLS:8902) and pretty-prints every LEI frame as it arrives.
 *
 * Features:
 *   - Correct Version3 framing + uint16 BE payload length prefix (so multi-
 *     frame TCP reads reassemble properly).
 *   - Color-coded by MessageType.
 *   - Zone / device / area names resolved from data/leap-<host>.json.
 *   - Telemetry body decoded: level, occupancy, button, LED.
 *   - Event body decoded: ProcessorEventIdType name + objectId/objectType.
 *   - Optional filter: --only <Cmd|Ack|Rsp|Evt|Ctrl|Tlm,...>
 *
 * Usage:
 *   npx tsx tools/ipl-monitor.ts
 *   npx tsx tools/ipl-monitor.ts --host 10.1.1.133 --only Tlm,Evt
 *   npx tsx tools/ipl-monitor.ts --no-color --raw
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { connect } from "tls";
import { fileURLToPath } from "url";
import { defaultHost } from "../lib/config";
import {
  decodeDeviceUploadProgressEvent,
  decodeDiagnosticBeacon,
  decodeEventHeader,
  decodeIPAnnouncementEvent,
  decodeOccupancyEvent,
  decodeRuntimeTelemetry,
  EventOp,
  level16ToPct,
  MsgType,
  MsgTypeName,
  type ParsedFrame,
  parseAllFrames,
  resolveOpName,
} from "../lib/ipl";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(name);

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const HOST = getArg("--host") ?? defaultHost ?? "10.1.1.133";
const PORT = Number.parseInt(getArg("--port") ?? "8902", 10);
const NO_COLOR = hasFlag("--no-color") || !process.stdout.isTTY;
const SHOW_RAW = hasFlag("--raw");
const ONLY = new Set(
  (getArg("--only") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const CERT_DIR = join(__dir, "..", "certs", "designer");
const clientCert = readFileSync(join(CERT_DIR, "ipl_client_cert.pem"));
const clientKey = readFileSync(join(CERT_DIR, "ipl_client_key.pem"));
const caCert = readFileSync(join(CERT_DIR, "radioRa3_products.crt"));

// ---------- LEAP lookups ----------

type Lookup = {
  zones: Record<string, { name: string; area?: string; controlType?: string }>;
  devices: Record<string, { name?: string; model?: string; area?: string }>;
  areas: Record<string, string>;
};

function loadLeap(host: string): Lookup {
  const emp: Lookup = { zones: {}, devices: {}, areas: {} };
  const candidates = [
    join(__dir, "..", "data", `leap-${host}.json`),
    join(__dir, "..", "data", `leap-${host}-full.json`),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (raw.zones) Object.assign(emp.zones, raw.zones);
      if (raw.devices) Object.assign(emp.devices, raw.devices);
      if (raw.areas) Object.assign(emp.areas, raw.areas);
    } catch {
      /* ignore */
    }
  }
  return emp;
}
const LEAP = loadLeap(HOST);

function zoneLabel(id: number): string {
  const z = LEAP.zones[String(id)];
  if (!z) return `zone=${id}`;
  return `zone=${id}(${z.area ? `${z.area}/` : ""}${z.name})`;
}
function deviceLabel(id: number): string {
  const d = LEAP.devices[String(id)];
  if (!d) return `dev=${id}`;
  return `dev=${id}(${d.area ? `${d.area}/` : ""}${d.name ?? d.model ?? "?"})`;
}
function objectLabel(id: number): string {
  return LEAP.zones[String(id)]
    ? zoneLabel(id)
    : LEAP.devices[String(id)]
      ? deviceLabel(id)
      : `obj=${id}`;
}

// ---------- Colors ----------

const C = NO_COLOR
  ? {
      reset: "",
      dim: "",
      bold: "",
      cmd: "",
      ack: "",
      rsp: "",
      evt: "",
      ctrl: "",
      tlm: "",
      name: "",
    }
  : {
      reset: "\x1b[0m",
      dim: "\x1b[2m",
      bold: "\x1b[1m",
      cmd: "\x1b[33m", // yellow
      ack: "\x1b[90m", // grey
      rsp: "\x1b[32m", // green
      evt: "\x1b[35m", // magenta
      ctrl: "\x1b[31m", // red
      tlm: "\x1b[36m", // cyan
      name: "\x1b[1;37m", // bold white
    };

function mtColor(mt: MsgType): string {
  switch (mt) {
    case MsgType.Command:
      return C.cmd;
    case MsgType.Acknowledgement:
      return C.ack;
    case MsgType.Response:
      return C.rsp;
    case MsgType.Event:
      return C.evt;
    case MsgType.Control:
      return C.ctrl;
    case MsgType.Telemetry:
      return C.tlm;
    default:
      return "";
  }
}

// ---------- Body decoders ----------

function fmtPropValue(propNum: number, val: Buffer): string {
  // Per RuntimePropertyConverter — Level (1/4/38/39) is either a bare uint16 BE
  // (response to GetRuntimeProperty) or [cmd:u8][level16:u16 BE] (spontaneous
  // telemetry push). Try the longer form first.
  const isLevel =
    propNum === 1 || propNum === 4 || propNum === 38 || propNum === 39;
  if (isLevel && val.length >= 3) {
    const cmd = val[0];
    const lvl = val.readUInt16BE(1);
    return `cmd=${cmd} ${level16ToPct(lvl)}% (0x${lvl.toString(16)})`;
  }
  if (isLevel && val.length === 2) {
    const lvl = val.readUInt16BE(0);
    return `${level16ToPct(lvl)}% (0x${lvl.toString(16)})`;
  }
  if (propNum === 16 && val.length >= 1) {
    // OccupancyStatus: 1=Unknown, 3=Occupied, 4=Unoccupied
    const s = val[0];
    return s === 3
      ? "Occupied"
      : s === 4
        ? "Unoccupied"
        : s === 1
          ? "Unknown"
          : `state=${s}`;
  }
  if (propNum === 23 && val.length >= 2) {
    // LED_STATUS — high byte is sub-led, low byte is on/off
    const v = val.readUInt16BE(0);
    return `led=${v & 0xff ? "ON" : "off"} (0x${v.toString(16).padStart(4, "0")})`;
  }
  if (propNum === 67 && val.length >= 2) {
    return `scene=${val.readUInt16BE(0)}`;
  }
  if (propNum === 91 && val.length >= 1) {
    return val[0] ? "ON" : "off";
  }
  if (val.length === 1) return `${val[0]}`;
  if (val.length === 2)
    return `0x${val.readUInt16BE(0).toString(16).padStart(4, "0")}`;
  if (val.length === 4)
    return `0x${val.readUInt32BE(0).toString(16).padStart(8, "0")}`;
  return `0x${val.toString("hex")}`;
}

function decodeTelemetry(f: ParsedFrame): string | null {
  // (heartbeat) telemetry has 0 or 1-byte body
  if (f.body.length <= 1) return "(heartbeat)";
  const t = decodeRuntimeTelemetry(f.body);
  if (!t) return `(unrecognised tlm body ${f.body.length}B)`;
  return `${objectLabel(t.objectId)} type=${t.objectType} ${t.propertyName}(${t.propertyNumber})=${fmtPropValue(t.propertyNumber, t.value)}`;
}

function decodeEvent(f: ParsedFrame): string | null {
  if (f.operationId === 6) {
    const o = decodeOccupancyEvent(f.body);
    if (o)
      return `OccupancyChange ${objectLabel(o.objectId)} type=${o.objectType} → ${o.statusName}`;
  }
  if (f.operationId === 47) {
    const a = decodeIPAnnouncementEvent(f.body);
    if (a)
      return `IPAnnouncement ${objectLabel(a.objectId)} type=${a.objectType} ip=${a.ip} serial=${a.serialHex}`;
  }
  if (f.operationId === 9) {
    const u = decodeDeviceUploadProgressEvent(f.body);
    if (u)
      return `DeviceUploadProgress ${objectLabel(u.objectId)} comp=${u.componentNumber} status=${u.status} type=${u.uploadType}`;
  }
  // Fallback: header + raw rest
  const h = decodeEventHeader(f.body);
  const name =
    f.operationId !== undefined
      ? (EventOp[f.operationId] ?? `Event(op${f.operationId})`)
      : "Event";
  if (!h) return `${name} (short body ${f.body.length}B)`;
  return `${name} ${objectLabel(h.objectId)} type=${h.objectType}${h.rest.length > 0 ? ` rest=${h.rest.toString("hex")}` : ""}`;
}

function decodeCommand(f: ParsedFrame): string | null {
  const op = f.operationId;
  if (op === undefined) return null;
  const b = f.body;
  switch (op) {
    case 13 /* GoToLevel */: {
      if (b.length < 14) return null;
      return `GoToLevel ${objectLabel(b.readUInt32BE(0))} type=${b.readUInt16BE(4)} level=${level16ToPct(b.readUInt16BE(6))}% orig=${b.readUInt16BE(8)} fade=${b.readUInt16BE(10) / 4}s delay=${b.readUInt16BE(12) / 4}s`;
    }
    case 28 /* DiagnosticBeacon */: {
      const d = decodeDiagnosticBeacon(b);
      if (!d) return null;
      return `DiagnosticBeacon serial=${d.serialHex} dbGUID=${d.databaseGuid} os=${d.os} boot=${d.boot} (${d.raw}B)`;
    }
    case 44 /* DeviceSetOutputLevel */: {
      if (b.length < 10) return null;
      return `DeviceSetOutputLevel proc=${b[0]} link=${b[1]} serial=0x${b.readUInt32BE(2).toString(16).padStart(8, "0")} comp=${b.readUInt16BE(6)} level=${level16ToPct(b.readUInt16BE(8))}%`;
    }
    case 338 /* ReportIPLProtocolVersion */: {
      if (b.length < 8) return null;
      return `ReportIPLProtocolVersion major=${b.readUInt32BE(0)} minor=${b.readUInt32BE(4)}`;
    }
    case 346 /* ReportDatabaseSyncInfo */: {
      if (b.length < 20) return null;
      return `ReportDatabaseSyncInfo guid=${b.subarray(0, 16).toString("hex")} modified=${b.readUInt32BE(16)}`;
    }
    case 349 /* NamedRPCWrapper */: {
      // body after payload-length stripping: [ASCII name][nulls...][zlib JSON]
      const sep = b.indexOf(0x00, 0);
      if (sep > 0) {
        const name = b.subarray(0, sep).toString("ascii");
        const zlibStart = [...b].findIndex(
          (byte, i) =>
            i > sep &&
            byte === 0x78 &&
            (b[i + 1] === 0xda || b[i + 1] === 0x9c),
        );
        let tail = "";
        if (zlibStart > 0) {
          try {
            // inflate lazily — only if we find a plausible zlib header
            const { inflateSync } = require("zlib");
            const out = inflateSync(b.subarray(zlibStart)).toString("utf8");
            tail = ` payload=${out}`;
          } catch {
            /* ignore */
          }
        }
        return `NamedRPC "${name}"${tail}`;
      }
      return null;
    }
  }
  return null;
}

// ---------- Render ----------

function shouldShow(f: ParsedFrame): boolean {
  if (ONLY.size === 0) return true;
  return ONLY.has(MsgTypeName[f.msgType]);
}

function formatFrame(f: ParsedFrame): string {
  const color = mtColor(f.msgType);
  const mt = MsgTypeName[f.msgType];
  const op = f.operationId;
  const opName = op !== undefined ? resolveOpName(f.msgType, op) : "";
  const marker = `LEI${String.fromCharCode(0x40 + f.msgType)}`;

  let decoded: string | null = null;
  if (f.msgType === MsgType.Telemetry) decoded = decodeTelemetry(f);
  else if (f.msgType === MsgType.Event) decoded = decodeEvent(f);
  else if (f.msgType === MsgType.Command || f.msgType === MsgType.Response)
    decoded = decodeCommand(f);

  const head = `${color}${marker}${C.reset} ${mt}/${f.receiverProcessing} sys=${f.systemId} s=${f.senderId}→${f.receiverId} seq=${f.messageId}${op !== undefined ? ` ${C.name}${opName}${C.reset}(${op})` : ""}`;

  if (decoded && !SHOW_RAW) return `${head} ${decoded}`;

  const bodyHex = f.body.toString("hex");
  const shown = bodyHex.length > 96 ? `${bodyHex.slice(0, 96)}…` : bodyHex;
  const raw = `${C.dim}[${f.body.length}B] ${shown}${C.reset}`;
  return decoded ? `${head} ${decoded}\n    ${raw}` : `${head} ${raw}`;
}

// ---------- Main ----------

function main() {
  console.log(
    `${C.bold}IPL monitor${C.reset} → ${HOST}:${PORT}  filter=${ONLY.size ? [...ONLY].join(",") : "(all)"}  leap=${Object.keys(LEAP.zones).length} zones loaded`,
  );
  console.log(
    "Legend: " +
      `${C.cmd}CMD${C.reset} ${C.ack}ACK${C.reset} ${C.rsp}RSP${C.reset} ` +
      `${C.evt}EVT${C.reset} ${C.ctrl}CTRL${C.reset} ${C.tlm}TLM${C.reset}`,
  );
  console.log("(Ctrl+C to exit)\n");

  const sock = connect({
    host: HOST,
    port: PORT,
    cert: clientCert,
    key: clientKey,
    ca: caCert,
    rejectUnauthorized: false,
  });

  let rxBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  sock.on("secureConnect", () => {
    console.error(`connected [${sock.getCipher()?.name ?? "?"}]\n`);
  });
  sock.on("data", (chunk: Buffer) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    const { frames, remainder } = parseAllFrames(rxBuf);
    rxBuf = remainder;
    for (const f of frames) {
      if (shouldShow(f)) console.log(formatFrame(f));
    }
  });
  sock.on("error", (err) => {
    console.error(`socket error: ${err.message}`);
    process.exit(1);
  });
  sock.on("close", () => {
    console.error("(connection closed)");
    process.exit(0);
  });
}

main();
