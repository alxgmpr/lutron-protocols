//! PyO3 Python bindings for CCA library
//!
//! Provides Python access to packet decoding, CRC calculation, and protocol types.
//!
//! Usage:
//! ```python
//! import cca
//!
//! # Decode a packet
//! packet = cca.decode("88 00 8D E6 95 05 21 04 03 00 02 00 ...")
//! print(packet.device_id, packet.packet_type, packet.button)
//!
//! # Calculate CRC
//! crc = cca.calc_crc(bytes.fromhex("88008DE695052104"))
//! ```

use pyo3::prelude::*;
use pyo3::exceptions::PyValueError;

use crate::crc;
use crate::packet::{PacketParser, PacketType, Button};

/// Decoded CCA packet
#[pyclass]
#[derive(Clone)]
pub struct Packet {
    #[pyo3(get)]
    pub packet_type: String,
    #[pyo3(get)]
    pub type_byte: u8,
    #[pyo3(get)]
    pub device_id: String,
    #[pyo3(get)]
    pub target_id: Option<String>,
    #[pyo3(get)]
    pub sequence: u8,
    #[pyo3(get)]
    pub button: Option<String>,
    #[pyo3(get)]
    pub action: Option<String>,
    #[pyo3(get)]
    pub level: Option<u8>,
    #[pyo3(get)]
    pub crc: u16,
    #[pyo3(get)]
    pub crc_valid: bool,
    #[pyo3(get)]
    pub raw: Vec<u8>,
}

#[pymethods]
impl Packet {
    fn __repr__(&self) -> String {
        let mut parts = vec![
            format!("type={}", self.packet_type),
            format!("device={}", self.device_id),
        ];
        if let Some(ref btn) = self.button {
            parts.push(format!("button={}", btn));
        }
        if let Some(ref act) = self.action {
            parts.push(format!("action={}", act));
        }
        if let Some(lvl) = self.level {
            parts.push(format!("level={}", lvl));
        }
        parts.push(format!("seq={}", self.sequence));
        parts.push(format!("crc_ok={}", self.crc_valid));
        format!("Packet({})", parts.join(", "))
    }

    /// Get raw bytes as hex string
    fn hex(&self) -> String {
        self.raw.iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Packet decoder
#[pyclass]
pub struct Decoder {
    parser: PacketParser,
}

#[pymethods]
impl Decoder {
    #[new]
    fn new() -> Self {
        Self {
            parser: PacketParser::new(),
        }
    }

    /// Decode packet from bytes
    fn decode_bytes(&self, data: &[u8]) -> PyResult<Packet> {
        self.parser.parse_bytes(data)
            .map(|p| Packet {
                packet_type: p.packet_type.name().to_string(),
                type_byte: p.type_byte,
                device_id: p.device_id_str(),
                target_id: p.target_id_str(),
                sequence: p.sequence,
                button: p.button.map(|b| b.name().to_string()),
                action: p.action.map(|a| a.name().to_string()),
                level: p.level,
                crc: p.crc,
                crc_valid: p.crc_valid,
                raw: p.raw.clone(),
            })
            .ok_or_else(|| PyValueError::new_err("Failed to decode packet"))
    }

    /// Decode packet from hex string
    fn decode_hex(&self, hex_str: &str) -> PyResult<Packet> {
        let clean: String = hex_str.chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect();
        let bytes = hex::decode(&clean)
            .map_err(|e| PyValueError::new_err(format!("Invalid hex: {}", e)))?;
        self.decode_bytes(&bytes)
    }
}

/// Calculate CRC-16 for data
#[pyfunction]
fn calc_crc(data: &[u8]) -> u16 {
    crc::calc_crc(data)
}

/// Verify CRC of a complete packet
#[pyfunction]
fn verify_crc(packet: &[u8]) -> bool {
    crc::verify_crc(packet)
}

/// Append CRC to packet data
#[pyfunction]
fn append_crc(data: &[u8]) -> Vec<u8> {
    crc::append_crc(data)
}

/// Decode a packet from hex string (convenience function)
#[pyfunction]
fn decode(hex_str: &str) -> PyResult<Packet> {
    let decoder = Decoder::new();
    decoder.decode_hex(hex_str)
}

/// Get packet type name from type byte
#[pyfunction]
fn packet_type_name(type_byte: u8) -> String {
    PacketType::from_byte(type_byte).name().to_string()
}

/// Get button name from button code
#[pyfunction]
fn button_name(button_code: u8) -> String {
    Button::from_byte(button_code).name().to_string()
}

/// Get expected packet length for type byte
#[pyfunction]
fn packet_length(type_byte: u8) -> usize {
    match type_byte {
        0xB0..=0xBF => 53,  // Pairing packets
        _ => 24,            // Standard packets
    }
}

/// Protocol constants
#[pyclass]
pub struct Protocol;

#[pymethods]
impl Protocol {
    #[classattr]
    const FREQUENCY_HZ: u32 = 433_602_844;

    #[classattr]
    const BAUD_RATE: f32 = 62_484.7;

    #[classattr]
    const CRC_POLY: u16 = 0xCA0F;

    #[classattr]
    const PKT_STANDARD_LEN: usize = 24;

    #[classattr]
    const PKT_PAIRING_LEN: usize = 53;
}

/// CCA Python module
#[pymodule]
fn cca(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Packet>()?;
    m.add_class::<Decoder>()?;
    m.add_class::<Protocol>()?;
    m.add_function(wrap_pyfunction!(calc_crc, m)?)?;
    m.add_function(wrap_pyfunction!(verify_crc, m)?)?;
    m.add_function(wrap_pyfunction!(append_crc, m)?)?;
    m.add_function(wrap_pyfunction!(decode, m)?)?;
    m.add_function(wrap_pyfunction!(packet_type_name, m)?)?;
    m.add_function(wrap_pyfunction!(button_name, m)?)?;
    m.add_function(wrap_pyfunction!(packet_length, m)?)?;
    Ok(())
}
