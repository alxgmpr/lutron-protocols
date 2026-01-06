//! Markdown documentation generator

use super::{Protocol, PacketType};

pub fn generate_markdown(protocol: &Protocol) -> String {
    let mut out = String::new();

    // Header
    out.push_str(&format!("# {}\n\n", protocol.meta.name));
    out.push_str(&format!("**Version:** {}  \n", protocol.meta.version));
    out.push_str("**Auto-generated from:** `protocol/cca.yaml`  \n");
    out.push_str("**DO NOT EDIT** - regenerate with: `cca codegen`\n\n");

    if !protocol.meta.description.is_empty() {
        out.push_str(&format!("{}\n\n", protocol.meta.description));
    }

    // Table of contents
    out.push_str("## Table of Contents\n\n");
    out.push_str("- [RF Parameters](#rf-parameters)\n");
    out.push_str("- [Packet Framing](#packet-framing)\n");
    out.push_str("- [CRC Configuration](#crc-configuration)\n");
    out.push_str("- [Timing](#timing)\n");
    out.push_str("- [Enumerations](#enumerations)\n");
    out.push_str("- [Packet Types](#packet-types)\n");
    out.push_str("- [Transmission Sequences](#transmission-sequences)\n\n");

    // RF Parameters
    out.push_str("## RF Parameters\n\n");
    out.push_str("| Parameter | Value |\n");
    out.push_str("|-----------|-------|\n");
    out.push_str(&format!("| Frequency | {} Hz ({:.3} MHz) |\n",
        protocol.rf.frequency_hz,
        protocol.rf.frequency_hz as f64 / 1_000_000.0));
    out.push_str(&format!("| Deviation | {} Hz ({:.1} kHz) |\n",
        protocol.rf.deviation_hz,
        protocol.rf.deviation_hz as f64 / 1_000.0));
    out.push_str(&format!("| Baud Rate | {:.1} bps |\n", protocol.rf.baud_rate));
    out.push_str(&format!("| Modulation | {} |\n", protocol.rf.modulation));
    out.push_str(&format!("| Encoding | {} |\n", protocol.rf.encoding));
    out.push_str("\n");

    // Packet Framing
    out.push_str("## Packet Framing\n\n");
    out.push_str("| Parameter | Value |\n");
    out.push_str("|-----------|-------|\n");
    out.push_str(&format!("| Preamble | {} bits of `0x{:08X}` |\n",
        protocol.framing.preamble_bits, protocol.framing.preamble_pattern));
    out.push_str(&format!("| Sync Byte | `0x{:02X}` |\n", protocol.framing.sync_byte));
    out.push_str("| Prefix | `");
    for (i, b) in protocol.framing.prefix.iter().enumerate() {
        if i > 0 { out.push_str(" "); }
        out.push_str(&format!("{:02X}", b));
    }
    out.push_str("` |\n");
    out.push_str(&format!("| Trailing | {} bits |\n", protocol.framing.trailing_bits));
    out.push_str("\n");

    // CRC Configuration
    out.push_str("## CRC Configuration\n\n");
    out.push_str("| Parameter | Value |\n");
    out.push_str("|-----------|-------|\n");
    out.push_str(&format!("| Polynomial | `0x{:04X}` |\n", protocol.crc.polynomial));
    out.push_str(&format!("| Width | {} bits |\n", protocol.crc.width));
    out.push_str(&format!("| Initial | `0x{:04X}` |\n", protocol.crc.initial));
    out.push_str(&format!("| Byte Order | {} |\n", protocol.crc.byte_order));
    out.push_str("\n");

    // Timing
    out.push_str("## Timing\n\n");
    out.push_str("| Event | Interval |\n");
    out.push_str("|-------|----------|\n");
    out.push_str(&format!("| Button Repeat | {} ms |\n", protocol.timing.button_repeat_ms));
    out.push_str(&format!("| Beacon | {} ms |\n", protocol.timing.beacon_interval_ms));
    out.push_str(&format!("| Pairing | {} ms |\n", protocol.timing.pairing_interval_ms));
    out.push_str(&format!("| Level Report | {} ms |\n", protocol.timing.level_report_ms));
    out.push_str(&format!("| Unpair | {} ms |\n", protocol.timing.unpair_interval_ms));
    out.push_str(&format!("| LED Config | {} ms |\n", protocol.timing.led_config_interval_ms));
    out.push_str("\n");

    out.push_str("### Sequence Numbers\n\n");
    out.push_str(&format!("- **Increment:** {} per transmission\n", protocol.sequence.increment));
    out.push_str(&format!("- **Wrap:** at `0x{:02X}` ({})\n\n", protocol.sequence.wrap, protocol.sequence.wrap));

    // Enumerations
    out.push_str("## Enumerations\n\n");
    for (enum_name, enum_def) in &protocol.enums {
        generate_enum_doc(&mut out, enum_name, enum_def);
    }

    // Packet Types
    out.push_str("## Packet Types\n\n");
    generate_packet_types_summary(&mut out, protocol);

    // Detailed packet documentation
    for (name, pkt) in &protocol.packet_types {
        if !pkt.fields.is_empty() && pkt.inherits.is_none() {
            generate_packet_detail(&mut out, name, pkt);
        }
    }

    // Transmission Sequences
    out.push_str("## Transmission Sequences\n\n");
    for (name, seq) in &protocol.sequences {
        generate_sequence_doc(&mut out, name, seq, protocol);
    }

    out
}

fn generate_enum_doc(out: &mut String, name: &str, enum_def: &super::EnumDef) {
    out.push_str(&format!("### {}\n\n", to_title_case(name)));

    if !enum_def.description.is_empty() {
        out.push_str(&format!("{}\n\n", enum_def.description));
    }

    out.push_str("| Name | Value | Description |\n");
    out.push_str("|------|-------|-------------|\n");

    for (variant_name, variant) in &enum_def.values {
        if let Some(value) = variant.value {
            out.push_str(&format!("| {} | `0x{:02X}` | {} |\n",
                variant_name, value,
                if variant.description.is_empty() { "-" } else { &variant.description }));
        }
    }

    out.push_str("\n");
}

fn generate_packet_types_summary(out: &mut String, protocol: &Protocol) {
    out.push_str("### Summary\n\n");
    out.push_str("| Type | Code | Length | Category | Description |\n");
    out.push_str("|------|------|--------|----------|-------------|\n");

    for (name, pkt) in &protocol.packet_types {
        let aliases = if pkt.aliases.is_empty() {
            String::new()
        } else {
            let alias_strs: Vec<_> = pkt.aliases.iter()
                .map(|a| format!("0x{:02X}", a))
                .collect();
            format!(" (aliases: {})", alias_strs.join(", "))
        };
        out.push_str(&format!("| {} | `0x{:02X}`{} | {} | {} | {} |\n",
            name, pkt.value, aliases, pkt.length, pkt.category, pkt.description));
    }

    out.push_str("\n");
}

fn generate_packet_detail(out: &mut String, name: &str, pkt: &PacketType) {
    out.push_str(&format!("### {} (`0x{:02X}`)\n\n", name, pkt.value));
    out.push_str(&format!("{}\n\n", pkt.description));
    out.push_str(&format!("- **Length:** {} bytes\n", pkt.length));
    out.push_str(&format!("- **Category:** {}\n", pkt.category));
    if pkt.device_id_endian == "big" {
        out.push_str("- **Device ID:** Big-endian\n");
    } else if !pkt.device_id_endian.is_empty() {
        out.push_str(&format!("- **Device ID:** {}\n", pkt.device_id_endian));
    }
    out.push_str("\n");

    if !pkt.fields.is_empty() {
        out.push_str("#### Fields\n\n");
        out.push_str("| Offset | Size | Field | Format | Description |\n");
        out.push_str("|--------|------|-------|--------|-------------|\n");

        for field in &pkt.fields {
            let desc = if field.description.is_empty() { "-" } else { &field.description };
            out.push_str(&format!("| {} | {} | {} | {} | {} |\n",
                field.offset, field.size, field.name, field.format, desc));
        }

        out.push_str("\n");
    }
}

fn generate_sequence_doc(out: &mut String, name: &str, seq: &super::SequenceDef, protocol: &Protocol) {
    out.push_str(&format!("### {}\n\n", to_title_case(name)));
    out.push_str(&format!("{}\n\n", seq.description));

    if !seq.params.is_empty() {
        out.push_str("**Parameters:**\n\n");
        for param in &seq.params {
            let desc = if param.description.is_empty() { "" } else { &format!(" - {}", param.description) };
            out.push_str(&format!("- `{}`: `{}`{}\n", param.name, param.param_type, desc));
        }
        out.push_str("\n");
    }

    out.push_str("**Steps:**\n\n");
    out.push_str("| Step | Packet | Count | Interval |\n");
    out.push_str("|------|--------|-------|----------|\n");

    for (i, step) in seq.steps.iter().enumerate() {
        let count = step.count.map(|c| format!("{}", c)).unwrap_or_else(|| "infinite".to_string());
        let interval = step.interval_ms.unwrap_or(protocol.timing.button_repeat_ms);
        out.push_str(&format!("| {} | {} | {} | {} ms |\n",
            i + 1, step.packet, count, interval));
    }

    out.push_str("\n");

    // Calculate total transmission info
    let total_packets: u32 = seq.steps.iter()
        .filter_map(|s| s.count)
        .sum();
    let has_infinite = seq.steps.iter().any(|s| s.count.is_none());

    if total_packets > 0 && !has_infinite {
        let total_time: u32 = seq.steps.iter()
            .filter_map(|s| s.count.map(|c| c * s.interval_ms.unwrap_or(protocol.timing.button_repeat_ms)))
            .sum();
        out.push_str(&format!("**Total:** {} packets, ~{} ms\n\n", total_packets, total_time));
    } else if has_infinite {
        out.push_str("**Note:** This sequence runs until explicitly stopped.\n\n");
    }
}

fn to_title_case(s: &str) -> String {
    s.split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => {
                    let upper: String = first.to_uppercase().collect();
                    let rest: String = chars.collect();
                    upper + &rest
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
