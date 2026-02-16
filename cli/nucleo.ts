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

import { createSocket, type Socket } from "dgram";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getPresetInfo,
  getSerialName,
  getZoneName,
  presetIdFromDeviceId,
  setLeapData,
} from "../ccx/config";
import { Level } from "../ccx/constants";
import { decodeBytes } from "../ccx/decoder";
import type { CCXMessage } from "../ccx/types";
import { DeviceClassNames } from "../protocol/generated/typescript/protocol";
import { identifyPacket, parseFieldValue } from "../protocol/protocol-ui";

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
  STATUS_QUERY: 0x11,
  TEXT: 0x20,
} as const;

// Stream response opcodes (STM32 → host)
const RESP_TEXT = 0xfd;
const TEXT_CMD_TIMEOUT_MS = 10000;

// Stream flags (STM32 → host)
const FLAG_TX = 0x80;
const FLAG_CCX = 0x40;
const FLAG_RSSI_MASK = 0x3f;

// Thread role names
const THREAD_ROLES = ["detached", "child", "router", "leader"] as const;

// ============================================================================
// CLI flags
// ============================================================================
function getCliArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}
const hasCliFlag = (name: string) => process.argv.includes(name);

const UPDATE_LEAP = hasCliFlag("--update-leap");
const LEAP_HOST = getCliArg("--leap-host") ?? "10.0.0.1";
const LEAP_CERTS = getCliArg("--leap-certs") ?? "ra3";

// ============================================================================
// State
// ============================================================================
// Find first positional arg (skip flags and their values)
const FLAG_WITH_VALUE = new Set(["--leap-host", "--leap-certs"]);
let host = process.env.NUCLEO_HOST || "";
{
  const cliArgs = process.argv.slice(2);
  for (let i = 0; i < cliArgs.length; ) {
    const a = cliArgs[i];
    if (FLAG_WITH_VALUE.has(a)) {
      i += 2;
    } else if (a.startsWith("--")) {
      i += 1;
    } else {
      host = a;
      break;
    }
  }
}
let udpSocket: Socket;
let quiet = false;
let raw = false;
let recording: { file: string; count: number; startTime: number } | null = null;
let keepaliveTimer: ReturnType<typeof setInterval>;
let lastCcaRadioTs = 0; // for CCA inter-packet delta
let lastCcxRadioTs = 0; // for CCX inter-packet delta
let textCmdTimer: ReturnType<typeof setTimeout> | null = null;

// ============================================================================
// Helpers
// ============================================================================

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
  return (
    buf[off] |
    (buf[off + 1] << 8) |
    (buf[off + 2] << 16) |
    ((buf[off + 3] << 24) >>> 0)
  );
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

/** Send a text command to the STM32 shell via UDP passthrough */
function sendTextCommand(text: string) {
  const textBytes = new TextEncoder().encode(text);
  send(buildCmd(CMD.TEXT, textBytes));
  // Safety timeout — show prompt if no response in 10s
  textCmdTimer = setTimeout(() => {
    textCmdTimer = null;
    console.log(`${YELLOW}(no response — timeout)${RESET}`);
    showPrompt();
  }, TEXT_CMD_TIMEOUT_MS);
}

// ============================================================================
// RX packet display
// ============================================================================

function displayCcaPacket(
  data: Buffer,
  flags: number,
  _radioTs: number = 0,
  deltaMs: number = 0,
) {
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
  const hexBytes = Array.from(data).map((b) => b.toString(16).padStart(2, "0"));

  // Fields to skip in output
  const SKIP_FIELDS = new Set([
    "type",
    "crc",
    "protocol",
    "broadcast",
    "device_repeat",
    "device_id2",
    "device_id3",
    "pico_frame",
    "cmd_class",
    "cmd_param",
  ]);

  // Fields that are only useful when decoded (skip raw hex noise)
  const DECODE_ONLY = new Set([
    "format",
    "data",
    "flags",
    "pair_flag",
    "btn_scheme",
    "device_type",
    "zone_id",
  ]);

  // Collect parsed field values
  const fieldValues = new Map<string, string>();
  for (const field of identified.fields) {
    if (SKIP_FIELDS.has(field.name)) continue;
    const { decoded, raw } = parseFieldValue(
      hexBytes,
      field.offset,
      field.size,
      field.format,
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
      const label =
        idField === "device_id"
          ? "dev"
          : idField === "source_id"
            ? "src"
            : idField === "load_id"
              ? "load"
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
    let btn = fieldValues.get("button") || "";
    const act = fieldValues.get("action") || "";
    // Enhance 4-button pico display using format byte + cmd_class (byte 17)
    // cmd_class 0x42 = dim (RAISE/LOWER), 0x40 = scene/preset
    // Action byte means "has payload" not "press/release" — don't display it
    // when we have command semantics; the packet type name already says press/release
    const fmtByte = data.length > 7 ? data[7] : 0;
    const cmdClass = data.length > 17 ? data[17] : 0xcc;
    const cmdParam = data.length > 19 ? data[19] : 0xcc;
    let hasCmd = false;
    if ((fmtByte === 0x0e || fmtByte === 0x0c) && cmdClass === 0x42) {
      // Dim command or dim stop — resolve SCENE3/SCENE2 to RAISE/LOWER
      btn = cmdParam === 0x01 || cmdParam === 0x03 ? "RAISE" : "LOWER";
      hasCmd = true;
    } else if (fmtByte === 0x0e && cmdClass === 0x40) {
      // Scene/preset — keep button name, drop confusing action byte
      hasCmd = true;
    }
    if (hasCmd) {
      parts.push(`${BOLD}${btn}${RESET}`);
    } else {
      // 5-button pico or short 4-button tap — use action as-is
      if (btn || act) parts.push(`${BOLD}${btn} ${act}${RESET}`);
    }
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
    const dcField = identified.fields.find((f) => f.name === "device_class");
    if (dcField && data.length > dcField.offset) {
      const code = data[dcField.offset];
      const name =
        DeviceClassNames[code] || `0x${code.toString(16).padStart(2, "0")}`;
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

  const rssiStr = isTx ? `${DIM}(echo)${RESET}` : `${DIM}rssi=${RESET}${rssi}`;
  const deltaStr = deltaMs > 0 ? `${DIM}+${deltaMs}ms${RESET}` : "";
  const summary = parts.length > 0 ? "  " + parts.join("  ") : "";
  const ts = new Date().toISOString().slice(11, 23);

  if (raw) {
    const rawHex = hexBytes.join(" ");
    console.log(
      `${DIM}${ts}${RESET} ${CYAN}A${RESET} ${dirColor}${direction}${RESET} ${typeColor}${BOLD}${typeName.padEnd(16)}${RESET}${seqStr}  ${rawHex}  ${rssiStr}  ${deltaStr}`,
    );
  } else {
    console.log(
      `${DIM}${ts}${RESET} ${CYAN}A${RESET} ${dirColor}${direction}${RESET} ${typeColor}${BOLD}${typeName.padEnd(16)}${RESET}${seqStr}${summary}  ${rssiStr}  ${deltaStr}`,
    );
  }

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
          field.format,
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

function formatCcxMessage(msg: CCXMessage): {
  typeName: string;
  parts: string[];
} {
  const parts: string[] = [];

  switch (msg.type) {
    case "LEVEL_CONTROL": {
      let levelStr: string;
      if (msg.level === Level.OFF) levelStr = "OFF";
      else if (msg.level === Level.FULL_ON) levelStr = "ON";
      else levelStr = `${msg.levelPercent.toFixed(0)}%`;
      const zoneName = getZoneName(msg.zoneId);
      parts.push(`${BOLD}${levelStr}${RESET}`);
      if (zoneName) {
        parts.push(
          `${DIM}zone=${RESET}${msg.zoneId} ${CYAN}"${zoneName}"${RESET}`,
        );
      } else {
        parts.push(`${DIM}zone=${RESET}${msg.zoneId}`);
      }
      const fadeSec = msg.fade / 4;
      if (fadeSec !== 0.25) parts.push(`${DIM}fade=${RESET}${fadeSec}s`);
      if (msg.delay > 0) parts.push(`${DIM}delay=${RESET}${msg.delay / 4}s`);
      return { typeName: "LEVEL_CONTROL", parts };
    }
    case "BUTTON_PRESS": {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      if (preset) {
        parts.push(
          `${BOLD}"${preset.name}"${RESET} ${DIM}[${preset.device}]${RESET}`,
        );
      } else {
        parts.push(`${DIM}preset=${RESET}${presetId}`);
      }
      return { typeName: "BUTTON_PRESS", parts };
    }
    case "DIM_HOLD": {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      if (preset) {
        parts.push(
          `${BOLD}"${preset.name}"${RESET} ${DIM}[${preset.device}]${RESET}`,
        );
      } else {
        parts.push(`${DIM}preset=${RESET}${presetId}`);
      }
      if (msg.action !== undefined)
        parts.push(`${DIM}action=${RESET}${msg.action}`);
      return { typeName: "DIM_HOLD", parts };
    }
    case "DIM_STEP": {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      if (preset) {
        parts.push(
          `${BOLD}"${preset.name}"${RESET} ${DIM}[${preset.device}]${RESET}`,
        );
      } else {
        parts.push(`${DIM}preset=${RESET}${presetId}`);
      }
      parts.push(`${DIM}step=${RESET}${msg.stepValue}`);
      return { typeName: "DIM_STEP", parts };
    }
    case "ACK": {
      const respHex = Array.from(msg.response)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      parts.push(`${DIM}response=${RESET}${respHex}`);
      return { typeName: "ACK", parts };
    }
    case "DEVICE_REPORT": {
      const serialInfo = getSerialName(msg.deviceSerial);
      if (serialInfo) {
        parts.push(`${BOLD}"${serialInfo}"${RESET}`);
      }
      parts.push(`${DIM}serial=${RESET}${msg.deviceSerial}`);
      if (msg.groupId) parts.push(`${DIM}group=${RESET}${msg.groupId}`);
      return { typeName: "DEVICE_REPORT", parts };
    }
    case "SCENE_RECALL": {
      parts.push(`${DIM}scene=${RESET}${msg.sceneId}`);
      if (msg.params.length > 0)
        parts.push(`${DIM}params=${RESET}[${msg.params.join(",")}]`);
      return { typeName: "SCENE_RECALL", parts };
    }
    case "COMPONENT_CMD": {
      parts.push(`${DIM}group=${RESET}${msg.groupId}`);
      if (msg.params.length > 0)
        parts.push(`${DIM}params=${RESET}[${msg.params.join(",")}]`);
      return { typeName: "COMPONENT_CMD", parts };
    }
    case "STATUS": {
      parts.push(
        `${DIM}dev=${RESET}0x${msg.deviceId.toString(16).padStart(8, "0")}`,
      );
      return { typeName: "STATUS", parts };
    }
    case "PRESENCE": {
      parts.push(`${DIM}status=${RESET}${msg.status}`);
      return { typeName: "PRESENCE", parts };
    }
    case "UNKNOWN": {
      parts.push(`${DIM}type=${RESET}${msg.msgType}`);
      return { typeName: `UNKNOWN_${msg.msgType}`, parts };
    }
  }
}

function displayCcxPacket(
  data: Buffer,
  flags: number,
  _radioTs: number = 0,
  deltaMs: number = 0,
) {
  const isTx = !!(flags & FLAG_TX);
  const direction = isTx ? "TX" : "RX";
  const dirColor = isTx ? MAGENTA : BLUE;
  const ts = new Date().toISOString().slice(11, 23);
  const deltaStr = deltaMs > 0 ? `${DIM}+${deltaMs}ms${RESET}` : "";

  // Try to decode CBOR
  let msg: CCXMessage | null = null;
  try {
    msg = decodeBytes(new Uint8Array(data));
  } catch {
    // Fall back to raw hex display
  }

  if (msg) {
    const { typeName, parts } = formatCcxMessage(msg);
    const seq = "sequence" in msg ? (msg as { sequence: number }).sequence : 0;
    const seqStr = `${DIM}#${RESET}${String(seq).padEnd(3)}`;

    // Category color
    const catColor: Record<string, string> = {
      LEVEL_CONTROL: BLUE,
      BUTTON_PRESS: GREEN,
      DIM_HOLD: GREEN,
      DIM_STEP: GREEN,
      ACK: DIM,
      DEVICE_REPORT: CYAN,
      SCENE_RECALL: MAGENTA,
      COMPONENT_CMD: MAGENTA,
      STATUS: YELLOW,
      PRESENCE: DIM,
    };
    const typeColor = catColor[msg.type] || WHITE;
    const summary = parts.length > 0 ? "  " + parts.join("  ") : "";

    if (raw) {
      const rawHex = Array.from(data)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      console.log(
        `${DIM}${ts}${RESET} ${YELLOW}X${RESET} ${dirColor}${direction}${RESET} ${typeColor}${BOLD}${typeName.padEnd(16)}${RESET}${seqStr}  ${rawHex}  ${deltaStr}`,
      );
    } else {
      console.log(
        `${DIM}${ts}${RESET} ${YELLOW}X${RESET} ${dirColor}${direction}${RESET} ${typeColor}${BOLD}${typeName.padEnd(16)}${RESET}${seqStr}${summary}  ${deltaStr}`,
      );
    }
  } else {
    // Fallback: raw hex (always show)
    const rawHex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    console.log(
      `${DIM}${ts}${RESET} ${YELLOW}X${RESET} ${dirColor}${direction}${RESET} ${rawHex}  ${deltaStr}`,
    );
  }

  if (recording) {
    const rawHex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    const typeName = msg?.type ?? "RAW";
    const line = `${new Date().toISOString()},${direction.toLowerCase()},ccx,${typeName},,0,${rawHex}\n`;
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
    ccxRole < THREAD_ROLES.length
      ? THREAD_ROLES[ccxRole]
      : `unknown(${ccxRole})`;

  console.log(`\n${BOLD}${WHITE}── Nucleo Status ──${RESET}`);
  console.log(`  ${DIM}uptime:${RESET}          ${fmtUptime(uptime)}`);
  console.log(`  ${DIM}heap_free:${RESET}       ${fmtNum(heapFree)} bytes`);
  console.log();
  console.log(
    `  ${CYAN}CCA${RESET}  rx=${fmtNum(ccaRx)}  tx=${fmtNum(ccaTx)}  drop=${ccaDrop}  crc_fail=${ccaCrc}  n81_err=${ccaN81}`,
  );
  console.log(
    `  ${CYAN}CC1101${RESET}  overflow=${ccOverflow}  runt=${ccRunt}`,
  );
  console.log();
  console.log(
    `  ${YELLOW}CCX${RESET}  rx=${fmtNum(ccxRx)}  tx=${fmtNum(ccxTx)}  joined=${ccxJoined ? "yes" : "no"}  role=${roleName}`,
  );
  console.log();
  console.log(
    `  ${GREEN}ETH${RESET}  link=${ethLink ? "up" : "down"}  clients=${numClients}`,
  );
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

    console.log(
      `  ${MAGENTA}CCA Radio${RESET}  ack=${fmtNum(ccaAck)}  crc_optional=${fmtNum(ccaCrcOptional)}  irq=${fmtNum(ccaIrq)}`,
    );
    console.log(
      `  ${MAGENTA}Restarts${RESET}  timeout=${fmtNum(restartTimeout)}  overflow=${fmtNum(restartOverflow)}  manual=${fmtNum(restartManual)}  packet=${fmtNum(restartPacket)}`,
    );
    console.log(
      `  ${MAGENTA}Sync${RESET}  hit=${fmtNum(syncHit)}  miss=${fmtNum(syncMiss)}  hit_rate=${syncHit + syncMiss > 0 ? ((syncHit * 100) / (syncHit + syncMiss)).toFixed(1) : "0.0"}%`,
    );
    console.log(
      `  ${MAGENTA}Ring${RESET}  max_occ=${fmtNum(ringMax)}  in=${fmtNum(ringBytesIn)}B  dropped=${fmtNum(ringBytesDropped)}B`,
    );
    console.log(
      `  ${MAGENTA}IRQ->RX${RESET}  min=${fmtNum(isrLatMin)}us  p95=${fmtNum(isrLatP95)}us  max=${fmtNum(isrLatMax)}us  n=${fmtNum(isrLatSamples)}`,
    );
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
    return;
  }

  // Text response: [0xFD][text...]
  if (flags === RESP_TEXT) {
    if (textCmdTimer) {
      clearTimeout(textCmdTimer);
      textCmdTimer = null;
    }
    const text = msg.subarray(1).toString("utf-8");
    if (text.length > 0) process.stdout.write(text);
    showPrompt();
    return;
  }

  // Status response: [0xFE][len][status blob]
  if (flags === 0xfe) {
    const data = msg.subarray(2, 2 + len);
    displayStatus(data);
    showPrompt();
    return;
  }

  // Packet frames: [FLAGS:1][LEN:1][TS_MS:4 LE][DATA:N]
  if (msg.length < 6 + len) return;

  const radioTs = readU32LE(msg, 2);
  const data = msg.subarray(6, 6 + len);
  const isCcx = !!(flags & FLAG_CCX);

  // Compute per-protocol inter-packet delta
  let deltaMs = 0;
  if (isCcx) {
    if (lastCcxRadioTs > 0) {
      deltaMs = (radioTs - lastCcxRadioTs) & 0xffffffff;
    }
    lastCcxRadioTs = radioTs;
  } else {
    if (lastCcaRadioTs > 0) {
      deltaMs = (radioTs - lastCcaRadioTs) & 0xffffffff;
    }
    lastCcaRadioTs = radioTs;
  }

  if (quiet) return;

  // Protocol dispatch
  if (isCcx) {
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
    console.log(
      `${GREEN}UDP socket bound to :${addr.port}, sending to ${host}:${UDP_PORT}${RESET}`,
    );

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
${BOLD}Local commands:${RESET}
  ${GREEN}status${RESET}         Query device status (rich formatted view)
  ${GREEN}record${RESET} [name]  Start CSV recording
  ${GREEN}stop${RESET}           Stop recording
  ${GREEN}quiet${RESET}          Toggle packet display
  ${GREEN}raw${RESET}            Toggle raw hex display
  ${GREEN}help${RESET}           This help
  ${GREEN}quit${RESET}           Exit

${DIM}All other commands (cca, ccx, tx, etc.) are forwarded to the STM32 shell.${RESET}
${DIM}Type 'help' on the STM32 shell for the full command list: just type the${RESET}
${DIM}command directly (e.g. 'cca button 0595E68D on').${RESET}
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

  // Local-only commands
  switch (cmd) {
    case "help":
    case "?":
      showHelp();
      showPrompt();
      return;

    case "status":
      send(buildCmd(CMD.STATUS_QUERY));
      // Don't show prompt — wait for status response handler
      return;

    case "quiet":
      quiet = !quiet;
      console.log(`Packet display: ${quiet ? "off" : "on"}`);
      showPrompt();
      return;

    case "raw":
      raw = !raw;
      console.log(`Raw hex display: ${raw ? "on" : "off"}`);
      showPrompt();
      return;

    case "record": {
      if (recording) {
        console.log(
          `${YELLOW}Already recording to ${recording.file.split("/").pop()}${RESET}`,
        );
      } else {
        mkdirSync(CAPTURES_DIR, { recursive: true });
        const name = args[1] || "session";
        const ts = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fileName = `${safeName}_${ts}.csv`;
        const filePath = join(CAPTURES_DIR, fileName);
        writeFileSync(
          filePath,
          "timestamp,direction,protocol,type,device_id,rssi,raw_hex\n",
        );
        recording = { file: filePath, count: 0, startTime: Date.now() };
        console.log(`${GREEN}Recording to ${fileName}${RESET}`);
      }
      showPrompt();
      return;
    }

    case "stop": {
      if (!recording) {
        console.log(`${YELLOW}Not recording${RESET}`);
      } else {
        const elapsed = ((Date.now() - recording.startTime) / 1000).toFixed(1);
        const fileName = recording.file.split("/").pop();
        console.log(
          `${GREEN}Stopped recording: ${fileName} (${recording.count} packets, ${elapsed}s)${RESET}`,
        );
        recording = null;
      }
      showPrompt();
      return;
    }

    case "quit":
    case "exit":
      cleanup();
      process.exit(0);
      return;

    case "restart":
      sendTextCommand("reboot");
      return;
  }

  // Everything else → forward to STM32 shell
  sendTextCommand(trimmed);
}

// ============================================================================
// Cleanup
// ============================================================================

function cleanup() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  if (recording) {
    const fileName = recording.file.split("/").pop();
    console.log(
      `\n${YELLOW}Stopped recording: ${fileName} (${recording.count} packets)${RESET}`,
    );
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
  console.error(`Usage: bun cli/nucleo.ts <host> [--update-leap] [--leap-host <ip>] [--leap-certs <name>]`);
  console.error(`  or set NUCLEO_HOST environment variable`);
  console.error(`\nFlags:`);
  console.error(`  --update-leap         Fetch LEAP data at startup (save to data/, use for session)`);
  console.error(`  --leap-host <ip>      LEAP processor IP (default: 10.0.0.1)`);
  console.error(`  --leap-certs <name>   Cert name prefix (default: ra3)`);
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

// Fetch LEAP data if requested, then start
async function startup() {
  if (UPDATE_LEAP) {
    try {
      const { LeapConnection, fetchLeapData, buildDumpData } = await import("../tools/leap-client");
      const { mkdirSync, writeFileSync } = await import("fs");
      const { join } = await import("path");

      console.log(`${CYAN}Fetching LEAP data from ${LEAP_HOST} (certs: ${LEAP_CERTS})...${RESET}`);
      const leap = new LeapConnection({ host: LEAP_HOST, certName: LEAP_CERTS });
      await leap.connect();
      const result = await fetchLeapData(leap);
      leap.close();

      const dumpData = buildDumpData(LEAP_HOST, result);
      const dataDir = join(import.meta.dir, "../data");
      mkdirSync(dataDir, { recursive: true });
      const filePath = join(dataDir, `leap-${LEAP_HOST}.json`);
      writeFileSync(filePath, JSON.stringify(dumpData, null, 2) + "\n");

      setLeapData(dumpData);
      const nZones = Object.keys(dumpData.zones).length;
      const nDevices = Object.keys(dumpData.devices).length;
      const nPresets = Object.keys(dumpData.presets).length;
      console.log(`${GREEN}LEAP: ${nZones} zones, ${nDevices} devices, ${nPresets} presets → saved to ${filePath}${RESET}\n`);
    } catch (err: any) {
      console.error(`${YELLOW}LEAP fetch failed: ${err.message} — using hardcoded config${RESET}\n`);
    }
  }

  // Start UDP socket
  setupUdp();
}

startup();

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
