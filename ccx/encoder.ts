/**
 * Lutron Clear Connect X (CCX) CBOR Encoder
 *
 * Encodes CCX commands as CBOR for UDP multicast on Thread network.
 * Uses a custom minimal CBOR encoder because cbor-x encodes JS object keys
 * as CBOR text strings, but CCX requires integer-keyed CBOR maps.
 *
 * Usage:
 *   import { encodeLevelControl, encodeOn, encodeOff } from "./encoder";
 *   const buf = encodeLevelControl({ zoneId: 961, level: 0xFEFF, sequence: 1 });
 *   // Send buf via UDP6 to ff03::1:9190
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { BodyKey, CCXMessageType, Level } from "./constants";

const SEQ_FILE = join(import.meta.dir, "..", ".ccx-seq");

// --- Minimal CBOR encoder for integer-keyed maps ---

/** Encode a CBOR major type + value header */
function encodeHeader(major: number, value: number): number[] {
  const mt = major << 5;
  if (value < 24) return [mt | value];
  if (value < 0x100) return [mt | 24, value];
  if (value < 0x10000) return [mt | 25, (value >> 8) & 0xff, value & 0xff];
  return [
    mt | 26,
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];
}

/** Encode a single CBOR value (unsigned int, array, or integer-keyed map) */
function encodeValue(val: unknown): number[] {
  if (typeof val === "number") {
    return encodeHeader(0, val); // Major 0: unsigned integer
  }
  if (Array.isArray(val)) {
    const bytes = encodeHeader(4, val.length); // Major 4: array
    for (const item of val) bytes.push(...encodeValue(item));
    return bytes;
  }
  if (typeof val === "object" && val !== null) {
    const entries = Object.entries(val as Record<string, unknown>);
    const bytes = encodeHeader(5, entries.length); // Major 5: map
    for (const [k, v] of entries) {
      bytes.push(...encodeHeader(0, Number(k))); // Integer key
      bytes.push(...encodeValue(v));
    }
    return bytes;
  }
  throw new Error(`Unsupported CBOR value type: ${typeof val}`);
}

/** Encode a full CCX message: CBOR array [msgType, body] */
export function encodeMessage(
  msgType: number,
  body: Record<number, unknown>,
): Buffer {
  const bytes = encodeValue([msgType, body]);
  return Buffer.from(bytes);
}

// --- Command encoders ---

export interface LevelControlOpts {
  zoneId: number;
  level: number;
  sequence: number;
  zoneType?: number; // default 16
  fade?: number; // command key 3 — quarter-seconds (1 = 0.25s instant)
  delay?: number; // command key 4 — quarter-seconds
  cct?: number; // command key 6 — color temperature in Kelvin
  warmDimMode?: number; // command key 5 — warm dim mode flag (5 = enabled)
}

/** Encode a LEVEL_CONTROL command */
export function encodeLevelControl(opts: LevelControlOpts): Buffer {
  const {
    zoneId,
    level,
    sequence,
    zoneType = 16,
    fade = 1,
    delay,
    cct,
    warmDimMode,
  } = opts;
  // Structure: [0, { 0: {0: level, 3: fade, 4?: delay, 5?: warmDimMode, 6?: cct}, 1: [16, zoneId], 5: seq }]
  const cmd: Record<number, unknown> = { 0: level, 3: fade };
  if (delay !== undefined) cmd[4] = delay;
  if (warmDimMode !== undefined) cmd[5] = warmDimMode;
  if (cct !== undefined) cmd[6] = cct;
  const body: Record<number, unknown> = {
    [BodyKey.COMMAND]: cmd,
    [BodyKey.ZONE]: [zoneType, zoneId],
    [BodyKey.SEQUENCE]: sequence,
  };
  return encodeMessage(CCXMessageType.LEVEL_CONTROL, body);
}

/** Encode an ON command (level = 0xFEFF) */
export function encodeOn(
  zoneId: number,
  sequence: number,
  fade?: number,
  delay?: number,
): Buffer {
  return encodeLevelControl({
    zoneId,
    level: Level.FULL_ON,
    sequence,
    fade,
    delay,
  });
}

/** Encode an OFF command (level = 0x0000) */
export function encodeOff(
  zoneId: number,
  sequence: number,
  fade?: number,
  delay?: number,
): Buffer {
  return encodeLevelControl({
    zoneId,
    level: Level.OFF,
    sequence,
    fade,
    delay,
  });
}

export interface SceneRecallOpts {
  sceneId: number;
  sequence: number;
}

/** Encode a SCENE_RECALL command */
export function encodeSceneRecall(opts: SceneRecallOpts): Buffer {
  const { sceneId, sequence } = opts;
  // Structure: [36, { 0: {0: [4]}, 1: [0], 3: {0: sceneId}, 5: seq }]
  const body: Record<number, unknown> = {
    [BodyKey.COMMAND]: { 0: [4] },
    [BodyKey.ZONE]: [0],
    [BodyKey.EXTRA]: { 0: sceneId },
    [BodyKey.SEQUENCE]: sequence,
  };
  return encodeMessage(CCXMessageType.SCENE_RECALL, body);
}

// --- Device Report encoder ---

export interface DeviceReportOpts {
  deviceSerial: number;
  level: number; // 0x0000-0xFEFF
  sequence: number;
  groupId?: number; // scene/group ID (key 3.1)
  deviceType?: number; // usually 1
}

/**
 * Encode a DEVICE_REPORT message (type 27).
 * Devices broadcast this after executing commands to report their current state.
 * Format B: inner key 3 = [[0, Uint8Array(level_BE), outputType]]
 */
export function encodeDeviceReport(opts: DeviceReportOpts): Buffer {
  const {
    deviceSerial,
    level,
    sequence,
    groupId = 0,
    deviceType = 1,
  } = opts;

  // Inner command: key 3 = array of [index, level_bytes, output_type]
  // We encode level as a 2-byte big-endian Uint8Array
  const levelHi = (level >> 8) & 0xff;
  const levelLo = level & 0xff;

  // Build raw CBOR manually since we need a byte string for the level
  // Structure: [27, { 0: {3: [[0, h'XXYY', 2]]}, 2: [1, serial], 3: {1: groupId}, 5: seq }]
  const bytes: number[] = [];

  // Outer array [msgType, body]
  bytes.push(0x82); // array(2)
  bytes.push(0x18, 27); // uint(27) = DEVICE_REPORT

  // Body map with 4 entries: keys 0, 2, 3, 5
  bytes.push(0xa4); // map(4)

  // Key 0 (COMMAND): inner map with key 3
  bytes.push(0x00); // uint(0)
  bytes.push(0xa1); // map(1)
  bytes.push(0x03); // uint(3)
  // Array of 1 tuple
  bytes.push(0x81); // array(1)
  // Tuple: [0, h'XXYY', 2]
  bytes.push(0x83); // array(3)
  bytes.push(0x00); // uint(0) — index
  bytes.push(0x42, levelHi, levelLo); // bstr(2) — level big-endian
  bytes.push(0x02); // uint(2) — output type

  // Key 2 (DEVICE): [deviceType, serial]
  bytes.push(0x02); // uint(2)
  bytes.push(0x82); // array(2)
  bytes.push(...encodeHeader(0, deviceType));
  bytes.push(...encodeHeader(0, deviceSerial));

  // Key 3 (EXTRA): {1: groupId}
  bytes.push(0x03); // uint(3)
  bytes.push(0xa1); // map(1)
  bytes.push(0x01); // uint(1)
  bytes.push(...encodeHeader(0, groupId));

  // Key 5 (SEQUENCE): seq
  bytes.push(0x05); // uint(5)
  bytes.push(...encodeHeader(0, sequence));

  return Buffer.from(bytes);
}

/** Convert percentage (0-100) to Lutron level (0x0000-0xFEFF) */
export function percentToLevel(percent: number): number {
  if (percent <= 0) return Level.OFF;
  if (percent >= 100) return Level.FULL_ON;
  return Math.round((percent * Level.FULL_ON) / 100);
}

/** Get next sequence number (file-backed 8-bit counter) */
export function nextSequence(): number {
  let seq = 0;
  try {
    if (existsSync(SEQ_FILE)) {
      seq = parseInt(readFileSync(SEQ_FILE, "utf-8").trim(), 10) || 0;
    }
  } catch {
    /* start at 0 */
  }
  const next = (seq + 1) & 0xff;
  writeFileSync(SEQ_FILE, String(next), "utf-8");
  return next;
}
