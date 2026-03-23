#!/usr/bin/env node --import tsx

/**
 * MCP Server: Nucleo STM32 Radio Interface
 *
 * Provides Claude Code with direct access to the STM32 Nucleo H723ZG
 * radio transceiver over UDP. Tools for shell commands, packet capture,
 * CCA/CCX control, and status queries.
 *
 * Transport: stdio (spawned by Claude Code)
 * Protocol:  UDP to Nucleo at NUCLEO_HOST:9433
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSocket, type Socket } from "dgram";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
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
import {
  fingerprintDevice,
  identifyPacket,
  parseFieldValue,
} from "../protocol/protocol-ui";

// ── Config ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const NUCLEO_HOST = process.env.NUCLEO_HOST ?? "10.0.0.3";
const UDP_PORT = 9433;
const KEEPALIVE_MS = 5000;
const CMD_TIMEOUT_MS = 8000;

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
  CCA_SAVE_FAV: 0x12,
  CCA_VIVE_LEVEL: 0x13,
  STATUS_QUERY: 0x11,
  TEXT: 0x20,
} as const;

// Stream flags
const FLAG_TX = 0x80;
const FLAG_CCX = 0x40;
const FLAG_RSSI_MASK = 0x1f;
const RESP_TEXT = 0xfd;

const THREAD_ROLES = ["detached", "child", "router", "leader"] as const;

// ── Load LEAP data for name resolution ──────────────────────────────

function loadLeapData() {
  const dataDir = join(PROJECT_ROOT, "data");
  try {
    const files = readdirSync(dataDir).filter(
      (f) => f.startsWith("leap-") && f.endsWith(".json"),
    );
    const datasets = files.map((f) =>
      JSON.parse(readFileSync(join(dataDir, f), "utf-8")),
    );
    if (datasets.length > 0) setLeapData(datasets);
  } catch {
    // LEAP data optional — name resolution just won't work
  }
}

loadLeapData();

// ── UDP Client ──────────────────────────────────────────────────────

let udpSocket: Socket | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let connected = false;
let lastDatagramTime = 0;
let activeToolCalls = 0;
const IDLE_CLOSE_MS = 10_000; // close socket 10s after last tool finishes

// Packet capture state
type CapturedPacket = {
  timestamp: string;
  radioTs: number;
  protocol: "CCA" | "CCX";
  direction: "RX" | "TX";
  rssi: number;
  rawHex: string;
  parsed: Record<string, unknown>;
};

let captureBuffer: CapturedPacket[] = [];
let capturing = false;

// Text command response state
let textResolve: ((text: string) => void) | null = null;
let textTimer: ReturnType<typeof setTimeout> | null = null;

// Status response state
let statusResolve: ((status: Record<string, unknown>) => void) | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function readU32LE(buf: Buffer, off: number): number {
  return (
    (buf[off] |
      (buf[off + 1] << 8) |
      (buf[off + 2] << 16) |
      ((buf[off + 3] << 24) >>> 0)) >>>
    0
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

function send(frame: Buffer): boolean {
  if (!udpSocket) return false;
  udpSocket.send(frame, 0, frame.length, UDP_PORT, NUCLEO_HOST);
  return true;
}

function sendTextCommand(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Clean up any pending text command
    if (textTimer) clearTimeout(textTimer);
    if (textResolve) textResolve("(superseded)");

    textResolve = resolve;
    const textBytes = new TextEncoder().encode(text);
    if (!send(buildCmd(CMD.TEXT, textBytes))) {
      textResolve = null;
      reject(new Error("UDP socket not ready"));
      return;
    }
    textTimer = setTimeout(() => {
      textResolve = null;
      textTimer = null;
      resolve("(no response — timeout)");
    }, CMD_TIMEOUT_MS);
  });
}

// ── Packet Parsing ──────────────────────────────────────────────────

function parseCcaPacket(
  data: Buffer,
  flags: number,
  _radioTs: number,
): Record<string, unknown> {
  const isTx = !!(flags & FLAG_TX);
  const rssi = isTx ? 0 : -(flags & FLAG_RSSI_MASK);
  const identified = identifyPacket(data);
  const hexBytes = Array.from(data).map((b) => b.toString(16).padStart(2, "0"));

  const fields: Record<string, string> = {};
  for (const field of identified.fields) {
    if (["type", "crc", "protocol"].includes(field.name)) continue;
    const { decoded, raw } = parseFieldValue(
      hexBytes,
      field.offset,
      field.size,
      field.format,
    );
    if (decoded) fields[field.name] = decoded;
    else if (raw !== "-") fields[field.name] = raw;
  }

  // Device name resolution
  const deviceField =
    fields.device_id || fields.source_id || fields.load_id || fields.target_id;
  let deviceName: string | undefined;
  if (deviceField) {
    const serial = parseInt(deviceField, 16);
    if (serial > 0) deviceName = getSerialName(serial) ?? undefined;
  }

  // Fingerprint for pairing packets
  let fingerprint: string | undefined;
  if (identified.category === "PAIRING") {
    const fp = fingerprintDevice(data);
    if (fp.key) fingerprint = fp.name;
  }

  return {
    typeName: identified.typeName,
    category: identified.category,
    seq: data.length > 1 ? data[1] : 0,
    rssi,
    fields,
    ...(deviceName && { deviceName }),
    ...(fingerprint && { fingerprint }),
    ...(identified.isVirtual && { isVirtual: true }),
    ...(identified.description && { description: identified.description }),
  };
}

function parseCcxPacket(data: Buffer): Record<string, unknown> {
  let msg: CCXMessage | null = null;
  try {
    msg = decodeBytes(new Uint8Array(data));
  } catch {
    return { typeName: "RAW", error: "CBOR decode failed" };
  }

  if (!msg) return { typeName: "RAW" };

  const result: Record<string, unknown> = { typeName: msg.type };

  switch (msg.type) {
    case "LEVEL_CONTROL": {
      let levelStr: string;
      if (msg.level === Level.OFF) levelStr = "OFF";
      else if (msg.level === Level.FULL_ON) levelStr = "ON";
      else levelStr = `${msg.levelPercent.toFixed(0)}%`;
      result.level = levelStr;
      result.zoneId = msg.zoneId;
      result.zoneName = getZoneName(msg.zoneId) ?? undefined;
      result.fadeSec = msg.fade / 4;
      if (msg.delay > 0) result.delaySec = msg.delay / 4;
      break;
    }
    case "BUTTON_PRESS": {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const preset = getPresetInfo(presetId);
      result.deviceId = msg.deviceId;
      result.presetId = presetId;
      if (preset) {
        result.presetName = preset.name;
        result.device = preset.device;
      }
      break;
    }
    case "DIM_HOLD":
    case "DIM_STEP": {
      result.deviceId = msg.deviceId;
      result.direction = msg.direction ?? msg.action;
      if (msg.zoneId) {
        result.zoneId = msg.zoneId;
        result.zoneName = getZoneName(msg.zoneId) ?? undefined;
      }
      if (msg.type === "DIM_STEP") result.stepValue = msg.stepValue;
      break;
    }
    case "DEVICE_REPORT": {
      result.deviceSerial = msg.deviceSerial;
      const name = getSerialName(msg.deviceSerial);
      if (name) result.deviceName = name;
      if (msg.levelPercent !== undefined)
        result.level = `${msg.levelPercent.toFixed(0)}%`;
      if (msg.groupId) {
        result.groupId = msg.groupId;
        result.sceneName = getSceneName(msg.groupId) ?? undefined;
      }
      const dev = getDeviceBySerial(msg.deviceSerial);
      if (dev?.area) result.area = dev.area;
      break;
    }
    case "SCENE_RECALL":
      result.sceneId = msg.sceneId;
      result.sceneName = getSceneName(msg.sceneId) ?? undefined;
      break;
    case "ACK":
      result.response = Array.from(msg.response)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (msg.responseLabel) result.responseLabel = msg.responseLabel;
      break;
    default:
      if ("deviceId" in msg) result.deviceId = (msg as any).deviceId;
      if ("rawBody" in msg) result.rawBody = (msg as any).rawBody;
  }

  if ("sequence" in msg) result.sequence = (msg as any).sequence;
  return result;
}

// ── Datagram Handler ────────────────────────────────────────────────

function handleDatagram(msg: Buffer) {
  if (msg.length < 2) return;

  const flags = msg[0];
  const len = msg[1];

  lastDatagramTime = Date.now();
  connected = true;

  // Heartbeat
  if (flags === 0xff && len === 0x00) return;

  // Text response
  if (flags === RESP_TEXT) {
    const text = msg.subarray(1).toString("utf-8").trim();
    if (textResolve) {
      if (textTimer) clearTimeout(textTimer);
      textTimer = null;
      const resolve = textResolve;
      textResolve = null;
      resolve(text);
    }
    return;
  }

  // Status response
  if (flags === 0xfe) {
    const blob = msg.subarray(2, 2 + len);
    if (statusResolve) {
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = null;
      const resolve = statusResolve;
      statusResolve = null;
      resolve(parseStatusBlob(blob));
    }
    return;
  }

  // Packet frames
  if (msg.length < 6 + len) return;

  const radioTs = readU32LE(msg, 2);
  const data = msg.subarray(6, 6 + len);
  const isCcx = !!(flags & FLAG_CCX);
  const isTx = !!(flags & FLAG_TX);

  if (capturing) {
    const rawHex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");

    const parsed = isCcx
      ? parseCcxPacket(data)
      : parseCcaPacket(data, flags, radioTs);

    captureBuffer.push({
      timestamp: new Date().toISOString(),
      radioTs,
      protocol: isCcx ? "CCX" : "CCA",
      direction: isTx ? "TX" : "RX",
      rssi: isTx ? 0 : -(flags & FLAG_RSSI_MASK),
      rawHex,
      parsed,
    });
  }
}

function parseStatusBlob(blob: Buffer): Record<string, unknown> {
  if (blob.length < 48) return { error: "Status blob too short" };

  const status: Record<string, unknown> = {
    uptime_ms: readU32LE(blob, 0),
    uptime_human: formatUptime(readU32LE(blob, 0)),
    cca: {
      rx: readU32LE(blob, 4),
      tx: readU32LE(blob, 8),
      drop: readU32LE(blob, 12),
      crc_fail: readU32LE(blob, 16),
      n81_err: readU32LE(blob, 20),
    },
    cc1101: {
      overflow: readU32LE(blob, 24),
      runt: readU32LE(blob, 28),
    },
    ccx: {
      rx: readU32LE(blob, 32),
      tx: readU32LE(blob, 36),
      thread_joined: !!blob[40],
      thread_role:
        blob[41] < THREAD_ROLES.length
          ? THREAD_ROLES[blob[41]]
          : `unknown(${blob[41]})`,
    },
    ethernet: {
      link_up: !!blob[42],
      clients: blob[43],
    },
    heap_free: readU32LE(blob, 44),
  };

  if (blob.length >= 112) {
    Object.assign(status, {
      restarts: {
        timeout: readU32LE(blob, 48),
        overflow: readU32LE(blob, 52),
        manual: readU32LE(blob, 56),
        packet: readU32LE(blob, 60),
      },
      sync: {
        hit: readU32LE(blob, 64),
        miss: readU32LE(blob, 68),
      },
      ring: {
        max_occupancy: readU32LE(blob, 72),
        bytes_in: readU32LE(blob, 76),
        bytes_dropped: readU32LE(blob, 80),
      },
      isr_latency_us: {
        min: readU32LE(blob, 96),
        p95: readU32LE(blob, 100),
        max: readU32LE(blob, 104),
        samples: readU32LE(blob, 108),
      },
    });
  }

  return status;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`;
}

// ── UDP Lifecycle (lazy — opens on tool call, closes after idle) ────

function openSocket(): Socket {
  if (udpSocket) return udpSocket;

  udpSocket = createSocket("udp4");
  udpSocket.on("message", handleDatagram);
  udpSocket.on("error", () => {
    /* swallow — tools return errors explicitly */
  });
  udpSocket.bind();

  // Register with Nucleo
  send(buildCmd(CMD.KEEPALIVE));

  // Keep registered while socket is alive
  keepaliveTimer = setInterval(() => {
    send(buildCmd(CMD.KEEPALIVE));
    if (
      connected &&
      lastDatagramTime > 0 &&
      Date.now() - lastDatagramTime > 12000
    ) {
      connected = false;
    }
  }, KEEPALIVE_MS);

  return udpSocket;
}

function closeSocket() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (udpSocket) {
    udpSocket.close();
    udpSocket = null;
  }
  connected = false;
  lastDatagramTime = 0;
}

function scheduleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activeToolCalls <= 0) closeSocket();
  }, IDLE_CLOSE_MS);
}

/** Call at tool entry — opens socket, cancels idle close */
function acquireSocket(): Socket {
  activeToolCalls++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  return openSocket();
}

/** Call at tool exit — schedules idle close when all tools done */
function releaseSocket() {
  activeToolCalls = Math.max(0, activeToolCalls - 1);
  if (activeToolCalls === 0) scheduleClose();
}

// ── MCP Server ──────────────────────────────────────────────────────

const server = new McpServer({
  name: "nucleo",
  version: "1.0.0",
});

// -- Tool: nucleo_command -------------------------------------------------

server.tool(
  "nucleo_command",
  "Send a shell command to the STM32 Nucleo and return its text response. " +
    "Use for any firmware shell command: cca, ccx, tx, rx, config, save, ot, " +
    "eth, stream, tdma, spinel, reboot, etc. Commands are executed on the " +
    "STM32 and the output is returned as text.",
  {
    command: z
      .string()
      .describe(
        "Shell command to send (e.g. 'cca status', 'ot', 'config', 'rx on')",
      ),
  },
  async ({ command }) => {
    acquireSocket();
    try {
      if (!connected) await new Promise((r) => setTimeout(r, 300));
      const response = await sendTextCommand(command);
      return {
        content: [{ type: "text", text: response || "(empty response)" }],
      };
    } finally {
      releaseSocket();
    }
  },
);

// -- Tool: nucleo_status --------------------------------------------------

server.tool(
  "nucleo_status",
  "Query Nucleo system status: uptime, CCA/CCX packet counters, " +
    "CC1101 radio health, Thread role, Ethernet link, heap, ISR latency. " +
    "Returns structured JSON.",
  {},
  async () => {
    acquireSocket();
    try {
      if (!connected) await new Promise((r) => setTimeout(r, 300));

      const status = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          if (statusTimer) clearTimeout(statusTimer);
          if (statusResolve) statusResolve({ error: "superseded" });

          statusResolve = resolve;
          if (!send(buildCmd(CMD.STATUS_QUERY))) {
            statusResolve = null;
            reject(new Error("UDP socket not ready"));
            return;
          }
          statusTimer = setTimeout(() => {
            statusResolve = null;
            statusTimer = null;
            resolve({ error: "timeout — no response from Nucleo" });
          }, CMD_TIMEOUT_MS);
        },
      );

      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    } finally {
      releaseSocket();
    }
  },
);

// -- Tool: nucleo_capture -------------------------------------------------

server.tool(
  "nucleo_capture",
  "Capture live CCA and/or CCX radio packets for a specified duration. " +
    "Returns an array of parsed packets with timestamps, protocol type, " +
    "direction, RSSI, decoded fields, device names, and raw hex. " +
    "Great for observing traffic patterns, debugging protocol issues, " +
    "or analyzing what happens when lights are controlled.",
  {
    duration_sec: z
      .number()
      .min(1)
      .max(60)
      .default(5)
      .describe("Capture duration in seconds (1-60, default 5)"),
    protocol: z
      .enum(["all", "cca", "ccx"])
      .default("all")
      .describe("Filter by protocol: 'all', 'cca', or 'ccx'"),
    max_packets: z
      .number()
      .min(1)
      .max(1000)
      .default(200)
      .describe("Maximum packets to return (default 200)"),
  },
  async ({ duration_sec, protocol, max_packets }) => {
    acquireSocket();
    try {
      if (!connected) await new Promise((r) => setTimeout(r, 300));

      // Start capture
      captureBuffer = [];
      capturing = true;

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          capturing = false;
          resolve();
        }, duration_sec * 1000);
      });

      // Filter by protocol
      let packets = captureBuffer;
      if (protocol === "cca")
        packets = packets.filter((p) => p.protocol === "CCA");
      else if (protocol === "ccx")
        packets = packets.filter((p) => p.protocol === "CCX");

      // Limit
      if (packets.length > max_packets) packets = packets.slice(0, max_packets);

      const summary =
        `Captured ${packets.length} packets in ${duration_sec}s` +
        (protocol !== "all" ? ` (${protocol.toUpperCase()} only)` : "");

      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: JSON.stringify(packets, null, 2) },
        ],
      };
    } finally {
      releaseSocket();
    }
  },
);

// -- Tool: nucleo_cca_level -----------------------------------------------

server.tool(
  "nucleo_cca_level",
  "Set a CCA zone's light level. This is the primary way to control " +
    "433 MHz Lutron dimmers and switches. Uses the bridge level command " +
    "which supports fade timing.",
  {
    zone: z.string().describe("Zone ID in hex (e.g. '01A2B3C4')"),
    target: z.string().describe("Target device ID in hex (e.g. '01A2B3C4')"),
    level_percent: z.number().min(0).max(100).describe("Light level 0-100%"),
    fade_quarter_sec: z
      .number()
      .min(0)
      .max(255)
      .default(4)
      .describe("Fade time in quarter-seconds (4 = 1 second, default)"),
  },
  async ({ zone, target, level_percent, fade_quarter_sec }) => {
    acquireSocket();
    try {
      if (!connected) await new Promise((r) => setTimeout(r, 300));

      const zoneId = parseInt(zone, 16);
      const targetId = parseInt(target, 16);
      const level = Math.round((level_percent * 0xfeff) / 100) & 0xffff;

      const payload = [
        (zoneId >> 24) & 0xff,
        (zoneId >> 16) & 0xff,
        (zoneId >> 8) & 0xff,
        zoneId & 0xff,
        (targetId >> 24) & 0xff,
        (targetId >> 16) & 0xff,
        (targetId >> 8) & 0xff,
        targetId & 0xff,
        level & 0xff,
        (level >> 8) & 0xff,
        fade_quarter_sec & 0xff,
      ];

      send(buildCmd(CMD.CCA_LEVEL, payload));

      return {
        content: [
          {
            type: "text",
            text: `Set zone ${zone} target ${target} to ${level_percent}% (fade ${fade_quarter_sec / 4}s)`,
          },
        ],
      };
    } finally {
      releaseSocket();
    }
  },
);

// -- Tool: nucleo_cca_button ----------------------------------------------

server.tool(
  "nucleo_cca_button",
  "Simulate a CCA button press on a device. Used for pico remotes, " +
    "keypads, and occupancy sensors. Button names: on, off, fav, raise, " +
    "lower, scene1, scene2, scene3, scene4.",
  {
    device_id: z.string().describe("Device ID in hex (e.g. '01A2B3C4')"),
    button: z
      .enum([
        "on",
        "off",
        "fav",
        "raise",
        "lower",
        "scene1",
        "scene2",
        "scene3",
        "scene4",
      ])
      .describe("Button name"),
  },
  async ({ device_id, button }) => {
    acquireSocket();
    try {
      if (!connected) await new Promise((r) => setTimeout(r, 300));

      const btnMap: Record<string, number> = {
        on: 0,
        off: 1,
        fav: 2,
        raise: 3,
        lower: 4,
        scene1: 5,
        scene2: 6,
        scene3: 7,
        scene4: 8,
      };
      const devId = parseInt(device_id, 16);

      const payload = [
        devId & 0xff,
        (devId >> 8) & 0xff,
        (devId >> 16) & 0xff,
        (devId >> 24) & 0xff,
        btnMap[button],
      ];

      send(buildCmd(CMD.CCA_BUTTON, payload));

      return {
        content: [
          {
            type: "text",
            text: `Sent button ${button.toUpperCase()} to device ${device_id}`,
          },
        ],
      };
    } finally {
      releaseSocket();
    }
  },
);

// -- Tool: nucleo_tx_raw --------------------------------------------------

server.tool(
  "nucleo_tx_raw",
  "Transmit a raw CCA packet (433 MHz). Provide the complete packet " +
    "bytes in hex. CRC is NOT auto-appended — include it if needed. " +
    "Use for protocol testing, replay, and reverse engineering.",
  {
    hex_bytes: z
      .string()
      .describe(
        "Hex string of the packet to transmit (e.g. '88014E10A2C700...')",
      ),
  },
  async ({ hex_bytes }) => {
    acquireSocket();
    try {
      if (!connected) await new Promise((r) => setTimeout(r, 300));

      const clean = hex_bytes.replace(/[\s,]/g, "");
      if (clean.length % 2 !== 0) {
        return {
          content: [
            { type: "text", text: "Error: hex string must have even length" },
          ],
          isError: true,
        };
      }
      const bytes = [];
      for (let i = 0; i < clean.length; i += 2) {
        bytes.push(parseInt(clean.substring(i, i + 2), 16));
      }

      send(buildCmd(CMD.TX_RAW_CCA, bytes));

      return {
        content: [
          {
            type: "text",
            text: `Transmitted ${bytes.length}-byte CCA packet: ${clean}`,
          },
        ],
      };
    } finally {
      releaseSocket();
    }
  },
);

// -- Tool: nucleo_ccx_level -----------------------------------------------

server.tool(
  "nucleo_ccx_level",
  "Control a CCX (Thread/802.15.4) zone — turn lights on/off or set level. " +
    "Sends command through the STM32 shell.",
  {
    zone: z.number().describe("CCX zone number"),
    level_percent: z
      .number()
      .min(0)
      .max(100)
      .describe("Light level 0-100% (0 = off, 100 = full on)"),
  },
  async ({ zone, level_percent }) => {
    acquireSocket();
    try {
      if (!connected) await new Promise((r) => setTimeout(r, 300));

      let cmd: string;
      if (level_percent === 0) cmd = `ccx off ${zone}`;
      else if (level_percent === 100) cmd = `ccx on ${zone}`;
      else cmd = `ccx level ${zone} ${level_percent}`;

      const response = await sendTextCommand(cmd);
      return {
        content: [
          {
            type: "text",
            text: `CCX zone ${zone} → ${level_percent}%${response ? "\n" + response : ""}`,
          },
        ],
      };
    } finally {
      releaseSocket();
    }
  },
);

// -- Tool: nucleo_ping ----------------------------------------------------

server.tool(
  "nucleo_ping",
  "Check if the Nucleo is reachable. Sends a keepalive and waits for " +
    "any datagram back. Returns connection status.",
  {},
  async () => {
    acquireSocket();
    try {
      // Send keepalive and wait briefly
      send(buildCmd(CMD.KEEPALIVE));
      await new Promise((r) => setTimeout(r, 500));

      return {
        content: [
          {
            type: "text",
            text: connected
              ? `Connected to Nucleo at ${NUCLEO_HOST}:${UDP_PORT}`
              : `No response from Nucleo at ${NUCLEO_HOST}:${UDP_PORT}`,
          },
        ],
      };
    } finally {
      releaseSocket();
    }
  },
);

// ── Start ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`nucleo MCP server error: ${err}\n`);
  process.exit(1);
});
