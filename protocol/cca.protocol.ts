/**
 * Lutron Clear Connect Type A (CCA) Protocol Definition
 *
 * Single source of truth for all CCA protocol constants, packet types,
 * field layouts, enums, and transmission sequences.
 *
 * Replaces: protocol/cca.yaml + firmware/src/cca/cca_protocol.h constants
 * Consumed by: TS code (direct import), C firmware (via codegen → cca_generated.h)
 */

import {
  type CCAProtocolDef,
  constantGroup,
  enumDef,
  type FieldDef,
  field,
  type PairingPreset,
  packetType,
  packetTypeFrom,
  type Sequence,
} from "./dsl";

// ============================================================================
// ENUMS
// ============================================================================

const buttonEnum = enumDef("Button", "Button code values", "BTN_", {
  ON: { value: 0x02, description: "5-button ON / top" },
  FAVORITE: { value: 0x03, description: "5-button FAV / middle" },
  OFF: { value: 0x04, description: "5-button OFF / bottom" },
  RAISE: { value: 0x05, description: "5-button RAISE" },
  LOWER: { value: 0x06, description: "5-button LOWER" },
  SCENE4: { value: 0x08, description: "4-button top (scene: BRIGHT, rl: ON)" },
  SCENE3: {
    value: 0x09,
    description: "4-button second (scene: 2nd, rl: RAISE)",
  },
  SCENE2: {
    value: 0x0a,
    description: "4-button third (scene: 3rd, rl: LOWER)",
  },
  SCENE1: {
    value: 0x0b,
    description: "4-button bottom (scene: OFF, rl: OFF)",
  },
  RESET: { value: 0xff, description: "Reset/unpair" },
});

const actionEnum = enumDef("Action", "Button action codes", "ACTION_", {
  PRESS: { value: 0x00 },
  RELEASE: { value: 0x01 },
  HOLD: { value: 0x02, description: "Continuous hold for dimming" },
  SAVE: { value: 0x03, description: "Save favorite/scene" },
});

const categoryEnum = enumDef(
  "Category",
  "Packet categories for filtering",
  "",
  {
    BUTTON: { value: -1, description: "Button press/release from Pico" },
    STATE: { value: -1, description: "Dimmer/switch state reports" },
    BEACON: { value: -1, description: "Pairing beacons" },
    PAIRING: { value: -1, description: "Pairing announcements" },
    CONFIG: { value: -1, description: "Device configuration" },
    HANDSHAKE: { value: -1, description: "Pairing responses" },
  },
);

const deviceClassEnum = enumDef(
  "DeviceClass",
  "Device class codes (byte 28 in pairing)",
  "DEVCLASS_",
  {
    DIMMER: { value: 0x04 },
    SWITCH: { value: 0x05 },
    FAN: { value: 0x06 },
    SHADE: { value: 0x0a },
    KEYPAD: { value: 0x0b },
  },
);

// ============================================================================
// CONSTANT GROUPS (absorb cca_protocol.h)
// ============================================================================

const qsFormat = constantGroup(
  "QsFormat",
  "Format byte values (= payload length in bytes)",
  "QS_FMT_",
  {
    TAP: { value: 0x04, description: "Button tap (4 bytes)" },
    STATE: { value: 0x08, description: "State report (8 bytes)" },
    CTRL: { value: 0x09, description: "Device control / hold-start (9 bytes)" },
    ADDR: { value: 0x0a, description: "Address assign (10 bytes)" },
    DIM_STEP: { value: 0x0b, description: "Dim step (11 bytes)" },
    BEACON: {
      value: 0x0c,
      description: "Beacon / unpair / dim-stop (12 bytes)",
    },
    LEVEL: {
      value: 0x0e,
      description: "GoToLevel / button extended (14 bytes)",
    },
    ACCEPT: { value: 0x10, description: "Pairing accept (16 bytes)" },
    LED: { value: 0x11, description: "LED config (17 bytes)" },
    FINAL: { value: 0x12, description: "Final config with zone (18 bytes)" },
    DIM_CAP: { value: 0x13, description: "Dimming capability (19 bytes)" },
    FUNC_MAP: { value: 0x14, description: "Function mapping (20 bytes)" },
    TRIM: { value: 0x15, description: "Trim / phase config (21 bytes)" },
    SCENE_CFG: { value: 0x1a, description: "Scene config (26 bytes)" },
    FADE: { value: 0x1c, description: "Fade config (28 bytes)" },
    ZONE: {
      value: 0x28,
      description: "Zone assignment (40 bytes, format at byte 6)",
    },
  },
);

const qsAddr = constantGroup(
  "QsAddr",
  "Addressing modes (QS Link payload offset 5)",
  "QS_ADDR_",
  {
    COMPONENT: {
      value: 0xfe,
      description: "Unicast to specific component/zone",
    },
    GROUP: { value: 0xef, description: "Multicast to all devices in a group" },
    BROADCAST: {
      value: 0xff,
      description: "Broadcast to all devices on the link",
    },
  },
);

const qsClass = constantGroup(
  "QsClass",
  "Command classes (QS Link payload offset 6)",
  "QS_CLASS_",
  {
    LEVEL: {
      value: 0x40,
      description: "Level control (GoToLevel) — unchanged since 2009",
    },
    DIM: {
      value: 0x42,
      description: "Dim control (raise/lower/stop) — modern CCA",
    },
    LEGACY: {
      value: 0x06,
      description:
        "Original 2009 dim/config class — persists in pairing packets",
    },
    DEVICE: {
      value: 0x01,
      description: "Device control (identify, mode changes)",
    },
    SELECT: { value: 0x03, description: "Select / query component" },
    BUTTON: { value: 0x05, description: "Button / programming master events" },
    ASSIGN: {
      value: 0x08,
      description: "Address assignment / component binding",
    },
    SCENE: { value: 0x09, description: "Scene activation" },
  },
);

const qsType = constantGroup(
  "QsType",
  "Command types (QS Link payload offset 7)",
  "QS_TYPE_",
  {
    EXECUTE: { value: 0x02, description: "Set / execute" },
    HOLD: { value: 0x00, description: "Hold / start" },
    STEP: {
      value: 0x02,
      description: "Dim step (same value as execute, context-dependent)",
    },
    IDENTIFY: { value: 0x22, description: "Flash LEDs / self-identify" },
    CONFIG: { value: 0x33, description: "Configuration" },
    ADDR_SET: { value: 0xa3, description: "Address assign" },
    ADDR_QRY: { value: 0xa5, description: "Address query" },
    PROP_SET_FIXED: { value: 0x64, description: "Property set (fixed-size)" },
    PROP_SET_VAR: { value: 0x65, description: "Property set (variable-size)" },
    DIM_CONFIG: { value: 0x78, description: "Dimming config sub-type" },
  },
);

const qsComp = constantGroup("QsComp", "Component types", "QS_COMP_", {
  DIMMER: { value: 0x50 },
  RELAY: { value: 0x38 },
  SCENE: { value: 0x40 },
});

const qsProto = constantGroup(
  "QsProto",
  "Protocol byte — radio IC TX command",
  "QS_PROTO_",
  {
    RADIO_TX: { value: 0x21 },
  },
);

const qsPico = constantGroup("QsPico", "Pico device framing", "QS_PICO_", {
  FRAME: { value: 0x03 },
});

const qsLevelMax = constantGroup(
  "QsLevelMax",
  "Level encoding (16-bit)",
  "QS_LEVEL_",
  {
    MAX: { value: 0xfeff, description: "100% as 16-bit" },
  },
  "uint16_t",
);

const qsLevelMax8 = constantGroup(
  "QsLevelMax8",
  "Level encoding (8-bit)",
  "QS_LEVEL_",
  {
    MAX_8: { value: 0xfe, description: "100% as 8-bit" },
  },
);

const qsState = constantGroup(
  "QsState",
  "State report field values",
  "QS_STATE_",
  {
    ENTITY_COMP: {
      value: 0x1b,
      description: "Component entity marker (state rpt bytes 9/13)",
    },
    STATUS_FLAG: {
      value: 0x92,
      description: "Status flag (state rpt byte 14)",
    },
  },
);

const qsPreset = constantGroup(
  "QsPreset",
  "Preset base offset (button → preset mapping in pico long format)",
  "QS_PRESET_",
  {
    BASE: { value: 0x1e },
  },
);

const qsPadding = constantGroup("QsPadding", "Padding", "QS_", {
  PADDING: { value: 0x00 },
});

// ============================================================================
// RF / CRC / FRAMING / TIMING / SEQUENCE / LENGTHS
// ============================================================================

const rfGroup = constantGroup("RF", "RF physical layer", "", {
  FREQUENCY_HZ: { value: 433602844 },
  DEVIATION_HZ: { value: 41200 },
  BAUD_RATE: { value: 62484.7 },
});

const crcGroup = constantGroup("CRC", "CRC configuration", "", {
  POLYNOMIAL: { value: 0xca0f },
  WIDTH: { value: 16 },
  INITIAL: { value: 0x0000 },
});

const framingGroup = constantGroup("Framing", "Packet framing", "", {
  PREAMBLE_BITS: { value: 32 },
  PREAMBLE_PATTERN: { value: 0xaaaaaaaa },
  SYNC_BYTE: { value: 0xff },
  TRAILING_BITS: { value: 16 },
});

const timingGroup = constantGroup(
  "Timing",
  "Timing constants (milliseconds)",
  "",
  {
    BUTTON_REPEAT_MS: { value: 70 },
    BEACON_INTERVAL_MS: { value: 65 },
    PAIRING_INTERVAL_MS: { value: 75 },
    LEVEL_REPORT_MS: { value: 60 },
    UNPAIR_INTERVAL_MS: { value: 60 },
    LED_CONFIG_INTERVAL_MS: { value: 75 },
  },
);

const sequenceGroup = constantGroup(
  "Sequence",
  "Sequence number behavior",
  "",
  {
    INCREMENT: { value: 6 },
    WRAP: { value: 0x48 },
  },
);

const lengthsGroup = constantGroup("Lengths", "Packet lengths", "", {
  STANDARD: { value: 24 },
  PAIRING: { value: 53 },
});

// ============================================================================
// PACKET FIELD TEMPLATES
// ============================================================================

const btnFields: FieldDef[] = [
  field("type", 0, 1, "hex"),
  field("sequence", 1, 1, "decimal"),
  field("device_id", 2, 4, "device_id_be"),
  field("protocol", 6, 1, "hex", "Always 0x21"),
  field("format", 7, 1, "hex", "0x04=tap, 0x0E=extended cmd"),
  field("pico_frame", 8, 1, "hex", "0x03 for pico"),
  field("button", 10, 1, "button"),
  field("action", 11, 1, "action", "0x00=no payload, 0x01=has payload"),
  field("device_repeat", 12, 4, "device_id_be", "Present when format=0x0E"),
  field("cmd_class", 17, 1, "hex", "0x40=scene, 0x42=dim (when format=0x0E)"),
  field(
    "cmd_param",
    19,
    1,
    "hex",
    "Preset ID or dim direction (when format=0x0E)",
  ),
  field("crc", 22, 2, "hex"),
];

const stateRptFields: FieldDef[] = [
  field("type", 0, 1, "hex"),
  field("sequence", 1, 1, "decimal"),
  field("device_id", 2, 4, "device_id"),
  field("protocol", 6, 1, "hex"),
  field("format", 7, 1, "hex", "0x08 = periodic state report"),
  field("level", 11, 1, "level_byte", "Light output level (0x00=off)"),
  field(
    "slider_level",
    15,
    1,
    "level_byte",
    "Slider/preset level (position even when off)",
  ),
  field("crc", 22, 2, "hex"),
];

const beaconFields: FieldDef[] = [
  field("type", 0, 1, "hex"),
  field("sequence", 1, 1, "decimal"),
  field("load_id", 2, 4, "device_id_be"),
  field("protocol", 6, 1, "hex"),
  field("format", 7, 1, "hex"),
  field("broadcast", 9, 5, "hex", "FF FF FF FF FF"),
  field("crc", 22, 2, "hex"),
];

const pairRespFields: FieldDef[] = [
  field("type", 0, 1, "hex"),
  field("sequence", 1, 1, "decimal"),
  field("device_id", 2, 4, "device_id_be"),
  field("protocol", 6, 1, "hex"),
  field("format", 7, 1, "hex"),
  field("data", 8, 14, "hex"),
  field("crc", 22, 2, "hex"),
];

// ============================================================================
// FORMAT DISCRIMINATION RULES
// ============================================================================

/** Format discrimination for short packet types (0x80-0x83) */
const stateFormatDisc: Record<number, string> = {
  0x09: "UNPAIR_PREP",
  0x0c: "UNPAIR",
  0x0e: "SET_LEVEL",
  0x12: "ZONE_BIND",
  0x13: "DIM_CONFIG",
  0x14: "FUNC_MAP",
  0x15: "TRIM_CONFIG",
  0x1a: "SCENE_CONFIG",
  0x1c: "FADE_CONFIG",
};

/** Format discrimination for long packet types (0xA1-0xA3) */
const longFormatDisc: Record<number, string> = {
  0x11: "LED_CONFIG",
  0x12: "ZONE_BIND",
  0x13: "DIM_CONFIG",
  0x14: "FUNC_MAP",
  0x15: "TRIM_CONFIG",
  0x1a: "SCENE_CONFIG",
  0x1c: "FADE_CONFIG",
  0x28: "ZONE_ASSIGN",
};

// ============================================================================
// PACKET TYPES
// ============================================================================

const BTN_SHORT_A = packetType(
  0x88,
  24,
  "BUTTON",
  "Button short format, group A",
  "big",
  btnFields,
  { ecosystems: ["CASETA", "RA3", "VIVE", "HOMEWORKS"] },
);

const BTN_LONG_A = packetTypeFrom(BTN_SHORT_A, {
  value: 0x89,
  description: "Button long format, group A",
});

const BTN_SHORT_B = packetTypeFrom(BTN_SHORT_A, {
  value: 0x8a,
  description: "Button short format, group B",
});

const BTN_LONG_B = packetTypeFrom(BTN_SHORT_A, {
  value: 0x8b,
  description: "Button long format, group B",
});

const STATE_RPT_81 = packetType(
  0x81,
  24,
  "STATE",
  "State report (type 81, cycles 81→82→83)",
  "little",
  stateRptFields,
  {
    ecosystems: ["CASETA", "RA3", "HOMEWORKS"],
    formatDiscrimination: stateFormatDisc,
  },
);

const STATE_RPT_82 = packetTypeFrom(STATE_RPT_81, {
  value: 0x82,
  description: "State report (type 82, cycles 81→82→83)",
});

const STATE_RPT_83 = packetTypeFrom(STATE_RPT_81, {
  value: 0x83,
  description: "State report (type 83, cycles 81→82→83)",
});

const STATE_80 = packetType(
  0x80,
  24,
  "STATE",
  "Dimmer state report (pairing phase)",
  "little",
  [
    field("type", 0, 1, "hex"),
    field("sequence", 1, 1, "decimal"),
    field("zone_id", 3, 2, "hex"),
    field("protocol", 5, 1, "hex"),
    field("crc", 22, 2, "hex"),
  ],
  {
    ecosystems: ["CASETA", "RA3"],
    formatDiscrimination: stateFormatDisc,
  },
);

const CONFIG_A1 = packetType(
  0xa1,
  24,
  "CONFIG",
  "Configuration packet (pairing)",
  "little",
  [
    field("type", 0, 1, "hex"),
    field("sequence", 1, 1, "decimal"),
    field("device_id", 2, 4, "device_id"),
    field("protocol", 6, 1, "hex"),
    field("format", 7, 1, "hex"),
    field("data", 8, 14, "hex"),
    field("crc", 22, 2, "hex"),
  ],
  {
    ecosystems: ["CASETA", "RA3"],
    formatDiscrimination: longFormatDisc,
  },
);

const SET_LEVEL = packetType(
  0xa2,
  24,
  "CONFIG",
  "Set level command",
  "little",
  [
    field("type", 0, 1, "hex"),
    field("sequence", 1, 1, "decimal"),
    field("source_id", 2, 4, "device_id"),
    field("protocol", 6, 1, "hex"),
    field("format", 7, 1, "hex"),
    field("target_id", 9, 4, "device_id_be"),
    field("level", 16, 2, "level_16bit"),
    field("crc", 22, 2, "hex"),
  ],
  {
    ecosystems: ["CASETA", "RA3", "VIVE", "HOMEWORKS"],
    cName: "PKT_LEVEL",
    formatDiscrimination: longFormatDisc,
  },
);

// A3 is not explicitly defined in YAML but follows the same long format discrimination
const CONFIG_A3 = packetTypeFrom(CONFIG_A1, {
  value: 0xa3,
  description: "Configuration packet (extended)",
  formatDiscrimination: longFormatDisc,
});

const BEACON_91 = packetType(
  0x91,
  24,
  "BEACON",
  "Pairing beacon",
  "big",
  beaconFields,
  { ecosystems: ["CASETA", "RA3"] },
);

const BEACON_92 = packetTypeFrom(BEACON_91, {
  value: 0x92,
  description: "Beacon stop",
  cName: "PKT_BEACON_STOP",
});

const BEACON_93 = packetTypeFrom(BEACON_91, {
  value: 0x93,
  description: "Initial pairing beacon",
});

const PAIR_B0 = packetType(
  0xb0,
  53,
  "PAIRING",
  "Dimmer discovery (announces hardware ID to bridge)",
  "big",
  [
    field("type", 0, 1, "hex"),
    field("sequence", 1, 1, "decimal"),
    field("flags", 2, 1, "hex"),
    field("zone_id", 3, 2, "hex", "Bridge zone ID"),
    field("pair_flag", 5, 1, "hex", "0x7F during pairing"),
    field("protocol", 6, 1, "hex"),
    field("format", 7, 1, "hex"),
    field("broadcast", 9, 5, "hex", "FF FF FF FF FF"),
    field("hardware_id", 16, 4, "device_id_be", "Dimmer hardware ID"),
    field("device_type", 20, 1, "hex", "0x04=dimmer"),
    field("crc", 51, 2, "hex"),
  ],
  { ecosystems: ["CASETA", "RA3"] },
);

const pairB8Fields: FieldDef[] = [
  field("type", 0, 1, "hex"),
  field("sequence", 1, 1, "decimal"),
  field("device_id", 2, 4, "device_id_be"),
  field("protocol", 6, 1, "hex"),
  field("format", 7, 1, "hex"),
  field("btn_scheme", 10, 1, "hex", "Button scheme byte"),
  field("broadcast", 13, 5, "hex", "FF FF FF FF FF"),
  field("device_id2", 20, 4, "device_id_be"),
  field("device_id3", 24, 4, "device_id_be"),
  field("device_class", 28, 1, "hex"),
  field("crc", 51, 2, "hex"),
];

const PAIR_B8 = packetType(
  0xb8,
  53,
  "PAIRING",
  "Device pairing request (Vive) / bridge-only pairing (pico)",
  "big",
  pairB8Fields,
  { ecosystems: ["CASETA", "RA3", "VIVE"] },
);

const PAIR_B9 = packetTypeFrom(PAIR_B8, {
  value: 0xb9,
  description: "Direct-pair capable / Vive beacon",
});

const PAIR_BA = packetTypeFrom(PAIR_B8, {
  value: 0xba,
  description: "Bridge-only pairing (pico) / Vive accept",
});

const PAIR_BB = packetTypeFrom(PAIR_B8, {
  value: 0xbb,
  description: "Direct-pair capable",
});

const PAIR_RESP_C0 = packetType(
  0xc0,
  24,
  "HANDSHAKE",
  "Pairing response",
  "big",
  pairRespFields,
);

// Handshake rounds — 6 rounds, dimmer=odd, bridge=even, increment by 6
const HS_C1 = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xc1,
  description: "Handshake round 1 (dimmer)",
});
const HS_C2 = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xc2,
  description: "Handshake round 1 (bridge)",
});
const HS_C7 = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xc7,
  description: "Handshake round 2 (dimmer)",
});
const HS_C8 = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xc8,
  description: "Handshake round 2 (bridge)",
});
const HS_CD = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xcd,
  description: "Handshake round 3 (dimmer)",
});
const HS_CE = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xce,
  description: "Handshake round 3 (bridge)",
});
const HS_D3 = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xd3,
  description: "Handshake round 4 (dimmer)",
});
const HS_D4 = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xd4,
  description: "Handshake round 4 (bridge)",
});
const HS_D9 = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xd9,
  description: "Handshake round 5 (dimmer)",
});
const HS_DA = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xda,
  description: "Handshake round 5 (bridge)",
});
const HS_DF = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xdf,
  description: "Handshake round 6 (dimmer)",
});
const HS_E0 = packetTypeFrom(PAIR_RESP_C0, {
  value: 0xe0,
  description: "Handshake round 6 (bridge)",
});

// Virtual types (assigned by decoder based on format byte)
const UNPAIR = packetType(
  0xf0,
  24,
  "CONFIG",
  "Unpair command (derived from STATE_RPT format 0x0C)",
  "little",
  [
    field("type", 0, 1, "hex"),
    field("sequence", 1, 1, "decimal"),
    field("source_id", 2, 4, "device_id"),
    field("protocol", 6, 1, "hex"),
    field("format", 7, 1, "hex", "0x0C for unpair"),
    field("broadcast", 9, 5, "hex", "FF FF FF FF FF"),
    field("target_id", 16, 4, "device_id_be"),
    field("crc", 22, 2, "hex"),
  ],
  { isVirtual: true },
);

const UNPAIR_PREP = packetTypeFrom(UNPAIR, {
  value: 0xf1,
  description: "Unpair preparation (derived from STATE_RPT format 0x09)",
  isVirtual: true,
});

const LED_CONFIG = packetType(
  0xf2,
  24,
  "CONFIG",
  "LED configuration (derived from STATE_RPT format 0x0A)",
  "little",
  [],
  { isVirtual: true },
);

// Virtual config types (format-discriminated, used by firmware for naming)
const ZONE_BIND = packetType(
  0xf3,
  24,
  "CONFIG",
  "Zone bind / final zone assignment (format 0x12, entity selector 0x6E)",
  "little",
  [],
  { isVirtual: true },
);

const DIM_CONFIG = packetType(
  0xf4,
  24,
  "CONFIG",
  "Dimming capability / fixed profile tuple (format 0x13)",
  "little",
  [],
  { isVirtual: true },
);

const FUNC_MAP = packetType(
  0xf5,
  24,
  "CONFIG",
  "Function mapping / conserved table descriptor (format 0x14)",
  "little",
  [],
  { isVirtual: true },
);

const TRIM_CONFIG = packetType(
  0xf6,
  24,
  "CONFIG",
  "Trim / phase config (format 0x15)",
  "little",
  [],
  { isVirtual: true },
);

const SCENE_CONFIG = packetType(
  0xf7,
  24,
  "CONFIG",
  "Scene config (format 0x1A)",
  "little",
  [],
  { isVirtual: true },
);

const FADE_CONFIG = packetType(
  0xf8,
  24,
  "CONFIG",
  "Fade config (format 0x1C)",
  "little",
  [],
  { isVirtual: true },
);

const ZONE_ASSIGN = packetType(
  0xf9,
  24,
  "CONFIG",
  "Zone assignment (format 0x28)",
  "little",
  [],
  { isVirtual: true },
);

// ============================================================================
// SEQUENCES
// ============================================================================

const sequences: Record<string, Sequence> = {
  button_press: {
    name: "button_press",
    description: "Standard 5-button Pico press",
    steps: [
      { packetType: "BTN_SHORT_A", count: 3, intervalMs: 70 },
      { packetType: "BTN_LONG_A", count: 1, intervalMs: 0 },
    ],
  },
  button_release: {
    name: "button_release",
    description: "Button release (sent after press)",
    steps: [
      { packetType: "BTN_SHORT_B", count: 3, intervalMs: 70 },
      { packetType: "BTN_LONG_B", count: 1, intervalMs: 0 },
    ],
  },
  button_hold: {
    name: "button_hold",
    description: "Dimming hold (raise/lower)",
    steps: [{ packetType: "BTN_SHORT_A", count: null, intervalMs: 65 }],
  },
  set_level: {
    name: "set_level",
    description: "Set dimmer level",
    steps: [{ packetType: "SET_LEVEL", count: 20, intervalMs: 60 }],
  },
  pairing_beacon: {
    name: "pairing_beacon",
    description: "Pairing beacon broadcast",
    steps: [{ packetType: "BEACON_91", count: null, intervalMs: 65 }],
  },
  pico_pairing: {
    name: "pico_pairing",
    description: "Pico pairing announcement",
    steps: [{ packetType: "PAIR_B9", count: 15, intervalMs: 75 }],
  },
  unpair: {
    name: "unpair",
    description: "Unpair device from bridge",
    steps: [{ packetType: "UNPAIR", count: 20, intervalMs: 60 }],
  },
};

// ============================================================================
// PAIRING PRESETS
// ============================================================================

const pairingPresets: Record<string, PairingPreset> = {
  "5btn": {
    description: "5-button Pico (ON/FAV/OFF/RAISE/LOWER)",
    packet: "PAIR_B9",
    btnScheme: 0x04,
    bytes: { 30: 0x03, 31: 0x00, 37: 0x02, 38: 0x06 },
  },
  "2btn": {
    description: "2-button Pico (ON/OFF)",
    packet: "PAIR_B9",
    btnScheme: 0x04,
    bytes: { 30: 0x03, 31: 0x08, 37: 0x01, 38: 0x01 },
  },
  "2btn-home": {
    description: "2-button Pico (HOME/AWAY)",
    packet: "PAIR_BB",
    btnScheme: 0x04,
    bytes: { 30: 0x03, 31: 0x00, 37: 0x02, 38: 0x23 },
  },
  "4btn-rl": {
    description: "4-button raise/lower Pico (ON/RAISE/LOWER/OFF)",
    packet: "PAIR_B9",
    btnScheme: 0x0b,
    bytes: { 30: 0x02, 31: 0x00, 37: 0x02, 38: 0x21 },
  },
  "4btn-cooking": {
    description: "4-button scene Pico (BRIGHT/COOKING/DINING/OFF)",
    packet: "PAIR_B9",
    btnScheme: 0x0b,
    bytes: { 30: 0x04, 31: 0x00, 37: 0x02, 38: 0x25 },
  },
  "4btn-movie": {
    description: "4-button scene Pico (BRIGHT/ENTERTAIN/MOVIE/OFF)",
    packet: "PAIR_B9",
    btnScheme: 0x0b,
    bytes: { 30: 0x04, 31: 0x00, 37: 0x02, 38: 0x26 },
  },
  "4btn-relax": {
    description:
      "4-button scene Pico (BRIGHT/ENTERTAIN/RELAX/OFF) - bridge-only",
    packet: "PAIR_B8",
    btnScheme: 0x0b,
    bytes: { 30: 0x04, 31: 0x00, 37: 0x02, 38: 0x27 },
  },
  "4btn-scene-custom": {
    description: "4-button scene Pico (custom engraved)",
    packet: "PAIR_B9",
    btnScheme: 0x0b,
    bytes: { 30: 0x04, 31: 0x00, 37: 0x02, 38: 0x28 },
  },
};

// ============================================================================
// PROTOCOL DEFINITION
// ============================================================================

export const CCA: CCAProtocolDef = {
  enums: {
    button: buttonEnum,
    action: actionEnum,
    category: categoryEnum,
    device_class: deviceClassEnum,
  },
  constantGroups: {
    qsFormat,
    qsAddr,
    qsClass,
    qsType,
    qsComp,
    qsProto,
    qsPico,
    qsLevelMax,
    qsLevelMax8,
    qsState,
    qsPreset,
    qsPadding,
    rf: rfGroup,
    crc: crcGroup,
    framing: framingGroup,
    timing: timingGroup,
    sequence: sequenceGroup,
    lengths: lengthsGroup,
  },
  packetTypes: {
    BTN_SHORT_A,
    BTN_LONG_A,
    BTN_SHORT_B,
    BTN_LONG_B,
    STATE_RPT_81,
    STATE_RPT_82,
    STATE_RPT_83,
    STATE_80,
    CONFIG_A1,
    SET_LEVEL,
    CONFIG_A3,
    BEACON_91,
    BEACON_92,
    BEACON_93,
    PAIR_B0,
    PAIR_B8,
    PAIR_B9,
    PAIR_BA,
    PAIR_BB,
    PAIR_RESP_C0,
    HS_C1,
    HS_C2,
    HS_C7,
    HS_C8,
    HS_CD,
    HS_CE,
    HS_D3,
    HS_D4,
    HS_D9,
    HS_DA,
    HS_DF,
    HS_E0,
    UNPAIR,
    UNPAIR_PREP,
    LED_CONFIG,
    ZONE_BIND,
    DIM_CONFIG,
    FUNC_MAP,
    TRIM_CONFIG,
    SCENE_CONFIG,
    FADE_CONFIG,
    ZONE_ASSIGN,
  },
  sequences,
  pairingPresets,
};

// ============================================================================
// DIRECT TS EXPORTS (same API as old generated protocol.ts)
// ============================================================================

/** Button code values */
export const Button = Object.fromEntries(
  Object.entries(buttonEnum.values).map(([k, v]) => [k, v.value]),
) as { readonly [K in keyof typeof buttonEnum.values]: number };

export type Button = (typeof Button)[keyof typeof Button];

/** Button name lookup by value */
export const ButtonNames: Record<number, string> = Object.fromEntries(
  Object.entries(buttonEnum.values).map(([k, v]) => [v.value, k]),
);

/** Action code values */
export const Action = Object.fromEntries(
  Object.entries(actionEnum.values).map(([k, v]) => [k, v.value]),
) as { readonly [K in keyof typeof actionEnum.values]: number };

export type Action = (typeof Action)[keyof typeof Action];

/** Action name lookup by value */
export const ActionNames: Record<number, string> = Object.fromEntries(
  Object.entries(actionEnum.values).map(([k, v]) => [v.value, k]),
);

/** Device class code values */
export const DeviceClass = Object.fromEntries(
  Object.entries(deviceClassEnum.values).map(([k, v]) => [k, v.value]),
) as { readonly [K in keyof typeof deviceClassEnum.values]: number };

export type DeviceClass = (typeof DeviceClass)[keyof typeof DeviceClass];

/** Device class name lookup by value */
export const DeviceClassNames: Record<number, string> = Object.fromEntries(
  Object.entries(deviceClassEnum.values).map(([k, v]) => [v.value, k]),
);

/** Packet type code values */
export const PacketType = Object.fromEntries(
  Object.entries(CCA.packetTypes).map(([k, v]) => [k, v.value]),
) as { readonly [K in keyof typeof CCA.packetTypes]: number };

export type PacketType = (typeof PacketType)[keyof typeof PacketType];

/** Packet type info lookup by type byte */
export interface PacketTypeInfoEntry {
  name: string;
  length: number;
  category: string;
  description: string;
  usesBigEndianDeviceId: boolean;
  isVirtual: boolean;
  ecosystems: string[];
}

export const PacketTypeInfo: Record<number, PacketTypeInfoEntry> =
  Object.fromEntries(
    Object.entries(CCA.packetTypes).map(([k, v]) => [
      v.value,
      {
        name: k,
        length: v.length,
        category: v.category,
        description: v.description,
        usesBigEndianDeviceId: v.deviceIdEndian === "big",
        isVirtual: v.isVirtual ?? false,
        ecosystems: v.ecosystems ?? [],
      },
    ]),
  );

/** Field definitions by packet type name */
export const PacketFields: Record<string, FieldDef[]> = Object.fromEntries(
  Object.entries(CCA.packetTypes)
    .filter(([_, v]) => v.fields.length > 0)
    .map(([k, v]) => [k, v.fields]),
);

/** RF constants */
export const RF = {
  FREQUENCY_HZ: 433602844,
  DEVIATION_HZ: 41200,
  BAUD_RATE: 62484.7,
  MODULATION: "2-FSK",
  ENCODING: "N81",
} as const;

/** CRC constants */
export const CRC = {
  POLYNOMIAL: 0xca0f,
  WIDTH: 16,
  INITIAL: 0,
  BYTE_ORDER: "big_endian",
} as const;

/** Framing constants */
export const FRAMING = {
  PREAMBLE_BITS: 32,
  PREAMBLE_PATTERN: 0xaaaaaaaa,
  SYNC_BYTE: 0xff,
  PREFIX: [0xfa, 0xde],
  TRAILING_BITS: 16,
} as const;

/** Timing constants (milliseconds) */
export const TIMING = {
  BUTTON_REPEAT_MS: 70,
  BEACON_INTERVAL_MS: 65,
  PAIRING_INTERVAL_MS: 75,
  LEVEL_REPORT_MS: 60,
  UNPAIR_INTERVAL_MS: 60,
  LED_CONFIG_INTERVAL_MS: 75,
} as const;

/** Sequence number behavior */
export const SEQUENCE = {
  INCREMENT: 6,
  WRAP: 0x48,
} as const;

/** Packet lengths */
export const LENGTHS = {
  STANDARD: 24,
  PAIRING: 53,
} as const;

/** Transmission sequences */
export const Sequences = CCA.sequences;

/** Sequence step / sequence types (re-exported from dsl) */
export type { FieldDef, FieldFormat, Sequence, SequenceStep } from "./dsl";

// ============================================================================
// HELPERS (same API as old generated protocol.ts)
// ============================================================================

/** Get expected packet length from type code */
export function getPacketLength(typeCode: number): number {
  return PacketTypeInfo[typeCode]?.length ?? 0;
}

/** Check if packet type is a button packet */
export function isButtonPacket(typeCode: number): boolean {
  return PacketTypeInfo[typeCode]?.category === "BUTTON";
}

/** Check if packet type belongs to a category */
export function isPacketCategory(typeCode: number, category: string): boolean {
  return PacketTypeInfo[typeCode]?.category === category;
}

/** Calculate next sequence number */
export function nextSequence(seq: number): number {
  return (seq + SEQUENCE.INCREMENT) % SEQUENCE.WRAP;
}
