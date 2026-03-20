/**
 * Protocol DSL — Builder types and functions for defining CCA/CCX protocol structures.
 *
 * These types are used by cca.protocol.ts and ccx.protocol.ts to define protocol
 * constants, enums, packet types, and message types in plain TypeScript objects
 * that can be imported directly by TS consumers and drive C codegen.
 */

// ============================================================================
// CCA Types
// ============================================================================

/** Field format types for CCA packet field definitions */
export type FieldFormat =
  | "hex"
  | "decimal"
  | "device_id"
  | "device_id_be"
  | "level_byte"
  | "level_16bit"
  | "lux_16bit"
  | "button"
  | "action";

/** A single field within a CCA packet */
export interface FieldDef {
  name: string;
  offset: number;
  size: number;
  format: FieldFormat;
  description?: string;
}

/** A named enum with numeric values and optional C prefix for codegen */
export interface EnumDef {
  name: string;
  description: string;
  cPrefix: string;
  values: Record<string, { value: number; description?: string }>;
}

/** A named constant group for codegen (e.g. QS_FMT_*, QS_ADDR_*) */
export interface ConstantGroup {
  name: string;
  description: string;
  cPrefix: string;
  cType?: string;
  values: Record<string, { value: number; description?: string }>;
}

/** CCA packet type definition */
export interface PacketTypeDef {
  value: number;
  length: number;
  category: string;
  description: string;
  deviceIdEndian: "big" | "little";
  isVirtual?: boolean;
  ecosystems?: string[];
  fields: FieldDef[];
  /** C constant name override (default: PKT_{name}) */
  cName?: string;
  /** Format byte → virtual type name for multi-purpose packet types */
  formatDiscrimination?: Record<number, string>;
}

/** Transmission sequence step */
export interface SequenceStep {
  packetType: string;
  count: number | null;
  intervalMs: number;
}

/** Transmission sequence definition */
export interface Sequence {
  name: string;
  description: string;
  steps: SequenceStep[];
}

/** Pairing preset definition */
export interface PairingPreset {
  description: string;
  packet: string;
  btnScheme: number;
  bytes: Record<number, number>;
}

/** Top-level CCA protocol definition */
export interface CCAProtocolDef {
  enums: Record<string, EnumDef>;
  constantGroups: Record<string, ConstantGroup>;
  packetTypes: Record<string, PacketTypeDef>;
  sequences: Record<string, Sequence>;
  pairingPresets: Record<string, PairingPreset>;
}

// ============================================================================
// CCX Types
// ============================================================================

/** A CBOR field definition */
export interface CborFieldDef {
  key: number;
  name: string;
  type: string;
  description?: string;
  optional?: boolean;
  unit?: string;
}

/** CCX message type definition */
export interface MessageTypeDef {
  id: number;
  description: string;
  category: string;
  bodyKeys: string[];
  commandSchema?: CborFieldDef[];
  extraSchema?: CborFieldDef[];
}

/** Top-level CCX protocol definition */
export interface CCXProtocolDef {
  messageTypes: Record<string, MessageTypeDef>;
  bodyKeys: Record<string, { key: number; description: string }>;
  constantGroups: Record<string, ConstantGroup>;
}

// ============================================================================
// Builder Functions
// ============================================================================

export function field(
  name: string,
  offset: number,
  size: number,
  format: FieldFormat,
  description?: string,
): FieldDef {
  const f: FieldDef = { name, offset, size, format };
  if (description) f.description = description;
  return f;
}

export function enumDef(
  name: string,
  description: string,
  cPrefix: string,
  values: Record<string, { value: number; description?: string }>,
): EnumDef {
  return { name, description, cPrefix, values };
}

export function constantGroup(
  name: string,
  description: string,
  cPrefix: string,
  values: Record<string, { value: number; description?: string }>,
  cType?: string,
): ConstantGroup {
  const g: ConstantGroup = { name, description, cPrefix, values };
  if (cType) g.cType = cType;
  return g;
}

export function packetType(
  value: number,
  length: number,
  category: string,
  description: string,
  deviceIdEndian: "big" | "little",
  fields: FieldDef[],
  opts?: {
    isVirtual?: boolean;
    ecosystems?: string[];
    cName?: string;
    formatDiscrimination?: Record<number, string>;
  },
): PacketTypeDef {
  return {
    value,
    length,
    category,
    description,
    deviceIdEndian,
    fields,
    ...opts,
  };
}

/** Create a packet type that inherits fields from another */
export function packetTypeFrom(
  base: PacketTypeDef,
  overrides: Partial<PacketTypeDef> & { value: number },
): PacketTypeDef {
  return { ...base, ...overrides, fields: overrides.fields ?? base.fields };
}

export function messageType(
  id: number,
  description: string,
  category: string,
  bodyKeys: string[],
  opts?: {
    commandSchema?: CborFieldDef[];
    extraSchema?: CborFieldDef[];
  },
): MessageTypeDef {
  return { id, description, category, bodyKeys, ...opts };
}
