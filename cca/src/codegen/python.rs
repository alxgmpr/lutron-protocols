//! Python code generator

use super::Protocol;

pub fn generate_python(protocol: &Protocol) -> String {
    let mut out = String::new();

    // Header
    out.push_str("\"\"\"\n");
    out.push_str("Auto-generated from protocol/cca.yaml\n");
    out.push_str("DO NOT EDIT - regenerate with: cca codegen\n");
    out.push_str("\n");
    out.push_str(&format!("{} v{}\n", protocol.meta.name, protocol.meta.version));
    out.push_str("\"\"\"\n\n");

    out.push_str("from enum import IntEnum\n");
    out.push_str("from dataclasses import dataclass\n");
    out.push_str("from typing import Optional, List, Callable, Awaitable\n");
    out.push_str("import asyncio\n\n");

    // RF Constants
    out.push_str("# RF physical layer constants\n");
    out.push_str(&format!("RF_FREQUENCY_HZ = {}\n", protocol.rf.frequency_hz));
    out.push_str(&format!("RF_DEVIATION_HZ = {}\n", protocol.rf.deviation_hz));
    out.push_str(&format!("RF_BAUD_RATE = {}\n", protocol.rf.baud_rate));
    out.push_str("\n");

    // CRC Constants
    out.push_str("# CRC configuration\n");
    out.push_str(&format!("CRC_POLYNOMIAL = 0x{:04X}\n", protocol.crc.polynomial));
    out.push_str(&format!("CRC_WIDTH = {}\n", protocol.crc.width));
    out.push_str(&format!("CRC_INITIAL = 0x{:04X}\n", protocol.crc.initial));
    out.push_str("\n");

    // Framing Constants
    out.push_str("# Packet framing\n");
    out.push_str(&format!("PREAMBLE_BITS = {}\n", protocol.framing.preamble_bits));
    out.push_str(&format!("PREAMBLE_PATTERN = 0x{:08X}\n", protocol.framing.preamble_pattern));
    out.push_str(&format!("SYNC_BYTE = 0x{:02X}\n", protocol.framing.sync_byte));
    out.push_str("PREFIX = bytes([");
    for (i, b) in protocol.framing.prefix.iter().enumerate() {
        if i > 0 { out.push_str(", "); }
        out.push_str(&format!("0x{:02X}", b));
    }
    out.push_str("])\n");
    out.push_str(&format!("TRAILING_BITS = {}\n", protocol.framing.trailing_bits));
    out.push_str("\n");

    // Timing Constants
    out.push_str("# Timing constants (milliseconds)\n");
    out.push_str(&format!("BUTTON_REPEAT_MS = {}\n", protocol.timing.button_repeat_ms));
    out.push_str(&format!("BEACON_INTERVAL_MS = {}\n", protocol.timing.beacon_interval_ms));
    out.push_str(&format!("PAIRING_INTERVAL_MS = {}\n", protocol.timing.pairing_interval_ms));
    out.push_str(&format!("LEVEL_REPORT_MS = {}\n", protocol.timing.level_report_ms));
    out.push_str(&format!("UNPAIR_INTERVAL_MS = {}\n", protocol.timing.unpair_interval_ms));
    out.push_str(&format!("LED_CONFIG_INTERVAL_MS = {}\n", protocol.timing.led_config_interval_ms));
    out.push_str("\n");

    // Sequence Constants
    out.push_str("# Sequence number behavior\n");
    out.push_str(&format!("SEQUENCE_INCREMENT = {}\n", protocol.sequence.increment));
    out.push_str(&format!("SEQUENCE_WRAP = 0x{:02X}\n", protocol.sequence.wrap));
    out.push_str("\n");

    // Packet Lengths
    out.push_str("# Packet lengths\n");
    out.push_str(&format!("LENGTH_STANDARD = {}\n", protocol.lengths.standard));
    out.push_str(&format!("LENGTH_PAIRING = {}\n", protocol.lengths.pairing));
    out.push_str("\n\n");

    // Generate enums
    for (enum_name, enum_def) in &protocol.enums {
        generate_enum(&mut out, enum_name, enum_def);
    }

    // Generate packet types enum
    generate_packet_type_enum(&mut out, protocol);

    // Generate field definitions
    generate_field_defs(&mut out, protocol);

    // Generate packet info
    generate_packet_info(&mut out, protocol);

    // Generate sequences
    generate_sequences(&mut out, protocol);

    // Generate helper functions
    generate_helpers(&mut out);

    out
}

fn generate_enum(out: &mut String, name: &str, enum_def: &super::EnumDef) {
    let class_name = to_pascal_case(name);

    if !enum_def.description.is_empty() {
        out.push_str(&format!("# {}\n", enum_def.description));
    }

    out.push_str(&format!("class {}(IntEnum):\n", class_name));
    out.push_str(&format!("    \"\"\"{}.\"\"\"\n", if enum_def.description.is_empty() { name } else { &enum_def.description }));

    let mut has_values = false;
    for (variant_name, variant) in &enum_def.values {
        if let Some(value) = variant.value {
            has_values = true;
            if !variant.description.is_empty() {
                out.push_str(&format!("    {} = 0x{:02X}  # {}\n", variant_name.to_uppercase(), value, variant.description));
            } else {
                out.push_str(&format!("    {} = 0x{:02X}\n", variant_name.to_uppercase(), value));
            }
        }
    }

    if !has_values {
        out.push_str("    pass\n");
    }

    out.push_str("\n\n");
}

fn generate_packet_type_enum(out: &mut String, protocol: &Protocol) {
    out.push_str("class PacketType(IntEnum):\n");
    out.push_str("    \"\"\"Packet type codes.\"\"\"\n");

    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("    {} = 0x{:02X}  # {}\n",
            name.to_uppercase(), pkt.value, pkt.description));
    }

    out.push_str("\n\n");

    // Packet type aliases mapping
    out.push_str("# Packet type aliases (map aliased values to canonical types)\n");
    out.push_str("PACKET_TYPE_ALIASES: dict[int, PacketType] = {\n");
    for (name, pkt) in &protocol.packet_types {
        for alias in &pkt.aliases {
            out.push_str(&format!("    0x{:02X}: PacketType.{},\n", alias, name.to_uppercase()));
        }
    }
    out.push_str("}\n\n\n");
}

fn generate_field_defs(out: &mut String, protocol: &Protocol) {
    out.push_str("@dataclass\n");
    out.push_str("class FieldDef:\n");
    out.push_str("    \"\"\"Field definition for packet parsing.\"\"\"\n");
    out.push_str("    name: str\n");
    out.push_str("    offset: int\n");
    out.push_str("    size: int\n");
    out.push_str("    format: str\n");
    out.push_str("    description: str = \"\"\n\n\n");

    out.push_str("# Field definitions by packet type\n");
    out.push_str("PACKET_FIELDS: dict[str, list[FieldDef]] = {\n");

    for (name, pkt) in &protocol.packet_types {
        if pkt.fields.is_empty() || pkt.inherits.is_some() {
            continue;
        }

        out.push_str(&format!("    \"{}\": [\n", name));
        for field in &pkt.fields {
            let desc = if field.description.is_empty() {
                String::new()
            } else {
                format!(", description=\"{}\"", field.description.replace('"', "\\\""))
            };
            out.push_str(&format!(
                "        FieldDef(name=\"{}\", offset={}, size={}, format=\"{}\"{}),\n",
                field.name, field.offset, field.size, field.format, desc
            ));
        }
        out.push_str("    ],\n");
    }

    out.push_str("}\n\n\n");
}

fn generate_packet_info(out: &mut String, protocol: &Protocol) {
    out.push_str("@dataclass\n");
    out.push_str("class PacketTypeInfo:\n");
    out.push_str("    \"\"\"Information about a packet type.\"\"\"\n");
    out.push_str("    name: str\n");
    out.push_str("    length: int\n");
    out.push_str("    category: str\n");
    out.push_str("    description: str\n");
    out.push_str("    uses_big_endian_device_id: bool\n");
    out.push_str("    is_virtual: bool = False\n\n\n");

    out.push_str("# Packet type information lookup\n");
    out.push_str("PACKET_TYPE_INFO: dict[int, PacketTypeInfo] = {\n");

    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("    0x{:02X}: PacketTypeInfo(\n", pkt.value));
        out.push_str(&format!("        name=\"{}\",\n", name));
        out.push_str(&format!("        length={},\n", pkt.length));
        out.push_str(&format!("        category=\"{}\",\n", pkt.category));
        out.push_str(&format!("        description=\"{}\",\n", pkt.description.replace('"', "\\\"")));
        out.push_str(&format!("        uses_big_endian_device_id={},\n",
            if pkt.device_id_endian == "big" { "True" } else { "False" }));
        out.push_str(&format!("        is_virtual={},\n",
            if pkt.virtual_type { "True" } else { "False" }));
        out.push_str("    ),\n");

        // Add aliases
        for alias in &pkt.aliases {
            out.push_str(&format!("    0x{:02X}: PacketTypeInfo(\n", alias));
            out.push_str(&format!("        name=\"{}\",\n", name));
            out.push_str(&format!("        length={},\n", pkt.length));
            out.push_str(&format!("        category=\"{}\",\n", pkt.category));
            out.push_str(&format!("        description=\"{}\",\n", pkt.description.replace('"', "\\\"")));
            out.push_str(&format!("        uses_big_endian_device_id={},\n",
                if pkt.device_id_endian == "big" { "True" } else { "False" }));
            out.push_str(&format!("        is_virtual={},\n",
                if pkt.virtual_type { "True" } else { "False" }));
            out.push_str("    ),\n");
        }
    }

    out.push_str("}\n\n\n");
}

fn generate_sequences(out: &mut String, protocol: &Protocol) {
    if protocol.sequences.is_empty() {
        return;
    }

    out.push_str("@dataclass\n");
    out.push_str("class SequenceStep:\n");
    out.push_str("    \"\"\"A step in a transmission sequence.\"\"\"\n");
    out.push_str("    packet_type: str\n");
    out.push_str("    count: Optional[int]  # None = repeat until stopped\n");
    out.push_str("    interval_ms: int\n\n\n");

    out.push_str("@dataclass\n");
    out.push_str("class Sequence:\n");
    out.push_str("    \"\"\"Transmission sequence definition.\"\"\"\n");
    out.push_str("    name: str\n");
    out.push_str("    description: str\n");
    out.push_str("    steps: list[SequenceStep]\n\n\n");

    out.push_str("# Transmission sequences\n");
    out.push_str("SEQUENCES: dict[str, Sequence] = {\n");

    for (name, seq) in &protocol.sequences {
        out.push_str(&format!("    \"{}\": Sequence(\n", name));
        out.push_str(&format!("        name=\"{}\",\n", name));
        out.push_str(&format!("        description=\"{}\",\n", seq.description.replace('"', "\\\"")));
        out.push_str("        steps=[\n");

        for step in &seq.steps {
            let count = step.count.map(|c| format!("{}", c)).unwrap_or_else(|| "None".to_string());
            let interval = step.interval_ms.unwrap_or(protocol.timing.button_repeat_ms);
            out.push_str(&format!(
                "            SequenceStep(packet_type=\"{}\", count={}, interval_ms={}),\n",
                step.packet, count, interval
            ));
        }

        out.push_str("        ],\n");
        out.push_str("    ),\n");
    }

    out.push_str("}\n\n\n");
}

fn generate_helpers(out: &mut String) {
    // get_packet_type_name
    out.push_str("def get_packet_type_name(type_code: int) -> str:\n");
    out.push_str("    \"\"\"Get packet type name from type code.\"\"\"\n");
    out.push_str("    info = PACKET_TYPE_INFO.get(type_code)\n");
    out.push_str("    return info.name if info else \"UNKNOWN\"\n\n\n");

    // get_packet_length
    out.push_str("def get_packet_length(type_code: int) -> int:\n");
    out.push_str("    \"\"\"Get expected packet length from type code.\"\"\"\n");
    out.push_str("    info = PACKET_TYPE_INFO.get(type_code)\n");
    out.push_str("    return info.length if info else 0\n\n\n");

    // is_button_packet
    out.push_str("def is_button_packet(type_code: int) -> bool:\n");
    out.push_str("    \"\"\"Check if packet type is a button packet.\"\"\"\n");
    out.push_str("    info = PACKET_TYPE_INFO.get(type_code)\n");
    out.push_str("    return info.category == \"button\" if info else False\n\n\n");

    // is_packet_category
    out.push_str("def is_packet_category(type_code: int, category: str) -> bool:\n");
    out.push_str("    \"\"\"Check if packet type belongs to a category.\"\"\"\n");
    out.push_str("    info = PACKET_TYPE_INFO.get(type_code)\n");
    out.push_str("    return info.category == category if info else False\n\n\n");

    // next_sequence
    out.push_str("def next_sequence(seq: int) -> int:\n");
    out.push_str("    \"\"\"Calculate next sequence number.\"\"\"\n");
    out.push_str("    return (seq + SEQUENCE_INCREMENT) % SEQUENCE_WRAP\n\n\n");

    // resolve_packet_type
    out.push_str("def resolve_packet_type(type_code: int) -> Optional[PacketType]:\n");
    out.push_str("    \"\"\"Resolve a packet type code to its canonical PacketType.\"\"\"\n");
    out.push_str("    try:\n");
    out.push_str("        return PacketType(type_code)\n");
    out.push_str("    except ValueError:\n");
    out.push_str("        return PACKET_TYPE_ALIASES.get(type_code)\n");
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
