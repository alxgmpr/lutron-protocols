import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from 'react'
import {
  PACKET_TYPES,
  FIELD_FORMATS,
  PACKET_TYPE_MAP,
  BUTTON_NAMES,
  ACTION_NAMES,
  getPacketTypeDef,
  parseFieldValue,
  type PacketTypeDef,
  type FieldDef,
  type FieldFormatType
} from '../generated/protocol'

// Re-export types for convenience
export type { PacketTypeDef, FieldDef, FieldFormatType }

interface ProtocolDefinitionContextType {
  // Protocol data
  packetTypes: Record<string, PacketTypeDef>
  fieldFormats: Record<string, typeof FIELD_FORMATS[keyof typeof FIELD_FORMATS]>
  packetTypeMap: Record<number, string>
  buttonNames: Record<number, string>
  actionNames: Record<number, string>

  // Utilities
  getPacketType: (typeByte: number) => string
  getPacketTypeDef: (packetType: string) => PacketTypeDef
  getFieldColor: (format: FieldFormatType) => string
  parseFieldValue: typeof parseFieldValue

  // Loading state
  loaded: boolean
  error: string | null
}

const ProtocolDefinitionContext = createContext<ProtocolDefinitionContextType | null>(null)

interface ProtocolDefinitionProviderProps {
  children: ReactNode
}

export function ProtocolDefinitionProvider({ children }: ProtocolDefinitionProviderProps) {
  const [loaded, setLoaded] = useState(true)  // Using bundled definitions
  const [error] = useState<string | null>(null)

  // Try to fetch from API for any updates (optional enhancement)
  useEffect(() => {
    // The bundled definitions are the source of truth for now
    // In the future, this could fetch from /api/protocol for live updates
    setLoaded(true)
  }, [])

  const value = useMemo<ProtocolDefinitionContextType>(() => ({
    packetTypes: PACKET_TYPES,
    fieldFormats: FIELD_FORMATS,
    packetTypeMap: PACKET_TYPE_MAP,
    buttonNames: BUTTON_NAMES,
    actionNames: ACTION_NAMES,

    getPacketType: (typeByte: number) => PACKET_TYPE_MAP[typeByte] ?? 'UNKNOWN',
    getPacketTypeDef,
    getFieldColor: (format: FieldFormatType) => FIELD_FORMATS[format]?.color ?? '#9E9E9E',
    parseFieldValue,

    loaded,
    error,
  }), [loaded, error])

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
 * Hook to get field definitions for a specific packet type
 */
export function usePacketFields(packetType: string) {
  const { getPacketTypeDef } = useProtocolDefinition()
  return useMemo(() => getPacketTypeDef(packetType).fields, [packetType, getPacketTypeDef])
}

/**
 * Hook to compute which field a byte belongs to
 */
export function useByteFieldMapping(packetType: string, byteCount: number) {
  const fields = usePacketFields(packetType)

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
