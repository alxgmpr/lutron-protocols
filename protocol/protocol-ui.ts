/**
 * Unified Protocol Module for Frontend & Backend
 *
 * Thin wrapper over protocol definitions. Provides:
 * - Multi-signal packet identification (type byte + format byte + length)
 * - Field value parsing utilities
 * - Broadcast address recognition
 *
 * Import this module instead of the protocol definition file directly.
 */

// Re-export everything consumers need from cca.protocol
export type {
  FieldDef,
  FieldFormat,
  Sequence,
  SequenceStep,
} from "./cca.protocol";
export {
  Action,
  ActionNames,
  Button,
  ButtonNames,
  CRC,
  DeviceClass,
  DeviceClassNames,
  FRAMING,
  getPacketLength,
  isButtonPacket,
  isPacketCategory,
  LENGTHS,
  nextSequence,
  PacketFields,
  PacketType,
  PacketTypeInfo,
  RF,
  SEQUENCE,
  Sequences,
  TIMING,
} from "./cca.protocol";

import {
  ActionNames,
  ButtonNames,
  CCA,
  type FieldDef,
  type FieldFormat,
  PacketFields,
  PacketTypeInfo,
} from "./cca.protocol";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Broadcast address pattern (5 bytes of 0xFF) */
export const BROADCAST_PATTERN = [0xff, 0xff, 0xff, 0xff, 0xff] as const;

// ============================================================================
// FORMAT DISCRIMINATION — built from packet type definitions
// ============================================================================

/**
 * Build virtual type lookup: { typeByte: { formatByte: virtualTypeName } }
 * Reads formatDiscrimination from each packet type definition.
 */
const VIRTUAL_TYPE_MAP: Record<number, Record<number, string>> = {};
for (const [, pkt] of Object.entries(CCA.packetTypes)) {
  if (pkt.formatDiscrimination) {
    VIRTUAL_TYPE_MAP[pkt.value] = pkt.formatDiscrimination;
  }
}

// ============================================================================
// PACKET IDENTIFICATION
// ============================================================================

export interface IdentifiedPacket {
  /** Resolved type name (e.g., 'UNPAIR' instead of 'STATE_RPT_81') */
  typeName: string;
  /** Category for filtering/display */
  category: string;
  /** Human-readable description */
  description: string;
  /** Whether the device ID uses big-endian format */
  usesBigEndianDeviceId: boolean;
  /** Field definitions for this packet type */
  fields: FieldDef[];
  /** Whether this is a virtual type (reclassified by format byte) */
  isVirtual: boolean;
}

/**
 * Multi-signal packet identification.
 *
 * Uses type byte as primary signal, then checks format byte for
 * virtual type discrimination (UNPAIR, UNPAIR_PREP, LED_CONFIG, etc.).
 */
export function identifyPacket(data: Uint8Array | number[]): IdentifiedPacket {
  if (data.length < 1) {
    return {
      typeName: "UNKNOWN",
      category: "unknown",
      description: "Empty packet",
      usesBigEndianDeviceId: true,
      fields: [],
      isVirtual: false,
    };
  }

  const typeByte = data[0];
  const formatByte = data.length > 7 ? data[7] : undefined;

  // Check for virtual type reclassification
  const virtualRules = VIRTUAL_TYPE_MAP[typeByte];
  if (virtualRules && formatByte !== undefined) {
    const virtualName = virtualRules[formatByte];
    if (virtualName) {
      // Look up the virtual type's info from protocol definitions
      const virtualInfo = Object.values(PacketTypeInfo).find(
        (i) => i.name === virtualName,
      );
      const virtualFields = PacketFields[virtualName];
      if (virtualInfo) {
        return {
          typeName: virtualName,
          category: virtualInfo.category,
          description: virtualInfo.description,
          usesBigEndianDeviceId: virtualInfo.usesBigEndianDeviceId,
          fields: virtualFields ?? [],
          isVirtual: true,
        };
      }
    }
  }

  // Standard type byte lookup
  const info = PacketTypeInfo[typeByte];
  if (info) {
    const fields = PacketFields[info.name] ?? [];
    return {
      typeName: info.name,
      category: info.category,
      description: info.description,
      usesBigEndianDeviceId: info.usesBigEndianDeviceId,
      fields,
      isVirtual: false,
    };
  }

  // Truly unknown packet
  return {
    typeName: `0x${typeByte.toString(16).toUpperCase().padStart(2, "0")}`,
    category: "unknown",
    description: `Unknown packet type 0x${typeByte.toString(16).toUpperCase().padStart(2, "0")}`,
    usesBigEndianDeviceId: true,
    fields: [],
    isVirtual: false,
  };
}

// ============================================================================
// FIELD VALUE PARSING
// ============================================================================

/**
 * Parse a device ID from hex byte strings.
 */
export function parseDeviceId(
  bytes: string[],
  offset: number,
  endian: "little" | "big",
): string {
  if (bytes.length < offset + 4) return "";
  const b = bytes.slice(offset, offset + 4);
  if (endian === "little") {
    return `${b[3]}${b[2]}${b[1]}${b[0]}`.toUpperCase();
  }
  return `${b[0]}${b[1]}${b[2]}${b[3]}`.toUpperCase();
}

/**
 * Parse a level byte (0x00-0xFE = 0-100%).
 */
export function parseLevelByte(byte: string): string {
  const value = parseInt(byte, 16);
  if (value === 0) return "0%";
  return `${Math.round((value * 100) / 254)}%`;
}

/**
 * Parse a 16-bit level (0x0000-0xFEFF = 0-100%).
 */
export function parseLevel16bit(bytes: string[]): string {
  if (bytes.length < 2) return "";
  const value = parseInt(bytes[0] + bytes[1], 16);
  if (value === 0) return "0%";
  return `${Math.round((value * 100) / 65279)}%`;
}

/**
 * Get button name from code.
 */
export function getButtonName(code: number): string {
  return (
    (ButtonNames as Record<number, string>)[code] ??
    `0x${code.toString(16).toUpperCase().padStart(2, "0")}`
  );
}

/**
 * Get action name from code.
 */
export function getActionName(code: number): string {
  return (
    (ActionNames as Record<number, string>)[code] ??
    `0x${code.toString(16).toUpperCase().padStart(2, "0")}`
  );
}

/**
 * Check if bytes at a given offset match the broadcast pattern (FF FF FF FF FF).
 */
export function isBroadcast(bytes: string[], offset: number): boolean {
  if (bytes.length < offset + 5) return false;
  return bytes.slice(offset, offset + 5).every((b) => b.toUpperCase() === "FF");
}

/**
 * Parse a field value based on its format.
 * Returns raw hex and optional decoded human-readable value.
 */
export function parseFieldValue(
  bytes: string[],
  offset: number,
  size: number,
  format: FieldFormat,
): { raw: string; decoded: string | null } {
  const fieldBytes = bytes.slice(offset, offset + size);
  const raw = fieldBytes.join(" ");

  if (fieldBytes.length === 0) {
    return { raw: "-", decoded: null };
  }

  let decoded: string | null = null;

  switch (format) {
    case "device_id":
      if (fieldBytes.length >= 4) {
        decoded = parseDeviceId(bytes, offset, "little");
      }
      break;
    case "device_id_be":
      if (fieldBytes.length >= 4) {
        decoded = parseDeviceId(bytes, offset, "big");
      }
      break;
    case "level_byte":
      if (fieldBytes.length >= 1) {
        decoded = parseLevelByte(fieldBytes[0]);
      }
      break;
    case "level_16bit":
      if (fieldBytes.length >= 2) {
        decoded = parseLevel16bit(fieldBytes);
      }
      break;
    case "button":
      if (fieldBytes.length >= 1) {
        decoded = getButtonName(parseInt(fieldBytes[0], 16));
      }
      break;
    case "action":
      if (fieldBytes.length >= 1) {
        decoded = getActionName(parseInt(fieldBytes[0], 16));
      }
      break;
    case "decimal":
      if (fieldBytes.length >= 1) {
        decoded = String(parseInt(fieldBytes[0], 16));
      }
      break;
    case "hex":
      // Check for broadcast pattern
      if (
        fieldBytes.length === 5 &&
        fieldBytes.every((b) => b.toUpperCase() === "FF")
      ) {
        decoded = "BROADCAST";
      }
      break;
  }

  return { raw, decoded };
}

// ============================================================================
// CATEGORY HELPERS
// ============================================================================

/** Get category color for display */
export function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    BUTTON: "#4CAF50",
    STATE: "#2196F3",
    BEACON: "#FF9800",
    PAIRING: "#9C27B0",
    CONFIG: "#00BCD4",
    HANDSHAKE: "#E91E63",
    // Lowercase variants for backwards compatibility
    button: "#4CAF50",
    state: "#2196F3",
    beacon: "#FF9800",
    pairing: "#9C27B0",
    config: "#00BCD4",
    handshake: "#E91E63",
    unknown: "#9E9E9E",
  };
  return colors[category] ?? "#9E9E9E";
}
