#!/usr/bin/env bun
/**
 * Nucleo CLI — interactive UDP shell for Nucleo H723ZG
 *
 * Connects over UDP to the Nucleo stream server (port 9433) and provides
 * an interactive shell mirroring the on-device commands, plus live packet
 * display using the protocol decoders from protocol/.
 *
 * Usage: bun cli/nucleo.ts <host>
 *        NUCLEO_HOST=192.168.1.50 bun cli/nucleo.ts
 */

import { join } from "path";
import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { createSocket, type Socket } from "dgram";
import {
  identifyPacket,
  parseFieldValue,
} from "../protocol/protocol-ui";
import { ButtonNames, DeviceClassNames } from "../protocol/generated/typescript/protocol";

// ============================================================================
// ANSI colors
// ============================================================================
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";

// ============================================================================
// Constants
// ============================================================================
const UDP_PORT = 9433;
const KEEPALIVE_MS = 10000;
const CAPTURES_DIR = join(import.meta.dir, "../captures/cca-sessions");
const STATUS_BLOB_MIN_SIZE = 48;
const STATUS_BLOB_V2_SIZE = 112;

// Stream command opcodes (host → STM32)
const CMD = {
  KEEPALIVE: 0x00,
  TX_RAW_CCA: 0x01,
  TX_RAW_CCX: 0x02,
  CCA_BUTTON: 0x05,
  CCA_LEVEL: 0x06,
  CCA_PICO_LVL: 0x07,
  CCA_STATE: 0x08,
  CCA_BEACON: 0x09,
  CCA_UNPAIR: 0x0a,
  CCA_LED: 0x0b,
  CCA_FADE: 0x0c,
  CCA_TRIM: 0x0d,
  CCA_PHASE: 0x0e,
  CCA_PICO_PAIR: 0x0f,
  CCA_BRIDGE_PAIR: 0x10,
  STATUS_QUERY: 0x11,
  CCA_SAVE_FAV: 0x12,
  CCA_VIVE_LEVEL: 0x13,
  CCA_VIVE_DIM: 0x14,
  CCA_VIVE_PAIR: 0x15,
} as const;

// Stream flags (STM32 → host)
const FLAG_TX = 0x80;
const FLAG_CCX = 0x40;
const FLAG_RSSI_MASK = 0x3f;

// Thread role names
const THREAD_ROLES = ["detached", "child", "router", "leader"] as const;

// Button name → code lookup (reverse of ButtonNames)
const BUTTON_LOOKUP: Record<string, number> = {};
for (const [code, name] of Object.entries(ButtonNames)) {
  BUTTON_LOOKUP[name.toLowerCase()] = Number(code);
}

// ============================================================================
// State
// ============================================================================
let host = process.argv[2] || process.env.NUCLEO_HOST || "";
let udpSocket: Socket;
let lastHeartbeat = 0;
let quiet = false;
let recording: { file: string; count: number; startTime: number } | null = null;
let keepaliveTimer: ReturnType<typeof setInterval>;
let lastRadioTimestamp = 0; // for inter-packet delta display

// ============================================================================
// Helpers
// ============================================================================

/** Parse a hex device ID string (e.g. "0595E68D") to 4 big-endian bytes */
function parseDevIdArg(s: string): Uint8Array | null {
  const hex = s.replace(/^0x/i, "");
  if (hex.length !== 8 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Format uptime from milliseconds */
function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`;
}

/** Format a number with commas */
function fmtNum(n: number): string {
  return n.toLocaleString();
}

/** Read LE u32 from buffer */
function readU32LE(buf: Buffer, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | ((buf[off + 3] << 24) >>> 0);
}

/** Build a binary command frame [CMD:1][LEN:1][DATA:N] */
function buildCmd(cmd: number, data?: Uint8Array | number[]): Buffer {
  const d = data ? new Uint8Array(data) : new Uint8Array(0);
  const frame = Buffer.alloc(2 + d.length);
  frame[0] = cmd;
  frame[1] = d.length;
  frame.set(d, 2);
  return frame;
}

/** Send a command frame to the Nucleo via UDP */
function send(frame: Buffer): boolean {
  if (!udpSocket) {
    console.log(`${RED}Socket not ready${RESET}`);
    return false;
  }
  udpSocket.send(frame, 0, frame.length, UDP_PORT, host);
  return true;
}

// ============================================================================
// RX packet display
// ============================================================================

function displayCcaPacket(data: Buffer, flags: number, radioTs: number = 0, deltaMs: number = 0) {
  const isTx = !!(flags & FLAG_TX);
  const rssi = isTx ? 0 : -(flags & FLAG_RSSI_MASK);
  const direction = isTx ? "TX" : "RX";
  const dirColor = isTx ? MAGENTA : GREEN;

  // Identify packet
  const identified = identifyPacket(data);
  const typeName = identified.typeName;
  const category = identified.category;

  // Category color for type name
  const catColor: Record<string, string> = {
    BUTTON: GREEN,
    STATE: BLUE,
    BEACON: YELLOW,
    PAIRING: MAGENTA,
    CONFIG: CYAN,
    HANDSHAKE: RED,
  };
  const typeColor = catColor[category] || WHITE;

  // Build hex strings for field parsing
  const hexBytes = Array.from(data).map((b) =>
    b.toString(16).padStart(2, "0")
  );

  // Fields to skip in output
  const SKIP_FIELDS = new Set([
    "type", "crc", "protocol", "broadcast", "device_repeat",
    "device_id2", "device_id3",
  ]);

  // Fields that are only useful when decoded (skip raw hex noise)
  const DECODE_ONLY = new Set(["format", "data", "flags", "pair_flag", "btn_scheme", "device_type", "zone_id"]);

  // Collect parsed field values
  const fieldValues = new Map<string, string>();
  for (const field of identified.fields) {
    if (SKIP_FIELDS.has(field.name)) continue;
    const { decoded, raw } = parseFieldValue(
      hexBytes,
      field.offset,
      field.size,
      field.format
    );
    if (decoded) {
      fieldValues.set(field.name, decoded);
    } else if (!DECODE_ONLY.has(field.name) && raw !== "-") {
      fieldValues.set(field.name, raw);
    }
  }

  // Sequence as decimal
  const seq = data[1];
  const seqStr = `${DIM}#${RESET}${String(seq).padEnd(3)}`;

  // Format device ID with highlighted suffix
  const fmtId = (label: string, val: string) => {
    const base = val.slice(0, 4);
    const tail = val.slice(4);
    return `${DIM}${label}=${RESET}${base}${YELLOW}${tail}${RESET}`;
  };

  // Build semantic parts
  const parts: string[] = [];

  // Device IDs with role-based labels
  for (const idField of ["device_id", "source_id", "load_id", "hardware_id"]) {
    const val = fieldValues.get(idField);
    if (val) {
      const label = idField === "device_id" ? "dev"
        : idField === "source_id" ? "src"
        : idField === "load_id" ? "load"
        : "hw";
      parts.push(fmtId(label, val));
      fieldValues.delete(idField);
    }
  }

  // Target ID
  const targetVal = fieldValues.get("target_id");
  if (targetVal) {
    parts.push(fmtId("target", targetVal));
    fieldValues.delete("target_id");
  }

  // Category-specific display
  fieldValues.delete("sequence");

  if (category === "BUTTON") {
    // Show button and action directly: "ON PRESS"
    const btn = fieldValues.get("button") || "";
    const act = fieldValues.get("action") || "";
    if (btn || act) parts.push(`${BOLD}${btn} ${act}${RESET}`);
    fieldValues.delete("button");
    fieldValues.delete("action");
  } else if (category === "STATE" || category === "CONFIG") {
    // Level as percentage
    const level = fieldValues.get("level");
    if (level) {
      parts.push(`${BOLD}${level}${RESET}`);
      fieldValues.delete("level");
    }
    // Format byte as fmt=XX (read raw since hex format doesn't decode)
    if (data.length > 7) {
      parts.push(`${DIM}fmt=${RESET}${data[7].toString(16).padStart(2, "0")}`);
    }
  } else if (category === "PAIRING") {
    // Translate device_class — read raw byte since hex format doesn't auto-decode
    const dcField = identified.fields.find(f => f.name === "device_class");
    if (dcField && data.length > dcField.offset) {
      const code = data[dcField.offset];
      const name = DeviceClassNames[code] || `0x${code.toString(16).padStart(2, "0")}`;
      parts.push(`${DIM}class=${RESET}${BOLD}${name}${RESET}`);
    }
    fieldValues.delete("device_class");
  } else if (category === "HANDSHAKE") {
    // Show description
    parts.push(`${DIM}"${identified.description}"${RESET}`);
  }

  // Remaining fields (zone_id, data, etc.)
  for (const [name, val] of fieldValues) {
    if (name === "format") continue; // already handled or not needed
    parts.push(`${DIM}${name}=${RESET}${val}`);
  }

  const rssiStr = isTx
    ? `${DIM}(echo)${RESET}`
    : `${DIM}rssi=${RESET}${rssi}`;
  const deltaStr = deltaMs > 0
    ? `${DIM}+${deltaMs}ms${RESET}`
    : "";
  const summary = parts.length > 0 ? "  " + parts.join("  ") : "";
  const ts = new Date().toISOString().slice(11, 23);

  console.log(
    `${DIM}${ts}${RESET} ${dirColor}${direction}${RESET} ${typeColor}${BOLD}${typeName.padEnd(16)}${RESET}${seqStr}${summary}  ${rssiStr}  ${deltaStr}`
  );

  // CSV recording
  if (recording) {
    const rawHex = hexBytes.join(" ");
    // Find device_id from fields
    let deviceId = "";
    for (const field of identified.fields) {
      if (
        field.name === "device_id" ||
        field.name === "load_id" ||
        field.name === "source_id"
      ) {
        const { decoded } = parseFieldValue(
          hexBytes,
          field.offset,
          field.size,
          field.format
        );
        if (decoded) {
          deviceId = decoded;
          break;
        }
      }
    }
    const line = `${new Date().toISOString()},${direction.toLowerCase()},cca,${typeName},${deviceId},${rssi},${rawHex}\n`;
    appendFileSync(recording.file, line);
    recording.count++;
  }
}

function displayCcxPacket(data: Buffer, flags: number, radioTs: number = 0, deltaMs: number = 0) {
  const isTx = !!(flags & FLAG_TX);
  const direction = isTx ? "TX" : "RX";
  const dirColor = isTx ? MAGENTA : BLUE;
  const rawHex = Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const ts = new Date().toISOString().slice(11, 23);

  const deltaStr = deltaMs > 0 ? `  ${DIM}+${deltaMs}ms${RESET}` : "";
  console.log(
    `${DIM}${ts}${RESET} ${YELLOW}[ccx]${RESET} ${dirColor}${direction}${RESET} ${rawHex}${deltaStr}`
  );

  if (recording) {
    const line = `${new Date().toISOString()},${direction.toLowerCase()},ccx,RAW,,0,${rawHex}\n`;
    appendFileSync(recording.file, line);
    recording.count++;
  }
}

function displayStatus(blob: Buffer) {
  if (blob.length < STATUS_BLOB_MIN_SIZE) {
    console.log(`${RED}Status blob too short: ${blob.length} bytes${RESET}`);
    return;
  }

  const uptime = readU32LE(blob, 0);
  const ccaRx = readU32LE(blob, 4);
  const ccaTx = readU32LE(blob, 8);
  const ccaDrop = readU32LE(blob, 12);
  const ccaCrc = readU32LE(blob, 16);
  const ccaN81 = readU32LE(blob, 20);
  const ccOverflow = readU32LE(blob, 24);
  const ccRunt = readU32LE(blob, 28);
  const ccxRx = readU32LE(blob, 32);
  const ccxTx = readU32LE(blob, 36);
  const ccxJoined = blob[40];
  const ccxRole = blob[41];
  const ethLink = blob[42];
  const numClients = blob[43];
  const heapFree = readU32LE(blob, 44);

  const roleName =
    ccxRole < THREAD_ROLES.length ? THREAD_ROLES[ccxRole] : `unknown(${ccxRole})`;

  console.log(`\n${BOLD}${WHITE}── Nucleo Status ──${RESET}`);
  console.log(`  ${DIM}uptime:${RESET}          ${fmtUptime(uptime)}`);
  console.log(`  ${DIM}heap_free:${RESET}       ${fmtNum(heapFree)} bytes`);
  console.log();
  console.log(`  ${CYAN}CCA${RESET}  rx=${fmtNum(ccaRx)}  tx=${fmtNum(ccaTx)}  drop=${ccaDrop}  crc_fail=${ccaCrc}  n81_err=${ccaN81}`);
  console.log(`  ${CYAN}CC1101${RESET}  overflow=${ccOverflow}  runt=${ccRunt}`);
  console.log();
  console.log(`  ${YELLOW}CCX${RESET}  rx=${fmtNum(ccxRx)}  tx=${fmtNum(ccxTx)}  joined=${ccxJoined ? "yes" : "no"}  role=${roleName}`);
  console.log();
  console.log(`  ${GREEN}ETH${RESET}  link=${ethLink ? "up" : "down"}  clients=${numClients}`);
  console.log();

  if (blob.length >= STATUS_BLOB_V2_SIZE) {
    const restartTimeout = readU32LE(blob, 48);
    const restartOverflow = readU32LE(blob, 52);
    const restartManual = readU32LE(blob, 56);
    const restartPacket = readU32LE(blob, 60);
    const syncHit = readU32LE(blob, 64);
    const syncMiss = readU32LE(blob, 68);
    const ringMax = readU32LE(blob, 72);
    const ringBytesIn = readU32LE(blob, 76);
    const ringBytesDropped = readU32LE(blob, 80);
    const ccaAck = readU32LE(blob, 84);
    const ccaCrcOptional = readU32LE(blob, 88);
    const ccaIrq = readU32LE(blob, 92);
    const isrLatMin = readU32LE(blob, 96);
    const isrLatP95 = readU32LE(blob, 100);
    const isrLatMax = readU32LE(blob, 104);
    const isrLatSamples = readU32LE(blob, 108);

    console.log(`  ${MAGENTA}CCA Radio${RESET}  ack=${fmtNum(ccaAck)}  crc_optional=${fmtNum(ccaCrcOptional)}  irq=${fmtNum(ccaIrq)}`);
    console.log(`  ${MAGENTA}Restarts${RESET}  timeout=${fmtNum(restartTimeout)}  overflow=${fmtNum(restartOverflow)}  manual=${fmtNum(restartManual)}  packet=${fmtNum(restartPacket)}`);
    console.log(`  ${MAGENTA}Sync${RESET}  hit=${fmtNum(syncHit)}  miss=${fmtNum(syncMiss)}  hit_rate=${syncHit + syncMiss > 0 ? ((syncHit * 100) / (syncHit + syncMiss)).toFixed(1) : "0.0"}%`);
    console.log(`  ${MAGENTA}Ring${RESET}  max_occ=${fmtNum(ringMax)}  in=${fmtNum(ringBytesIn)}B  dropped=${fmtNum(ringBytesDropped)}B`);
    console.log(`  ${MAGENTA}IRQ->RX${RESET}  min=${fmtNum(isrLatMin)}us  p95=${fmtNum(isrLatP95)}us  max=${fmtNum(isrLatMax)}us  n=${fmtNum(isrLatSamples)}`);
    console.log();
  }
}

// ============================================================================
// RX datagram handler — each UDP datagram is one complete frame
// ============================================================================

function handleDatagram(msg: Buffer) {
  if (msg.length < 2) return;

  const flags = msg[0];
  const len = msg[1];

  // Heartbeat: [0xFF][0x00]
  if (flags === 0xff && len === 0x00) {
    lastHeartbeat = Date.now();
    return;
  }

  // Status response: [0xFE][len][status blob]
  if (flags === 0xfe) {
    const data = msg.subarray(2, 2 + len);
    displayStatus(data);
    return;
  }

  // Packet frames: [FLAGS:1][LEN:1][TS_MS:4 LE][DATA:N]
  if (msg.length < 6 + len) return;

  const radioTs = readU32LE(msg, 2);
  const data = msg.subarray(6, 6 + len);

  // Compute inter-packet delta
  let deltaMs = 0;
  if (lastRadioTimestamp > 0) {
    deltaMs = (radioTs - lastRadioTimestamp) & 0xffffffff; // handle wrap
  }
  lastRadioTimestamp = radioTs;

  if (quiet) return;

  // Protocol dispatch
  if (flags & FLAG_CCX) {
    displayCcxPacket(data, flags, radioTs, deltaMs);
  } else {
    displayCcaPacket(data, flags, radioTs, deltaMs);
  }
}

// ============================================================================
// UDP connection
// ============================================================================

function setupUdp() {
  udpSocket = createSocket("udp4");

  udpSocket.on("message", (msg: Buffer) => {
    handleDatagram(msg);
  });

  udpSocket.on("error", (err: Error) => {
    console.error(`${RED}UDP error: ${err.message}${RESET}`);
  });

  udpSocket.bind(() => {
    const addr = udpSocket.address();
    console.log(`${GREEN}UDP socket bound to :${addr.port}, sending to ${host}:${UDP_PORT}${RESET}`);

    // Send initial keepalive to register with the Nucleo
    send(buildCmd(CMD.KEEPALIVE));

    // Periodic keepalive to stay registered (firmware expires after 30s)
    keepaliveTimer = setInterval(() => {
      send(buildCmd(CMD.KEEPALIVE));
    }, KEEPALIVE_MS);

    showPrompt();
  });
}

// ============================================================================
// Shell commands
// ============================================================================

function showPrompt() {
  process.stdout.write(`${BOLD}nucleo>${RESET} `);
}

function showHelp() {
  console.log(`
${BOLD}Commands:${RESET}
  ${GREEN}status${RESET}                            Query device status
  ${GREEN}cca button${RESET} <dev> <btn>             Button press (on/off/raise/lower/fav)
  ${GREEN}cca level${RESET} <zone> <target> <%> [fade]  Bridge set-level
  ${GREEN}cca pico-level${RESET} <dev> <%>           Pico set-level
  ${GREEN}cca beacon${RESET} <dev> [dur_sec]         Start beacon
  ${GREEN}cca unpair${RESET} <zone> <target>         Unpair device
  ${GREEN}cca state${RESET} <dev> <%>                State report
  ${GREEN}cca led${RESET} <zone> <target> <mode>     LED config (0-3)
  ${GREEN}cca fade${RESET} <zone> <target> <on_qs> <off_qs>  Fade config
  ${GREEN}cca trim${RESET} <zone> <target> <hi> <lo>  Trim config
  ${GREEN}cca phase${RESET} <zone> <target> <byte>   Phase config
  ${GREEN}cca save-fav${RESET} <dev>                  Save favorite level
  ${GREEN}cca vive-level${RESET} <hub> <zone> <%> [fade]  Vive set-level
  ${GREEN}cca vive-raise${RESET} <hub> <zone>         Vive raise (dim up)
  ${GREEN}cca vive-lower${RESET} <hub> <zone>         Vive lower (dim down)
  ${GREEN}cca vive-pair${RESET} <hub> <zone> [dur]   Vive pairing (beacon+accept)
  ${GREEN}cca pico-pair${RESET} <dev> <type> [dur]   Pico pairing (type: 0-3)
  ${GREEN}cca bridge-pair${RESET} <zone> <target> [dur]  Bridge pairing
  ${GREEN}ccx on${RESET} <zone>                      CCX zone ON
  ${GREEN}ccx off${RESET} <zone>                     CCX zone OFF
  ${GREEN}ccx level${RESET} <zone> <%>               CCX zone level
  ${GREEN}tx${RESET} <hex bytes>                     Raw CCA TX
  ${GREEN}record${RESET} [name]                      Start CSV recording
  ${GREEN}stop${RESET}                               Stop recording
  ${GREEN}quiet${RESET}                              Toggle packet display
  ${GREEN}help${RESET}                               This help
  ${GREEN}quit${RESET}                               Exit
`);
}

function handleCommand(line: string) {
  const trimmed = line.trim();
  if (!trimmed) {
    showPrompt();
    return;
  }

  const args = trimmed.split(/\s+/);
  const cmd = args[0].toLowerCase();

  switch (cmd) {
    case "help":
    case "?":
      showHelp();
      break;

    case "status":
      send(buildCmd(CMD.STATUS_QUERY));
      break;

    case "quiet":
      quiet = !quiet;
      console.log(`Packet display: ${quiet ? "off" : "on"}`);
      break;

    case "record": {
      if (recording) {
        console.log(`${YELLOW}Already recording to ${recording.file.split("/").pop()}${RESET}`);
        break;
      }
      mkdirSync(CAPTURES_DIR, { recursive: true });
      const name = args[1] || "session";
      const ts = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:.]/g, "-");
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const fileName = `${safeName}_${ts}.csv`;
      const filePath = join(CAPTURES_DIR, fileName);
      writeFileSync(
        filePath,
        "timestamp,direction,protocol,type,device_id,rssi,raw_hex\n"
      );
      recording = { file: filePath, count: 0, startTime: Date.now() };
      console.log(`${GREEN}Recording to ${fileName}${RESET}`);
      break;
    }

    case "stop": {
      if (!recording) {
        console.log(`${YELLOW}Not recording${RESET}`);
        break;
      }
      const elapsed = ((Date.now() - recording.startTime) / 1000).toFixed(1);
      const fileName = recording.file.split("/").pop();
      console.log(
        `${GREEN}Stopped recording: ${fileName} (${recording.count} packets, ${elapsed}s)${RESET}`
      );
      recording = null;
      break;
    }

    case "quit":
    case "exit":
      cleanup();
      process.exit(0);
      break;

    case "cca":
      handleCcaCommand(args.slice(1));
      break;

    case "ccx":
      handleCcxCommand(args.slice(1));
      break;

    case "tx":
      handleTxRaw(args.slice(1));
      break;

    default:
      console.log(`${RED}Unknown command: ${cmd}${RESET}. Type 'help' for commands.`);
      break;
  }

  showPrompt();
}

function handleCcaCommand(args: string[]) {
  if (args.length === 0) {
    console.log(`${RED}Usage: cca <subcommand> ...${RESET}`);
    return;
  }
  const sub = args[0].toLowerCase();

  switch (sub) {
    case "button": {
      if (args.length < 3) {
        console.log(`${RED}Usage: cca button <device_id> <button>${RESET}`);
        console.log(`  buttons: on, off, raise, lower, favorite, scene1-4, reset`);
        return;
      }
      const devBytes = parseDevIdArg(args[1]);
      if (!devBytes) {
        console.log(`${RED}Invalid device ID: ${args[1]} (expected 8 hex chars)${RESET}`);
        return;
      }
      const btnName = args[2].toLowerCase();
      const btnCode = BUTTON_LOOKUP[btnName];
      if (btnCode === undefined) {
        console.log(`${RED}Unknown button: ${args[2]}${RESET}`);
        console.log(`  Valid: ${Object.keys(BUTTON_LOOKUP).join(", ")}`);
        return;
      }
      send(buildCmd(CMD.CCA_BUTTON, [...devBytes, btnCode]));
      console.log(`${DIM}→ button ${args[1]} ${btnName}${RESET}`);
      break;
    }

    case "level": {
      if (args.length < 4) {
        console.log(`${RED}Usage: cca level <zone_id> <target_id> <percent> [fade_qs]${RESET}`);
        return;
      }
      const zone = parseDevIdArg(args[1]);
      const target = parseDevIdArg(args[2]);
      if (!zone || !target) {
        console.log(`${RED}Invalid device ID (expected 8 hex chars)${RESET}`);
        return;
      }
      const pct = parseInt(args[3]);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        console.log(`${RED}Level must be 0-100${RESET}`);
        return;
      }
      const fade = args[4] ? parseInt(args[4]) : 0;
      send(buildCmd(CMD.CCA_LEVEL, [...zone, ...target, pct, fade & 0xff]));
      console.log(`${DIM}→ level ${args[1]}→${args[2]} ${pct}% fade=${fade}${RESET}`);
      break;
    }

    case "pico-level": {
      if (args.length < 3) {
        console.log(`${RED}Usage: cca pico-level <device_id> <percent>${RESET}`);
        return;
      }
      const dev = parseDevIdArg(args[1]);
      if (!dev) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      const pct = parseInt(args[2]);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        console.log(`${RED}Level must be 0-100${RESET}`);
        return;
      }
      send(buildCmd(CMD.CCA_PICO_LVL, [...dev, pct]));
      console.log(`${DIM}→ pico-level ${args[1]} ${pct}%${RESET}`);
      break;
    }

    case "state": {
      if (args.length < 3) {
        console.log(`${RED}Usage: cca state <device_id> <percent>${RESET}`);
        return;
      }
      const dev = parseDevIdArg(args[1]);
      if (!dev) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      const pct = parseInt(args[2]);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        console.log(`${RED}Level must be 0-100${RESET}`);
        return;
      }
      send(buildCmd(CMD.CCA_STATE, [...dev, pct]));
      console.log(`${DIM}→ state ${args[1]} ${pct}%${RESET}`);
      break;
    }

    case "beacon": {
      if (args.length < 2) {
        console.log(`${RED}Usage: cca beacon <device_id> [duration_sec]${RESET}`);
        return;
      }
      const dev = parseDevIdArg(args[1]);
      if (!dev) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      const dur = args[2] ? parseInt(args[2]) : 10;
      send(buildCmd(CMD.CCA_BEACON, [...dev, dur & 0xff]));
      console.log(`${DIM}→ beacon ${args[1]} ${dur}s${RESET}`);
      break;
    }

    case "unpair": {
      if (args.length < 3) {
        console.log(`${RED}Usage: cca unpair <zone_id> <target_id>${RESET}`);
        return;
      }
      const zone = parseDevIdArg(args[1]);
      const target = parseDevIdArg(args[2]);
      if (!zone || !target) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      send(buildCmd(CMD.CCA_UNPAIR, [...zone, ...target]));
      console.log(`${DIM}→ unpair ${args[1]}→${args[2]}${RESET}`);
      break;
    }

    case "led": {
      if (args.length < 4) {
        console.log(`${RED}Usage: cca led <zone_id> <target_id> <mode 0-3>${RESET}`);
        return;
      }
      const zone = parseDevIdArg(args[1]);
      const target = parseDevIdArg(args[2]);
      if (!zone || !target) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      const mode = parseInt(args[3]);
      if (isNaN(mode) || mode < 0 || mode > 3) {
        console.log(`${RED}LED mode must be 0-3${RESET}`);
        return;
      }
      send(buildCmd(CMD.CCA_LED, [...zone, ...target, mode]));
      console.log(`${DIM}→ led ${args[1]}→${args[2]} mode=${mode}${RESET}`);
      break;
    }

    case "fade": {
      if (args.length < 5) {
        console.log(`${RED}Usage: cca fade <zone_id> <target_id> <on_qs> <off_qs>${RESET}`);
        return;
      }
      const zone = parseDevIdArg(args[1]);
      const target = parseDevIdArg(args[2]);
      if (!zone || !target) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      const onQs = parseInt(args[3]);
      const offQs = parseInt(args[4]);
      send(
        buildCmd(CMD.CCA_FADE, [
          ...zone,
          ...target,
          onQs & 0xff,
          (onQs >> 8) & 0xff,
          offQs & 0xff,
          (offQs >> 8) & 0xff,
        ])
      );
      console.log(`${DIM}→ fade ${args[1]}→${args[2]} on=${onQs}qs off=${offQs}qs${RESET}`);
      break;
    }

    case "trim": {
      if (args.length < 5) {
        console.log(`${RED}Usage: cca trim <zone_id> <target_id> <high%> <low%>${RESET}`);
        return;
      }
      const zone = parseDevIdArg(args[1]);
      const target = parseDevIdArg(args[2]);
      if (!zone || !target) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      const hi = parseInt(args[3]);
      const lo = parseInt(args[4]);
      send(buildCmd(CMD.CCA_TRIM, [...zone, ...target, hi & 0xff, lo & 0xff]));
      console.log(`${DIM}→ trim ${args[1]}→${args[2]} hi=${hi} lo=${lo}${RESET}`);
      break;
    }

    case "phase": {
      if (args.length < 4) {
        console.log(`${RED}Usage: cca phase <zone_id> <target_id> <phase_hex>${RESET}`);
        return;
      }
      const zone = parseDevIdArg(args[1]);
      const target = parseDevIdArg(args[2]);
      if (!zone || !target) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      const phase = parseInt(args[3], 16);
      send(buildCmd(CMD.CCA_PHASE, [...zone, ...target, phase & 0xff]));
      console.log(`${DIM}→ phase ${args[1]}→${args[2]} 0x${phase.toString(16).padStart(2, "0")}${RESET}`);
      break;
    }

    case "save-fav": {
      if (args.length < 2) {
        console.log(`${RED}Usage: cca save-fav <device_id>${RESET}`);
        return;
      }
      const dev = parseDevIdArg(args[1]);
      if (!dev) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      send(buildCmd(CMD.CCA_SAVE_FAV, [...dev]));
      console.log(`${DIM}→ save-fav ${args[1]}${RESET}`);
      break;
    }

    case "pico-pair": {
      if (args.length < 3) {
        console.log(`${RED}Usage: cca pico-pair <device_id> <type 0-3> [duration_sec]${RESET}`);
        console.log(`  types: 0=5btn, 1=2btn, 2=4btn-RL, 3=4btn-scene`);
        return;
      }
      const dev = parseDevIdArg(args[1]);
      if (!dev) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      const type = parseInt(args[2]);
      const dur = args[3] ? parseInt(args[3]) : 30;
      send(buildCmd(CMD.CCA_PICO_PAIR, [...dev, type & 0xff, dur & 0xff]));
      console.log(`${DIM}→ pico-pair ${args[1]} type=${type} ${dur}s${RESET}`);
      break;
    }

    case "bridge-pair": {
      if (args.length < 3) {
        console.log(`${RED}Usage: cca bridge-pair <zone_id> <target_id> [duration_sec]${RESET}`);
        return;
      }
      const zone = parseDevIdArg(args[1]);
      const target = parseDevIdArg(args[2]);
      if (!zone || !target) {
        console.log(`${RED}Invalid device ID${RESET}`);
        return;
      }
      const dur = args[3] ? parseInt(args[3]) : 30;
      send(buildCmd(CMD.CCA_BRIDGE_PAIR, [...zone, ...target, dur & 0xff]));
      console.log(`${DIM}→ bridge-pair ${args[1]}→${args[2]} ${dur}s${RESET}`);
      break;
    }

    case "vive-level": {
      if (args.length < 4) {
        console.log(`${RED}Usage: cca vive-level <hub_id> <zone_hex> <percent> [fade_qs]${RESET}`);
        return;
      }
      const hub = parseDevIdArg(args[1]);
      if (!hub) {
        console.log(`${RED}Invalid hub ID: ${args[1]} (expected 8 hex chars)${RESET}`);
        return;
      }
      const zone = parseInt(args[2], 16);
      if (isNaN(zone) || zone < 0 || zone > 0xff) {
        console.log(`${RED}Invalid zone (expected 1-2 hex chars, e.g. 38)${RESET}`);
        return;
      }
      const pct = parseInt(args[3]);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        console.log(`${RED}Level must be 0-100${RESET}`);
        return;
      }
      const fade = args[4] ? parseInt(args[4]) : 4;
      send(buildCmd(CMD.CCA_VIVE_LEVEL, [...hub, zone & 0xff, pct, fade & 0xff]));
      console.log(`${DIM}→ vive-level hub=${args[1]} zone=0x${zone.toString(16)} ${pct}% fade=${fade}${RESET}`);
      break;
    }

    case "vive-raise": {
      if (args.length < 3) {
        console.log(`${RED}Usage: cca vive-raise <hub_id> <zone_hex>${RESET}`);
        return;
      }
      const hub = parseDevIdArg(args[1]);
      if (!hub) {
        console.log(`${RED}Invalid hub ID: ${args[1]} (expected 8 hex chars)${RESET}`);
        return;
      }
      const zone = parseInt(args[2], 16);
      if (isNaN(zone) || zone < 0 || zone > 0xff) {
        console.log(`${RED}Invalid zone (expected 1-2 hex chars, e.g. 38)${RESET}`);
        return;
      }
      send(buildCmd(CMD.CCA_VIVE_DIM, [...hub, zone & 0xff, 0x03]));
      console.log(`${DIM}→ vive-raise hub=${args[1]} zone=0x${zone.toString(16)}${RESET}`);
      break;
    }

    case "vive-lower": {
      if (args.length < 3) {
        console.log(`${RED}Usage: cca vive-lower <hub_id> <zone_hex>${RESET}`);
        return;
      }
      const hub = parseDevIdArg(args[1]);
      if (!hub) {
        console.log(`${RED}Invalid hub ID: ${args[1]} (expected 8 hex chars)${RESET}`);
        return;
      }
      const zone = parseInt(args[2], 16);
      if (isNaN(zone) || zone < 0 || zone > 0xff) {
        console.log(`${RED}Invalid zone (expected 1-2 hex chars, e.g. 38)${RESET}`);
        return;
      }
      send(buildCmd(CMD.CCA_VIVE_DIM, [...hub, zone & 0xff, 0x02]));
      console.log(`${DIM}→ vive-lower hub=${args[1]} zone=0x${zone.toString(16)}${RESET}`);
      break;
    }

    case "vive-pair": {
      if (args.length < 3) {
        console.log(`${RED}Usage: cca vive-pair <hub_id> <zone_hex> [duration_sec]${RESET}`);
        return;
      }
      const hub = parseDevIdArg(args[1]);
      if (!hub) {
        console.log(`${RED}Invalid hub ID: ${args[1]} (expected 8 hex chars)${RESET}`);
        return;
      }
      const zone = parseInt(args[2], 16);
      if (isNaN(zone) || zone < 0 || zone > 0xff) {
        console.log(`${RED}Invalid zone (expected 1-2 hex chars, e.g. 38)${RESET}`);
        return;
      }
      const dur = args[3] ? parseInt(args[3]) : 30;
      send(buildCmd(CMD.CCA_VIVE_PAIR, [...hub, zone & 0xff, dur & 0xff]));
      console.log(`${DIM}→ vive-pair hub=${args[1]} zone=0x${zone.toString(16)} ${dur}s${RESET}`);
      break;
    }

    default:
      console.log(`${RED}Unknown CCA subcommand: ${sub}${RESET}`);
      console.log(
        `  Subcommands: button, level, pico-level, state, beacon, unpair, led, fade, trim, phase, save-fav, vive-level, vive-raise, vive-lower, vive-pair, pico-pair, bridge-pair`
      );
      break;
  }
}

function handleCcxCommand(args: string[]) {
  if (args.length < 2) {
    console.log(`${RED}Usage: ccx <on|off|level> <zone> [percent]${RESET}`);
    return;
  }
  const sub = args[0].toLowerCase();
  const zoneStr = args[1].replace(/^0x/i, "");
  const zoneId = parseInt(zoneStr, 16);
  if (isNaN(zoneId) || zoneId < 0 || zoneId > 0xffff) {
    console.log(`${RED}Invalid zone ID: ${args[1]} (expected 1-4 hex chars)${RESET}`);
    return;
  }

  const zoneHi = (zoneId >> 8) & 0xff;
  const zoneLo = zoneId & 0xff;

  switch (sub) {
    case "on":
      send(buildCmd(CMD.TX_RAW_CCX, [zoneHi, zoneLo, 0xfe, 0xff, 0x00]));
      console.log(`${DIM}→ ccx ON zone=0x${zoneId.toString(16).padStart(4, "0")}${RESET}`);
      break;

    case "off":
      send(buildCmd(CMD.TX_RAW_CCX, [zoneHi, zoneLo, 0x00, 0x00, 0x00]));
      console.log(`${DIM}→ ccx OFF zone=0x${zoneId.toString(16).padStart(4, "0")}${RESET}`);
      break;

    case "level": {
      if (args.length < 3) {
        console.log(`${RED}Usage: ccx level <zone> <percent>${RESET}`);
        return;
      }
      const pct = parseInt(args[2]);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        console.log(`${RED}Level must be 0-100${RESET}`);
        return;
      }
      const level16 = Math.round((pct * 0xfeff) / 100);
      const levelHi = (level16 >> 8) & 0xff;
      const levelLo = level16 & 0xff;
      send(
        buildCmd(CMD.TX_RAW_CCX, [zoneHi, zoneLo, levelHi, levelLo, 0x00])
      );
      console.log(
        `${DIM}→ ccx LEVEL zone=0x${zoneId.toString(16).padStart(4, "0")} ${pct}% (0x${level16.toString(16).padStart(4, "0")})${RESET}`
      );
      break;
    }

    default:
      console.log(`${RED}Unknown CCX subcommand: ${sub}${RESET}`);
      console.log(`  Subcommands: on, off, level`);
      break;
  }
}

function handleTxRaw(args: string[]) {
  if (args.length === 0) {
    console.log(`${RED}Usage: tx <hex bytes...>${RESET}`);
    console.log(`  Example: tx 88 06 05 95 E6 8D 02 04 ...`);
    return;
  }
  const hexStr = args.join(" ").replace(/0x/gi, "").replace(/,/g, " ");
  const bytes: number[] = [];
  for (const part of hexStr.split(/\s+/)) {
    if (!part) continue;
    const val = parseInt(part, 16);
    if (isNaN(val) || val < 0 || val > 0xff) {
      console.log(`${RED}Invalid hex byte: ${part}${RESET}`);
      return;
    }
    bytes.push(val);
  }
  if (bytes.length === 0) {
    console.log(`${RED}No bytes to send${RESET}`);
    return;
  }
  send(buildCmd(CMD.TX_RAW_CCA, bytes));
  const display = bytes
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  console.log(`${DIM}→ raw TX ${bytes.length} bytes: ${display}${RESET}`);
}

// ============================================================================
// Cleanup
// ============================================================================

function cleanup() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  if (recording) {
    const fileName = recording.file.split("/").pop();
    console.log(`\n${YELLOW}Stopped recording: ${fileName} (${recording.count} packets)${RESET}`);
    recording = null;
  }
  if (udpSocket) {
    udpSocket.close();
  }
}

// ============================================================================
// Main
// ============================================================================

if (!host) {
  console.error(`Usage: bun cli/nucleo.ts <host>`);
  console.error(`  or set NUCLEO_HOST environment variable`);
  process.exit(1);
}

console.log(`${BOLD}Nucleo CLI${RESET} — UDP to ${host}:${UDP_PORT}`);
console.log(`Type 'help' for commands, 'quit' to exit\n`);

// Handle Ctrl-C
process.on("SIGINT", () => {
  cleanup();
  console.log();
  process.exit(0);
});

// Start UDP socket
setupUdp();

// Read stdin line by line
const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();

async function readInput() {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.length > 0) {
        handleCommand(line);
      }
    }
  }
}

readInput();
