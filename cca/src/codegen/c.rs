//! C header code generator

use super::Protocol;
use std::collections::BTreeSet;

pub fn generate_c(protocol: &Protocol) -> String {
    let mut out = String::new();

    // Header guard and info
    out.push_str("/**\n");
    out.push_str(" * Auto-generated from protocol/cca.yaml\n");
    out.push_str(" * DO NOT EDIT - regenerate with: cca codegen\n");
    out.push_str(" *\n");
    out.push_str(&format!(" * {} v{}\n", protocol.meta.name, protocol.meta.version));
    out.push_str(" */\n\n");
    out.push_str("#ifndef CCA_PROTOCOL_H\n");
    out.push_str("#define CCA_PROTOCOL_H\n\n");
    out.push_str("#include <stdint.h>\n");
    out.push_str("#include <stdbool.h>\n\n");

    // RF Constants
    out.push_str("/* RF physical layer constants */\n");
    out.push_str(&format!("#define CCA_FREQUENCY_HZ      {}\n", protocol.rf.frequency_hz));
    out.push_str(&format!("#define CCA_DEVIATION_HZ      {}\n", protocol.rf.deviation_hz));
    out.push_str(&format!("#define CCA_BAUD_RATE         {:.1}f\n", protocol.rf.baud_rate));
    out.push_str("\n");

    // CRC Constants
    out.push_str("/* CRC configuration */\n");
    out.push_str(&format!("#define CCA_CRC_POLYNOMIAL    0x{:04X}\n", protocol.crc.polynomial));
    out.push_str(&format!("#define CCA_CRC_WIDTH         {}\n", protocol.crc.width));
    out.push_str(&format!("#define CCA_CRC_INITIAL       0x{:04X}\n", protocol.crc.initial));
    out.push_str("\n");

    // Framing Constants
    out.push_str("/* Packet framing */\n");
    out.push_str(&format!("#define CCA_PREAMBLE_BITS     {}\n", protocol.framing.preamble_bits));
    out.push_str(&format!("#define CCA_PREAMBLE_PATTERN  0x{:08X}\n", protocol.framing.preamble_pattern));
    out.push_str(&format!("#define CCA_SYNC_BYTE         0x{:02X}\n", protocol.framing.sync_byte));
    out.push_str(&format!("#define CCA_TRAILING_BITS     {}\n", protocol.framing.trailing_bits));
    out.push_str(&format!("#define CCA_PREFIX_LEN        {}\n", protocol.framing.prefix.len()));
    out.push_str("static const uint8_t CCA_PREFIX[] = {");
    for (i, b) in protocol.framing.prefix.iter().enumerate() {
        if i > 0 { out.push_str(", "); }
        out.push_str(&format!("0x{:02X}", b));
    }
    out.push_str("};\n\n");

    // Timing Constants
    out.push_str("/* Timing constants (milliseconds) */\n");
    out.push_str(&format!("#define CCA_BUTTON_REPEAT_MS     {}\n", protocol.timing.button_repeat_ms));
    out.push_str(&format!("#define CCA_BEACON_INTERVAL_MS   {}\n", protocol.timing.beacon_interval_ms));
    out.push_str(&format!("#define CCA_PAIRING_INTERVAL_MS  {}\n", protocol.timing.pairing_interval_ms));
    out.push_str(&format!("#define CCA_LEVEL_REPORT_MS      {}\n", protocol.timing.level_report_ms));
    out.push_str(&format!("#define CCA_UNPAIR_INTERVAL_MS   {}\n", protocol.timing.unpair_interval_ms));
    out.push_str(&format!("#define CCA_LED_CONFIG_INTERVAL_MS {}\n", protocol.timing.led_config_interval_ms));
    out.push_str("\n");

    // Sequence Constants
    out.push_str("/* Sequence number behavior */\n");
    out.push_str(&format!("#define CCA_SEQUENCE_INCREMENT   {}\n", protocol.sequence.increment));
    out.push_str(&format!("#define CCA_SEQUENCE_WRAP        0x{:02X}\n", protocol.sequence.wrap));
    out.push_str("\n");

    // Packet Lengths
    out.push_str("/* Packet lengths */\n");
    out.push_str(&format!("#define CCA_LENGTH_STANDARD      {}\n", protocol.lengths.standard));
    out.push_str(&format!("#define CCA_LENGTH_PAIRING       {}\n", protocol.lengths.pairing));
    out.push_str("\n");

    // Generate enums
    for (enum_name, enum_def) in &protocol.enums {
        generate_enum(&mut out, enum_name, enum_def);
    }

    // Generate packet type enum
    generate_packet_types(&mut out, protocol);

    // Generate helper macros
    generate_helper_macros(&mut out, protocol);

    // Generate field offset defines
    generate_field_offsets(&mut out, protocol);

    // Generate sequence structures
    generate_sequences(&mut out, protocol);

    out.push_str("#endif /* CCA_PROTOCOL_H */\n");

    out
}

fn generate_enum(out: &mut String, name: &str, enum_def: &super::EnumDef) {
    let prefix = format!("CCA_{}", name.to_uppercase());

    if !enum_def.description.is_empty() {
        out.push_str(&format!("/* {} */\n", enum_def.description));
    }

    for (variant_name, variant) in &enum_def.values {
        if let Some(value) = variant.value {
            if !variant.description.is_empty() {
                out.push_str(&format!("#define {}_{:<12} 0x{:02X}  /* {} */\n",
                    prefix, variant_name.to_uppercase(), value, variant.description));
            } else {
                out.push_str(&format!("#define {}_{:<12} 0x{:02X}\n",
                    prefix, variant_name.to_uppercase(), value));
            }
        }
    }
    out.push_str("\n");
}

fn generate_packet_types(out: &mut String, protocol: &Protocol) {
    out.push_str("/* Packet type codes */\n");

    for (name, pkt) in &protocol.packet_types {
        let define_name = format!("CCA_PKT_{}", name.to_uppercase());
        out.push_str(&format!("#define {:<28} 0x{:02X}  /* {} */\n",
            define_name, pkt.value, pkt.description));
    }
    out.push_str("\n");

    // Packet lengths
    out.push_str("/* Packet type lengths */\n");
    for (name, pkt) in &protocol.packet_types {
        let define_name = format!("CCA_PKT_{}_LEN", name.to_uppercase());
        out.push_str(&format!("#define {:<28} {}\n", define_name, pkt.length));
    }
    out.push_str("\n");
}

fn generate_helper_macros(out: &mut String, protocol: &Protocol) {
    out.push_str("/* Helper macros */\n");

    // Category check macros
    let mut categories: BTreeSet<&str> = BTreeSet::new();
    for pkt in protocol.packet_types.values() {
        categories.insert(&pkt.category);
    }

    for category in categories {
        let macro_name = format!("CCA_IS_{}_PKT", category.to_uppercase());
        out.push_str(&format!("#define {}(t) ( \\\n", macro_name));
        let matching: Vec<_> = protocol.packet_types.iter()
            .filter(|(_, pkt)| pkt.category == category)
            .collect();
        for (i, (name, _)) in matching.iter().enumerate() {
            let pkt_define = format!("CCA_PKT_{}", name.to_uppercase());
            if i == matching.len() - 1 {
                out.push_str(&format!("    (t) == {} \\\n", pkt_define));
            } else {
                out.push_str(&format!("    (t) == {} || \\\n", pkt_define));
            }
        }
        out.push_str(")\n\n");
    }

    // Big-endian device ID check
    out.push_str("#define CCA_PKT_USES_BE_DEVICE_ID(t) ( \\\n");
    let be_types: Vec<_> = protocol.packet_types.iter()
        .filter(|(_, pkt)| pkt.device_id_endian == "big")
        .collect();
    for (i, (name, _)) in be_types.iter().enumerate() {
        let pkt_define = format!("CCA_PKT_{}", name.to_uppercase());
        if i == be_types.len() - 1 {
            out.push_str(&format!("    (t) == {} \\\n", pkt_define));
        } else {
            out.push_str(&format!("    (t) == {} || \\\n", pkt_define));
        }
    }
    out.push_str(")\n\n");

    // Packet length lookup
    out.push_str("static inline uint8_t cca_packet_length(uint8_t type) {\n");
    out.push_str("    switch (type) {\n");
    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("        case CCA_PKT_{}: return {};\n",
            name.to_uppercase(), pkt.length));
        // Handle aliases
        for alias in &pkt.aliases {
            out.push_str(&format!("        case 0x{:02X}: return {};\n", alias, pkt.length));
        }
    }
    out.push_str("        default: return 0;\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");

    // Packet type name lookup
    out.push_str("static inline const char* cca_packet_name(uint8_t type) {\n");
    out.push_str("    switch (type) {\n");
    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("        case CCA_PKT_{}: return \"{}\";\n",
            name.to_uppercase(), name));
        for alias in &pkt.aliases {
            out.push_str(&format!("        case 0x{:02X}: return \"{}\";\n", alias, name));
        }
    }
    out.push_str("        default: return \"UNKNOWN\";\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
}

fn generate_field_offsets(out: &mut String, protocol: &Protocol) {
    out.push_str("/* Field offsets for packet parsing */\n");

    for (name, pkt) in &protocol.packet_types {
        if pkt.fields.is_empty() || pkt.inherits.is_some() {
            continue;
        }

        let prefix = format!("CCA_{}", name.to_uppercase());
        out.push_str(&format!("/* {} fields */\n", name));

        for field in &pkt.fields {
            let field_upper = field.name.to_uppercase();
            out.push_str(&format!("#define {}_OFF_{}    {}\n", prefix, field_upper, field.offset));
            out.push_str(&format!("#define {}_SIZE_{}   {}\n", prefix, field_upper, field.size));
        }
        out.push_str("\n");
    }
}

fn generate_sequences(out: &mut String, protocol: &Protocol) {
    if protocol.sequences.is_empty() {
        return;
    }

    out.push_str("/* Transmission sequence definitions */\n\n");

    // Sequence step struct
    out.push_str("typedef struct {\n");
    out.push_str("    uint8_t packet_type;\n");
    out.push_str("    int32_t count;       /* -1 = repeat until stopped */\n");
    out.push_str("    uint32_t interval_ms;\n");
    out.push_str("} cca_sequence_step_t;\n\n");

    // Sequence struct
    out.push_str("typedef struct {\n");
    out.push_str("    const char* name;\n");
    out.push_str("    const char* description;\n");
    out.push_str("    const cca_sequence_step_t* steps;\n");
    out.push_str("    uint8_t step_count;\n");
    out.push_str("} cca_sequence_t;\n\n");

    // Generate each sequence
    for (name, seq) in protocol.sequences.iter() {
        let const_name = name.to_uppercase();

        out.push_str(&format!("/* {} */\n", seq.description));
        out.push_str(&format!("static const cca_sequence_step_t CCA_SEQ_{}_STEPS[] = {{\n", const_name));

        for step in &seq.steps {
            let pkt_type = format!("CCA_PKT_{}", step.packet.to_uppercase());
            let count = step.count.map(|c| c as i32).unwrap_or(-1);
            let interval = step.interval_ms.unwrap_or(protocol.timing.button_repeat_ms);
            out.push_str(&format!("    {{ {}, {}, {} }},\n", pkt_type, count, interval));
        }

        out.push_str("};\n\n");

        out.push_str(&format!("static const cca_sequence_t CCA_SEQ_{} = {{\n", const_name));
        out.push_str(&format!("    .name = \"{}\",\n", name));
        out.push_str(&format!("    .description = \"{}\",\n", seq.description));
        out.push_str(&format!("    .steps = CCA_SEQ_{}_STEPS,\n", const_name));
        out.push_str(&format!("    .step_count = sizeof(CCA_SEQ_{}_STEPS) / sizeof(cca_sequence_step_t),\n", const_name));
        out.push_str("};\n\n");
    }
}
