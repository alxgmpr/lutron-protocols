/**
 * Lutron Clear Connect X (CCX) Protocol Types
 *
 * CCX uses Thread (802.15.4) as transport with CBOR-encoded payloads on UDP port 9190.
 * All messages are CBOR arrays: [msg_type, body_map]
 */

/** Raw CBOR body - integer-keyed map */
export type CCXBody = Record<number, unknown>;

/** Base interface — all parsed message types extend this */
export interface CCXMessageBase {
  sequence: number;
  rawBody?: CCXBody;
  unknownKeys?: Record<number, unknown>;
}

/** Level control command (on/off, dimming) */
export interface CCXLevelControl extends CCXMessageBase {
  type: "LEVEL_CONTROL";
  level: number; // 0x0000 = OFF, 0xFEFF = FULL ON
  levelPercent: number; // 0-100
  zoneType: number; // Usually 16
  zoneId: number; // Internal Lutron zone ID
  fade: number; // Quarter-seconds (1 = 0.25s instant)
  delay: number; // Quarter-seconds (0 = no delay)
  colorXy?: [number, number]; // CIE xy chromaticity as [x*10000, y*10000] (key 1)
  vibrancy?: number; // Ketra vibrancy 0-100 (key 2), spectral quality tuning
  cct?: number; // Color temperature in Kelvin (key 6), present for explicit CCT
  warmDimMode?: number; // Warm dim mode flag (key 5 = 5), fixture computes CCT internally
}

/** Physical button / scene press */
export interface CCXButtonPress extends CCXMessageBase {
  type: "BUTTON_PRESS";
  deviceId: Uint8Array; // 4-byte device identifier
  buttonZone: number; // Extracted from deviceId[1]
  cmdType: number; // deviceId[0], 0x03 = button
  counters: number[]; // Frame counters (replay protection)
}

/** Acknowledgment */
export interface CCXAck extends CCXMessageBase {
  type: "ACK";
  responseCode: number; // e.g. 0x50 ('P') for level, 0x55 ('U') for button
  response: Uint8Array; // Raw response bytes
  responseLabel?: string; // Human-readable: "LEVEL_ACK", "BUTTON_ACK"
}

/** Thread/device status update */
export interface CCXStatus extends CCXMessageBase {
  type: "STATUS";
  innerData: Uint8Array; // Raw status payload
  deviceType: number;
  deviceId: number;
  sceneFamilyId?: number; // key 3.1 — recurring scene/group-family identifier
  extra: Record<number, unknown>;
}

/** Presence/broadcast announcement */
export interface CCXPresence extends CCXMessageBase {
  type: "PRESENCE";
  status: number;
}

/** Dim hold — start of a raise/lower (action=3 raise, action=2 lower) */
export interface CCXDimHold extends CCXMessageBase {
  type: "DIM_HOLD";
  deviceId: Uint8Array; // 4-byte device identifier (same format as button press)
  buttonZone: number; // deviceId[1]
  cmdType: number; // deviceId[0]
  action: number | undefined; // 2 = lower, 3 = raise
  direction?: "RAISE" | "LOWER"; // Derived from action
  zoneType: number; // body key 1[0] (0 if absent)
  zoneId: number; // body key 1[1] (0 if absent — app-triggered has zone, pico doesn't)
}

/** Dim step — release/end of a raise/lower, contains elapsed time */
export interface CCXDimStep extends CCXMessageBase {
  type: "DIM_STEP";
  deviceId: Uint8Array;
  buttonZone: number;
  cmdType: number;
  action: number | undefined; // 2 = lower, 3 = raise
  direction?: "RAISE" | "LOWER"; // Derived from action
  stepValue: number; // elapsed ms (~1000/sec observed from pico, 0 from app)
  zoneType: number; // body key 1[0]
  zoneId: number; // body key 1[1]
}

/** Device state report — broadcast by devices after executing commands */
export interface CCXDeviceReport extends CCXMessageBase {
  type: "DEVICE_REPORT";
  deviceType: number; // key 2[0] — always 1 observed
  deviceSerial: number; // key 2[1] — device serial number
  groupId: number; // key 3.1 — scene/group identifier
  innerData: Record<number, unknown>; // key 0 inner map
  level?: number; // 0-0xFEFF, extracted from inner map
  levelPercent?: number; // 0-100
  outputType?: number; // Format B tuple element [2] — 2 or 3 observed
}

/** Device state notification (Type 34) — component/output state from a device */
export interface CCXDeviceState extends CCXMessageBase {
  type: "DEVICE_STATE";
  deviceType: number; // key 2[0] — always 1
  deviceSerial: number; // key 2[1]
  stateType: number; // inner key 0 — 5, 8, 18 observed; likely local UI/interaction state
  stateValue: number; // inner key 1 — 0 or 1 (boolean-like)
  stateData?: Uint8Array; // inner key 2 — 2-byte payload (optional, 000e/000c/0116/0008 observed)
}

/** Scene/group recall command */
export interface CCXSceneRecall extends CCXMessageBase {
  type: "SCENE_RECALL";
  command: unknown; // key 0.0 raw value for compatibility
  recallVector: number[]; // key 0.0 observed as a fixed-length byte vector, not just [4]
  targets: number[]; // key 1 — target list, e.g. [0] for all
  sceneId: number; // key 3.0 — scene/group identifier
  params: number[]; // key 3.2 — [component_type, value], e.g. [5, 60]
}

/** Shade/component command */
export interface CCXComponentCmd extends CCXMessageBase {
  type: "COMPONENT_CMD";
  command: unknown; // key 0.0 — e.g. 0
  targets: number[]; // key 1
  groupId: number; // key 3.0
  params: number[]; // key 3.2 — [component_type, value], e.g. [10, 4800]
}

/** Catch-all for undiscovered message types */
export interface CCXUnknown extends CCXMessageBase {
  type: "UNKNOWN";
  msgType: number;
  body: CCXBody;
}

/** Union of all parsed CCX message types */
export type CCXMessage =
  | CCXLevelControl
  | CCXButtonPress
  | CCXDimHold
  | CCXDimStep
  | CCXAck
  | CCXDeviceReport
  | CCXDeviceState
  | CCXSceneRecall
  | CCXComponentCmd
  | CCXStatus
  | CCXPresence
  | CCXUnknown;

/** A fully decoded CCX packet with transport metadata */
export interface CCXPacket {
  timestamp: string;
  srcAddr: string; // IPv6 source
  dstAddr: string; // IPv6 destination
  srcEui64: string; // 802.15.4 EUI-64 source (if available)
  dstEui64: string; // 802.15.4 EUI-64 destination (if available)
  msgType: number;
  body: CCXBody; // Raw CBOR map (integer keys)
  parsed: CCXMessage; // Typed interpretation
  rawHex: string; // Original CBOR hex
}
