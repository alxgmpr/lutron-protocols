#!/usr/bin/env bun

/**
 * Nucleo CLI — interactive UDP shell for Nucleo H723ZG
 *
 * Connects over UDP to the Nucleo stream server (port 9433) and provides
 * an interactive shell mirroring the on-device commands, plus live packet
 * display using the protocol decoders from protocol/.
 *
 * Usage: bun cli/nucleo.ts <host>
 *        NUCLEO_HOST=10.0.0.3 bun cli/nucleo.ts
 */

import { createSocket, type Socket } from "dgram";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { stripVTControlCharacters } from "util";
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
const CCA_SLOT_MS = 12.5;
const CCA_SLOT_MAX_DT_MS = 400;
const CCA_SLOT_MAX_DSEQ = 32;
const CCA_SLOT_MAX_FLOWS = 256;
const CCA_SLOT_WARMUP_SAMPLES = 8;
const CCA_SLOT_GOOD_ERR_MS = 2.5;
const CCA_SLOT_MISS_MIN_CONFIDENCE = 85;
const CCA_SLOT_MISS_MIN_SAMPLES = 10;
const CCA_SLOT_MISS_STRIDE_PURITY_MIN = 0.75;

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
import { RA3_HOST } from "../lib/env";
const LEAP_HOST = getCliArg("--leap-host") ?? RA3_HOST;
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
let slotTracking = true;
let lockDetails = false;

interface CcaSlotFlowState {
  key: string;
  lastTs: number;
  lastSeq: number;
  samples: number;
  goodSamples: number;
  emaAbsErrMs: number;
  strideCounts: Map<number, number>;
  lastSeenTick: number;
}

interface CcaSlotIndicator {
  status: "LEARN" | "TRACK" | "LOCK";
  confidencePct: number;
  dSeq?: number;
  errMs?: number;
  missedPackets?: number;
}

const ccaSlotFlows = new Map<string, CcaSlotFlowState>();
let packetRowsSinceHeader = 0;
let packetHeaderSig = "";

const PACKET_HEADER_INTERVAL = 40;
const MIN_PACKET_STATE_WIDTH = 10;
const MIN_PACKET_RAW_WIDTH = 12;
const MIN_PACKET_DELTA_WIDTH = 6;
const MIN_PACKET_SLOT_WIDTH = 6;
const MIN_PACKET_MISS_WIDTH = 4;
const MIN_PACKET_SEQ_WIDTH = 3;

interface PacketLayout {
  showRaw: boolean;
  totalWidth: number;
  time: number;
  proto: number;
  dir: number;
  seq: number;
  type: number;
  device: number;
  action: number;
  state: number;
  raw: number;
  delta: number;
  slot: number;
  miss: number;
}

interface PacketRow {
  ts: string;
  proto: string;
  protoColor: string;
  direction: string;
  dirColor: string;
  seq: string;
  type: string;
  typeColor: string;
  device: string;
  deviceColor?: string;
  action: string;
  actionColor?: string;
  state: string;
  raw: string;
  delta: string;
  slot: string;
  slotColor?: string;
  miss: string;
  missColor?: string;
}

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

function pruneCcaSlotFlows() {
  if (ccaSlotFlows.size <= CCA_SLOT_MAX_FLOWS) return;
  const entries = Array.from(ccaSlotFlows.values()).sort(
    (a, b) => a.lastSeenTick - b.lastSeenTick,
  );
  const removeCount = ccaSlotFlows.size - CCA_SLOT_MAX_FLOWS;
  for (let i = 0; i < removeCount; i++) {
    ccaSlotFlows.delete(entries[i].key);
  }
}

function slotConfidence(state: CcaSlotFlowState): number {
  if (state.samples <= 0) return 0;
  const warmup = Math.min(1, state.samples / CCA_SLOT_WARMUP_SAMPLES);
  const goodRate = state.goodSamples / state.samples;
  const errScore = Math.max(0, Math.min(1, 1 - state.emaAbsErrMs / 6));
  const score = warmup * (0.7 * goodRate + 0.3 * errScore);
  return Math.round(score * 100);
}

function slotStatus(confidencePct: number): "LEARN" | "TRACK" | "LOCK" {
  if (confidencePct >= 75) return "LOCK";
  if (confidencePct >= 45) return "TRACK";
  return "LEARN";
}

function formatDevKey(data: Buffer): string {
  if (data.length < 6) return "NA";
  return Array.from(data.subarray(2, 6))
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join("");
}

function slotFlowKey(data: Buffer): string {
  if (data.length >= 6) return formatDevKey(data);
  const typeByte = data.length > 0 ? data[0] : 0;
  const typeHex = typeByte.toString(16).toUpperCase().padStart(2, "0");

  // Dimmer ACK short packets: 0B [seq] [response_class] [seq^0x26] [response_subtype]
  // Key by stable fields so parallel ACK sources don't blend into one lock flow.
  if (typeByte === 0x0b && data.length >= 5) {
    const clsHex = data[2].toString(16).toUpperCase().padStart(2, "0");
    const subHex = data[4].toString(16).toUpperCase().padStart(2, "0");
    return `T${typeHex}-${clsHex}-${subHex}`;
  }

  return `T${typeHex}`;
}

function dominantStride(strideCounts: Map<number, number>): number | null {
  let bestStride = 0;
  let bestCount = 0;
  for (const [stride, count] of strideCounts) {
    if (count > bestCount || (count === bestCount && stride < bestStride)) {
      bestStride = stride;
      bestCount = count;
    }
  }
  return bestCount > 0 ? bestStride : null;
}

function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

function clipCell(
  text: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  const clipped =
    plain.length > width
      ? width <= 3
        ? plain.slice(0, width)
        : `${plain.slice(0, width - 3)}...`
      : plain;

  if (align === "right") return clipped.padStart(width);
  if (align === "center") {
    const left = Math.floor((width - clipped.length) / 2);
    const right = width - clipped.length - left;
    return `${" ".repeat(Math.max(0, left))}${clipped}${" ".repeat(Math.max(0, right))}`;
  }
  return clipped.padEnd(width);
}

function colorCell(text: string, color: string, bold = false): string {
  if (!color) return text;
  return `${bold ? BOLD : ""}${color}${text}${RESET}`;
}

function getPacketLayout(showRaw: boolean): PacketLayout {
  const termWidth =
    typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : 120;

  const layout: PacketLayout = {
    showRaw,
    totalWidth: 0,
    time: 12,
    proto: 1,
    dir: 2,
    seq: 4,
    type: 16,
    device: 20,
    action: 12,
    state: MIN_PACKET_STATE_WIDTH,
    raw: showRaw ? 24 : 0,
    delta: 8,
    slot: 12,
    miss: 5,
  };

  const columns = showRaw ? 12 : 11;
  const spaces = columns - 1;
  const fixedNoState =
    layout.time +
    layout.proto +
    layout.dir +
    layout.seq +
    layout.type +
    layout.device +
    layout.action +
    layout.delta +
    layout.slot +
    layout.miss +
    (showRaw ? layout.raw : 0);

  let availableState = termWidth - fixedNoState - spaces;
  while (availableState < MIN_PACKET_STATE_WIDTH) {
    if (showRaw && layout.raw > MIN_PACKET_RAW_WIDTH) {
      layout.raw--;
      availableState++;
      continue;
    }
    if (layout.slot > MIN_PACKET_SLOT_WIDTH) {
      layout.slot--;
      availableState++;
      continue;
    }
    if (layout.delta > MIN_PACKET_DELTA_WIDTH) {
      layout.delta--;
      availableState++;
      continue;
    }
    if (layout.miss > MIN_PACKET_MISS_WIDTH) {
      layout.miss--;
      availableState++;
      continue;
    }
    if (layout.seq > MIN_PACKET_SEQ_WIDTH) {
      layout.seq--;
      availableState++;
      continue;
    }
    if (layout.device > 10) {
      layout.device--;
      availableState++;
      continue;
    }
    if (layout.action > 8) {
      layout.action--;
      availableState++;
      continue;
    }
    if (layout.type > 10) {
      layout.type--;
      availableState++;
      continue;
    }
    if (layout.time > 8) {
      layout.time--;
      availableState++;
      continue;
    }
    break;
  }

  layout.state = Math.max(MIN_PACKET_STATE_WIDTH, availableState);
  layout.totalWidth =
    layout.time +
    layout.proto +
    layout.dir +
    layout.seq +
    layout.type +
    layout.action +
    layout.device +
    layout.state +
    (showRaw ? layout.raw : 0) +
    layout.delta +
    layout.slot +
    layout.miss +
    spaces;

  return layout;
}

function renderPacketHeader(layout: PacketLayout) {
  const headerCells: string[] = [
    clipCell("TIME", layout.time),
    clipCell("P", layout.proto, "center"),
    clipCell("D", layout.dir, "center"),
    clipCell("S", layout.seq, "right"),
    clipCell("TYPE", layout.type),
    clipCell("DEVICE", layout.device),
    clipCell("ACTION", layout.action),
    clipCell("STATE", layout.state),
  ];
  if (layout.showRaw) {
    headerCells.push(clipCell("RAW", layout.raw, "right"));
  }
  headerCells.push(clipCell("DELTA", layout.delta, "right"));
  headerCells.push(clipCell("SLOT", layout.slot));
  headerCells.push(clipCell("MISS", layout.miss, "right"));
  const headerLine = headerCells.join(" ");
  console.log(`${DIM}${headerLine}${RESET}`);
  console.log(`${DIM}${"-".repeat(layout.totalWidth)}${RESET}`);
}

function renderPacketRow(row: PacketRow) {
  const layout = getPacketLayout(raw);
  const headerSig = `${layout.totalWidth}:${layout.showRaw ? 1 : 0}`;
  if (
    packetHeaderSig !== headerSig ||
    packetRowsSinceHeader >= PACKET_HEADER_INTERVAL
  ) {
    renderPacketHeader(layout);
    packetHeaderSig = headerSig;
    packetRowsSinceHeader = 0;
  }

  const cells: string[] = [
    clipCell(row.ts, layout.time),
    colorCell(clipCell(row.proto, layout.proto, "center"), row.protoColor),
    colorCell(clipCell(row.direction, layout.dir, "center"), row.dirColor),
    clipCell(row.seq, layout.seq, "right"),
    colorCell(clipCell(row.type, layout.type), row.typeColor, true),
    colorCell(clipCell(row.device, layout.device), row.deviceColor ?? YELLOW),
    colorCell(clipCell(row.action, layout.action), row.actionColor ?? WHITE),
    clipCell(row.state, layout.state),
  ];
  if (layout.showRaw) {
    cells.push(clipCell(row.raw, layout.raw, "right"));
  }
  cells.push(clipCell(row.delta, layout.delta, "right"));
  cells.push(
    colorCell(clipCell(row.slot, layout.slot), row.slotColor ?? WHITE),
  );
  cells.push(
    colorCell(clipCell(row.miss, layout.miss, "right"), row.missColor ?? RED),
  );

  console.log(cells.join(" "));
  packetRowsSinceHeader++;
}

function updateCcaSlotTracker(
  data: Buffer,
  isTx: boolean,
  radioTs: number,
): CcaSlotIndicator | null {
  if (!slotTracking || isTx || data.length < 2) return null;

  const seq = data[1];
  // Track per-device when possible; for short packets (e.g. 0x0B ACK),
  // fall back to a per-type flow key.
  const key = slotFlowKey(data);
  const nowTick = Date.now();

  let state = ccaSlotFlows.get(key);
  if (!state) {
    state = {
      key,
      lastTs: radioTs >>> 0,
      lastSeq: seq,
      samples: 0,
      goodSamples: 0,
      emaAbsErrMs: 0,
      strideCounts: new Map<number, number>(),
      lastSeenTick: nowTick,
    };
    ccaSlotFlows.set(key, state);
    pruneCcaSlotFlows();
    return { status: "LEARN", confidencePct: 0 };
  }

  state.lastSeenTick = nowTick;
  const dtMs = ((radioTs >>> 0) - (state.lastTs >>> 0)) >>> 0;
  const dSeq = ((seq - state.lastSeq + 256) & 0xff) >>> 0;
  state.lastTs = radioTs >>> 0;
  state.lastSeq = seq;

  let errMs: number | undefined;
  let sampleDSeq: number | undefined;
  if (
    dtMs > 0 &&
    dtMs <= CCA_SLOT_MAX_DT_MS &&
    dSeq > 0 &&
    dSeq <= CCA_SLOT_MAX_DSEQ
  ) {
    sampleDSeq = dSeq;
    const predictedMs = CCA_SLOT_MS * dSeq;
    errMs = dtMs - predictedMs;
    const absErrMs = Math.abs(errMs);

    state.samples++;
    if (absErrMs <= CCA_SLOT_GOOD_ERR_MS) state.goodSamples++;
    state.emaAbsErrMs =
      state.samples === 1 ? absErrMs : state.emaAbsErrMs * 0.8 + absErrMs * 0.2;
    state.strideCounts.set(dSeq, (state.strideCounts.get(dSeq) || 0) + 1);
  }

  const confidencePct = slotConfidence(state);
  let status = slotStatus(confidencePct);
  const stride = dominantStride(state.strideCounts);
  const dominantCount =
    stride !== null ? state.strideCounts.get(stride) || 0 : 0;
  const stridePurity = state.samples > 0 ? dominantCount / state.samples : 0;
  // If confidence is still warming but stride is stable, show TRACK for usability.
  if (
    status === "LEARN" &&
    stride !== null &&
    state.samples >= 4 &&
    confidencePct >= 40
  ) {
    status = "TRACK";
  }

  let missedPackets: number | undefined;
  if (
    sampleDSeq !== undefined &&
    errMs !== undefined &&
    stride !== null &&
    stride > 0 &&
    confidencePct >= CCA_SLOT_MISS_MIN_CONFIDENCE &&
    state.samples >= CCA_SLOT_MISS_MIN_SAMPLES &&
    stridePurity >= CCA_SLOT_MISS_STRIDE_PURITY_MIN &&
    sampleDSeq >= stride * 2 &&
    sampleDSeq % stride === 0 &&
    Math.abs(errMs) <= CCA_SLOT_GOOD_ERR_MS
  ) {
    missedPackets = sampleDSeq / stride - 1;
  }

  return { status, confidencePct, dSeq: sampleDSeq, errMs, missedPackets };
}

// ============================================================================
// RX packet display
// ============================================================================

function displayCcaPacket(
  data: Buffer,
  flags: number,
  radioTs: number = 0,
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
  const seq = data.length > 1 ? data[1] : 0;
  const ts = new Date().toISOString().slice(11, 23);

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
  const rawHex = hexBytes.join(" ");

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

  let deviceText = "";
  let deviceColor = WHITE;
  const takeDevice = (fieldName: string, label: string): boolean => {
    const val = fieldValues.get(fieldName);
    if (!val || deviceText) return false;
    let text = `${label}:${val}`;
    const serial = parseInt(val, 16);
    if (serial > 0) {
      const name = getSerialName(serial);
      if (name) text += ` "${name}"`;
    }
    deviceText = text;
    deviceColor = YELLOW;
    fieldValues.delete(fieldName);
    return true;
  };
  takeDevice("device_id", "dev") ||
    takeDevice("source_id", "src") ||
    takeDevice("load_id", "load") ||
    takeDevice("hardware_id", "hw") ||
    takeDevice("target_id", "target");

  let actionText = "";
  let actionColor = WHITE;
  const stateParts: string[] = [];

  fieldValues.delete("sequence");
  if (category === "BUTTON") {
    let btn = fieldValues.get("button") || "";
    const act = fieldValues.get("action") || "";
    // Enhance 4-button pico display using format byte + cmd_class (byte 17)
    // cmd_class 0x42 = dim (RAISE/LOWER), 0x40 = scene/preset
    // Action byte means "has payload" not "press/release" — don't display it
    // when we have command semantics; the packet type name already says press/release
    const fmtByte = data.length > 7 ? data[7] : 0;
    const cmdClass = data.length > 17 ? data[17] : 0x00;
    const cmdParam = data.length > 19 ? data[19] : 0x00;
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
      // Show action qualifier: action byte 0x00 = start/press, 0x01 = stop/release
      const actByte = data.length > 11 ? data[11] : 0;
      actionText = actByte === 0x00 ? `${btn} PRESS` : btn;
    } else {
      // 5-button pico or short 4-button tap — use action as-is
      const btnAct = `${btn}${btn && act ? " " : ""}${act}`.trim();
      actionText = btnAct;
    }
    actionColor = GREEN;
    fieldValues.delete("button");
    fieldValues.delete("action");
  } else if (category === "STATE" || category === "CONFIG") {
    actionText = category === "STATE" ? "REPORT" : "CONFIG";
    actionColor = BLUE;
    // Level as percentage
    const level = fieldValues.get("level");
    const sliderLevel = fieldValues.get("slider_level");
    if (level) {
      stateParts.push(level);
      fieldValues.delete("level");
    }
    // Show slider_level when it differs from level (e.g. light off but slider at position)
    if (sliderLevel && sliderLevel !== level) {
      stateParts.push(`slider=${sliderLevel}`);
    }
    fieldValues.delete("slider_level");
    // Format byte as fmt=XX (read raw since hex format doesn't decode)
    if (data.length > 7) {
      stateParts.push(`fmt=${data[7].toString(16).padStart(2, "0")}`);
    }
  } else if (category === "PAIRING") {
    actionText = "PAIR";
    actionColor = MAGENTA;
    // Translate device_class — read raw byte since hex format doesn't auto-decode
    const dcField = identified.fields.find((f) => f.name === "device_class");
    if (dcField && data.length > dcField.offset) {
      const code = data[dcField.offset];
      const name =
        DeviceClassNames[code] || `0x${code.toString(16).padStart(2, "0")}`;
      stateParts.push(`class=${name}`);
    }
    fieldValues.delete("device_class");
  } else if (category === "HANDSHAKE") {
    actionText = "HS";
    actionColor = RED;
    stateParts.push(identified.description);
  } else if (category === "BEACON") {
    actionText = "BEACON";
    actionColor = YELLOW;
  }

  // Remaining fields
  for (const [name, val] of fieldValues) {
    if (name === "format") continue; // already handled or not needed
    stateParts.push(`${name}=${val}`);
  }

  const slot = updateCcaSlotTracker(data, isTx, radioTs);
  const deltaText = deltaMs > 0 ? `+${deltaMs}ms` : "";
  let slotText = "";
  let slotColor = WHITE;
  let missText = "";
  let missColor = RED;
  if (slot) {
    slotColor =
      slot.status === "LOCK" ? GREEN : slot.status === "TRACK" ? YELLOW : WHITE;
    const slotLabel = lockDetails
      ? `${slot.status}${slot.confidencePct}%`
      : slot.status;
    const slotParts: string[] = [slotLabel];
    if (slot.dSeq && slot.dSeq > 0) slotParts.push(`d${slot.dSeq}`);
    if (lockDetails) {
      const errPart =
        slot.errMs !== undefined
          ? `e${slot.errMs >= 0 ? "+" : ""}${slot.errMs.toFixed(1)}ms`
          : "e?";
      slotParts.push(errPart);
    }
    if (slot.missedPackets && slot.missedPackets > 0) {
      missText = String(slot.missedPackets);
      missColor = RED;
    }
    slotText = slotParts.join(" ");
  }

  if (!actionText && stateParts.length === 0) {
    // Unknown/unparsed packets: state falls back to raw bytes.
    stateParts.push(rawHex);
  }

  renderPacketRow({
    ts,
    proto: "A",
    protoColor: CYAN,
    direction,
    dirColor,
    seq: `#${seq}`,
    type: typeName,
    typeColor,
    device: deviceText,
    deviceColor,
    action: actionText,
    actionColor,
    state: stateParts.join("  "),
    raw: raw ? rawHex : "",
    delta: deltaText,
    slot: slotText,
    slotColor,
    miss: missText,
    missColor,
  });

  // CSV recording
  if (recording) {
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
      parts.push(levelStr);
      if (zoneName) {
        parts.push(`zone=${msg.zoneId} "${zoneName}"`);
      } else {
        parts.push(`zone=${msg.zoneId}`);
      }
      const fadeSec = msg.fade / 4;
      if (fadeSec !== 0.25) parts.push(`fade=${fadeSec}s`);
      if (msg.delay > 0) parts.push(`delay=${msg.delay / 4}s`);
      return { typeName: "LEVEL_CONTROL", parts };
    }
    case "BUTTON_PRESS": {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      if (preset) {
        parts.push(`"${preset.name}" [${preset.device}]`);
      } else {
        parts.push(`preset=${presetId}`);
      }
      return { typeName: "BUTTON_PRESS", parts };
    }
    case "DIM_HOLD": {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      if (preset) {
        parts.push(`"${preset.name}" [${preset.device}]`);
      } else {
        parts.push(`preset=${presetId}`);
      }
      if (msg.action !== undefined) parts.push(`action=${msg.action}`);
      return { typeName: "DIM_HOLD", parts };
    }
    case "DIM_STEP": {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      if (preset) {
        parts.push(`"${preset.name}" [${preset.device}]`);
      } else {
        parts.push(`preset=${presetId}`);
      }
      parts.push(`step=${msg.stepValue}`);
      return { typeName: "DIM_STEP", parts };
    }
    case "ACK": {
      const respHex = Array.from(msg.response)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      parts.push(`response=${respHex}`);
      return { typeName: "ACK", parts };
    }
    case "DEVICE_REPORT": {
      const serialInfo = getSerialName(msg.deviceSerial);
      if (serialInfo) {
        parts.push(`"${serialInfo}"`);
      }
      parts.push(`serial=${msg.deviceSerial}`);
      if (msg.groupId) parts.push(`group=${msg.groupId}`);
      return { typeName: "DEVICE_REPORT", parts };
    }
    case "SCENE_RECALL": {
      parts.push(`scene=${msg.sceneId}`);
      if (msg.params.length > 0) parts.push(`params=[${msg.params.join(",")}]`);
      return { typeName: "SCENE_RECALL", parts };
    }
    case "COMPONENT_CMD": {
      parts.push(`group=${msg.groupId}`);
      if (msg.params.length > 0) parts.push(`params=[${msg.params.join(",")}]`);
      return { typeName: "COMPONENT_CMD", parts };
    }
    case "STATUS": {
      parts.push(`dev=0x${msg.deviceId.toString(16).padStart(8, "0")}`);
      return { typeName: "STATUS", parts };
    }
    case "PRESENCE": {
      parts.push(`status=${msg.status}`);
      return { typeName: "PRESENCE", parts };
    }
    case "UNKNOWN": {
      parts.push(`type=${msg.msgType}`);
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
  const deltaStr = deltaMs > 0 ? `+${deltaMs}ms` : "";

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

    // Category color
    const catColor: Record<string, string> = {
      LEVEL_CONTROL: BLUE,
      BUTTON_PRESS: GREEN,
      DIM_HOLD: GREEN,
      DIM_STEP: GREEN,
      ACK: WHITE,
      DEVICE_REPORT: CYAN,
      SCENE_RECALL: MAGENTA,
      COMPONENT_CMD: MAGENTA,
      STATUS: YELLOW,
      PRESENCE: WHITE,
    };
    const typeColor = catColor[msg.type] || WHITE;
    const rawHex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    let deviceText = "";
    if ("deviceId" in msg) {
      const devId = (msg as { deviceId: number }).deviceId;
      deviceText = `dev:${devId.toString(16).toUpperCase().padStart(8, "0")}`;
    } else if ("deviceSerial" in msg) {
      const serial = (msg as { deviceSerial: number }).deviceSerial;
      const name = getSerialName(serial);
      deviceText = name ? `serial:${serial} "${name}"` : `serial:${serial}`;
    }
    const actionText = msg.type.replaceAll("_", " ");

    renderPacketRow({
      ts,
      proto: "X",
      protoColor: YELLOW,
      direction,
      dirColor,
      seq: seq ? `#${seq}` : "",
      type: typeName,
      typeColor,
      device: deviceText,
      deviceColor: CYAN,
      action: actionText,
      actionColor: typeColor,
      state: parts.join("  "),
      raw: raw ? rawHex : "",
      delta: deltaStr,
      slot: "",
      miss: "",
    });
  } else {
    // Fallback: raw hex (always show)
    const rawHex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    renderPacketRow({
      ts,
      proto: "X",
      protoColor: YELLOW,
      direction,
      dirColor,
      seq: "",
      type: "RAW",
      typeColor: WHITE,
      device: "",
      action: "RAW",
      actionColor: WHITE,
      state: raw ? "" : rawHex,
      raw: raw ? rawHex : "",
      delta: deltaStr,
      slot: "",
      miss: "",
    });
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
  ${GREEN}lock${RESET} [on|off]  Toggle lock detail fields (%/d/e)
  ${GREEN}slot${RESET} [reset]   Toggle slot-tracking overlay or reset tracker
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

    case "lock": {
      const mode = (args[1] || "").toLowerCase();
      if (mode === "on") lockDetails = true;
      else if (mode === "off") lockDetails = false;
      else lockDetails = !lockDetails;
      console.log(`Lock details: ${lockDetails ? "on" : "off"}`);
      showPrompt();
      return;
    }

    case "slot":
      if ((args[1] || "").toLowerCase() === "reset") {
        ccaSlotFlows.clear();
        console.log("Slot tracker: reset");
      } else {
        slotTracking = !slotTracking;
        console.log(`Slot tracker: ${slotTracking ? "on" : "off"}`);
      }
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
  console.error(
    `Usage: bun cli/nucleo.ts <host> [--update-leap] [--leap-host <ip>] [--leap-certs <name>]`,
  );
  console.error(`  or set NUCLEO_HOST environment variable`);
  console.error(`\nFlags:`);
  console.error(
    `  --update-leap         Fetch LEAP data at startup (save to data/, use for session)`,
  );
  console.error(
    `  --leap-host <ip>      LEAP processor IP (default: $RA3_HOST)`,
  );
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

/** Load saved LEAP data from data/leap-*.json, merging all files */
function loadSavedLeapData(): boolean {
  const dataDir = join(import.meta.dir, "../data");
  if (!existsSync(dataDir)) return false;

  const files = readdirSync(dataDir).filter(
    (f) => f.startsWith("leap-") && f.endsWith(".json"),
  );
  if (files.length === 0) return false;

  // Merge all LEAP dump files into one combined dataset
  const merged = {
    zones: {} as Record<string, any>,
    devices: {} as Record<string, any>,
    serials: {} as Record<string, any>,
    presets: {} as Record<string, any>,
  };

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dataDir, file), "utf-8"));
      Object.assign(merged.zones, data.zones ?? {});
      Object.assign(merged.devices, data.devices ?? {});
      Object.assign(merged.serials, data.serials ?? {});
      Object.assign(merged.presets, data.presets ?? {});
    } catch {
      // Skip malformed files
    }
  }

  const nSerials = Object.keys(merged.serials).length;
  if (nSerials === 0) return false;

  setLeapData(merged as any);
  const nZones = Object.keys(merged.zones).length;
  console.log(
    `${DIM}LEAP: loaded ${nSerials} devices, ${nZones} zones from ${files.length} saved file(s)${RESET}`,
  );
  return true;
}

// Fetch LEAP data if requested, then start
async function startup() {
  if (UPDATE_LEAP) {
    try {
      const { LeapConnection, fetchLeapData, buildDumpData } = await import(
        "../tools/leap-client"
      );

      console.log(
        `${CYAN}Fetching LEAP data from ${LEAP_HOST} (certs: ${LEAP_CERTS})...${RESET}`,
      );
      const leap = new LeapConnection({
        host: LEAP_HOST,
        certName: LEAP_CERTS,
      });
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
      console.log(
        `${GREEN}LEAP: ${nZones} zones, ${nDevices} devices, ${nPresets} presets → saved to ${filePath}${RESET}\n`,
      );
    } catch (err: any) {
      console.error(
        `${YELLOW}LEAP fetch failed: ${err.message} — using saved LEAP data${RESET}\n`,
      );
      // Fall back to saved data
      loadSavedLeapData();
    }
  } else {
    // Auto-load saved LEAP data from data/ directory
    loadSavedLeapData();
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
