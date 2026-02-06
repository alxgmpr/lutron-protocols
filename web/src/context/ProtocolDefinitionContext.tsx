import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  PacketTypeInfo,
  PacketFields,
  ButtonNames,
  ActionNames,
  identifyPacket,
  parseFieldValue,
  getCategoryColor,
  type FieldDef,
  type FieldFormat,
  type IdentifiedPacket,
} from '../../../protocol/protocol-ui'

// Re-export types for convenience
export type { FieldDef, FieldFormat, IdentifiedPacket }

interface ProtocolDefinitionContextType {
  // Utilities
  identifyPacket: (data: Uint8Array | number[]) => IdentifiedPacket
  identifyPacketFromHex: (bytes: string[]) => IdentifiedPacket
  getFieldsForType: (typeName: string) => FieldDef[]
  parseFieldValue: typeof parseFieldValue
  getCategoryColor: (category: string) => string

  // Enums
  buttonNames: Record<number, string>
  actionNames: Record<number, string>
}

const ProtocolDefinitionContext = createContext<ProtocolDefinitionContextType | null>(null)

interface ProtocolDefinitionProviderProps {
  children: ReactNode
}

export function ProtocolDefinitionProvider({ children }: ProtocolDefinitionProviderProps) {
  const value = useMemo<ProtocolDefinitionContextType>(() => ({
    identifyPacket,
    identifyPacketFromHex: (bytes: string[]) => {
      const data = bytes.map(b => parseInt(b, 16))
      return identifyPacket(data)
    },
    getFieldsForType: (typeName: string) => {
      // Check direct match first
      if (PacketFields[typeName]) return PacketFields[typeName]
      // Check if any PacketTypeInfo has this name and try its fields
      const info = Object.values(PacketTypeInfo).find(i => i.name === typeName)
      if (info && PacketFields[info.name]) return PacketFields[info.name]
      return []
    },
    parseFieldValue,
    getCategoryColor,
    buttonNames: ButtonNames as Record<number, string>,
    actionNames: ActionNames as Record<number, string>,
  }), [])

  return (
    <ProtocolDefinitionContext.Provider value={value}>
      {children}
    </ProtocolDefinitionContext.Provider>
  )
}

export function useProtocolDefinition() {
  const context = useContext(ProtocolDefinitionContext)
  if (!context) {
    throw new Error('useProtocolDefinition must be used within a ProtocolDefinitionProvider')
  }
  return context
}

/**
 * Hook to get field definitions for a packet identified by hex bytes
 */
export function usePacketFields(bytes: string[]) {
  const { identifyPacketFromHex } = useProtocolDefinition()
  return useMemo(() => {
    const identified = identifyPacketFromHex(bytes)
    return identified.fields
  }, [bytes, identifyPacketFromHex])
}

/**
 * Hook to compute which field a byte belongs to
 */
export function useByteFieldMapping(bytes: string[], byteCount: number) {
  const fields = usePacketFields(bytes)

  return useMemo(() => {
    const mapping: Array<{ field: FieldDef; fieldIndex: number } | null> = []

    for (let i = 0; i < byteCount; i++) {
      let found: { field: FieldDef; fieldIndex: number } | null = null
      for (let fi = 0; fi < fields.length; fi++) {
        const field = fields[fi]
        if (i >= field.offset && i < field.offset + field.size) {
          found = { field, fieldIndex: fi }
          break
        }
      }
      mapping.push(found)
    }

    return mapping
  }, [fields, byteCount])
}
