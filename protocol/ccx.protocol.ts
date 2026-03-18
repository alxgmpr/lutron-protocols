/**
 * Lutron Clear Connect Type X (CCX) Protocol Definition
 *
 * Single source of truth for CCX message types, body keys, CBOR structure,
 * and level/timing constants.
 *
 * Replaces: ccx/constants.ts constants + protocol/ccx.yaml
 * Consumed by: TS code (direct import via ccx/constants.ts re-exports),
 *              C firmware (via codegen → ccx_generated.h)
 */

import { type CCXProtocolDef, constantGroup, messageType } from "./dsl";
import { LEVEL_MAX_16 } from "./shared";

// ============================================================================
// BODY KEYS
// ============================================================================

const bodyKeys = {
  COMMAND: {
    key: 0,
    description: "Inner command data (type-specific nested map)",
  },
  ZONE: { key: 1, description: "Zone info: [zone_type, zone_id]" },
  DEVICE: { key: 2, description: "Device info: [type, device_id]" },
  EXTRA: { key: 3, description: "Extra data map (scene ID, group ID, etc.)" },
  STATUS: { key: 4, description: "Status value (used by PRESENCE)" },
  SEQUENCE: { key: 5, description: "8-bit sequence number for deduplication" },
};

// ============================================================================
// MESSAGE TYPES
// ============================================================================

const LEVEL_CONTROL = messageType(
  0,
  "Set zone level (on/off/dim). Primary command for OUTPUT control.",
  "OUTPUT",
  ["COMMAND", "ZONE", "SEQUENCE"],
  {
    commandSchema: [
      {
        key: 0,
        name: "level",
        type: "uint16",
        description: "Level value (0x0000-0xFEFF)",
      },
      {
        key: 3,
        name: "fade",
        type: "uint16",
        unit: "quarter-seconds",
        description: "Fade time (1 = 0.25s instant)",
      },
      {
        key: 4,
        name: "delay",
        type: "uint16",
        unit: "quarter-seconds",
        optional: true,
        description: "Delay before fade starts",
      },
    ],
  },
);

const BUTTON_PRESS = messageType(
  1,
  "Physical button press from pico/keypad. Uses DEVICE path.",
  "DEVICE",
  ["COMMAND", "SEQUENCE"],
  {
    commandSchema: [
      {
        key: 0,
        name: "device_id",
        type: "bytes(4)",
        description: "4-byte device ID (preset_hi, preset_lo, 0xEF, 0x20)",
      },
      {
        key: 1,
        name: "counters",
        type: "array[uint]",
        description: "Frame counters for replay protection",
      },
    ],
  },
);

const DIM_HOLD = messageType(
  2,
  "Dim hold start - first of a raise/lower pair (even sequence number)",
  "DEVICE",
  ["COMMAND", "ZONE", "SEQUENCE"],
  {
    commandSchema: [
      {
        key: 0,
        name: "device_id",
        type: "bytes(4)",
        description: "Same format as BUTTON_PRESS",
      },
      {
        key: 1,
        name: "action",
        type: "uint8",
        description: "2 = lower, 3 = raise",
      },
    ],
  },
);

const DIM_STEP = messageType(
  3,
  "Dim step - second of a raise/lower pair (odd sequence number)",
  "DEVICE",
  ["COMMAND", "ZONE", "SEQUENCE"],
  {
    commandSchema: [
      {
        key: 0,
        name: "device_id",
        type: "bytes(4)",
        description: "Same format as BUTTON_PRESS",
      },
      {
        key: 1,
        name: "action",
        type: "uint8",
        description: "2 = lower, 3 = raise",
      },
      {
        key: 2,
        name: "step_value",
        type: "uint16",
        description: "Step size or timing (180-250 observed)",
      },
    ],
  },
);

const ACK = messageType(
  7,
  "Acknowledgment from processor. Response codes: 0x50='P' (LEVEL_ACK), 0x55='U' (BUTTON_ACK)",
  "CONTROL",
  ["COMMAND", "SEQUENCE"],
  {
    commandSchema: [
      {
        key: 1,
        name: "response",
        type: "map",
        description:
          "Response map: {0: bytes} — first byte is response code (0x50=LEVEL_ACK, 0x55=BUTTON_ACK)",
      },
    ],
  },
);

const DEVICE_REPORT = messageType(
  27,
  "Device state report - broadcast by devices after executing commands",
  "STATE",
  ["COMMAND", "DEVICE", "EXTRA", "SEQUENCE"],
  {
    commandSchema: [
      {
        key: 0,
        name: "action",
        type: "uint8",
        description: "Report action type",
      },
      {
        key: 1,
        name: "level_map",
        type: "map",
        optional: true,
        description:
          "Format A: {0: 8-bit level} — scale to 16-bit via level*0xFEFF/255",
      },
      {
        key: 3,
        name: "level_tuples",
        type: "array",
        optional: true,
        description:
          "Format B: [[idx, Uint8Array(2)]] — uint16 BE level per zone",
      },
    ],
    extraSchema: [
      {
        key: 1,
        name: "group_id",
        type: "uint16",
        description: "Scene/group identifier",
      },
    ],
  },
);

const SCENE_RECALL = messageType(
  36,
  "Scene/group recall - triggers devices to execute stored scenes. command[0]=[4] for recall",
  "OUTPUT",
  ["COMMAND", "ZONE", "EXTRA", "SEQUENCE"],
  {
    commandSchema: [
      {
        key: 0,
        name: "recall_cmd",
        type: "array[uint]",
        description: "[4] = recall action, 0 = set/program",
      },
    ],
    extraSchema: [
      {
        key: 0,
        name: "scene_id",
        type: "uint16",
        description: "Scene/group identifier",
      },
      {
        key: 2,
        name: "params",
        type: "array[uint]",
        description: "[component_type, value] e.g. [5, 60]",
      },
    ],
  },
);

const COMPONENT_CMD = messageType(
  40,
  "Component command - shade position, fan speed, CCO relay, etc. command[0]=0 for set",
  "OUTPUT",
  ["COMMAND", "ZONE", "EXTRA", "SEQUENCE"],
  {
    commandSchema: [
      {
        key: 0,
        name: "action",
        type: "uint8",
        description: "0 = set, [4] = recall",
      },
    ],
    extraSchema: [
      {
        key: 0,
        name: "group_id",
        type: "uint16",
        description: "Component group ID",
      },
      {
        key: 2,
        name: "params",
        type: "array[uint]",
        description: "[component_type, value] e.g. [10, 4800]",
      },
    ],
  },
);

const STATUS = messageType(
  41,
  "Device status update with binary payload",
  "STATE",
  ["COMMAND", "DEVICE", "EXTRA", "SEQUENCE"],
  {
    commandSchema: [
      { key: 0, name: "action", type: "uint8" },
      {
        key: 2,
        name: "payload",
        type: "bytes",
        description: "Binary status payload",
      },
    ],
  },
);

const PRESENCE = messageType(
  65535,
  "Periodic presence/heartbeat announcement",
  "CONTROL",
  ["STATUS", "SEQUENCE"],
);

// ============================================================================
// CONSTANT GROUPS
// ============================================================================

const levelConstants = constantGroup(
  "Level",
  "CCX level encoding constants",
  "CCX_LEVEL_",
  {
    FULL_ON: { value: 0xfeff, description: "100% level" },
    OFF: { value: 0x0000, description: "0% level" },
  },
  "uint16_t",
);

const portConstants = constantGroup("Port", "CCX UDP port", "CCX_", {
  UDP_PORT: { value: 9190 },
});

const zoneConstants = constantGroup(
  "Zone",
  "CCX zone types",
  "CCX_ZONE_TYPE_",
  {
    DIMMER: { value: 16, description: "Default zone type for dimmers" },
  },
);

// ============================================================================
// PROTOCOL DEFINITION
// ============================================================================

export const CCX: CCXProtocolDef = {
  messageTypes: {
    LEVEL_CONTROL,
    BUTTON_PRESS,
    DIM_HOLD,
    DIM_STEP,
    ACK,
    DEVICE_REPORT,
    SCENE_RECALL,
    COMPONENT_CMD,
    STATUS,
    PRESENCE,
  },
  bodyKeys,
  constantGroups: {
    level: levelConstants,
    port: portConstants,
    zone: zoneConstants,
  },
};

// ============================================================================
// DIRECT TS EXPORTS (same API as old ccx/constants.ts)
// ============================================================================

/** Known CCX message type IDs */
export const CCXMessageType = Object.fromEntries(
  Object.entries(CCX.messageTypes).map(([k, v]) => [k, v.id]),
) as {
  readonly LEVEL_CONTROL: 0;
  readonly BUTTON_PRESS: 1;
  readonly DIM_HOLD: 2;
  readonly DIM_STEP: 3;
  readonly ACK: 7;
  readonly DEVICE_REPORT: 27;
  readonly SCENE_RECALL: 36;
  readonly COMPONENT_CMD: 40;
  readonly STATUS: 41;
  readonly PRESENCE: 65535;
};

export type CCXMessageTypeId =
  (typeof CCXMessageType)[keyof typeof CCXMessageType];

/** Human-readable names for message types */
export const CCXMessageTypeName: Record<number, string> = Object.fromEntries(
  Object.entries(CCX.messageTypes).map(([k, v]) => [v.id, k]),
);

/** Top-level body map keys */
export const BodyKey = Object.fromEntries(
  Object.entries(CCX.bodyKeys).map(([k, v]) => [k, v.key]),
) as {
  readonly COMMAND: 0;
  readonly ZONE: 1;
  readonly DEVICE: 2;
  readonly EXTRA: 3;
  readonly STATUS: 4;
  readonly SEQUENCE: 5;
};

/** Level encoding constants */
export const Level = {
  /** Maximum possible level value (note: FULL_ON is the correct 100% value) */
  MAX: 0xffff,
  /** Lutron "full on" level (distinct from MAX) */
  FULL_ON: 0xfeff,
  /** Off */
  OFF: 0x0000,
} as const;

/** Convert level (0-0xFEFF) to percentage (0-100) — uses correct FULL_ON divisor */
export function levelToPercent(level: number): number {
  return (level / LEVEL_MAX_16) * 100;
}

/** Convert percentage (0-100) to level (0-0xFEFF) */
export function percentToLevel(percent: number): number {
  return Math.round((percent * LEVEL_MAX_16) / 100);
}

/** Lutron CCX UDP port */
export const CCX_UDP_PORT = 9190;
