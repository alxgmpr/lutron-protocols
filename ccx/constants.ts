/**
 * CCX Protocol Constants
 *
 * Message type IDs, field key mappings, and level encoding constants.
 */

/** Known CCX message type IDs */
export const CCXMessageType = {
  LEVEL_CONTROL: 0,
  BUTTON_PRESS: 1,
  /** Dim hold — first of a raise/lower pair (even seq), announces hold start */
  DIM_HOLD: 2,
  /** Dim step — second of a raise/lower pair (odd seq), contains step size */
  DIM_STEP: 3,
  ACK: 7,
  /** Device state report — devices broadcast after executing commands (no seq) */
  DEVICE_REPORT: 27, // 0x1B
  /** Scene/group recall — triggers devices to execute stored scenes */
  SCENE_RECALL: 36, // 0x24
  /** Shade/component command — shade position, fan speed, etc. */
  COMPONENT_CMD: 40, // 0x28
  STATUS: 41, // 0x29
  PRESENCE: 65535, // 0xFFFF
} as const;

export type CCXMessageTypeId =
  (typeof CCXMessageType)[keyof typeof CCXMessageType];

/** Human-readable names for message types */
export const CCXMessageTypeName: Record<number, string> = {
  [CCXMessageType.LEVEL_CONTROL]: "LEVEL_CONTROL",
  [CCXMessageType.BUTTON_PRESS]: "BUTTON_PRESS",
  [CCXMessageType.DIM_HOLD]: "DIM_HOLD",
  [CCXMessageType.DIM_STEP]: "DIM_STEP",
  [CCXMessageType.ACK]: "ACK",
  [CCXMessageType.DEVICE_REPORT]: "DEVICE_REPORT",
  [CCXMessageType.SCENE_RECALL]: "SCENE_RECALL",
  [CCXMessageType.COMPONENT_CMD]: "COMPONENT_CMD",
  [CCXMessageType.STATUS]: "STATUS",
  [CCXMessageType.PRESENCE]: "PRESENCE",
};

/**
 * Top-level body map keys (shared across message types).
 * Key 5 = sequence is used by all types.
 */
export const BodyKey = {
  /** Inner command data (type-specific) */
  COMMAND: 0,
  /** Zone info: [zone_type, zone_id] */
  ZONE: 1,
  /** Device info: [type, device_id] (used by STATUS) */
  DEVICE: 2,
  /** Extra info map (used by STATUS) */
  EXTRA: 3,
  /** Status field (used by PRESENCE) */
  STATUS: 4,
  /** Sequence number */
  SEQUENCE: 5,
} as const;

/** Level encoding constants */
export const Level = {
  /** Maximum possible level value */
  MAX: 0xffff,
  /** Lutron "full on" level (distinct from MAX) */
  FULL_ON: 0xfeff,
  /** Off */
  OFF: 0x0000,
} as const;

/** Convert level (0-0xFFFF) to percentage (0-100) */
export function levelToPercent(level: number): number {
  return (level / Level.MAX) * 100;
}

/** Convert percentage (0-100) to level (0-0xFFFF) */
export function percentToLevel(percent: number): number {
  return Math.round(percent * (Level.MAX / 100));
}

/** Lutron CCX UDP port */
export const CCX_UDP_PORT = 9190;
