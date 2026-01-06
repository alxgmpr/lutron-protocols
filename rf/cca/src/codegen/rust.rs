//! Rust code generator

use super::{Protocol, Field};

pub fn generate_rust(protocol: &Protocol) -> String {
    let mut out = String::new();

    // Header
    out.push_str("//! Auto-generated from protocol/cca.yaml\n");
    out.push_str("//! DO NOT EDIT - regenerate with: cca codegen\n");
    out.push_str("//!\n");
    out.push_str(&format!("//! {} v{}\n", protocol.meta.name, protocol.meta.version));
    out.push_str("\n");
    out.push_str("#![allow(dead_code)]\n");
    out.push_str("\n");

    // RF Constants
    out.push_str("/// RF physical layer constants\n");
    out.push_str("pub mod rf {\n");
    out.push_str(&format!("    pub const FREQUENCY_HZ: u32 = {};\n", protocol.rf.frequency_hz));
    out.push_str(&format!("    pub const DEVIATION_HZ: u32 = {};\n", protocol.rf.deviation_hz));
    out.push_str(&format!("    pub const BAUD_RATE: f32 = {:.1};\n", protocol.rf.baud_rate));
    out.push_str("}\n\n");

    // CRC Constants
    out.push_str("/// CRC configuration\n");
    out.push_str("pub mod crc {\n");
    out.push_str(&format!("    pub const POLYNOMIAL: u16 = 0x{:04X};\n", protocol.crc.polynomial));
    out.push_str(&format!("    pub const WIDTH: u8 = {};\n", protocol.crc.width));
    out.push_str(&format!("    pub const INITIAL: u16 = 0x{:04X};\n", protocol.crc.initial));
    out.push_str("}\n\n");

    // Framing Constants
    out.push_str("/// Packet framing\n");
    out.push_str("pub mod framing {\n");
    out.push_str(&format!("    pub const PREAMBLE_BITS: u8 = {};\n", protocol.framing.preamble_bits));
    out.push_str(&format!("    pub const PREAMBLE_PATTERN: u32 = 0x{:08X};\n", protocol.framing.preamble_pattern));
    out.push_str(&format!("    pub const SYNC_BYTE: u8 = 0x{:02X};\n", protocol.framing.sync_byte));
    out.push_str(&format!("    pub const PREFIX: [u8; {}] = [", protocol.framing.prefix.len()));
    for (i, b) in protocol.framing.prefix.iter().enumerate() {
        if i > 0 { out.push_str(", "); }
        out.push_str(&format!("0x{:02X}", b));
    }
    out.push_str("];\n");
    out.push_str(&format!("    pub const TRAILING_BITS: u8 = {};\n", protocol.framing.trailing_bits));
    out.push_str("}\n\n");

    // Timing Constants
    out.push_str("/// Timing constants (milliseconds)\n");
    out.push_str("pub mod timing {\n");
    out.push_str(&format!("    pub const BUTTON_REPEAT_MS: u32 = {};\n", protocol.timing.button_repeat_ms));
    out.push_str(&format!("    pub const BEACON_INTERVAL_MS: u32 = {};\n", protocol.timing.beacon_interval_ms));
    out.push_str(&format!("    pub const PAIRING_INTERVAL_MS: u32 = {};\n", protocol.timing.pairing_interval_ms));
    out.push_str(&format!("    pub const LEVEL_REPORT_MS: u32 = {};\n", protocol.timing.level_report_ms));
    out.push_str(&format!("    pub const UNPAIR_INTERVAL_MS: u32 = {};\n", protocol.timing.unpair_interval_ms));
    out.push_str(&format!("    pub const LED_CONFIG_INTERVAL_MS: u32 = {};\n", protocol.timing.led_config_interval_ms));
    out.push_str("}\n\n");

    // Sequence Constants
    out.push_str("/// Sequence number behavior\n");
    out.push_str("pub mod sequence {\n");
    out.push_str(&format!("    pub const INCREMENT: u8 = {};\n", protocol.sequence.increment));
    out.push_str(&format!("    pub const WRAP: u8 = 0x{:02X};\n", protocol.sequence.wrap));
    out.push_str("}\n\n");

    // Packet Lengths
    out.push_str("/// Packet lengths\n");
    out.push_str("pub mod lengths {\n");
    out.push_str(&format!("    pub const STANDARD: usize = {};\n", protocol.lengths.standard));
    out.push_str(&format!("    pub const PAIRING: usize = {};\n", protocol.lengths.pairing));
    out.push_str("}\n\n");

    // Generate enums
    for (enum_name, enum_def) in &protocol.enums {
        generate_enum(&mut out, enum_name, enum_def);
    }

    // Generate packet type enum
    generate_packet_type_enum(&mut out, protocol);

    // Generate field definitions
    generate_field_defs(&mut out, protocol);

    // Generate sequence definitions
    generate_sequences(&mut out, protocol);

    out
}

fn generate_enum(out: &mut String, name: &str, enum_def: &super::EnumDef) {
    let rust_name = to_pascal_case(name);

    if !enum_def.description.is_empty() {
        out.push_str(&format!("/// {}\n", enum_def.description));
    }
    out.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq)]\n");
    out.push_str("#[repr(u8)]\n");
    out.push_str(&format!("pub enum {} {{\n", rust_name));

    for (variant_name, variant) in &enum_def.values {
        if let Some(value) = variant.value {
            if !variant.description.is_empty() {
                out.push_str(&format!("    /// {}\n", variant.description));
            }
            out.push_str(&format!("    {} = 0x{:02X},\n", to_pascal_case(variant_name), value));
        }
    }

    out.push_str("}\n\n");

    // from_byte implementation
    out.push_str(&format!("impl {} {{\n", rust_name));
    out.push_str("    pub fn from_byte(b: u8) -> Option<Self> {\n");
    out.push_str("        match b {\n");
    for (variant_name, variant) in &enum_def.values {
        if let Some(value) = variant.value {
            out.push_str(&format!("            0x{:02X} => Some(Self::{}),\n", value, to_pascal_case(variant_name)));
        }
    }
    out.push_str("            _ => None,\n");
    out.push_str("        }\n");
    out.push_str("    }\n\n");

    // name implementation
    out.push_str("    pub fn name(&self) -> &'static str {\n");
    out.push_str("        match self {\n");
    for variant_name in enum_def.values.keys() {
        out.push_str(&format!("            Self::{} => \"{}\",\n", to_pascal_case(variant_name), variant_name));
    }
    out.push_str("        }\n");
    out.push_str("    }\n");
    out.push_str("}\n\n");
}

fn generate_packet_type_enum(out: &mut String, protocol: &Protocol) {
    out.push_str("/// Packet type codes\n");
    out.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq)]\n");
    out.push_str("#[repr(u8)]\n");
    out.push_str("pub enum PacketType {\n");

    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("    /// {}\n", pkt.description));
        out.push_str(&format!("    {} = 0x{:02X},\n", to_pascal_case(name), pkt.value));
    }

    out.push_str("}\n\n");

    // Implementations
    out.push_str("impl PacketType {\n");

    // from_byte
    out.push_str("    pub fn from_byte(b: u8) -> Option<Self> {\n");
    out.push_str("        match b {\n");
    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("            0x{:02X} => Some(Self::{}),\n", pkt.value, to_pascal_case(name)));
        // Handle aliases
        for alias in &pkt.aliases {
            out.push_str(&format!("            0x{:02X} => Some(Self::{}),\n", alias, to_pascal_case(name)));
        }
    }
    out.push_str("            _ => None,\n");
    out.push_str("        }\n");
    out.push_str("    }\n\n");

    // name
    out.push_str("    pub fn name(&self) -> &'static str {\n");
    out.push_str("        match self {\n");
    for name in protocol.packet_types.keys() {
        out.push_str(&format!("            Self::{} => \"{}\",\n", to_pascal_case(name), name));
    }
    out.push_str("        }\n");
    out.push_str("    }\n\n");

    // expected_length
    out.push_str("    pub fn expected_length(&self) -> usize {\n");
    out.push_str("        match self {\n");
    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("            Self::{} => {},\n", to_pascal_case(name), pkt.length));
    }
    out.push_str("        }\n");
    out.push_str("    }\n\n");

    // category
    out.push_str("    pub fn category(&self) -> &'static str {\n");
    out.push_str("        match self {\n");
    for (name, pkt) in &protocol.packet_types {
        out.push_str(&format!("            Self::{} => \"{}\",\n", to_pascal_case(name), pkt.category));
    }
    out.push_str("        }\n");
    out.push_str("    }\n\n");

    // uses_big_endian_device_id
    out.push_str("    pub fn uses_big_endian_device_id(&self) -> bool {\n");
    out.push_str("        match self {\n");
    for (name, pkt) in &protocol.packet_types {
        let is_be = pkt.device_id_endian == "big";
        out.push_str(&format!("            Self::{} => {},\n", to_pascal_case(name), is_be));
    }
    out.push_str("        }\n");
    out.push_str("    }\n\n");

    // is_virtual
    out.push_str("    pub fn is_virtual(&self) -> bool {\n");
    out.push_str("        match self {\n");
    for (name, pkt) in &protocol.packet_types {
        if pkt.virtual_type {
            out.push_str(&format!("            Self::{} => true,\n", to_pascal_case(name)));
        }
    }
    out.push_str("            _ => false,\n");
    out.push_str("        }\n");
    out.push_str("    }\n");

    out.push_str("}\n\n");
}

fn generate_field_defs(out: &mut String, protocol: &Protocol) {
    out.push_str("/// Field definition for packet parsing\n");
    out.push_str("#[derive(Debug, Clone)]\n");
    out.push_str("pub struct FieldDef {\n");
    out.push_str("    pub name: &'static str,\n");
    out.push_str("    pub offset: usize,\n");
    out.push_str("    pub size: usize,\n");
    out.push_str("    pub format: FieldFormat,\n");
    out.push_str("}\n\n");

    out.push_str("/// Field format types\n");
    out.push_str("#[derive(Debug, Clone, Copy, PartialEq, Eq)]\n");
    out.push_str("pub enum FieldFormat {\n");
    out.push_str("    Hex,\n");
    out.push_str("    Decimal,\n");
    out.push_str("    DeviceId,\n");
    out.push_str("    DeviceIdBe,\n");
    out.push_str("    LevelByte,\n");
    out.push_str("    Level16bit,\n");
    out.push_str("    Button,\n");
    out.push_str("    Action,\n");
    out.push_str("}\n\n");

    // Generate field arrays for each packet type
    out.push_str("/// Packet field definitions\n");
    out.push_str("pub mod fields {\n");
    out.push_str("    use super::{FieldDef, FieldFormat};\n\n");

    for (name, pkt) in &protocol.packet_types {
        if !pkt.fields.is_empty() && pkt.inherits.is_none() {
            generate_field_array(out, name, &pkt.fields);
        }
    }

    out.push_str("}\n\n");
}

fn generate_field_array(out: &mut String, name: &str, fields: &[Field]) {
    let const_name = name.to_uppercase();
    out.push_str(&format!("    pub const {}: &[FieldDef] = &[\n", const_name));

    for field in fields {
        let format = match field.format.as_str() {
            "hex" => "FieldFormat::Hex",
            "decimal" => "FieldFormat::Decimal",
            "device_id" => "FieldFormat::DeviceId",
            "device_id_be" => "FieldFormat::DeviceIdBe",
            "level_byte" => "FieldFormat::LevelByte",
            "level_16bit" => "FieldFormat::Level16bit",
            "button" => "FieldFormat::Button",
            "action" => "FieldFormat::Action",
            _ => "FieldFormat::Hex",
        };
        out.push_str(&format!(
            "        FieldDef {{ name: \"{}\", offset: {}, size: {}, format: {} }},\n",
            field.name, field.offset, field.size, format
        ));
    }

    out.push_str("    ];\n\n");
}

fn generate_sequences(out: &mut String, protocol: &Protocol) {
    out.push_str("/// Transmission sequence definitions\n");
    out.push_str("pub mod sequences {\n");
    out.push_str("    use super::PacketType;\n\n");

    out.push_str("    /// A step in a transmission sequence\n");
    out.push_str("    #[derive(Debug, Clone)]\n");
    out.push_str("    pub struct Step {\n");
    out.push_str("        pub packet_type: PacketType,\n");
    out.push_str("        pub count: Option<u32>,  // None = repeat until stopped\n");
    out.push_str("        pub interval_ms: u32,\n");
    out.push_str("    }\n\n");

    out.push_str("    /// Sequence definition\n");
    out.push_str("    #[derive(Debug, Clone)]\n");
    out.push_str("    pub struct Sequence {\n");
    out.push_str("        pub name: &'static str,\n");
    out.push_str("        pub description: &'static str,\n");
    out.push_str("        pub steps: &'static [Step],\n");
    out.push_str("    }\n\n");

    // Generate sequence constants
    for (name, seq) in protocol.sequences.iter() {
        let const_name = name.to_uppercase();
        out.push_str(&format!("    /// {}\n", seq.description));
        out.push_str(&format!("    pub const {}_STEPS: &[Step] = &[\n", const_name));

        for step in &seq.steps {
            let pkt_type = to_pascal_case(&step.packet);
            let count = match step.count {
                Some(c) => format!("Some({})", c),
                None => "None".to_string(),
            };
            let interval = step.interval_ms.unwrap_or(protocol.timing.button_repeat_ms);
            out.push_str(&format!(
                "        Step {{ packet_type: PacketType::{}, count: {}, interval_ms: {} }},\n",
                pkt_type, count, interval
            ));
        }

        out.push_str("    ];\n\n");

        out.push_str(&format!("    pub const {}: Sequence = Sequence {{\n", const_name));
        out.push_str(&format!("        name: \"{}\",\n", name));
        out.push_str(&format!("        description: \"{}\",\n", seq.description));
        out.push_str(&format!("        steps: {}_STEPS,\n", const_name));
        out.push_str("    };\n\n");
    }

    out.push_str("}\n");
}

fn to_pascal_case(s: &str) -> String {
    s.split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().chain(chars.flat_map(|c| c.to_lowercase())).collect(),
            }
        })
        .collect()
}
