//! TypeScript code generator

use super::Protocol;

pub fn generate_typescript(protocol: &Protocol) -> String {
    let mut out = String::new();

    // Header
    out.push_str("/**\n");
    out.push_str(" * Auto-generated from protocol/cca.yaml\n");
    out.push_str(" * DO NOT EDIT - regenerate with: cca codegen\n");
    out.push_str(" *\n");
    out.push_str(&format!(" * {} v{}\n", protocol.meta.name, protocol.meta.version));
    out.push_str(" */\n\n");

    // RF Constants
    out.push_str("/** RF physical layer constants */\n");
    out.push_str("export const RF = {\n");
    out.push_str(&format!("  FREQUENCY_HZ: {},\n", protocol.rf.frequency_hz));
    out.push_str(&format!("  DEVIATION_HZ: {},\n", protocol.rf.deviation_hz));
    out.push_str(&format!("  BAUD_RATE: {},\n", protocol.rf.baud_rate));
    out.push_str("} as const;\n\n");

    // CRC Constants
    out.push_str("/** CRC configuration */\n");
    out.push_str("export const CRC = {\n");
    out.push_str(&format!("  POLYNOMIAL: 0x{:04X},\n", protocol.crc.polynomial));
    out.push_str(&format!("  WIDTH: {},\n", protocol.crc.width));
    out.push_str(&format!("  INITIAL: 0x{:04X},\n", protocol.crc.initial));
    out.push_str("} as const;\n\n");

    // Framing Constants
    out.push_str("/** Packet framing */\n");
    out.push_str("export const FRAMING = {\n");
    out.push_str(&format!("  PREAMBLE_BITS: {},\n", protocol.framing.preamble_bits));
    out.push_str(&format!("  PREAMBLE_PATTERN: 0x{:08X},\n", protocol.framing.preamble_pattern));
    out.push_str(&format!("  SYNC_BYTE: 0x{:02X},\n", protocol.framing.sync_byte));
    out.push_str("  PREFIX: [");
    for (i, b) in protocol.framing.prefix.iter().enumerate() {
        if i > 0 { out.push_str(", "); }
        out.push_str(&format!("0x{:02X}", b));
    }
    out.push_str("],\n");
    out.push_str(&format!("  TRAILING_BITS: {},\n", protocol.framing.trailing_bits));
    out.push_str("} as const;\n\n");

    // Timing Constants
    out.push_str("/** Timing constants (milliseconds) */\n");
    out.push_str("export const TIMING = {\n");
    out.push_str(&format!("  BUTTON_REPEAT_MS: {},\n", protocol.timing.button_repeat_ms));
    out.push_str(&format!("  BEACON_INTERVAL_MS: {},\n", protocol.timing.beacon_interval_ms));
    out.push_str(&format!("  PAIRING_INTERVAL_MS: {},\n", protocol.timing.pairing_interval_ms));
    out.push_str(&format!("  LEVEL_REPORT_MS: {},\n", protocol.timing.level_report_ms));
    out.push_str(&format!("  UNPAIR_INTERVAL_MS: {},\n", protocol.timing.unpair_interval_ms));
    out.push_str(&format!("  LED_CONFIG_INTERVAL_MS: {},\n", protocol.timing.led_config_interval_ms));
    out.push_str("} as const;\n\n");

    // Sequence Constants
    out.push_str("/** Sequence number behavior */\n");
    out.push_str("export const SEQUENCE = {\n");
    out.push_str(&format!("  INCREMENT: {},\n", protocol.sequence.increment));
    out.push_str(&format!("  WRAP: 0x{:02X},\n", protocol.sequence.wrap));
    out.push_str("} as const;\n\n");

    // Packet Lengths
    out.push_str("/** Packet lengths */\n");
    out.push_str("export const LENGTHS = {\n");
    out.push_str(&format!("  STANDARD: {},\n", protocol.lengths.standard));
    out.push_str(&format!("  PAIRING: {},\n", protocol.lengths.pairing));
    out.push_str("} as const;\n\n");

    // Generate enums
    for (enum_name, enum_def) in &protocol.enums {
        generate_enum(&mut out, enum_name, enum_def);
    }

    // Generate packet types
    generate_packet_types(&mut out, protocol);

    // Generate field definitions
    generate_field_defs(&mut out, protocol);

    // Generate sequences
    generate_sequences(&mut out, protocol);

    // Generate helper functions
    generate_helpers(&mut out, protocol);

    out
}

fn generate_enum(out: &mut String, name: &str, enum_def: &super::EnumDef) {
    let ts_name = to_pascal_case(name);

    if !enum_def.description.is_empty() {
        out.push_str(&format!("/** {} */\n", enum_def.description));
    }

    out.push_str(&format!("export const {} = {{\n", ts_name));
    for (variant_name, variant) in &enum_def.values {
        if let Some(value) = variant.value {
            if !variant.description.is_empty() {
                out.push_str(&format!("  /** {} */\n", variant.description));
            }
            out.push_str(&format!("  {}: 0x{:02X},\n", variant_name.to_uppercase(), value));
        }
    }
    out.push_str("} as const;\n\n");

    // Type alias
    out.push_str(&format!("export type {} = typeof {}[keyof typeof {}];\n\n",
        ts_name, ts_name, ts_name));

    // Name lookup
    out.push_str(&format!("export const {}Names: Record<{}, string> = {{\n", ts_name, ts_name));
    for (variant_name, variant) in &enum_def.values {
        if let Some(value) = variant.value {
            out.push_str(&format!("  [0x{:02X}]: '{}',\n", value, variant_name));
        }
    }
    out.push_str("};\n\n");
}

fn generate_packet_types(out: &mut String, protocol: &Protocol) {
    out.push_str("/** Packet type codes */\n");
    out.push_str("export const PacketType = {\n");
    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("  /** {} */\n", pkt.description));
        out.push_str(&format!("  {}: 0x{:02X},\n", name.to_uppercase(), pkt.value));
    }
    out.push_str("} as const;\n\n");

    out.push_str("export type PacketType = typeof PacketType[keyof typeof PacketType];\n\n");

    // Packet type info
    out.push_str("export interface PacketTypeInfo {\n");
    out.push_str("  name: string;\n");
    out.push_str("  length: number;\n");
    out.push_str("  category: string;\n");
    out.push_str("  description: string;\n");
    out.push_str("  usesBigEndianDeviceId: boolean;\n");
    out.push_str("  isVirtual: boolean;\n");
    out.push_str("}\n\n");

    out.push_str("export const PacketTypeInfo: Record<number, PacketTypeInfo> = {\n");
    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("  [0x{:02X}]: {{\n", pkt.value));
        out.push_str(&format!("    name: '{}',\n", name));
        out.push_str(&format!("    length: {},\n", pkt.length));
        out.push_str(&format!("    category: '{}',\n", pkt.category));
        out.push_str(&format!("    description: '{}',\n", pkt.description.replace('\'', "\\'")));
        out.push_str(&format!("    usesBigEndianDeviceId: {},\n", pkt.device_id_endian == "big"));
        out.push_str(&format!("    isVirtual: {},\n", pkt.virtual_type));
        out.push_str("  },\n");

        // Add aliases
        for alias in &pkt.aliases {
            out.push_str(&format!("  [0x{:02X}]: {{\n", alias));
            out.push_str(&format!("    name: '{}',\n", name));
            out.push_str(&format!("    length: {},\n", pkt.length));
            out.push_str(&format!("    category: '{}',\n", pkt.category));
            out.push_str(&format!("    description: '{}',\n", pkt.description.replace('\'', "\\'")));
            out.push_str(&format!("    usesBigEndianDeviceId: {},\n", pkt.device_id_endian == "big"));
            out.push_str(&format!("    isVirtual: {},\n", pkt.virtual_type));
            out.push_str("  },\n");
        }
    }
    out.push_str("};\n\n");
}

fn generate_field_defs(out: &mut String, protocol: &Protocol) {
    out.push_str("/** Field format types */\n");
    out.push_str("export type FieldFormat = 'hex' | 'decimal' | 'device_id' | 'device_id_be' | 'level_byte' | 'level_16bit' | 'button' | 'action';\n\n");

    out.push_str("export interface FieldDef {\n");
    out.push_str("  name: string;\n");
    out.push_str("  offset: number;\n");
    out.push_str("  size: number;\n");
    out.push_str("  format: FieldFormat;\n");
    out.push_str("  description?: string;\n");
    out.push_str("}\n\n");

    out.push_str("/** Field definitions by packet type */\n");
    out.push_str("export const PacketFields: Record<string, FieldDef[]> = {\n");

    for (name, pkt) in &protocol.packet_types {
        if pkt.fields.is_empty() || pkt.inherits.is_some() {
            continue;
        }

        out.push_str(&format!("  '{}': [\n", name));
        for field in &pkt.fields {
            out.push_str("    {\n");
            out.push_str(&format!("      name: '{}',\n", field.name));
            out.push_str(&format!("      offset: {},\n", field.offset));
            out.push_str(&format!("      size: {},\n", field.size));
            out.push_str(&format!("      format: '{}',\n", field.format));
            if !field.description.is_empty() {
                out.push_str(&format!("      description: '{}',\n", field.description.replace('\'', "\\'")));
            }
            out.push_str("    },\n");
        }
        out.push_str("  ],\n");
    }

    out.push_str("};\n\n");
}

fn generate_sequences(out: &mut String, protocol: &Protocol) {
    if protocol.sequences.is_empty() {
        return;
    }

    out.push_str("/** Sequence step definition */\n");
    out.push_str("export interface SequenceStep {\n");
    out.push_str("  packetType: string;\n");
    out.push_str("  count: number | null;  // null = repeat until stopped\n");
    out.push_str("  intervalMs: number;\n");
    out.push_str("}\n\n");

    out.push_str("/** Sequence definition */\n");
    out.push_str("export interface Sequence {\n");
    out.push_str("  name: string;\n");
    out.push_str("  description: string;\n");
    out.push_str("  steps: SequenceStep[];\n");
    out.push_str("}\n\n");

    out.push_str("/** Transmission sequences */\n");
    out.push_str("export const Sequences: Record<string, Sequence> = {\n");

    for (name, seq) in &protocol.sequences {
        out.push_str(&format!("  '{}': {{\n", name));
        out.push_str(&format!("    name: '{}',\n", name));
        out.push_str(&format!("    description: '{}',\n", seq.description.replace('\'', "\\'")));
        out.push_str("    steps: [\n");

        for step in &seq.steps {
            let count = step.count.map(|c| format!("{}", c)).unwrap_or_else(|| "null".to_string());
            let interval = step.interval_ms.unwrap_or(protocol.timing.button_repeat_ms);
            out.push_str(&format!("      {{ packetType: '{}', count: {}, intervalMs: {} }},\n",
                step.packet, count, interval));
        }

        out.push_str("    ],\n");
        out.push_str("  },\n");
    }

    out.push_str("};\n\n");
}

fn generate_helpers(out: &mut String, _protocol: &Protocol) {
    // getPacketTypeName
    out.push_str("/** Get packet type name from type code */\n");
    out.push_str("export function getPacketTypeName(typeCode: number): string {\n");
    out.push_str("  return PacketTypeInfo[typeCode]?.name ?? 'UNKNOWN';\n");
    out.push_str("}\n\n");

    // getPacketLength
    out.push_str("/** Get expected packet length from type code */\n");
    out.push_str("export function getPacketLength(typeCode: number): number {\n");
    out.push_str("  return PacketTypeInfo[typeCode]?.length ?? 0;\n");
    out.push_str("}\n\n");

    // isButtonPacket
    out.push_str("/** Check if packet type is a button packet */\n");
    out.push_str("export function isButtonPacket(typeCode: number): boolean {\n");
    out.push_str("  return PacketTypeInfo[typeCode]?.category === 'button';\n");
    out.push_str("}\n\n");

    // Category checker
    out.push_str("/** Check if packet type belongs to a category */\n");
    out.push_str("export function isPacketCategory(typeCode: number, category: string): boolean {\n");
    out.push_str("  return PacketTypeInfo[typeCode]?.category === category;\n");
    out.push_str("}\n\n");

    // nextSequence helper
    out.push_str("/** Calculate next sequence number */\n");
    out.push_str("export function nextSequence(seq: number): number {\n");
    out.push_str(&format!("  return (seq + SEQUENCE.INCREMENT) % SEQUENCE.WRAP;\n"));
    out.push_str("}\n");
}

fn to_pascal_case(s: &str) -> String {
    s.split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => {
                    let upper: String = first.to_uppercase().collect();
                    let rest: String = chars.flat_map(|c| c.to_lowercase()).collect();
                    upper + &rest
                }
            }
        })
        .collect()
}
