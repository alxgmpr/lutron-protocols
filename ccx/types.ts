/**
 * Lutron Clear Connect X (CCX) Protocol Types
 *
 * CCX uses Thread (802.15.4) as transport with CBOR-encoded payloads on UDP port 9190.
 * All messages are CBOR arrays: [msg_type, body_map]
 */

/** Raw CBOR body - integer-keyed map */
export type CCXBody = Record<number, unknown>;

/** Level control command (on/off, dimming) */
export interface CCXLevelControl {
  type: "LEVEL_CONTROL";
  level: number; // 0x0000 = OFF, 0xFEFF = FULL ON
  levelPercent: number; // 0-100
  zoneType: number; // Usually 16
  zoneId: number; // Internal Lutron zone ID
  fade: number; // Quarter-seconds (1 = 0.25s instant)
  delay: number; // Quarter-seconds (0 = no delay)
  sequence: number;
}

/** Physical button / scene press */
export interface CCXButtonPress {
  type: "BUTTON_PRESS";
  deviceId: Uint8Array; // 4-byte device identifier
  buttonZone: number; // Extracted from deviceId[1]
  cmdType: number; // deviceId[0], 0x03 = button
  counters: number[]; // Frame counters (replay protection)
  sequence: number;
}

/** Acknowledgment */
export interface CCXAck {
  type: "ACK";
  responseCode: number; // e.g. 0x50 ('P') for level, 0x55 ('U') for button
  response: Uint8Array; // Raw response bytes
  sequence: number;
}

/** Thread/device status update */
export interface CCXStatus {
  type: "STATUS";
  innerData: Uint8Array; // Raw status payload
  deviceType: number;
  deviceId: number;
  extra: Record<number, unknown>;
  sequence: number;
}

/** Presence/broadcast announcement */
export interface CCXPresence {
  type: "PRESENCE";
  status: number;
  sequence: number;
}

/** Dim hold — first of a raise/lower pair (even seq) */
export interface CCXDimHold {
  type: "DIM_HOLD";
  deviceId: Uint8Array; // 4-byte device identifier (same format as button press)
  buttonZone: number; // deviceId[1]
  cmdType: number; // deviceId[0]
  action: number | undefined; // inner key 1 (3 = raise/lower?)
  sequence: number;
}

/** Dim step — second of a raise/lower pair (odd seq), contains step value */
export interface CCXDimStep {
  type: "DIM_STEP";
  deviceId: Uint8Array;
  buttonZone: number;
  cmdType: number;
  action: number | undefined; // inner key 1
  stepValue: number; // inner key 2 — step size or timing (180-250 observed)
  sequence: number;
}

/** Device state report — broadcast by devices after executing commands */
export interface CCXDeviceReport {
  type: "DEVICE_REPORT";
  deviceType: number; // key 2[0] — always 1 observed
  deviceSerial: number; // key 2[1] — device serial number
  groupId: number; // key 3.1 — scene/group identifier
  innerData: Record<number, unknown>; // key 0 inner map
}

/** Scene/group recall command */
export interface CCXSceneRecall {
  type: "SCENE_RECALL";
  command: unknown; // key 0.0 — e.g. [4] for recall
  targets: number[]; // key 1 — target list, e.g. [0] for all
  sceneId: number; // key 3.0 — scene/group identifier
  params: number[]; // key 3.2 — [component_type, value], e.g. [5, 60]
  sequence: number;
}

/** Shade/component command */
export interface CCXComponentCmd {
  type: "COMPONENT_CMD";
  command: unknown; // key 0.0 — e.g. 0
  targets: number[]; // key 1
  groupId: number; // key 3.0
  params: number[]; // key 3.2 — [component_type, value], e.g. [10, 4800]
  sequence: number;
}

/** Catch-all for undiscovered message types */
export interface CCXUnknown {
  type: "UNKNOWN";
  msgType: number;
  body: CCXBody;
  sequence: number;
}

/** Union of all parsed CCX message types */
export type CCXMessage =
  | CCXLevelControl
  | CCXButtonPress
  | CCXDimHold
  | CCXDimStep
  | CCXAck
  | CCXDeviceReport
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
