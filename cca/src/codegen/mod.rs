//! Code generation from protocol YAML definitions
//!
//! This module parses `protocol/cca.yaml` and generates code for multiple targets:
//! - Rust (constants, enums, packet definitions)
//! - C (header file for ESPHome)
//! - TypeScript (for web frontend)
//! - Python (for backend)
//! - Markdown (documentation)

#[cfg(feature = "std")]
mod rust;
#[cfg(feature = "std")]
mod c;
#[cfg(feature = "std")]
mod typescript;
#[cfg(feature = "std")]
mod python;
#[cfg(feature = "std")]
mod markdown;

#[cfg(feature = "std")]
pub use rust::generate_rust;
#[cfg(feature = "std")]
pub use c::generate_c;
#[cfg(feature = "std")]
pub use typescript::generate_typescript;
#[cfg(feature = "std")]
pub use python::generate_python;
#[cfg(feature = "std")]
pub use markdown::generate_markdown;

use std::collections::BTreeMap;
use serde::Deserialize;

/// Root protocol definition
#[derive(Debug, Deserialize)]
pub struct Protocol {
    pub meta: Meta,
    pub rf: RfParams,
    pub crc: CrcConfig,
    pub framing: Framing,
    pub timing: Timing,
    pub sequence: SequenceConfig,
    pub lengths: Lengths,
    #[serde(default)]
    pub field_formats: BTreeMap<String, FieldFormat>,
    pub enums: BTreeMap<String, EnumDef>,
    pub packet_types: BTreeMap<String, PacketType>,
    #[serde(default)]
    pub sequences: BTreeMap<String, SequenceDef>,
    #[serde(default)]
    pub pairing_presets: BTreeMap<String, PairingPreset>,
}

#[derive(Debug, Deserialize)]
pub struct Meta {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct RfParams {
    pub frequency_hz: u32,
    pub deviation_hz: u32,
    pub baud_rate: f32,
    pub modulation: String,
    pub encoding: String,
}

#[derive(Debug, Deserialize)]
pub struct CrcConfig {
    pub polynomial: u16,
    pub width: u8,
    pub initial: u16,
    pub byte_order: String,
}

#[derive(Debug, Deserialize)]
pub struct Framing {
    pub preamble_bits: u8,
    pub preamble_pattern: u32,
    pub sync_byte: u8,
    pub prefix: Vec<u8>,
    pub trailing_bits: u8,
}

#[derive(Debug, Deserialize)]
pub struct Timing {
    pub button_repeat_ms: u32,
    pub beacon_interval_ms: u32,
    pub pairing_interval_ms: u32,
    pub level_report_ms: u32,
    pub unpair_interval_ms: u32,
    pub led_config_interval_ms: u32,
}

#[derive(Debug, Deserialize)]
pub struct SequenceConfig {
    pub increment: u8,
    pub wrap: u8,
}

#[derive(Debug, Deserialize)]
pub struct Lengths {
    pub standard: u8,
    pub pairing: u8,
}

#[derive(Debug, Deserialize)]
pub struct FieldFormat {
    pub description: String,
    #[serde(default)]
    pub size: Option<u8>,
    #[serde(default)]
    pub endian: Option<String>,
    #[serde(default)]
    pub divisor: Option<u32>,
    #[serde(default)]
    pub enum_ref: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EnumDef {
    #[serde(default)]
    pub description: String,
    pub values: BTreeMap<String, EnumValue>,
}

#[derive(Debug, Deserialize)]
pub struct EnumValue {
    #[serde(default)]
    pub value: Option<u8>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct PacketType {
    pub value: u8,
    pub length: u8,
    pub category: String,
    pub description: String,
    #[serde(default)]
    pub device_id_endian: String,
    #[serde(default)]
    pub fields: Vec<Field>,
    #[serde(default)]
    pub inherits: Option<String>,
    #[serde(default)]
    pub virtual_type: bool,
    #[serde(default)]
    pub aliases: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Field {
    pub name: String,
    pub offset: u8,
    pub size: u8,
    pub format: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct SequenceDef {
    pub description: String,
    #[serde(default)]
    pub params: Vec<SequenceParam>,
    pub steps: Vec<SequenceStep>,
}

#[derive(Debug, Deserialize)]
pub struct SequenceParam {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct SequenceStep {
    pub packet: String,
    pub count: Option<u32>,  // None = repeat until stopped
    #[serde(default)]
    pub interval_ms: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct PairingPreset {
    pub description: String,
    pub packet: String,
    pub btn_scheme: u8,
    #[serde(default)]
    pub bytes: BTreeMap<u8, u8>,
}

/// Parse protocol YAML from string
#[cfg(feature = "std")]
pub fn parse_protocol(yaml: &str) -> Result<Protocol, serde_yaml::Error> {
    serde_yaml::from_str(yaml)
}

/// Load and parse protocol from file
#[cfg(feature = "std")]
pub fn load_protocol(path: &std::path::Path) -> Result<Protocol, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let protocol = parse_protocol(&content)?;
    Ok(protocol)
}

/// Target for code generation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Rust,
    C,
    TypeScript,
    Python,
    Markdown,
}

impl Target {
    pub fn all() -> &'static [Target] {
        &[Target::Rust, Target::C, Target::TypeScript, Target::Python, Target::Markdown]
    }

    pub fn from_str(s: &str) -> Option<Target> {
        match s.to_lowercase().as_str() {
            "rust" | "rs" => Some(Target::Rust),
            "c" | "h" => Some(Target::C),
            "typescript" | "ts" => Some(Target::TypeScript),
            "python" | "py" => Some(Target::Python),
            "markdown" | "md" => Some(Target::Markdown),
            _ => None,
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Target::Rust => "rs",
            Target::C => "h",
            Target::TypeScript => "ts",
            Target::Python => "py",
            Target::Markdown => "md",
        }
    }

    pub fn output_dir(&self) -> &'static str {
        match self {
            Target::Rust => "rust",
            Target::C => "c",
            Target::TypeScript => "typescript",
            Target::Python => "python",
            Target::Markdown => "markdown",
        }
    }
}

/// Generate code for specified targets
#[cfg(feature = "std")]
pub fn generate(
    protocol: &Protocol,
    output_dir: &std::path::Path,
    targets: &[Target],
) -> Result<(), Box<dyn std::error::Error>> {
    use std::fs;

    for target in targets {
        let target_dir = output_dir.join(target.output_dir());
        fs::create_dir_all(&target_dir)?;

        match target {
            Target::Rust => {
                let code = generate_rust(protocol);
                fs::write(target_dir.join("mod.rs"), &code)?;
            }
            Target::C => {
                let code = generate_c(protocol);
                fs::write(target_dir.join("cca_protocol.h"), &code)?;
            }
            Target::TypeScript => {
                let code = generate_typescript(protocol);
                fs::write(target_dir.join("protocol.ts"), &code)?;
            }
            Target::Python => {
                let code = generate_python(protocol);
                fs::write(target_dir.join("cca_protocol.py"), &code)?;
            }
            Target::Markdown => {
                let code = generate_markdown(protocol);
                fs::write(target_dir.join("PROTOCOL.md"), &code)?;
            }
        }
    }

    Ok(())
}

/// Check if generated files are up-to-date
#[cfg(feature = "std")]
pub fn check(
    protocol: &Protocol,
    output_dir: &std::path::Path,
    targets: &[Target],
) -> Result<bool, Box<dyn std::error::Error>> {
    use std::fs;

    let mut all_match = true;

    for target in targets {
        let target_dir = output_dir.join(target.output_dir());

        let (filename, expected) = match target {
            Target::Rust => ("mod.rs", generate_rust(protocol)),
            Target::C => ("cca_protocol.h", generate_c(protocol)),
            Target::TypeScript => ("protocol.ts", generate_typescript(protocol)),
            Target::Python => ("cca_protocol.py", generate_python(protocol)),
            Target::Markdown => ("PROTOCOL.md", generate_markdown(protocol)),
        };

        let file_path = target_dir.join(filename);

        if !file_path.exists() {
            eprintln!("Missing: {}", file_path.display());
            all_match = false;
            continue;
        }

        let actual = fs::read_to_string(&file_path)?;
        if actual != expected {
            eprintln!("Out of date: {}", file_path.display());
            all_match = false;
        }
    }

    Ok(all_match)
}
