/**
 * Device ID structure (Lutron CCA):
 * [ZoneID][SubnetLo][SubnetHi][Endpoint]
 *
 * Example: 062C908C
 * - Zone ID: 0x06
 * - Subnet: 902C (displayed in Lutron Designer format, big-endian)
 * - Endpoint: 0x8C
 *
 * The subnet identifies which processor/bridge controls the device.
 * Devices on different subnets cannot communicate directly.
 */

export interface DeviceIdParts {
  zoneId: string      // Byte 0 - device/zone within subnet
  subnet: string      // Bytes 1-2 as big-endian (Lutron Designer format)
  subnetLE: string    // Bytes 1-2 as little-endian (packet format)
  endpoint: string    // Byte 3 - button/endpoint indicator
  raw: string         // Original device ID
}

/**
 * Parse a device ID into its component parts
 */
export function parseDeviceId(deviceId: string): DeviceIdParts | null {
  const id = deviceId.replace(/^0x/i, '').toUpperCase()
  if (id.length !== 8 || !/^[0-9A-F]+$/.test(id)) {
    return null
  }

  const zoneId = id.slice(0, 2)
  const subnetLE = id.slice(2, 6)  // As it appears in packet
  const subnet = subnetLE.slice(2, 4) + subnetLE.slice(0, 2)  // Swap to big-endian
  const endpoint = id.slice(6, 8)

  return {
    zoneId,
    subnet,
    subnetLE,
    endpoint,
    raw: id
  }
}

/**
 * Extract subnet from device ID in Lutron Designer format (big-endian)
 */
export function extractSubnet(deviceId: string): string | null {
  const parts = parseDeviceId(deviceId)
  return parts?.subnet ?? null
}

/**
 * Format device ID with subnet highlighted
 */
export function formatDeviceIdWithSubnet(deviceId: string): { zone: string; subnet: string; endpoint: string } | null {
  const parts = parseDeviceId(deviceId)
  if (!parts) return null

  return {
    zone: parts.zoneId,
    subnet: parts.subnet,
    endpoint: parts.endpoint
  }
}
