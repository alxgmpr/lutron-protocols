#!/usr/bin/env npx tsx

/**
 * Nucleo CLI — interactive UDP shell for Nucleo H723ZG
 *
 * Connects over UDP to the Nucleo stream server (port 9433) and provides
 * an interactive shell mirroring the on-device commands, plus live packet
 * display using the protocol decoders from protocol/.
 *
 * Usage: npx tsx cli/nucleo.ts <host>
 *        npx tsx cli/nucleo.ts                  # uses openBridge from config.json
 */

import { decode as cborDecode } from "cbor-x";
import { createSocket, type Socket } from "dgram";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  getDeviceBySerial,
  getPresetInfo,
  getSceneName,
  getSerialName,
  getZoneName,
  presetIdFromDeviceId,
  setLeapData,
} from "../ccx/config";
import { Level } from "../ccx/constants";
import { decodeBytes } from "../ccx/decoder";
import type { CCXMessage } from "../ccx/types";
import { DeviceClassNames } from "../protocol/cca.protocol";
import {
  fingerprintDevice,
  identifyPacket,
  parseFieldValue,
} from "../protocol/protocol-ui";
import {
  BLUE,
  BOLD,
  CYAN,
  DIM,
  GREEN,
  getPacketLayout,
  MAGENTA,
  type PacketRow,
  RED,
  RESET,
  renderHeader,
  renderRow,
  WHITE,
  YELLOW,
} from "./core/packets";
import { createScreen, type InkScreen } from "./ui/screen";

// ============================================================================
// Constants
// ============================================================================
const __dirname = dirname(fileURLToPath(import.meta.url));
const UDP_PORT = 9433;
const KEEPALIVE_MS = 5000;
const CONNECTION_TIMEOUT_MS = 12000; // no datagram for 12s → disconnected
const CAPTURES_DIR = join(__dirname, "../captures/cca-sessions");
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

import { config, defaultHost } from "../lib/config";

const LEAP_HOST = getCliArg("--leap-host") ?? defaultHost;

// ============================================================================
// State
// ============================================================================
// Find first positional arg (skip flags and their values)
const FLAG_WITH_VALUE = new Set(["--leap-host"]);
let host = "";
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
if (!host) host = process.env.OPEN_BRIDGE_HOST || config.openBridge;
let udpSocket: Socket;
let quiet = false;
let raw = true;
let verbose = false;
let recording: { file: string; count: number; startTime: number } | null = null;
let keepaliveTimer: ReturnType<typeof setInterval>;
let lastCcaRadioTs = 0; // for CCA inter-packet delta
let lastCcxRadioTs = 0; // for CCX inter-packet delta
let lastDatagramTime = 0; // wall-clock ms of last received datagram
let connected = false;
let textCmdTimer: ReturnType<typeof setTimeout> | null = null;
let slotTracking = true;
let showDiag = !hasCliFlag("--no-diag");

// ============================================================================
// CoAP first-class interface state
// ============================================================================
interface CoapPending {
  method: string;
  addr: string;
  path: string;
  lines: string[];
  startTime: number;
}

interface CoapScanJob {
  addr: string;
  paths: string[];
  hits: Map<string, string>; // path → code
  sent: number;
  received: number;
  startTime: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let coapPending: CoapPending | null = null;
let coapScan: CoapScanJob | null = null;

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
  dtMs?: number;
  errMs?: number;
  missedPackets?: number;
}

const ccaSlotFlows = new Map<string, CcaSlotFlowState>();

// TUI instance — combined screen + line-editor adapter backed by Ink.
const screen: InkScreen = createScreen();

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
    screen.appendLine(`${RED}Socket not ready${RESET}`);
    return false;
  }
  udpSocket.send(frame, 0, frame.length, UDP_PORT, host);
  return true;
}

/** Send a text command to the STM32 shell via UDP passthrough */
function sendTextCommand(text: string) {
  const textBytes = new TextEncoder().encode(text);
  send(buildCmd(CMD.TEXT, textBytes));
  // Safety timeout — if no response in 10s
  textCmdTimer = setTimeout(() => {
    textCmdTimer = null;
    screen.appendLine(`${YELLOW}(no response — timeout)${RESET}`);
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

// ============================================================================
// TUI helpers
// ============================================================================
let ccaRxCount = 0;
let ccaTxCount = 0;
let ccxRxCount = 0;
let ccxTxCount = 0;

function updateColumnHeaders(): void {
  const layout = getPacketLayout(raw, screen.width, verbose);
  const [labels, separator] = renderHeader(layout);
  screen.setColumnHeaders(labels, separator);
}

function updateStatusBar(): void {
  const parts: string[] = [];
  if (quiet) parts.push(`${YELLOW}[quiet]${RESET}`);
  if (!raw) parts.push(`${CYAN}[raw off]${RESET}`);
  if (verbose) parts.push(`${GREEN}[verbose]${RESET}`);
  if (!showDiag) parts.push(`${YELLOW}[diag off]${RESET}`);
  if (!slotTracking) parts.push(`${YELLOW}[slot off]${RESET}`);
  if (recording) parts.push(`${RED}[REC ${recording.count}]${RESET}`);
  if (coapScan) {
    const { sent, received, hits, paths } = coapScan;
    parts.push(
      `${CYAN}[scan ${sent}/${paths.length} sent=${sent} recv=${received} hits=${hits.size}]${RESET}`,
    );
  }
  screen.setStatusBar(parts.join(" "));
}

function updateHeader(): void {
  const connState = connected
    ? `${GREEN}● Connected${RESET}`
    : `${RED}● Disconnected${RESET}`;
  const left = `${BOLD}Nucleo CLI${RESET} — ${host}:${UDP_PORT}  ${connState}`;
  const counters = `${DIM}CCA ${ccaRxCount}rx ${ccaTxCount}tx  CCX ${ccxRxCount}rx ${ccxTxCount}tx${RESET}`;
  screen.setHeader(left, counters);
}

function emitPacketRow(row: PacketRow): void {
  const layout = getPacketLayout(raw, screen.width, verbose);
  const rendered = renderRow(row, layout);
  screen.appendLine(rendered);
  // Emit verbose detail line if present
  if (row.verboseLine) {
    const detailRow: PacketRow = {
      ts: "",
      proto: "",
      protoColor: "",
      direction: "",
      dirColor: "",
      rssi: "",
      seq: "",
      opcode: "",
      typeAction: "",
      typeActionColor: "",
      device: "",
      zone: "",
      state: "",
      raw: "",
      delta: "",
      isDetail: true,
      verboseLine: row.verboseLine,
    };
    const detailRendered = renderRow(detailRow, layout);
    if (detailRendered) {
      screen.appendLine(detailRendered);
    }
  }
}

function fullRedraw(): void {
  updateHeader();
  updateColumnHeaders();
  updateStatusBar();
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

  return {
    status,
    confidencePct,
    dSeq: sampleDSeq,
    dtMs: dtMs > 0 && dtMs <= CCA_SLOT_MAX_DT_MS ? dtMs : undefined,
    errMs,
    missedPackets,
  };
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
  if (isTx) ccaTxCount++;
  else ccaRxCount++;
  updateHeader();
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
    "link_addr",
  ]);

  // Fields that are only useful when decoded (skip raw hex noise)
  const DECODE_ONLY = new Set([
    "format",
    "data",
    "flags",
    "pair_flag",
    "btn_scheme",
    "device_type",
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
      field.name,
    );
    if (decoded) {
      fieldValues.set(field.name, decoded);
    } else if (!DECODE_ONLY.has(field.name) && raw !== "-") {
      fieldValues.set(field.name, raw);
    }
  }

  const fallbackDeviceId =
    data.length >= 6
      ? Array.from(data.subarray(2, 6))
          .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
          .join("")
      : "";

  // Device column: MAC-only (8 hex chars)
  let deviceText = "";
  let deviceColor = WHITE;
  let _deviceSerial = 0; // for LEAP zone lookup
  const takeDevice = (fieldName: string): boolean => {
    const val = fieldValues.get(fieldName);
    if (!val || deviceText) return false;
    deviceText = val;
    _deviceSerial = parseInt(val, 16);
    deviceColor = YELLOW;
    fieldValues.delete(fieldName);
    return true;
  };
  takeDevice("device_id") ||
    takeDevice("source_id") ||
    takeDevice("load_id") ||
    takeDevice("hardware_id") ||
    takeDevice("target_id");
  // Fallback to raw bytes 2-5 only if packet doesn't have QS address fields
  const hasQsAddress = identified.fields.some((f) => f.name === "subnet");
  if (!deviceText && !hasQsAddress && fallbackDeviceId) {
    deviceText = fallbackDeviceId;
    _deviceSerial = parseInt(fallbackDeviceId, 16);
    deviceColor = YELLOW;
  }

  // Zone column: from packet fields only (no LEAP enrichment in compact mode)
  let zoneText = "";
  let zoneColor = WHITE;
  // State reports (0x80-0x83): bytes 3-4 = subnet, byte 5 = zone
  const packetSubnet = fieldValues.get("subnet");
  const packetZone = fieldValues.get("zone");
  if (packetSubnet || packetZone) {
    const parts: string[] = [];
    if (packetSubnet) {
      parts.push(packetSubnet.replace(/\s/g, ""));
      fieldValues.delete("subnet");
    }
    if (packetZone) {
      parts.push(packetZone);
      fieldValues.delete("zone");
    }
    zoneText = parts.join("/");
    zoneColor = CYAN;
  }
  // Packet-level zone_id (PAIR_B0 etc)
  const packetZoneId = fieldValues.get("zone_id");
  if (!zoneText && packetZoneId) {
    zoneText = packetZoneId.replace(/\s/g, "");
    zoneColor = CYAN;
    fieldValues.delete("zone_id");
  }

  // Fields whose values are self-evident (strip labels in compact mode)
  const STRIP_LABELS = new Set([
    "level",
    "slider_level",
    "fade",
    "delay",
    "format",
    "fmt",
  ]);

  let typeActionText = "";
  let typeActionColor = WHITE;
  const stateParts: string[] = [];
  const verboseParts: string[] = [];

  fieldValues.delete("sequence");
  if (category === "BUTTON") {
    let btn = fieldValues.get("button") || "";
    // Action byte (offset 11): 0x00=PRESS, 0x01=RELEASE (authoritative)
    // Type groups A/B alternate between successive presses for double-tap detection
    const actByte = data.length > 11 ? data[11] : 0;
    const pressRelease = actByte === 0x00 ? "PRESS" : "RELEASE";
    // Enhance 4-button pico display using format byte + cmd_class (byte 17)
    const fmtByte = data.length > 7 ? data[7] : 0;
    const cmdClass = data.length > 17 ? data[17] : 0x00;
    const cmdParam = data.length > 19 ? data[19] : 0x00;
    if ((fmtByte === 0x0e || fmtByte === 0x0c) && cmdClass === 0x42) {
      btn = cmdParam === 0x01 || cmdParam === 0x03 ? "RAISE" : "LOWER";
    } else if (fmtByte === 0x0e && cmdClass === 0x40) {
      // Scene/preset — keep button name
    }
    const btnLabel = btn || "BTN";
    typeActionText = `${btnLabel} ${pressRelease}`;
    typeActionColor = GREEN;
    fieldValues.delete("button");
    fieldValues.delete("action");
  } else if (category === "STATE" || category === "CONFIG") {
    // For CONFIG with virtual type name, use it; otherwise REPORT/CONFIG
    if (category === "CONFIG" && identified.isVirtual) {
      typeActionText = typeName;
    } else {
      typeActionText = category === "STATE" ? "REPORT" : "CONFIG";
    }
    typeActionColor = BLUE;
    const level = fieldValues.get("level");
    const sliderLevel = fieldValues.get("slider_level");
    if (level) {
      stateParts.push(level);
      verboseParts.push(`level:${level}`);
      fieldValues.delete("level");
    }
    if (sliderLevel && sliderLevel !== level) {
      stateParts.push(sliderLevel);
      verboseParts.push(`slider:${sliderLevel}`);
    }
    fieldValues.delete("slider_level");
    if (data.length > 7) {
      const fmt = data[7].toString(16).padStart(2, "0");
      stateParts.push(fmt);
      verboseParts.push(`fmt=${fmt}`);
    }
  } else if (category === "PAIRING") {
    typeActionText = "PAIR";
    typeActionColor = MAGENTA;
    const fmtByte = data.length > 7 ? data[7] : -1;
    const fp = fingerprintDevice(data);
    if (fp.key) {
      stateParts.push(fp.name);
      verboseParts.push(fp.name);
    } else {
      const dcField = identified.fields.find((f) => f.name === "device_class");
      if (dcField && data.length > dcField.offset) {
        const code = data[dcField.offset];
        if (code > 0) {
          const name =
            DeviceClassNames[code] || `0x${code.toString(16).padStart(2, "0")}`;
          stateParts.push(`class=${name}`);
          verboseParts.push(`class=${name}`);
        }
      }
    }
    fieldValues.delete("device_class");
    if (fmtByte >= 0) {
      const fmt = fmtByte.toString(16).padStart(2, "0");
      stateParts.push(fmt);
      verboseParts.push(`fmt=${fmt}`);
    }
  } else if (category === "HANDSHAKE") {
    typeActionText = "HS";
    typeActionColor = RED;
    stateParts.push(identified.description);
    verboseParts.push(identified.description);
  } else if (category === "BEACON") {
    typeActionText = "BEACON";
    typeActionColor = YELLOW;
  }

  // Remaining fields
  for (const [name, val] of fieldValues) {
    if (name === "format") continue;
    if (STRIP_LABELS.has(name)) {
      stateParts.push(val);
    } else {
      stateParts.push(`${name}=${val}`);
    }
    verboseParts.push(`${name}=${val}`);
  }

  // Delta from slot tracker or global
  const slot = updateCcaSlotTracker(data, isTx, radioTs);
  let deltaText = "";
  if (slot?.dtMs !== undefined && slot.dtMs > 0) {
    deltaText = `+${slot.dtMs}ms`;
  } else if (deltaMs > 0) {
    deltaText = `+${deltaMs}ms`;
  }

  if (!typeActionText && stateParts.length === 0) {
    // Unknown/unparsed packets: state falls back to raw bytes.
    stateParts.push(rawHex);
  }

  const rssiText = rssi < 0 ? `${rssi}` : "";
  const opcode = data[0].toString(16).padStart(2, "0");
  emitPacketRow({
    ts,
    proto: "A",
    protoColor: CYAN,
    direction,
    dirColor,
    rssi: rssiText,
    seq: seq.toString(),
    opcode,
    typeAction: typeActionText || typeName,
    typeActionColor: typeActionText ? typeActionColor : typeColor,
    device: deviceText,
    deviceColor,
    zone: zoneText,
    zoneColor,
    state: stateParts.join("  "),
    raw: raw ? rawHex : "",
    delta: deltaText,
    verboseLine: verboseParts.length > 0 ? verboseParts.join("  ") : undefined,
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
    if (!deviceId) deviceId = fallbackDeviceId;
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
      parts.push(msg.direction ?? `action=${msg.action}`);
      if (msg.zoneId) {
        const zoneName = getZoneName(msg.zoneId);
        parts.push(
          zoneName ? `zone=${msg.zoneId} "${zoneName}"` : `zone=${msg.zoneId}`,
        );
      }
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
      parts.push(msg.direction ?? `action=${msg.action}`);
      parts.push(`step=${msg.stepValue}`);
      if (msg.zoneId) {
        const zoneName = getZoneName(msg.zoneId);
        parts.push(
          zoneName ? `zone=${msg.zoneId} "${zoneName}"` : `zone=${msg.zoneId}`,
        );
      }
      return { typeName: "DIM_STEP", parts };
    }
    case "ACK": {
      const respHex = Array.from(msg.response)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (msg.responseLabel) parts.push(msg.responseLabel);
      parts.push(`response=${respHex}`);
      return { typeName: "ACK", parts };
    }
    case "DEVICE_REPORT": {
      const serialInfo = getSerialName(msg.deviceSerial);
      if (serialInfo) {
        parts.push(`"${serialInfo}"`);
      }
      parts.push(`serial=${msg.deviceSerial}`);
      if (msg.levelPercent !== undefined) {
        parts.push(`level=${msg.levelPercent.toFixed(0)}%`);
      }
      if (msg.groupId) {
        const sceneName = getSceneName(msg.groupId);
        parts.push(
          sceneName
            ? `group=${msg.groupId} "${sceneName}"`
            : `group=${msg.groupId}`,
        );
      }
      const dev = getDeviceBySerial(msg.deviceSerial);
      if (dev?.area) parts.push(`[${dev.area}]`);
      return { typeName: "DEVICE_REPORT", parts };
    }
    case "DEVICE_STATE": {
      const serialInfo = getSerialName(msg.deviceSerial);
      if (serialInfo) parts.push(`"${serialInfo}"`);
      parts.push(`type=${msg.stateType}`);
      parts.push(`val=${msg.stateValue}`);
      if (msg.stateData) {
        const hex = Array.from(msg.stateData)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        parts.push(`data=0x${hex}`);
      }
      return { typeName: "DEVICE_STATE", parts };
    }
    case "SCENE_RECALL": {
      const sceneName = getSceneName(msg.sceneId);
      parts.push(
        sceneName
          ? `scene=${msg.sceneId} "${sceneName}"`
          : `scene=${msg.sceneId}`,
      );
      if (msg.params.length > 0) parts.push(`params=[${msg.params.join(",")}]`);
      return { typeName: "SCENE_RECALL", parts };
    }
    case "COMPONENT_CMD": {
      parts.push(`group=${msg.groupId}`);
      if (msg.params.length > 0) parts.push(`params=[${msg.params.join(",")}]`);
      return { typeName: "COMPONENT_CMD", parts };
    }
    case "STATUS": {
      const serialName = getSerialName(msg.deviceId);
      if (serialName) {
        parts.push(`"${serialName}"`);
      } else {
        parts.push(`dev=0x${msg.deviceId.toString(16).padStart(8, "0")}`);
      }
      if (msg.rawBody) {
        parts.push(`keys=[${Object.keys(msg.rawBody).join(",")}]`);
      }
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
  if (isTx) ccxTxCount++;
  else ccxRxCount++;
  updateHeader();
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
      deviceText = devId.toString(16).toUpperCase().padStart(8, "0");
    } else if ("deviceSerial" in msg) {
      const serial = (msg as { deviceSerial: number }).deviceSerial;
      deviceText = serial.toString(16).toUpperCase().padStart(8, "0");
    }

    // Zone from CCX message
    let zoneText = "";
    let zoneColor = WHITE;
    if ("zoneId" in msg && (msg as { zoneId: number }).zoneId) {
      const zId = (msg as { zoneId: number }).zoneId;
      const zoneName = getZoneName(zId);
      zoneText = zoneName ?? `z${zId}`;
      zoneColor = CYAN;
    }

    // Strip obvious labels for compact display
    const compactParts = parts.map((p) =>
      p.replace(/^(level|fade|delay|step)=/, ""),
    );

    emitPacketRow({
      ts,
      proto: "X",
      protoColor: YELLOW,
      direction,
      dirColor,
      rssi: "",
      seq: seq ? seq.toString() : "",
      opcode: data.length > 0 ? data[0].toString(16).padStart(2, "0") : "",
      typeAction: typeName,
      typeActionColor: typeColor,
      device: deviceText,
      deviceColor: CYAN,
      zone: zoneText,
      zoneColor,
      state: compactParts.join("  "),
      raw: raw ? rawHex : "",
      delta: deltaStr,
      verboseLine: parts.length > 0 ? parts.join("  ") : undefined,
    });
  } else {
    // Fallback: raw hex (always show)
    const rawHex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    emitPacketRow({
      ts,
      proto: "X",
      protoColor: YELLOW,
      direction,
      dirColor,
      rssi: "",
      seq: "",
      opcode: data.length > 0 ? data[0].toString(16).padStart(2, "0") : "",
      typeAction: "RAW",
      typeActionColor: WHITE,
      device: "",
      zone: "",
      state: raw ? "" : rawHex,
      raw: raw ? rawHex : "",
      delta: deltaStr,
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
    screen.showOverlay([
      `${RED}Status blob too short: ${blob.length} bytes${RESET}`,
    ]);
    return;
  }

  const uptime = readU32LE(blob, 0);
  const ccaRxStat = readU32LE(blob, 4);
  const ccaTxStat = readU32LE(blob, 8);
  const ccaDrop = readU32LE(blob, 12);
  const ccaCrc = readU32LE(blob, 16);
  const ccaN81 = readU32LE(blob, 20);
  const ccOverflow = readU32LE(blob, 24);
  const ccRunt = readU32LE(blob, 28);
  const ccxRxStat = readU32LE(blob, 32);
  const ccxTxStat = readU32LE(blob, 36);
  const ccxJoined = blob[40];
  const ccxRole = blob[41];
  const ethLink = blob[42];
  const numClients = blob[43];
  const heapFree = readU32LE(blob, 44);

  const roleName =
    ccxRole < THREAD_ROLES.length
      ? THREAD_ROLES[ccxRole]
      : `unknown(${ccxRole})`;

  const lines: string[] = [
    `${BOLD}${WHITE}── Nucleo Status ──${RESET}`,
    `  ${DIM}uptime:${RESET}          ${fmtUptime(uptime)}`,
    `  ${DIM}heap_free:${RESET}       ${fmtNum(heapFree)} bytes`,
    "",
    `  ${CYAN}CCA${RESET}  rx=${fmtNum(ccaRxStat)}  tx=${fmtNum(ccaTxStat)}  drop=${ccaDrop}  crc_fail=${ccaCrc}  n81_err=${ccaN81}`,
    `  ${CYAN}CC1101${RESET}  overflow=${ccOverflow}  runt=${ccRunt}`,
    "",
    `  ${YELLOW}CCX${RESET}  rx=${fmtNum(ccxRxStat)}  tx=${fmtNum(ccxTxStat)}  joined=${ccxJoined ? "yes" : "no"}  role=${roleName}`,
    "",
    `  ${GREEN}ETH${RESET}  link=${ethLink ? "up" : "down"}  clients=${numClients}`,
    "",
  ];

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

    lines.push(
      `  ${MAGENTA}CCA Radio${RESET}  ack=${fmtNum(ccaAck)}  crc_optional=${fmtNum(ccaCrcOptional)}  irq=${fmtNum(ccaIrq)}`,
      `  ${MAGENTA}Restarts${RESET}  timeout=${fmtNum(restartTimeout)}  overflow=${fmtNum(restartOverflow)}  manual=${fmtNum(restartManual)}  packet=${fmtNum(restartPacket)}`,
      `  ${MAGENTA}Sync${RESET}  hit=${fmtNum(syncHit)}  miss=${fmtNum(syncMiss)}  hit_rate=${syncHit + syncMiss > 0 ? ((syncHit * 100) / (syncHit + syncMiss)).toFixed(1) : "0.0"}%`,
      `  ${MAGENTA}Ring${RESET}  max_occ=${fmtNum(ringMax)}  in=${fmtNum(ringBytesIn)}B  dropped=${fmtNum(ringBytesDropped)}B`,
      `  ${MAGENTA}IRQ->RX${RESET}  min=${fmtNum(isrLatMin)}us  p95=${fmtNum(isrLatP95)}us  max=${fmtNum(isrLatMax)}us  n=${fmtNum(isrLatSamples)}`,
    );
  }

  screen.showOverlay(lines);
}

// ============================================================================
// RX datagram handler — each UDP datagram is one complete frame
// ============================================================================

function handleDatagram(msg: Buffer) {
  if (msg.length < 2) return;

  const flags = msg[0];
  const len = msg[1];

  // Track connection liveness from any datagram
  const wasConnected = connected;
  lastDatagramTime = Date.now();
  connected = true;
  if (!wasConnected) updateHeader();

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
    const text = msg.subarray(1).toString("utf-8").trim();
    if (text.length === 0) return;

    // Check for [coap] broadcast (async response notification)
    const coapBc = text.match(
      /^\[coap\] (\d+\.\d+)(?: (.+?))? mid=0x([0-9A-Fa-f]+) len=(\d+)/,
    );
    if (coapBc) {
      handleCoapBroadcast(
        coapBc[1],
        coapBc[2] || null,
        coapBc[3],
        parseInt(coapBc[4], 10),
      );
      return;
    }

    // Suppress [diag] lines when diag display is off
    if (!showDiag && text.startsWith("[diag]")) return;

    // Suppress [ccx] CoAP TX/Observe broadcast lines (noise during pending/scan)
    if (text.startsWith("[ccx] CoAP") && (coapPending || coapScan)) return;

    // Suppress "OK" from probe commands during scan
    if (text === "OK" && coapScan) return;

    // If we have a pending CoAP request, accumulate response lines
    if (coapPending) {
      for (const l of text.split("\n")) {
        const lt = l.trim();
        if (lt) coapPending.lines.push(lt);
      }
      // Check for terminal conditions
      if (
        text.includes("Payload (") ||
        text.includes("(no payload)") ||
        text.includes("No CoAP response") ||
        text.includes("CoAP TX failed")
      ) {
        finishCoapPending();
      }
      return;
    }

    // Normal text passthrough — always inline
    const lines = text.split("\n").map((l) => `${DIM}> ${l}${RESET}`);
    for (const line of lines) screen.appendLine(line);
    return;
  }

  // Status response: [0xFE][len][status blob]
  if (flags === 0xfe) {
    const data = msg.subarray(2, 2 + len);
    displayStatus(data);
    return;
  }

  // Packet frames: [FLAGS:1][LEN:1][TS_MS:4 LE][TS_CYC:4 LE][DATA:N]
  if (msg.length < 10 + len) return;

  const radioTs = readU32LE(msg, 2);
  // radioCyc at offset 6 (DWT cycle count, ~1.82 ns @ 548 MHz) — ignored by CLI display
  const data = msg.subarray(10, 10 + len);
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
  updateStatusBar();
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
    screen.appendLine(`${RED}UDP error: ${err.message}${RESET}`);
  });

  udpSocket.bind(() => {
    // Send initial keepalive to register with the Nucleo
    send(buildCmd(CMD.KEEPALIVE));

    // Periodic keepalive + connection liveness check
    keepaliveTimer = setInterval(() => {
      send(buildCmd(CMD.KEEPALIVE));
      // Check if we've heard back recently
      if (
        connected &&
        lastDatagramTime > 0 &&
        Date.now() - lastDatagramTime > CONNECTION_TIMEOUT_MS
      ) {
        connected = false;
        updateHeader();
      }
    }, KEEPALIVE_MS);

    updateHeader();
    updateStatusBar();
  });
}

// ============================================================================
// Shell commands
// ============================================================================

function showHelp() {
  screen.showOverlay([
    `${BOLD}CLI Commands${RESET} ${DIM}(local — not forwarded to STM32)${RESET}`,
    `  ${GREEN}status${RESET}            Query Nucleo status (overlay)`,
    `  ${GREEN}quiet${RESET}             Toggle packet display on/off`,
    `  ${GREEN}raw${RESET}               Toggle raw hex column (on by default)`,
    `  ${GREEN}verbose${RESET}           Toggle verbose detail lines below packets`,
    `  ${GREEN}diag${RESET}              Toggle [diag] log display (also --no-diag flag)`,
    `  ${GREEN}slot${RESET} [reset]      Toggle slot tracking on/off, or reset tracker`,
    `  ${GREEN}record${RESET} [name]     Start CSV recording to captures/cca-sessions/`,
    `  ${GREEN}stop${RESET}              Stop recording`,
    `  ${GREEN}restart${RESET}           Reboot the STM32`,
    `  ${GREEN}help${RESET}              This help`,
    `  ${GREEN}quit${RESET}              Exit (also Ctrl-C)`,
    "",
    `${BOLD}CCA Commands${RESET} ${DIM}(433 MHz Clear Connect Type A)${RESET}`,
    `  ${CYAN}cca button${RESET} <dev> <name>                  Button press (on off fav raise lower scene1-4)`,
    `  ${CYAN}cca level${RESET} <zone> <target> <%> [fade]     Set level via bridge (fade in quarter-sec)`,
    `  ${CYAN}cca broadcast${RESET} <zone> <%> [fade]          Broadcast level to all devices`,
    `  ${CYAN}cca pico-level${RESET} <dev> <%>                 Pico set-level (no fade)`,
    `  ${CYAN}cca state${RESET} <dev> <%>                      Send state report`,
    `  ${CYAN}cca scene${RESET} <zone> <target> <%> [fade]     Scene execute`,
    `  ${CYAN}cca beacon${RESET} <dev> [dur]                   Discovery beacon`,
    `  ${CYAN}cca pair pico${RESET} <dev> [type] [dur]         Pico pairing (5btn 2btn 4btn-rl 4btn-scene)`,
    `  ${CYAN}cca pair bridge${RESET} <id> <target> <zone>     Bridge pairing`,
    `  ${CYAN}cca unpair${RESET} <zone> <target>               Unpair device`,
    `  ${CYAN}cca led${RESET} <zone> <target> <0-3>            LED config`,
    `  ${CYAN}cca fade${RESET} <zone> <target> <on_qs> <off>   Fade config (quarter-sec)`,
    `  ${CYAN}cca trim${RESET} <zone> <target> <hi%> <lo%>     High/low trim`,
    `  ${CYAN}cca phase${RESET} <zone> <target> <hex>          Phase config`,
    `  ${CYAN}cca dim-config${RESET} <zone> <target> <hex...>  Dimming config bytes`,
    `  ${CYAN}cca save-fav${RESET} <dev>                       Save current level as favorite`,
    `  ${CYAN}cca identify${RESET} <target>                    Flash device LED (QS identify)`,
    `  ${CYAN}cca query${RESET} <target>                       Query device component info`,
    `  ${CYAN}cca raw${RESET} <zone> <target> <fmt> <bytes...> Raw packet (auto-builds header)`,
    `  ${CYAN}cca vive-level${RESET} <hub> <zone> <%> [fade]   Vive set-level`,
    `  ${CYAN}cca vive-raise${RESET}/<lower> <hub> <zone>      Vive dim raise/lower`,
    `  ${CYAN}cca vive-pair${RESET} <hub> <zone> [dur]         Vive pairing`,
    `  ${CYAN}cca hybrid-pair${RESET} <bridge> <class> <subnet> <zone> [dur]  Vive→RA3 pair`,
    `  ${CYAN}cca tune${RESET} ...                             CC1101 tuning/debug`,
    `  ${CYAN}cca log${RESET} [on|off]                         CCA RX UART log toggle`,
    "",
    `${BOLD}CCX Commands${RESET} ${DIM}(Thread/802.15.4 Clear Connect Type X)${RESET}`,
    `  ${YELLOW}ccx${RESET}                                      Thread status`,
    `  ${YELLOW}ccx on${RESET}/<off> <zone>                       Send ON/OFF to zone`,
    `  ${YELLOW}ccx level${RESET} <zone> <0-100>                  Set level %`,
    `  ${YELLOW}ccx scene${RESET} <id>                            Recall scene`,
    `  ${YELLOW}ccx peers${RESET}                                 List known Thread peers`,
    `  ${YELLOW}ccx coap get${RESET} <addr> <path>                 CoAP GET with decoded response`,
    `  ${YELLOW}ccx coap put${RESET} <addr> <path> <hex>          CoAP PUT`,
    `  ${YELLOW}ccx coap post${RESET} <addr> <path> <hex>         CoAP POST`,
    `  ${YELLOW}ccx coap observe${RESET} <addr> <path>            Subscribe to notifications`,
    `  ${YELLOW}ccx coap scan${RESET} <addr> <basePath>           Scan suffixes A-Z (e.g. cg/db/ct/c/AA)`,
    `  ${YELLOW}ccx coap probe${RESET} <addr> <path>              Fire-and-forget GET`,
    `  ${YELLOW}ccx coap trim${RESET}/${YELLOW}led${RESET}/${YELLOW}preset${RESET} ...              Device programming`,
    `  ${YELLOW}ccx discover${RESET} <ipv6>                       TMF Address Query`,
    `  ${YELLOW}ccx promisc${RESET} [on|off]                      802.15.4 promiscuous mode`,
    `  ${YELLOW}ccx log${RESET} [on|off]                          CCX RX UART log`,
    "",
    `${BOLD}Other STM32 Commands${RESET}`,
    `  ${MAGENTA}tx${RESET} <hex bytes>                            Raw CCA TX (e.g. tx 88014E10A2C7)`,
    `  ${MAGENTA}rx${RESET} on|off                                 Enable/disable CCA RX`,
    `  ${MAGENTA}ot${RESET}                                        OpenThread status (role/ch/panid)`,
    `  ${MAGENTA}stream${RESET}                                    UDP stream status (clients/stats)`,
    `  ${MAGENTA}eth${RESET}                                       Ethernet link status`,
    `  ${MAGENTA}config${RESET}                                    Show flash-stored config`,
    `  ${MAGENTA}save${RESET}                                      Save settings to flash`,
    "",
    `${DIM}All IDs are hex. Fade is in quarter-seconds (4 = 1s). Ctrl-L to redraw.${RESET}`,
  ]);
}

// ============================================================================
// CoAP first-class command handler
// ============================================================================

function tryDecodeCbor(hex: string): string | null {
  try {
    const buf = Buffer.from(hex.replace(/ /g, ""), "hex");
    const val = cborDecode(buf);
    return JSON.stringify(
      val,
      (_, v) => {
        if (typeof v === "bigint") return "0x" + v.toString(16);
        if (Buffer.isBuffer(v)) return "h'" + v.toString("hex") + "'";
        return v;
      },
      2,
    );
  } catch {
    return null;
  }
}

function coapCodeColor(code: string): string {
  if (code.startsWith("2.")) return GREEN;
  if (code.startsWith("4.") || code.startsWith("5.")) return RED;
  return YELLOW;
}

function finishCoapPending() {
  if (!coapPending) return;
  const { method, path, lines } = coapPending;
  coapPending = null;

  // Parse response from accumulated text lines
  let code = "";
  let payloadHex = "";
  let fromAddr = "";
  let error = "";

  for (const l of lines) {
    const cm = l.match(/code=(\d+\.\d+)/);
    if (cm) code = cm[1];
    const pm = l.match(/Payload \(\d+ bytes\):\s*([0-9A-Fa-f ]+)/);
    if (pm) payloadHex = pm[1].trim();
    const fm = l.match(/from ([\da-f:]+)/);
    if (fm) fromAddr = fm[1];
    if (l.includes("No CoAP response")) error = "timeout";
    if (l.includes("CoAP TX failed")) error = "tx failed";
  }

  if (error) {
    screen.appendLine(
      `${RED}[CoAP] ${method.toUpperCase()} ${path} → ${error}${RESET}`,
    );
    return;
  }

  const cc = coapCodeColor(code);
  const methodUp = method.toUpperCase();
  const hdr = `${cc}[CoAP]${RESET} ${cc}${code}${RESET} ${methodUp} ${YELLOW}${path}${RESET}`;

  if (!payloadHex) {
    screen.appendLine(`${hdr}${fromAddr ? `  ${DIM}${fromAddr}${RESET}` : ""}`);
    return;
  }

  // Has payload — decode
  const bytes = payloadHex.split(" ").length;
  screen.appendLine(
    `${hdr}  ${DIM}${bytes} bytes${fromAddr ? "  " + fromAddr : ""}${RESET}`,
  );
  screen.appendLine(`${DIM}  hex: ${payloadHex}${RESET}`);
  const decoded = tryDecodeCbor(payloadHex);
  if (decoded) {
    for (const dl of decoded.split("\n")) {
      screen.appendLine(`  ${GREEN}${dl}${RESET}`);
    }
  }
}

function handleCoapBroadcast(
  code: string,
  path: string | null,
  mid: string,
  len: number,
) {
  // Route to scan job if active
  if (coapScan && path) {
    coapScan.received++;
    if (code !== "4.04") coapScan.hits.set(path, code);
    updateStatusBar();
    return;
  }

  // Otherwise display as notification (observe, unsolicited, etc.)
  if (path) {
    const cc = coapCodeColor(code);
    screen.appendLine(
      `${CYAN}[CoAP notify]${RESET} ${cc}${code}${RESET} ${path} ${DIM}mid=${mid} len=${len}${RESET}`,
    );
  }
}

function startCoapScan(addr: string, basePath: string) {
  // Generate paths to probe
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const paths: string[] = [];

  // If basePath ends with 1-2 chars after last /, enumerate the remaining letters
  // e.g. "cg/db/ct/c/AA" → scan AAA-AAZ
  // e.g. "cg/db/ct/c/" → scan A-Z (single letter)
  // e.g. "cg/db/ct/c" → scan cg/db/ct/c/A - cg/db/ct/c/Z
  const lastSlash = basePath.lastIndexOf("/");
  const prefix =
    lastSlash >= 0 ? basePath.slice(0, lastSlash + 1) : basePath + "/";
  const suffix = lastSlash >= 0 ? basePath.slice(lastSlash + 1) : "";

  if (suffix.length === 0) {
    // Scan single letters: prefix + A through Z
    for (const c of alpha) paths.push(prefix + c);
  } else if (suffix.length <= 2) {
    // Scan suffix + [A-Z]
    for (const c of alpha) paths.push(prefix + suffix + c);
  } else {
    // 3+ chars — just probe that one path
    paths.push(basePath);
  }

  coapScan = {
    addr,
    paths,
    hits: new Map(),
    sent: 0,
    received: 0,
    startTime: Date.now(),
    timer: null,
  };

  screen.appendLine(
    `${CYAN}[CoAP scan]${RESET} Probing ${paths.length} paths on ${addr}...`,
  );
  updateStatusBar();

  // Fire probes in sequence with 800ms delay
  let idx = 0;
  function sendNext() {
    if (!coapScan || idx >= coapScan.paths.length) {
      // All sent — wait for stragglers then finish
      if (coapScan) {
        coapScan.timer = setTimeout(finishCoapScan, 3000);
      }
      return;
    }
    const p = coapScan.paths[idx++];
    coapScan.sent = idx;
    sendTextCommand(`ccx coap probe rloc:${addr} ${p}`);
    updateStatusBar();
    if (coapScan) coapScan.timer = setTimeout(sendNext, 800);
  }
  sendNext();
}

function finishCoapScan() {
  if (!coapScan) return;
  const { hits, sent, received, startTime } = coapScan;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  coapScan = null;

  if (hits.size === 0) {
    screen.appendLine(
      `${DIM}[CoAP scan] No hits from ${sent} probes (${received} responses, ${elapsed}s)${RESET}`,
    );
  } else {
    const lines = [
      `${BOLD}CoAP Scan Results${RESET} — ${hits.size} hits from ${sent} probes (${elapsed}s)`,
      "",
    ];
    for (const [p, c] of [...hits.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const cc = coapCodeColor(c);
      lines.push(`  ${cc}${c.padEnd(6)}${RESET} ${p}`);
    }
    screen.showOverlay(lines);
  }
  updateStatusBar();
}

function handleCoapCommand(args: string[]) {
  // args: ["ccx", "coap", subcommand, ...]
  const sub = (args[2] || "").toLowerCase();
  const addr = args[3] || "";
  const path = args[4] || "";
  if (sub === "scan") {
    if (!addr || !path) {
      screen.appendLine(
        `Usage: ccx coap scan <rloc> <basePath>  (e.g. ccx coap scan 4800 cg/db/ct/c/AA)`,
      );
      return;
    }
    startCoapScan(addr, path);
    return;
  }

  if (["get", "put", "post", "delete", "observe"].includes(sub)) {
    if (!addr || !path) {
      screen.appendLine(`Usage: ccx coap ${sub} <addr> <path> [payload_hex]`);
      return;
    }
    // Set up pending response capture
    coapPending = {
      method: sub,
      addr,
      path,
      lines: [],
      startTime: Date.now(),
    };
    // Forward the full command to STM32 as-is
    sendTextCommand(args.join(" "));
    return;
  }

  // For probe, trim, led, preset, etc. — just pass through
  sendTextCommand(args.join(" "));
}

function handleCommand(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const args = trimmed.split(/\s+/);
  const cmd = args[0].toLowerCase();

  // Local-only commands
  switch (cmd) {
    case "help":
    case "?":
      showHelp();
      return;

    case "status":
      send(buildCmd(CMD.STATUS_QUERY));
      return;

    case "quiet":
      quiet = !quiet;
      screen.appendLine(`Packet display: ${quiet ? "off" : "on"}`);
      updateStatusBar();
      return;

    case "raw":
      raw = !raw;
      fullRedraw();
      screen.appendLine(`Raw hex display: ${raw ? "on" : "off"}`);
      updateStatusBar();
      return;

    case "verbose":
      verbose = !verbose;
      fullRedraw();
      screen.appendLine(`Verbose display: ${verbose ? "on" : "off"}`);
      updateStatusBar();
      return;

    case "diag":
      showDiag = !showDiag;
      screen.appendLine(`Diagnostic logs: ${showDiag ? "on" : "off"}`);
      updateStatusBar();
      return;

    case "slot":
      if ((args[1] || "").toLowerCase() === "reset") {
        ccaSlotFlows.clear();
        screen.appendLine("Slot tracker: reset");
      } else {
        slotTracking = !slotTracking;
        screen.appendLine(`Slot tracker: ${slotTracking ? "on" : "off"}`);
      }
      updateStatusBar();
      return;

    case "record": {
      if (recording) {
        screen.appendLine(
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
        screen.appendLine(`${GREEN}Recording to ${fileName}${RESET}`);
      }
      updateStatusBar();
      return;
    }

    case "stop": {
      if (!recording) {
        screen.appendLine(`${YELLOW}Not recording${RESET}`);
      } else {
        const elapsed = ((Date.now() - recording.startTime) / 1000).toFixed(1);
        const fileName = recording.file.split("/").pop();
        screen.appendLine(
          `${GREEN}Stopped recording: ${fileName} (${recording.count} packets, ${elapsed}s)${RESET}`,
        );
        recording = null;
      }
      updateStatusBar();
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

  // CoAP first-class handler
  if (cmd === "ccx" && args[1]?.toLowerCase() === "coap") {
    handleCoapCommand(args);
    return;
  }

  // Everything else → forward to STM32 shell
  sendTextCommand(trimmed);
}

// ============================================================================
// Cleanup
// ============================================================================

function cleanup() {
  screen.stop();
  screen.destroy();
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  if (recording) {
    const fileName = recording.file.split("/").pop();
    console.log(
      `${YELLOW}Stopped recording: ${fileName} (${recording.count} packets)${RESET}`,
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
    `Usage: bun cli/nucleo.ts [host] [--update-leap] [--leap-host <ip>]`,
  );
  console.error(
    `  or set OPEN_BRIDGE_HOST env var, or configure openBridge in config.json`,
  );
  console.error(`\nFlags:`);
  console.error(
    `  --update-leap         Fetch LEAP data at startup (save to data/, use for session)`,
  );
  console.error(
    `  --leap-host <ip>      LEAP processor IP (default: first in config.json)`,
  );
  console.error(`  Certs resolved from config.json by host IP`);
  process.exit(1);
}

/** Load saved LEAP data from data/leap-*.json, merging all files */
function loadSavedLeapData(): boolean {
  const dataDir = join(__dirname, "../data");
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
  return true;
}

// Fetch LEAP data if requested, then start
async function startup() {
  // Load LEAP data before initializing TUI (so device names are available)
  if (UPDATE_LEAP) {
    try {
      const { LeapConnection, fetchLeapData, buildDumpData } = await import(
        "../lib/leap-client"
      );

      // LEAP fetch happens before TUI init — use console.log
      console.log(`${CYAN}Fetching LEAP data from ${LEAP_HOST}...${RESET}`);
      const leap = new LeapConnection({ host: LEAP_HOST });
      await leap.connect();
      const result = await fetchLeapData(leap);
      leap.close();

      const dumpData = buildDumpData(LEAP_HOST, result);
      const dataDir = join(__dirname, "../data");
      mkdirSync(dataDir, { recursive: true });
      const filePath = join(dataDir, `leap-${LEAP_HOST}.json`);
      writeFileSync(filePath, JSON.stringify(dumpData, null, 2) + "\n");

      setLeapData(dumpData);
      const nZones = Object.keys(dumpData.zones).length;
      const nDevices = Object.keys(dumpData.devices).length;
      console.log(
        `${GREEN}LEAP: ${nZones} zones, ${nDevices} devices → saved${RESET}`,
      );
    } catch (err: any) {
      console.error(
        `${YELLOW}LEAP fetch failed: ${err.message} — using saved data${RESET}`,
      );
      loadSavedLeapData();
    }
  } else {
    loadSavedLeapData();
  }

  // Initialize screen state (header/columns/status) before mounting Ink.
  screen.init();
  updateHeader();
  updateColumnHeaders();
  updateStatusBar();

  screen.onRedraw = () => fullRedraw();
  screen.onQuit = () => {
    cleanup();
    process.exit(0);
  };

  // On terminal resize, recompute column headers so they match the new width
  // and the layout used for subsequent packet rows.
  process.stdout.on("resize", () => {
    updateColumnHeaders();
    updateHeader();
  });

  // Tab completion candidates
  screen.setCompletions([
    // Local
    "status",
    "record",
    "stop",
    "quiet",
    "raw",
    "verbose",
    "diag",
    "slot",
    "help",
    "quit",
    "exit",
    "restart",
    // CCA
    "cca button",
    "cca level",
    "cca broadcast",
    "cca pico-level",
    "cca state",
    "cca scene",
    "cca beacon",
    "cca pair pico",
    "cca pair bridge",
    "cca unpair",
    "cca led",
    "cca fade",
    "cca trim",
    "cca phase",
    "cca dim-config",
    "cca save-fav",
    "cca identify",
    "cca query",
    "cca raw",
    "cca vive-level",
    "cca vive-raise",
    "cca vive-lower",
    "cca vive-pair",
    "cca hybrid-pair",
    "cca tune",
    "cca log",
    // CCX
    "ccx on",
    "ccx off",
    "ccx level",
    "ccx scene",
    "ccx peers",
    "ccx coap get",
    "ccx coap put",
    "ccx coap post",
    "ccx coap observe",
    "ccx coap scan",
    "ccx coap probe",
    "ccx coap trim",
    "ccx coap led",
    "ccx coap preset",
    "ccx discover",
    "ccx promisc",
    "ccx log",
    // Other STM32
    "tx",
    "rx",
    "ot",
    "stream",
    "eth",
    "config",
    "save",
  ]);

  screen.start(handleCommand);

  // Start UDP socket
  setupUdp();
}

startup();
