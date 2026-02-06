// Protocol reference data - sourced from protocol-ui (which sources from cca.yaml codegen)

import {
  PacketTypeInfo,
  getCategoryColor,
} from '../../../../protocol/protocol-ui'

export interface PacketTypeDisplayInfo {
  type: number
  name: string
  category: string
  description: string
}

// Build display info from the generated PacketTypeInfo registry
const PACKET_DISPLAY_INFO: Record<number, PacketTypeDisplayInfo> = {}
for (const [code, info] of Object.entries(PacketTypeInfo)) {
  const typeCode = Number(code)
  PACKET_DISPLAY_INFO[typeCode] = {
    type: typeCode,
    name: info.name,
    category: info.category,
    description: info.description,
  }
}

// Re-export for consumers
export { PACKET_DISPLAY_INFO as PACKET_TYPES }
export type { PacketTypeDisplayInfo as PacketTypeInfo }

export function getPacketTypeInfo(type: number): PacketTypeDisplayInfo | undefined {
  return PACKET_DISPLAY_INFO[type]
}

export { getCategoryColor }
