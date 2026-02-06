/**
 * Auto-generated from protocol/cca.yaml
 * DO NOT EDIT - regenerate with: cca codegen
 *
 * Lutron Clear Connect Type A v1.0.0
 */

/** RF physical layer constants */
export const RF = {
  FREQUENCY_HZ: 433602844,
  DEVIATION_HZ: 41200,
  BAUD_RATE: 62484.7,
} as const;

/** CRC configuration */
export const CRC = {
  POLYNOMIAL: 0xCA0F,
  WIDTH: 16,
  INITIAL: 0x0000,
} as const;

/** Packet framing */
export const FRAMING = {
  PREAMBLE_BITS: 32,
  PREAMBLE_PATTERN: 0xAAAAAAAA,
  SYNC_BYTE: 0xFF,
  PREFIX: [0xFA, 0xDE],
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

/** Button action codes */
export const Action = {
  /** Continuous hold for dimming */
  HOLD: 0x02,
  PRESS: 0x00,
  RELEASE: 0x01,
  /** Save favorite/scene */
  SAVE: 0x03,
} as const;

export type Action = typeof Action[keyof typeof Action];

export const ActionNames: Record<Action, string> = {
  [0x02]: 'HOLD',
  [0x00]: 'PRESS',
  [0x01]: 'RELEASE',
  [0x03]: 'SAVE',
};

/** Button code values */
export const Button = {
  /** 5-button FAV / middle */
  FAVORITE: 0x03,
  /** 5-button LOWER */
  LOWER: 0x06,
  /** 5-button OFF / bottom */
  OFF: 0x04,
  /** 5-button ON / top */
  ON: 0x02,
  /** 5-button RAISE */
  RAISE: 0x05,
  /** Reset/unpair */
  RESET: 0xFF,
  /** 4-button top */
  SCENE1: 0x0B,
  /** 4-button second */
  SCENE2: 0x0A,
  /** 4-button third */
  SCENE3: 0x09,
  /** 4-button bottom */
  SCENE4: 0x08,
} as const;

export type Button = typeof Button[keyof typeof Button];

export const ButtonNames: Record<Button, string> = {
  [0x03]: 'FAVORITE',
  [0x06]: 'LOWER',
  [0x04]: 'OFF',
  [0x02]: 'ON',
  [0x05]: 'RAISE',
  [0xFF]: 'RESET',
  [0x0B]: 'SCENE1',
  [0x0A]: 'SCENE2',
  [0x09]: 'SCENE3',
  [0x08]: 'SCENE4',
};

/** Packet categories for filtering */
export const Category = {
} as const;

export type Category = typeof Category[keyof typeof Category];

export const CategoryNames: Record<Category, string> = {
};

/** Device class codes (byte 28 in pairing) */
export const DeviceClass = {
  DIMMER: 0x04,
  FAN: 0x06,
  KEYPAD: 0x0B,
  SHADE: 0x0A,
  SWITCH: 0x05,
} as const;

export type DeviceClass = typeof DeviceClass[keyof typeof DeviceClass];

export const DeviceClassNames: Record<DeviceClass, string> = {
  [0x04]: 'DIMMER',
  [0x06]: 'FAN',
  [0x0B]: 'KEYPAD',
  [0x0A]: 'SHADE',
  [0x05]: 'SWITCH',
};

/** Packet type codes */
export const PacketType = {
  /** Pairing beacon */
  BEACON_91: 0x91,
  /** Beacon stop */
  BEACON_92: 0x92,
  /** Initial pairing beacon */
  BEACON_93: 0x93,
  /** Button press, group A */
  BTN_PRESS_A: 0x88,
  /** Button press, group B */
  BTN_PRESS_B: 0x8A,
  /** Button release, group A */
  BTN_RELEASE_A: 0x89,
  /** Button release, group B */
  BTN_RELEASE_B: 0x8B,
  /** Configuration packet (pairing) */
  CONFIG_A1: 0xA1,
  /** Handshake round 1 (dimmer) */
  HS_C1: 0xC1,
  /** Handshake round 1 (bridge) */
  HS_C2: 0xC2,
  /** Handshake round 2 (dimmer) */
  HS_C7: 0xC7,
  /** Handshake round 2 (bridge) */
  HS_C8: 0xC8,
  /** Handshake round 3 (dimmer) */
  HS_CD: 0xCD,
  /** Handshake round 3 (bridge) */
  HS_CE: 0xCE,
  /** Handshake round 4 (dimmer) */
  HS_D3: 0xD3,
  /** Handshake round 4 (bridge) */
  HS_D4: 0xD4,
  /** Handshake round 5 (dimmer) */
  HS_D9: 0xD9,
  /** Handshake round 5 (bridge) */
  HS_DA: 0xDA,
  /** Handshake round 6 (dimmer) */
  HS_DF: 0xDF,
  /** Handshake round 6 (bridge) */
  HS_E0: 0xE0,
  /** LED configuration (derived from STATE_RPT format 0x0A) */
  LED_CONFIG: 0xF2,
  /** Dimmer discovery (announces hardware ID to bridge) */
  PAIR_B0: 0xB0,
  /** Scene Pico pairing (bridge-only) */
  PAIR_B8: 0xB8,
  /** Direct-pair Pico pairing */
  PAIR_B9: 0xB9,
  /** Scene Pico pairing variant */
  PAIR_BA: 0xBA,
  /** Direct-pair Pico pairing variant */
  PAIR_BB: 0xBB,
  /** Pairing response */
  PAIR_RESP_C0: 0xC0,
  /** Set level command */
  SET_LEVEL: 0xA2,
  /** Dimmer state report (pairing phase) */
  STATE_80: 0x80,
  /** State report (type 81) */
  STATE_RPT_81: 0x81,
  /** State report (type 82) */
  STATE_RPT_82: 0x82,
  /** State report (type 83) */
  STATE_RPT_83: 0x83,
  /** Unpair command (derived from STATE_RPT format 0x0C) */
  UNPAIR: 0xF0,
  /** Unpair preparation (derived from STATE_RPT format 0x09) */
  UNPAIR_PREP: 0xF1,
} as const;

export type PacketType = typeof PacketType[keyof typeof PacketType];

export interface PacketTypeInfo {
  name: string;
  length: number;
  category: string;
  description: string;
  usesBigEndianDeviceId: boolean;
  isVirtual: boolean;
}

export const PacketTypeInfo: Record<number, PacketTypeInfo> = {
  [0x91]: {
    name: 'BEACON_91',
    length: 24,
    category: 'BEACON',
    description: 'Pairing beacon',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0x92]: {
    name: 'BEACON_92',
    length: 24,
    category: 'BEACON',
    description: 'Beacon stop',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0x93]: {
    name: 'BEACON_93',
    length: 24,
    category: 'BEACON',
    description: 'Initial pairing beacon',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0x88]: {
    name: 'BTN_PRESS_A',
    length: 24,
    category: 'BUTTON',
    description: 'Button press, group A',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0x8A]: {
    name: 'BTN_PRESS_B',
    length: 24,
    category: 'BUTTON',
    description: 'Button press, group B',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0x89]: {
    name: 'BTN_RELEASE_A',
    length: 24,
    category: 'BUTTON',
    description: 'Button release, group A',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0x8B]: {
    name: 'BTN_RELEASE_B',
    length: 24,
    category: 'BUTTON',
    description: 'Button release, group B',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xA1]: {
    name: 'CONFIG_A1',
    length: 24,
    category: 'CONFIG',
    description: 'Configuration packet (pairing)',
    usesBigEndianDeviceId: false,
    isVirtual: false,
  },
  [0xC1]: {
    name: 'HS_C1',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 1 (dimmer)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xC2]: {
    name: 'HS_C2',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 1 (bridge)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xC7]: {
    name: 'HS_C7',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 2 (dimmer)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xC8]: {
    name: 'HS_C8',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 2 (bridge)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xCD]: {
    name: 'HS_CD',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 3 (dimmer)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xCE]: {
    name: 'HS_CE',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 3 (bridge)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xD3]: {
    name: 'HS_D3',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 4 (dimmer)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xD4]: {
    name: 'HS_D4',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 4 (bridge)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xD9]: {
    name: 'HS_D9',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 5 (dimmer)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xDA]: {
    name: 'HS_DA',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 5 (bridge)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xDF]: {
    name: 'HS_DF',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 6 (dimmer)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xE0]: {
    name: 'HS_E0',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Handshake round 6 (bridge)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xF2]: {
    name: 'LED_CONFIG',
    length: 24,
    category: 'CONFIG',
    description: 'LED configuration (derived from STATE_RPT format 0x0A)',
    usesBigEndianDeviceId: false,
    isVirtual: false,
  },
  [0xB0]: {
    name: 'PAIR_B0',
    length: 53,
    category: 'PAIRING',
    description: 'Dimmer discovery (announces hardware ID to bridge)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xB8]: {
    name: 'PAIR_B8',
    length: 53,
    category: 'PAIRING',
    description: 'Scene Pico pairing (bridge-only)',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xB9]: {
    name: 'PAIR_B9',
    length: 53,
    category: 'PAIRING',
    description: 'Direct-pair Pico pairing',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xBA]: {
    name: 'PAIR_BA',
    length: 53,
    category: 'PAIRING',
    description: 'Scene Pico pairing variant',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xBB]: {
    name: 'PAIR_BB',
    length: 53,
    category: 'PAIRING',
    description: 'Direct-pair Pico pairing variant',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xC0]: {
    name: 'PAIR_RESP_C0',
    length: 24,
    category: 'HANDSHAKE',
    description: 'Pairing response',
    usesBigEndianDeviceId: true,
    isVirtual: false,
  },
  [0xA2]: {
    name: 'SET_LEVEL',
    length: 24,
    category: 'CONFIG',
    description: 'Set level command',
    usesBigEndianDeviceId: false,
    isVirtual: false,
  },
  [0x80]: {
    name: 'STATE_80',
    length: 24,
    category: 'STATE',
    description: 'Dimmer state report (pairing phase)',
    usesBigEndianDeviceId: false,
    isVirtual: false,
  },
  [0x81]: {
    name: 'STATE_RPT_81',
    length: 24,
    category: 'STATE',
    description: 'State report (type 81)',
    usesBigEndianDeviceId: false,
    isVirtual: false,
  },
  [0x82]: {
    name: 'STATE_RPT_82',
    length: 24,
    category: 'STATE',
    description: 'State report (type 82)',
    usesBigEndianDeviceId: false,
    isVirtual: false,
  },
  [0x83]: {
    name: 'STATE_RPT_83',
    length: 24,
    category: 'STATE',
    description: 'State report (type 83)',
    usesBigEndianDeviceId: false,
    isVirtual: false,
  },
  [0xF0]: {
    name: 'UNPAIR',
    length: 24,
    category: 'CONFIG',
    description: 'Unpair command (derived from STATE_RPT format 0x0C)',
    usesBigEndianDeviceId: false,
    isVirtual: false,
  },
  [0xF1]: {
    name: 'UNPAIR_PREP',
    length: 24,
    category: 'CONFIG',
    description: 'Unpair preparation (derived from STATE_RPT format 0x09)',
    usesBigEndianDeviceId: false,
    isVirtual: false,
  },
};

/** Field format types */
export type FieldFormat = 'hex' | 'decimal' | 'device_id' | 'device_id_be' | 'level_byte' | 'level_16bit' | 'button' | 'action';

export interface FieldDef {
  name: string;
  offset: number;
  size: number;
  format: FieldFormat;
  description?: string;
}

/** Field definitions by packet type */
export const PacketFields: Record<string, FieldDef[]> = {
  'BEACON_91': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'load_id',
      offset: 2,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
    },
    {
      name: 'broadcast',
      offset: 9,
      size: 5,
      format: 'hex',
      description: 'FF FF FF FF FF',
    },
    {
      name: 'crc',
      offset: 22,
      size: 2,
      format: 'hex',
    },
  ],
  'BTN_PRESS_A': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'device_id',
      offset: 2,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
      description: 'Always 0x21',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
      description: '0x04 for press',
    },
    {
      name: 'button',
      offset: 10,
      size: 1,
      format: 'button',
    },
    {
      name: 'action',
      offset: 11,
      size: 1,
      format: 'action',
    },
    {
      name: 'crc',
      offset: 22,
      size: 2,
      format: 'hex',
    },
  ],
  'BTN_RELEASE_A': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'device_id',
      offset: 2,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
      description: '0x0E for release',
    },
    {
      name: 'button',
      offset: 10,
      size: 1,
      format: 'button',
    },
    {
      name: 'action',
      offset: 11,
      size: 1,
      format: 'action',
    },
    {
      name: 'device_repeat',
      offset: 12,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'crc',
      offset: 22,
      size: 2,
      format: 'hex',
    },
  ],
  'CONFIG_A1': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'device_id',
      offset: 2,
      size: 4,
      format: 'device_id',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
    },
    {
      name: 'data',
      offset: 8,
      size: 14,
      format: 'hex',
    },
    {
      name: 'crc',
      offset: 22,
      size: 2,
      format: 'hex',
    },
  ],
  'PAIR_B0': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'flags',
      offset: 2,
      size: 1,
      format: 'hex',
    },
    {
      name: 'zone_id',
      offset: 3,
      size: 2,
      format: 'hex',
      description: 'Bridge zone ID',
    },
    {
      name: 'pair_flag',
      offset: 5,
      size: 1,
      format: 'hex',
      description: '0x7F during pairing',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
    },
    {
      name: 'broadcast',
      offset: 9,
      size: 5,
      format: 'hex',
      description: 'FF FF FF FF FF',
    },
    {
      name: 'hardware_id',
      offset: 16,
      size: 4,
      format: 'device_id_be',
      description: 'Dimmer hardware ID',
    },
    {
      name: 'device_type',
      offset: 20,
      size: 1,
      format: 'hex',
      description: '0x04=dimmer',
    },
    {
      name: 'crc',
      offset: 51,
      size: 2,
      format: 'hex',
    },
  ],
  'PAIR_B8': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'device_id',
      offset: 2,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
    },
    {
      name: 'btn_scheme',
      offset: 10,
      size: 1,
      format: 'hex',
      description: 'Button scheme byte',
    },
    {
      name: 'broadcast',
      offset: 13,
      size: 5,
      format: 'hex',
      description: 'FF FF FF FF FF',
    },
    {
      name: 'device_id2',
      offset: 20,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'device_id3',
      offset: 24,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'device_class',
      offset: 28,
      size: 1,
      format: 'hex',
    },
    {
      name: 'crc',
      offset: 51,
      size: 2,
      format: 'hex',
    },
  ],
  'PAIR_RESP_C0': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'device_id',
      offset: 2,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
    },
    {
      name: 'data',
      offset: 8,
      size: 14,
      format: 'hex',
    },
    {
      name: 'crc',
      offset: 22,
      size: 2,
      format: 'hex',
    },
  ],
  'SET_LEVEL': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'source_id',
      offset: 2,
      size: 4,
      format: 'device_id',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
    },
    {
      name: 'target_id',
      offset: 9,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'level',
      offset: 16,
      size: 2,
      format: 'level_16bit',
    },
    {
      name: 'crc',
      offset: 22,
      size: 2,
      format: 'hex',
    },
  ],
  'STATE_80': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'zone_id',
      offset: 3,
      size: 2,
      format: 'hex',
    },
    {
      name: 'protocol',
      offset: 5,
      size: 1,
      format: 'hex',
    },
    {
      name: 'crc',
      offset: 22,
      size: 2,
      format: 'hex',
    },
  ],
  'STATE_RPT_81': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'device_id',
      offset: 2,
      size: 4,
      format: 'device_id',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
    },
    {
      name: 'level',
      offset: 11,
      size: 1,
      format: 'level_byte',
    },
    {
      name: 'crc',
      offset: 22,
      size: 2,
      format: 'hex',
    },
  ],
  'UNPAIR': [
    {
      name: 'type',
      offset: 0,
      size: 1,
      format: 'hex',
    },
    {
      name: 'sequence',
      offset: 1,
      size: 1,
      format: 'decimal',
    },
    {
      name: 'source_id',
      offset: 2,
      size: 4,
      format: 'device_id',
    },
    {
      name: 'protocol',
      offset: 6,
      size: 1,
      format: 'hex',
    },
    {
      name: 'format',
      offset: 7,
      size: 1,
      format: 'hex',
      description: '0x0C for unpair',
    },
    {
      name: 'broadcast',
      offset: 9,
      size: 5,
      format: 'hex',
      description: 'FF FF FF FF FF',
    },
    {
      name: 'target_id',
      offset: 16,
      size: 4,
      format: 'device_id_be',
    },
    {
      name: 'crc',
      offset: 22,
      size: 2,
      format: 'hex',
    },
  ],
};

/** Sequence step definition */
export interface SequenceStep {
  packetType: string;
  count: number | null;  // null = repeat until stopped
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
  'button_hold': {
    name: 'button_hold',
    description: 'Dimming hold (raise/lower)',
    steps: [
      { packetType: 'BTN_PRESS_A', count: null, intervalMs: 65 },
    ],
  },
  'button_press': {
    name: 'button_press',
    description: 'Standard 5-button Pico press',
    steps: [
      { packetType: 'BTN_PRESS_A', count: 3, intervalMs: 70 },
      { packetType: 'BTN_RELEASE_A', count: 1, intervalMs: 70 },
    ],
  },
  'button_release': {
    name: 'button_release',
    description: 'Button release (sent after press)',
    steps: [
      { packetType: 'BTN_PRESS_B', count: 3, intervalMs: 70 },
      { packetType: 'BTN_RELEASE_B', count: 1, intervalMs: 70 },
    ],
  },
  'pairing_beacon': {
    name: 'pairing_beacon',
    description: 'Pairing beacon broadcast',
    steps: [
      { packetType: 'BEACON_91', count: null, intervalMs: 65 },
    ],
  },
  'pico_pairing': {
    name: 'pico_pairing',
    description: 'Pico pairing announcement',
    steps: [
      { packetType: 'PAIR_B9', count: 15, intervalMs: 75 },
    ],
  },
  'set_level': {
    name: 'set_level',
    description: 'Set dimmer level',
    steps: [
      { packetType: 'SET_LEVEL', count: 20, intervalMs: 60 },
    ],
  },
  'unpair': {
    name: 'unpair',
    description: 'Unpair device from bridge',
    steps: [
      { packetType: 'UNPAIR', count: 20, intervalMs: 60 },
    ],
  },
};

/** Get packet type name from type code */
export function getPacketTypeName(typeCode: number): string {
  return PacketTypeInfo[typeCode]?.name ?? 'UNKNOWN';
}

/** Get expected packet length from type code */
export function getPacketLength(typeCode: number): number {
  return PacketTypeInfo[typeCode]?.length ?? 0;
}

/** Check if packet type is a button packet */
export function isButtonPacket(typeCode: number): boolean {
  return PacketTypeInfo[typeCode]?.category === 'button';
}

/** Check if packet type belongs to a category */
export function isPacketCategory(typeCode: number, category: string): boolean {
  return PacketTypeInfo[typeCode]?.category === category;
}

/** Calculate next sequence number */
export function nextSequence(seq: number): number {
  return (seq + SEQUENCE.INCREMENT) % SEQUENCE.WRAP;
}
