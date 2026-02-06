/**
 * CCX Network Configuration
 *
 * Thread network parameters extracted from the Lutron project database.
 * Edit these values to match your installation.
 */

export const CCX_CONFIG = {
  /** 802.15.4 channel (2400 + channel * 5 MHz) */
  channel: 25,

  /** 802.15.4 PAN ID */
  panId: 0xXXXX,

  /** Thread Extended PAN ID */
  extPanId: "XX:XX:XX:XX:XX:XX:XX:XX",

  /** Thread Network Master Key (hex, no separators for tshark) */
  masterKey: "00000000000000000000000000000000",

  /** Lutron application UDP port */
  udpPort: 9190,

  /** Known Thread devices (IPv6 → metadata) */
  knownDevices: {
    "fd00::ff:fe00:2c0c": { name: "Processor", linkNodeId: 1 },
  } as Record<string, { name: string; linkNodeId: number }>,

  /** Known Lutron zones (from LEAP: bun run tools/leap-dump.ts --config) */
  knownZones: {
    273: { name: "Kitchen Undercab Lights" },
    840: { name: "Living Room Mantle" },
    865: { name: "Living Room Fireplace Blower" },
    961: { name: "Office Light" },
    1081: { name: "Guest Room Light" },
    1209: { name: "Office Lamps" },
    1237: { name: "Guest Room Lamps" },
    1466: { name: "Master Bedroom Closet Light" },
    1638: { name: "Exterior Pathway" },
    1688: { name: "Foyer Lights" },
    1723: { name: "Powder Room Vanity" },
    1740: { name: "Powder Room Exhaust Fan" },
    1843: { name: "Living Room Lights" },
    1874: { name: "Exterior Patio Light" },
    1929: { name: "Dining Room Pendant" },
    1979: { name: "Kitchen Island Pendants" },
    2000: { name: "Kitchen Lights" },
    2340: { name: "Stairs Unused" },
    2385: { name: "Stairs Sconces" },
    2406: { name: "Hallway Lights" },
    2456: { name: "Hallway Unused" },
    2776: { name: "Foyer Lamp" },
    2793: { name: "Living Room Lamp" },
    2810: { name: "Dining Room Lamps" },
    2827: { name: "Kitchen Lamp" },
    2844: { name: "Master Bedroom Lamps" },
    2861: { name: "Hallway Lamps" },
    3049: { name: "Laundry Room Task Light" },
  } as Record<number, { name: string }>,

  /** Known device serials (from LEAP: bun run tools/leap-dump.ts --config) */
  knownSerials: {
    30706980: { name: "Master Bedroom Bedside Pico", leapId: 555 },
    30732827: { name: "Laundry Room PlugInDimmer", leapId: 3043 },
    43433330: { name: "Kitchen Cabinet PlugInDimmer", leapId: 266 },
    49190135: { name: "Master Bedroom Bedside Pico", leapId: 569 },
    71146122: { name: "Kitchen Corner Dimmer", leapId: 1993 },
    71146518: { name: "Master Bedroom Closet Dimmer", leapId: 1459 },
    71148018: { name: "Dining Room Back Door Dimmer", leapId: 1867 },
    71268188: { name: "Foyer Doorway Dimmer", leapId: 1681 },
    71817881: { name: "Living Room Corner Dimmer", leapId: 1836 },
    72186070: { name: "Living Room Fireplace Dimmer", leapId: 833 },
    72396826: { name: "Hallway Stairwell Dimmer", leapId: 2399 },
    76586349: { name: "Living Room CCO", leapId: 858 },
    92885464: { name: "Living Room Coffee Table Pico", leapId: 990 },
    100967173: { name: "Living Room Corner Keypad", leapId: 638 },
    103891990: { name: "Foyer Doorway Keypad", leapId: 1604 },
    100000003: { name: "Office Doorway Keypad", leapId: 926 },
    103922228: { name: "Hallway Stairwell Keypad", leapId: 2351 },
    103941911: { name: "Hallway Doorway Keypad", leapId: 2422 },
    103956080: { name: "Guest Room Doorway Keypad", leapId: 1046 },
    103957356: { name: "Stairs Base Keypad", leapId: 2306 },
    103975965: { name: "Kitchen Corner Keypad", leapId: 1945 },
    103976004: { name: "Dining Room Shelf Keypad", leapId: 1895 },
    100000001: { name: "Main Processor", leapId: 232 },
    141110640: { name: "Office Desk Pico", leapId: 1152 },
    141800308: { name: "Kitchen Backsplash Pico", leapId: 365 },
    141890674: { name: "Hallway Table Pico", leapId: 2919 },
    141890691: { name: "Guest Room Desk Pico", leapId: 1176 },
  } as Record<number, { name: string; leapId: number }>,
  /** Preset ID → button mapping (from LEAP: bun run tools/leap-dump.ts --config)
   *  CCX device_id bytes 0-1 = preset ID as big-endian uint16
   *  CCX device_id bytes 2-3 = 0xEF20 (constant) */
  knownPresets: {
    371: { name: "On", role: "single", device: "Kitchen Backsplash" },
    380: { name: "Off", role: "single", device: "Kitchen Backsplash" },
    429: { name: "Raise", role: "single", device: "Kitchen Backsplash" },
    433: { name: "Lower", role: "single", device: "Kitchen Backsplash" },
    543: { name: "Good Night", role: "primary", device: "Master Bedroom Bedside" },
    585: { name: "Alert", role: "secondary", device: "Master Bedroom Bedside" },
    589: { name: "Good Night", role: "secondary", device: "Master Bedroom Bedside" },
    593: { name: "Alert", role: "secondary", device: "Master Bedroom Bedside" },
    597: { name: "Good Night", role: "secondary", device: "Master Bedroom Bedside" },
    649: { name: "Living", role: "primary", device: "Living Room Corner" },
    657: { name: "Media", role: "primary", device: "Living Room Corner" },
    914: { name: "Fireplace On", role: "single", device: "Living Room Phantom" },
    939: { name: "Office", role: "primary", device: "Office Doorway" },
    943: { name: "Lamps", role: "primary", device: "Office Doorway" },
    947: { name: "Relax", role: "primary", device: "Office Doorway" },
    984: { name: "Lower", role: "single", device: "Office Doorway" },
    987: { name: "Raise", role: "single", device: "Office Doorway" },
    996: { name: "On", role: "single", device: "Living Room Coffee Table" },
    999: { name: "Favorite", role: "single", device: "Living Room Coffee Table" },
    1002: { name: "Off", role: "single", device: "Living Room Coffee Table" },
    1005: { name: "Raise", role: "single", device: "Living Room Coffee Table" },
    1008: { name: "Lower", role: "single", device: "Living Room Coffee Table" },
    1060: { name: "Everyday", role: "primary", device: "Guest Room Doorway" },
    1061: { name: "Everyday", role: "secondary", device: "Guest Room Doorway" },
    1064: { name: "Bright", role: "primary", device: "Guest Room Doorway" },
    1065: { name: "Bright", role: "secondary", device: "Guest Room Doorway" },
    1068: { name: "Relax", role: "primary", device: "Guest Room Doorway" },
    1069: { name: "Relax", role: "secondary", device: "Guest Room Doorway" },
    1093: { name: "Office", role: "secondary", device: "Office Doorway" },
    1158: { name: "On", role: "single", device: "Office Desk" },
    1161: { name: "Raise", role: "single", device: "Office Desk" },
    1164: { name: "Lower", role: "single", device: "Office Desk" },
    1167: { name: "Off", role: "single", device: "Office Desk" },
    1182: { name: "On", role: "single", device: "Guest Room Desk" },
    1185: { name: "Raise", role: "single", device: "Guest Room Desk" },
    1188: { name: "Lower", role: "single", device: "Guest Room Desk" },
    1191: { name: "Off", role: "single", device: "Guest Room Desk" },
    1223: { name: "Lamps", role: "secondary", device: "Office Doorway" },
    1260: { name: "Fireplace Off", role: "single", device: "Living Room Phantom" },
    1338: { name: "Living", role: "secondary", device: "Living Room Corner" },
    1342: { name: "Relax", role: "secondary", device: "Living Room Corner" },
    1348: { name: "Media", role: "secondary", device: "Living Room Corner" },
    1617: { name: "Welcome", role: "single", device: "Foyer Doorway" },
    1622: { name: "Relax", role: "secondary", device: "Foyer Doorway" },
    1625: { name: "Exterior", role: "primary", device: "Foyer Doorway" },
    1626: { name: "Exterior", role: "secondary", device: "Foyer Doorway" },
    1862: { name: "Goodbye", role: "single", device: "Foyer Doorway" },
    1908: { name: "Pendant", role: "primary", device: "Dining Room Shelf" },
    1909: { name: "Pendant", role: "secondary", device: "Dining Room Shelf" },
    1913: { name: "Kitchen", role: "secondary", device: "Dining Room Shelf" },
    1916: { name: "Dining", role: "single", device: "Dining Room Shelf" },
    1958: { name: "Kitchen", role: "primary", device: "Kitchen Corner" },
    1959: { name: "Kitchen", role: "secondary", device: "Kitchen Corner" },
    1962: { name: "Island", role: "primary", device: "Kitchen Corner" },
    1963: { name: "Island", role: "secondary", device: "Kitchen Corner" },
    1966: { name: "Cooking", role: "single", device: "Kitchen Corner" },
    2011: { name: "Relax", role: "secondary", device: "Office Doorway" },
    2197: { name: "Alert", role: "primary", device: "Master Bedroom Bedside" },
    2320: { name: "Stairwell", role: "primary", device: "Stairs Base" },
    2321: { name: "Stairwell", role: "secondary", device: "Stairs Base" },
    2325: { name: "Upstairs Off", role: "secondary", device: "Stairs Base" },
    2329: { name: "Relax", role: "secondary", device: "Stairs Base" },
    2365: { name: "Stairwell", role: "primary", device: "Hallway Stairwell" },
    2366: { name: "Stairwell", role: "secondary", device: "Hallway Stairwell" },
    2370: { name: "Downstairs Off", role: "secondary", device: "Hallway Stairwell" },
    2374: { name: "Relax", role: "secondary", device: "Hallway Stairwell" },
    2378: { name: "Downstairs Off", role: "secondary", device: "Hallway Stairwell" },
    2435: { name: "Hallway", role: "primary", device: "Hallway Doorway" },
    2436: { name: "Hallway", role: "secondary", device: "Hallway Doorway" },
    2440: { name: "Relax", role: "secondary", device: "Hallway Doorway" },
    2444: { name: "Nightlight", role: "secondary", device: "Hallway Doorway" },
    2507: { name: "Relax", role: "primary", device: "Living Room Corner" },
    2508: { name: "Upstairs Off", role: "single", device: "Stairs Base" },
    2509: { name: "Downstairs Off", role: "primary", device: "Hallway Stairwell" },
    2510: { name: "Nightlight", role: "primary", device: "Hallway Doorway" },
    2925: { name: "On", role: "single", device: "Hallway Table" },
    2928: { name: "Raise", role: "single", device: "Hallway Table" },
    2931: { name: "Lower", role: "single", device: "Hallway Table" },
    2934: { name: "Off", role: "single", device: "Hallway Table" },
    2972: { name: "On", role: "single", device: "Dining Room Dresser" },
    2975: { name: "Favorite", role: "single", device: "Dining Room Dresser" },
    2978: { name: "Off", role: "single", device: "Dining Room Dresser" },
    2981: { name: "Raise", role: "single", device: "Dining Room Dresser" },
    2984: { name: "Lower", role: "single", device: "Dining Room Dresser" },
    3013: { name: "All Off", role: "primary", device: "Stairs Base" },
  } as Record<number, { name: string; role: string; device: string }>,
};

/** Look up a device name by IPv6 address */
export function getDeviceName(ipv6: string): string | undefined {
  return CCX_CONFIG.knownDevices[ipv6]?.name;
}

/** Look up a zone name by zone ID */
export function getZoneName(zoneId: number): string | undefined {
  return CCX_CONFIG.knownZones[zoneId]?.name;
}

/** Look up a preset by ID (extracted from CCX BUTTON_PRESS device_id bytes 0-1) */
export function getPresetInfo(presetId: number): { name: string; role: string; device: string } | undefined {
  return CCX_CONFIG.knownPresets[presetId];
}

/** Extract preset ID from CCX device_id (4-byte Uint8Array: [presetHi, presetLo, 0xEF, 0x20]) */
export function presetIdFromDeviceId(deviceId: Uint8Array): number {
  return (deviceId[0] << 8) | deviceId[1];
}
