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

  /** Known Lutron zones (from LEAP device database) */
  knownZones: {
    273: { name: "Kitchen Undercab" },
    840: { name: "Living Room Mantle" },
    865: { name: "Living Room Fireplace" },
    961: { name: "Office Light" },
    1081: { name: "Guest Room Light" },
    1209: { name: "Office Lamps" },
    1237: { name: "Guest Room Lamps" },
    1466: { name: "Master Bedroom Closet" },
    1638: { name: "Exterior Pathway" },
    1688: { name: "Foyer Lights" },
    1723: { name: "Powder Room Vanity" },
    1740: { name: "Powder Room Fan" },
    1843: { name: "Living Room Lights" },
    1874: { name: "Exterior Patio" },
    1929: { name: "Dining Pendant" },
    1979: { name: "Kitchen Island" },
    2000: { name: "Kitchen Lights" },
    2385: { name: "Stairs Sconces" },
    2406: { name: "Hallway Lights" },
    2776: { name: "Foyer Lamp" },
    2793: { name: "Living Room Lamp" },
    2810: { name: "Dining Lamps" },
    2827: { name: "Kitchen Lamp" },
    2844: { name: "Master Bedroom Lamps" },
    2861: { name: "Hallway Lamps" },
    3049: { name: "Laundry Room Task" },
  } as Record<number, { name: string }>,

  /** Known device serials (from LEAP, for DEVICE_REPORT matching) */
  knownSerials: {
    100000003: { name: "Office Doorway Keypad", leapId: 926 },
    103891990: { name: "Foyer Doorway Keypad", leapId: 1604 },
    103975965: { name: "Kitchen Corner Keypad", leapId: 1945 },
    103957356: { name: "Stairs Base Keypad", leapId: 2306 },
    103941911: { name: "Hallway Doorway Keypad", leapId: 2422 },
    103976004: { name: "Dining Shelf Keypad", leapId: 1895 },
    103956080: { name: "Guest Room Keypad", leapId: 1046 },
    103922228: { name: "Hallway Stairwell Keypad", leapId: 2351 },
    100967173: { name: "Living Room Corner Keypad", leapId: 638 },
    100000001: { name: "Main Processor", leapId: 1 },
  } as Record<number, { name: string; leapId: number }>,
};

/** Look up a device name by IPv6 address */
export function getDeviceName(ipv6: string): string | undefined {
  return CCX_CONFIG.knownDevices[ipv6]?.name;
}

/** Look up a zone name by zone ID */
export function getZoneName(zoneId: number): string | undefined {
  return CCX_CONFIG.knownZones[zoneId]?.name;
}
