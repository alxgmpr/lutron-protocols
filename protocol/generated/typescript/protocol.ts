/**
 * Auto-generated from protocol/cca.yaml
 * DO NOT EDIT - regenerate with: npm run codegen
 *
 * Lutron Clear Connect Type A v1.1.0
 */

export const ECOSYSTEMS = {
  CASETA: {
    description: "Consumer-grade, bridge-based",
  },
  RA3: {
    description: "Pro-grade, RadioRA3 / Homeworks QSX",
  },
  VIVE: {
    description: "Commercial-grade, hub-based",
  },
  HOMEWORKS: {
    description: "Legacy/High-end Homeworks",
  },
} as const;

export const ID_SCHEMAS = {
  PICO: {
    pattern: "XX XX XX XX",
    endian: "big",
    ecosystems: ["CASETA", "RA3", "VIVE", "HOMEWORKS"],
    description: "Static hardware ID printed on device",
  },
  CASETA_LOAD: {
    pattern: "06 [Subnet] [Suffix]",
    endian: "little",
    ecosystems: ["CASETA"],
    description:
      "Assigned load ID. Suffix (byte 5) is typically 0x80 for primary load.",
  },
  RA3_SUBNET: {
    pattern: "00 [Subnet] [Suffix]",
    endian: "little",
    ecosystems: ["RA3", "HOMEWORKS"],
    description:
      "Logical area address. Suffix (byte 5) is typically 0xA1 for integration.",
  },
  VIVE_HUB: {
    pattern: "[Hub3] [Hub2] [Hub1] [Zone]",
    endian: "mixed",
    ecosystems: ["VIVE"],
    description: "Vive hub-centric addressing",
  },
} as const;

/** rf constants */
export const RF = {
  FREQUENCY_HZ: 433602844,
  DEVIATION_HZ: 41200,
  BAUD_RATE: 62484.7,
  MODULATION: "2-FSK",
  ENCODING: "N81",
} as const;

/** crc constants */
export const CRC = {
  POLYNOMIAL: 51727,
  WIDTH: 16,
  INITIAL: 0,
  BYTE_ORDER: "big_endian",
} as const;

/** framing constants */
export const FRAMING = {
  PREAMBLE_BITS: 32,
  PREAMBLE_PATTERN: 2863311530,
  SYNC_BYTE: 255,
  PREFIX: [250, 222],
  TRAILING_BITS: 16,
} as const;

/** timing constants */
export const TIMING = {
  BUTTON_REPEAT_MS: 70,
  BEACON_INTERVAL_MS: 65,
  PAIRING_INTERVAL_MS: 75,
  LEVEL_REPORT_MS: 60,
  UNPAIR_INTERVAL_MS: 60,
  LED_CONFIG_INTERVAL_MS: 75,
} as const;

/** sequence constants */
export const SEQUENCE = {
  INCREMENT: 6,
  WRAP: 72,
} as const;

/** lengths constants */
export const LENGTHS = {
  STANDARD: 24,
  PAIRING: 53,
} as const;

/** Button code values */
export const Button = {
  /** 5-button ON / top */
  ON: 2,
  /** 5-button FAV / middle */
  FAVORITE: 3,
  /** 5-button OFF / bottom */
  OFF: 4,
  /** 5-button RAISE */
  RAISE: 5,
  /** 5-button LOWER */
  LOWER: 6,
  /** 4-button top (scene: BRIGHT, rl: ON) */
  SCENE4: 8,
  /** 4-button second (scene: 2nd, rl: RAISE) */
  SCENE3: 9,
  /** 4-button third (scene: 3rd, rl: LOWER) */
  SCENE2: 10,
  /** 4-button bottom (scene: OFF, rl: OFF) */
  SCENE1: 11,
  /** Reset/unpair */
  RESET: 255,
} as const;

export type Button = (typeof Button)[keyof typeof Button];

export const ButtonNames: Record<number, string> = {
  [2]: "ON",
  [3]: "FAVORITE",
  [4]: "OFF",
  [5]: "RAISE",
  [6]: "LOWER",
  [8]: "SCENE4",
  [9]: "SCENE3",
  [10]: "SCENE2",
  [11]: "SCENE1",
  [255]: "RESET",
};

/** Button action codes */
export const Action = {
  PRESS: 0,
  RELEASE: 1,
  /** Continuous hold for dimming */
  HOLD: 2,
  /** Save favorite/scene */
  SAVE: 3,
} as const;

export type Action = (typeof Action)[keyof typeof Action];

export const ActionNames: Record<number, string> = {
  [0]: "PRESS",
  [1]: "RELEASE",
  [2]: "HOLD",
  [3]: "SAVE",
};

/** Packet categories for filtering */
export const Category = {
  /** Button press/release from Pico */
  BUTTON: "BUTTON",
  /** Dimmer/switch state reports */
  STATE: "STATE",
  /** Pairing beacons */
  BEACON: "BEACON",
  /** Pairing announcements */
  PAIRING: "PAIRING",
  /** Device configuration */
  CONFIG: "CONFIG",
  /** Pairing responses */
  HANDSHAKE: "HANDSHAKE",
} as const;

export type Category = (typeof Category)[keyof typeof Category];

/** Device class codes (byte 28 in pairing) */
export const DeviceClass = {
  DIMMER: 4,
  SWITCH: 5,
  FAN: 6,
  SHADE: 10,
  KEYPAD: 11,
} as const;

export type DeviceClass = (typeof DeviceClass)[keyof typeof DeviceClass];

export const DeviceClassNames: Record<number, string> = {
  [4]: "DIMMER",
  [5]: "SWITCH",
  [6]: "FAN",
  [10]: "SHADE",
  [11]: "KEYPAD",
};

/** Packet type codes */
export const PacketType = {
  /** Dimmer state report (pairing phase) */
  STATE_80: 128,
  /** State report (type 81) */
  STATE_RPT_81: 129,
  /** State report (type 82) */
  STATE_RPT_82: 130,
  /** State report (type 83) */
  STATE_RPT_83: 131,
  /** Button press, group A */
  BTN_PRESS_A: 136,
  /** Button release, group A */
  BTN_RELEASE_A: 137,
  /** Button press, group B */
  BTN_PRESS_B: 138,
  /** Button release, group B */
  BTN_RELEASE_B: 139,
  /** Pairing beacon */
  BEACON_91: 145,
  /** Beacon stop */
  BEACON_92: 146,
  /** Initial pairing beacon */
  BEACON_93: 147,
  /** Configuration packet (pairing) */
  CONFIG_A1: 161,
  /** Set level command */
  SET_LEVEL: 162,
  /** Dimmer discovery (announces hardware ID to bridge) */
  PAIR_B0: 176,
  /** Device pairing request (Vive) / bridge-only pairing (pico) */
  PAIR_B8: 184,
  /** Direct-pair capable / Vive beacon */
  PAIR_B9: 185,
  /** Bridge-only pairing (pico) / Vive accept */
  PAIR_BA: 186,
  /** Direct-pair capable */
  PAIR_BB: 187,
  /** Pairing response */
  PAIR_RESP_C0: 192,
  /** Handshake round 1 (dimmer) */
  HS_C1: 193,
  /** Handshake round 1 (bridge) */
  HS_C2: 194,
  /** Handshake round 2 (dimmer) */
  HS_C7: 199,
  /** Handshake round 2 (bridge) */
  HS_C8: 200,
  /** Handshake round 3 (dimmer) */
  HS_CD: 205,
  /** Handshake round 3 (bridge) */
  HS_CE: 206,
  /** Handshake round 4 (dimmer) */
  HS_D3: 211,
  /** Handshake round 4 (bridge) */
  HS_D4: 212,
  /** Handshake round 5 (dimmer) */
  HS_D9: 217,
  /** Handshake round 5 (bridge) */
  HS_DA: 218,
  /** Handshake round 6 (dimmer) */
  HS_DF: 223,
  /** Handshake round 6 (bridge) */
  HS_E0: 224,
  /** Unpair command (derived from STATE_RPT format 0x0C) */
  UNPAIR: 240,
  /** Unpair preparation (derived from STATE_RPT format 0x09) */
  UNPAIR_PREP: 241,
  /** LED configuration (derived from STATE_RPT format 0x0A) */
  LED_CONFIG: 242,
} as const;

export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export interface PacketTypeInfo {
  name: string;
  length: number;
  category: string;
  description: string;
  usesBigEndianDeviceId: boolean;
  isVirtual: boolean;
  ecosystems: string[];
}

export const PacketTypeInfo: Record<number, PacketTypeInfo> = {
  [128]: {
    name: "STATE_80",
    length: 24,
    category: "STATE",
    description: "Dimmer state report (pairing phase)",
    usesBigEndianDeviceId: false,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3"],
  },
  [129]: {
    name: "STATE_RPT_81",
    length: 24,
    category: "STATE",
    description: "State report (type 81)",
    usesBigEndianDeviceId: false,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "HOMEWORKS"],
  },
  [130]: {
    name: "STATE_RPT_82",
    length: 24,
    category: "STATE",
    description: "State report (type 82)",
    usesBigEndianDeviceId: false,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "HOMEWORKS"],
  },
  [131]: {
    name: "STATE_RPT_83",
    length: 24,
    category: "STATE",
    description: "State report (type 83)",
    usesBigEndianDeviceId: false,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "HOMEWORKS"],
  },
  [136]: {
    name: "BTN_PRESS_A",
    length: 24,
    category: "BUTTON",
    description: "Button press, group A",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "VIVE", "HOMEWORKS"],
  },
  [137]: {
    name: "BTN_RELEASE_A",
    length: 24,
    category: "BUTTON",
    description: "Button release, group A",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "VIVE", "HOMEWORKS"],
  },
  [138]: {
    name: "BTN_PRESS_B",
    length: 24,
    category: "BUTTON",
    description: "Button press, group B",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "VIVE", "HOMEWORKS"],
  },
  [139]: {
    name: "BTN_RELEASE_B",
    length: 24,
    category: "BUTTON",
    description: "Button release, group B",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "VIVE", "HOMEWORKS"],
  },
  [145]: {
    name: "BEACON_91",
    length: 24,
    category: "BEACON",
    description: "Pairing beacon",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3"],
  },
  [146]: {
    name: "BEACON_92",
    length: 24,
    category: "BEACON",
    description: "Beacon stop",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3"],
  },
  [147]: {
    name: "BEACON_93",
    length: 24,
    category: "BEACON",
    description: "Initial pairing beacon",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3"],
  },
  [161]: {
    name: "CONFIG_A1",
    length: 24,
    category: "CONFIG",
    description: "Configuration packet (pairing)",
    usesBigEndianDeviceId: false,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3"],
  },
  [162]: {
    name: "SET_LEVEL",
    length: 24,
    category: "CONFIG",
    description: "Set level command",
    usesBigEndianDeviceId: false,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "VIVE", "HOMEWORKS"],
  },
  [176]: {
    name: "PAIR_B0",
    length: 53,
    category: "PAIRING",
    description: "Dimmer discovery (announces hardware ID to bridge)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3"],
  },
  [184]: {
    name: "PAIR_B8",
    length: 53,
    category: "PAIRING",
    description: "Device pairing request (Vive) / bridge-only pairing (pico)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "VIVE"],
  },
  [185]: {
    name: "PAIR_B9",
    length: 53,
    category: "PAIRING",
    description: "Direct-pair capable / Vive beacon",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "VIVE"],
  },
  [186]: {
    name: "PAIR_BA",
    length: 53,
    category: "PAIRING",
    description: "Bridge-only pairing (pico) / Vive accept",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "VIVE"],
  },
  [187]: {
    name: "PAIR_BB",
    length: 53,
    category: "PAIRING",
    description: "Direct-pair capable",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: ["CASETA", "RA3", "VIVE"],
  },
  [192]: {
    name: "PAIR_RESP_C0",
    length: 24,
    category: "HANDSHAKE",
    description: "Pairing response",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [193]: {
    name: "HS_C1",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 1 (dimmer)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [194]: {
    name: "HS_C2",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 1 (bridge)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [199]: {
    name: "HS_C7",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 2 (dimmer)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [200]: {
    name: "HS_C8",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 2 (bridge)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [205]: {
    name: "HS_CD",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 3 (dimmer)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [206]: {
    name: "HS_CE",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 3 (bridge)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [211]: {
    name: "HS_D3",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 4 (dimmer)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [212]: {
    name: "HS_D4",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 4 (bridge)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [217]: {
    name: "HS_D9",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 5 (dimmer)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [218]: {
    name: "HS_DA",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 5 (bridge)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [223]: {
    name: "HS_DF",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 6 (dimmer)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [224]: {
    name: "HS_E0",
    length: 24,
    category: "HANDSHAKE",
    description: "Handshake round 6 (bridge)",
    usesBigEndianDeviceId: true,
    isVirtual: false,
    ecosystems: [],
  },
  [240]: {
    name: "UNPAIR",
    length: 24,
    category: "CONFIG",
    description: "Unpair command (derived from STATE_RPT format 0x0C)",
    usesBigEndianDeviceId: false,
    isVirtual: true,
    ecosystems: [],
  },
  [241]: {
    name: "UNPAIR_PREP",
    length: 24,
    category: "CONFIG",
    description: "Unpair preparation (derived from STATE_RPT format 0x09)",
    usesBigEndianDeviceId: false,
    isVirtual: true,
    ecosystems: [],
  },
  [242]: {
    name: "LED_CONFIG",
    length: 24,
    category: "CONFIG",
    description: "LED configuration (derived from STATE_RPT format 0x0A)",
    usesBigEndianDeviceId: false,
    isVirtual: true,
    ecosystems: [],
  },
};

/** Field format types */
export type FieldFormat =
  | "hex"
  | "decimal"
  | "device_id"
  | "device_id_be"
  | "level_byte"
  | "level_16bit"
  | "button"
  | "action";

export interface FieldDef {
  name: string;
  offset: number;
  size: number;
  format: FieldFormat;
  description?: string;
}

/** Field definitions by packet type */
export const PacketFields: Record<string, FieldDef[]> = {
  BTN_PRESS_A: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "device_id",
      offset: 2,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
      description: "Always 0x21",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
      description: "0x04=tap, 0x0E=extended cmd",
    },
    {
      name: "pico_frame",
      offset: 8,
      size: 1,
      format: "hex",
      description: "0x03 for pico",
    },
    {
      name: "button",
      offset: 10,
      size: 1,
      format: "button",
    },
    {
      name: "action",
      offset: 11,
      size: 1,
      format: "action",
      description: "0x00=no payload, 0x01=has payload",
    },
    {
      name: "device_repeat",
      offset: 12,
      size: 4,
      format: "device_id_be",
      description: "Present when format=0x0E",
    },
    {
      name: "cmd_class",
      offset: 17,
      size: 1,
      format: "hex",
      description: "0x40=scene, 0x42=dim (when format=0x0E)",
    },
    {
      name: "cmd_param",
      offset: 19,
      size: 1,
      format: "hex",
      description: "Preset ID or dim direction (when format=0x0E)",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  BTN_RELEASE_A: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "device_id",
      offset: 2,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
      description: "0x0E=extended cmd, 0x04=tap, 0x0C=dim stop",
    },
    {
      name: "pico_frame",
      offset: 8,
      size: 1,
      format: "hex",
      description: "0x03 for pico",
    },
    {
      name: "button",
      offset: 10,
      size: 1,
      format: "button",
    },
    {
      name: "action",
      offset: 11,
      size: 1,
      format: "action",
      description: "0x00=no payload, 0x01=has payload",
    },
    {
      name: "device_repeat",
      offset: 12,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "cmd_class",
      offset: 17,
      size: 1,
      format: "hex",
      description: "0x40=scene, 0x42=dim (when format=0x0E)",
    },
    {
      name: "cmd_param",
      offset: 19,
      size: 1,
      format: "hex",
      description: "Preset ID or dim direction (when format=0x0E)",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  BTN_PRESS_B: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "device_id",
      offset: 2,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
      description: "Always 0x21",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
      description: "0x04=tap, 0x0E=extended cmd",
    },
    {
      name: "pico_frame",
      offset: 8,
      size: 1,
      format: "hex",
      description: "0x03 for pico",
    },
    {
      name: "button",
      offset: 10,
      size: 1,
      format: "button",
    },
    {
      name: "action",
      offset: 11,
      size: 1,
      format: "action",
      description: "0x00=no payload, 0x01=has payload",
    },
    {
      name: "device_repeat",
      offset: 12,
      size: 4,
      format: "device_id_be",
      description: "Present when format=0x0E",
    },
    {
      name: "cmd_class",
      offset: 17,
      size: 1,
      format: "hex",
      description: "0x40=scene, 0x42=dim (when format=0x0E)",
    },
    {
      name: "cmd_param",
      offset: 19,
      size: 1,
      format: "hex",
      description: "Preset ID or dim direction (when format=0x0E)",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  BTN_RELEASE_B: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "device_id",
      offset: 2,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
      description: "0x0E=extended cmd, 0x04=tap, 0x0C=dim stop",
    },
    {
      name: "pico_frame",
      offset: 8,
      size: 1,
      format: "hex",
      description: "0x03 for pico",
    },
    {
      name: "button",
      offset: 10,
      size: 1,
      format: "button",
    },
    {
      name: "action",
      offset: 11,
      size: 1,
      format: "action",
      description: "0x00=no payload, 0x01=has payload",
    },
    {
      name: "device_repeat",
      offset: 12,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "cmd_class",
      offset: 17,
      size: 1,
      format: "hex",
      description: "0x40=scene, 0x42=dim (when format=0x0E)",
    },
    {
      name: "cmd_param",
      offset: 19,
      size: 1,
      format: "hex",
      description: "Preset ID or dim direction (when format=0x0E)",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  STATE_RPT_81: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "device_id",
      offset: 2,
      size: 4,
      format: "device_id",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
    },
    {
      name: "level",
      offset: 11,
      size: 1,
      format: "level_byte",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  STATE_80: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "zone_id",
      offset: 3,
      size: 2,
      format: "hex",
    },
    {
      name: "protocol",
      offset: 5,
      size: 1,
      format: "hex",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  CONFIG_A1: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "device_id",
      offset: 2,
      size: 4,
      format: "device_id",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
    },
    {
      name: "data",
      offset: 8,
      size: 14,
      format: "hex",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  SET_LEVEL: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "source_id",
      offset: 2,
      size: 4,
      format: "device_id",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
    },
    {
      name: "target_id",
      offset: 9,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "level",
      offset: 16,
      size: 2,
      format: "level_16bit",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  BEACON_91: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "load_id",
      offset: 2,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
    },
    {
      name: "broadcast",
      offset: 9,
      size: 5,
      format: "hex",
      description: "FF FF FF FF FF",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  PAIR_B0: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "flags",
      offset: 2,
      size: 1,
      format: "hex",
    },
    {
      name: "zone_id",
      offset: 3,
      size: 2,
      format: "hex",
      description: "Bridge zone ID",
    },
    {
      name: "pair_flag",
      offset: 5,
      size: 1,
      format: "hex",
      description: "0x7F during pairing",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
    },
    {
      name: "broadcast",
      offset: 9,
      size: 5,
      format: "hex",
      description: "FF FF FF FF FF",
    },
    {
      name: "hardware_id",
      offset: 16,
      size: 4,
      format: "device_id_be",
      description: "Dimmer hardware ID",
    },
    {
      name: "device_type",
      offset: 20,
      size: 1,
      format: "hex",
      description: "0x04=dimmer",
    },
    {
      name: "crc",
      offset: 51,
      size: 2,
      format: "hex",
    },
  ],
  PAIR_B8: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "device_id",
      offset: 2,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
    },
    {
      name: "btn_scheme",
      offset: 10,
      size: 1,
      format: "hex",
      description: "Button scheme byte",
    },
    {
      name: "broadcast",
      offset: 13,
      size: 5,
      format: "hex",
      description: "FF FF FF FF FF",
    },
    {
      name: "device_id2",
      offset: 20,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "device_id3",
      offset: 24,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "device_class",
      offset: 28,
      size: 1,
      format: "hex",
    },
    {
      name: "crc",
      offset: 51,
      size: 2,
      format: "hex",
    },
  ],
  PAIR_RESP_C0: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "device_id",
      offset: 2,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
    },
    {
      name: "data",
      offset: 8,
      size: 14,
      format: "hex",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
  UNPAIR: [
    {
      name: "type",
      offset: 0,
      size: 1,
      format: "hex",
    },
    {
      name: "sequence",
      offset: 1,
      size: 1,
      format: "decimal",
    },
    {
      name: "source_id",
      offset: 2,
      size: 4,
      format: "device_id",
    },
    {
      name: "protocol",
      offset: 6,
      size: 1,
      format: "hex",
    },
    {
      name: "format",
      offset: 7,
      size: 1,
      format: "hex",
      description: "0x0C for unpair",
    },
    {
      name: "broadcast",
      offset: 9,
      size: 5,
      format: "hex",
      description: "FF FF FF FF FF",
    },
    {
      name: "target_id",
      offset: 16,
      size: 4,
      format: "device_id_be",
    },
    {
      name: "crc",
      offset: 22,
      size: 2,
      format: "hex",
    },
  ],
};

/** Sequence step definition */
export interface SequenceStep {
  packetType: string;
  count: number | null; // null = repeat until stopped
  intervalMs: number;
}

/** Sequence definition */
export interface Sequence {
  name: string;
  description: string;
  steps: SequenceStep[];
}

/** Transmission sequences */
export const Sequences: Record<string, Sequence> = {
  button_press: {
    name: "button_press",
    description: "Standard 5-button Pico press",
    steps: [
      { packetType: "BTN_PRESS_A", count: 3, intervalMs: 70 },
      { packetType: "BTN_RELEASE_A", count: 1, intervalMs: 0 },
    ],
  },
  button_release: {
    name: "button_release",
    description: "Button release (sent after press)",
    steps: [
      { packetType: "BTN_PRESS_B", count: 3, intervalMs: 70 },
      { packetType: "BTN_RELEASE_B", count: 1, intervalMs: 0 },
    ],
  },
  button_hold: {
    name: "button_hold",
    description: "Dimming hold (raise/lower)",
    steps: [{ packetType: "BTN_PRESS_A", count: null, intervalMs: 65 }],
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

/** Get packet type name from type code */
export function getPacketTypeName(typeCode: number): string {
  return PacketTypeInfo[typeCode]?.name ?? "UNKNOWN";
}

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
