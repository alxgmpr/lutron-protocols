//! C-compatible API for Lutron CCA protocol
//!
//! This module provides a stable C ABI for use with ESPHome and other C/C++ projects.
//! All functions are `extern "C"` and use `#[no_mangle]` for symbol visibility.

use std::os::raw::c_char;
use std::ptr;

use crate::crc;
use crate::n81;
use crate::packet::{PacketParser, PacketType, Button};

/// Maximum raw packet size (pairing packets are 53 bytes)
pub const CCA_MAX_PACKET_LEN: usize = 56;

/// C-compatible decoded packet structure
#[repr(C)]
pub struct CcaPacket {
    /// Whether the packet is valid
    pub valid: bool,
    /// Packet type byte (original wire value)
    pub packet_type: u8,
    /// Decoded packet type (may differ from wire if reclassified)
    pub decoded_type: u8,
    /// Sequence number
    pub sequence: u8,
    /// Source device ID (32-bit)
    pub device_id: u32,
    /// Target device ID (for bridge commands)
    pub target_id: u32,
    /// Button code (for button packets)
    pub button: u8,
    /// Action code (0=press, 1=release)
    pub action: u8,
    /// Level (0-100 for level/state packets)
    pub level: u8,
    /// Format byte at offset 7
    pub format_byte: u8,
    /// CRC value from packet
    pub crc: u16,
    /// Whether CRC is valid
    pub crc_valid: bool,
    /// Raw packet bytes
    pub raw: [u8; CCA_MAX_PACKET_LEN],
    /// Length of raw bytes
    pub raw_len: usize,
}

impl Default for CcaPacket {
    fn default() -> Self {
        Self {
            valid: false,
            packet_type: 0,
            decoded_type: 0,
            sequence: 0,
            device_id: 0,
            target_id: 0,
            button: 0,
            action: 0,
            level: 0,
            format_byte: 0,
            crc: 0,
            crc_valid: false,
            raw: [0u8; CCA_MAX_PACKET_LEN],
            raw_len: 0,
        }
    }
}

/// Opaque decoder handle
pub struct CcaDecoder {
    parser: PacketParser,
}

// ============================================================================
// Decoder lifecycle functions
// ============================================================================

/// Create a new CCA decoder instance
///
/// Returns a pointer to the decoder, or NULL on failure.
/// The caller is responsible for calling `cca_decoder_free` to release memory.
#[no_mangle]
pub extern "C" fn cca_decoder_new() -> *mut CcaDecoder {
    let decoder = Box::new(CcaDecoder {
        parser: PacketParser::new(),
    });
    Box::into_raw(decoder)
}

/// Free a CCA decoder instance
///
/// # Safety
/// The decoder pointer must be valid and not already freed.
#[no_mangle]
pub unsafe extern "C" fn cca_decoder_free(decoder: *mut CcaDecoder) {
    if !decoder.is_null() {
        drop(Box::from_raw(decoder));
    }
}

// ============================================================================
// Decoding functions
// ============================================================================

/// Decode raw CC1101 FIFO data to a Lutron packet
///
/// This function handles N81 decoding from the raw bitstream.
///
/// # Arguments
/// * `decoder` - Decoder instance
/// * `fifo_data` - Raw bytes from CC1101 RXFIFO
/// * `len` - Number of bytes
/// * `packet` - Output packet structure
///
/// # Returns
/// `true` if a valid packet was decoded
///
/// # Safety
/// All pointers must be valid and non-null.
#[no_mangle]
pub unsafe extern "C" fn cca_decode_fifo(
    decoder: *const CcaDecoder,
    fifo_data: *const u8,
    len: usize,
    packet: *mut CcaPacket,
) -> bool {
    if decoder.is_null() || fifo_data.is_null() || packet.is_null() {
        return false;
    }

    let decoder = &*decoder;
    let data = std::slice::from_raw_parts(fifo_data, len);
    let out = &mut *packet;

    *out = CcaPacket::default();

    match decoder.parser.decode_fifo(data) {
        Some(decoded) => {
            fill_c_packet(out, &decoded);
            true
        }
        None => false,
    }
}

/// Parse already-decoded packet bytes (skip N81 decoding)
///
/// Use this when you have raw packet bytes that are already N81-decoded.
///
/// # Arguments
/// * `decoder` - Decoder instance
/// * `bytes` - Decoded packet bytes (24-53 bytes)
/// * `len` - Number of bytes
/// * `packet` - Output packet structure
///
/// # Returns
/// `true` if valid packet structure
///
/// # Safety
/// All pointers must be valid and non-null.
#[no_mangle]
pub unsafe extern "C" fn cca_parse_bytes(
    decoder: *const CcaDecoder,
    bytes: *const u8,
    len: usize,
    packet: *mut CcaPacket,
) -> bool {
    if decoder.is_null() || bytes.is_null() || packet.is_null() {
        return false;
    }

    let decoder = &*decoder;
    let data = std::slice::from_raw_parts(bytes, len);
    let out = &mut *packet;

    *out = CcaPacket::default();

    match decoder.parser.parse_bytes(data) {
        Some(decoded) => {
            fill_c_packet(out, &decoded);
            true
        }
        None => false,
    }
}

// ============================================================================
// CRC functions
// ============================================================================

/// Calculate CRC-16 for packet data
///
/// # Arguments
/// * `data` - Bytes to calculate CRC over
/// * `len` - Number of bytes
///
/// # Returns
/// 16-bit CRC value
#[no_mangle]
pub extern "C" fn cca_calc_crc(data: *const u8, len: usize) -> u16 {
    if data.is_null() || len == 0 {
        return 0;
    }
    let slice = unsafe { std::slice::from_raw_parts(data, len) };
    crc::calc_crc(slice)
}

/// Verify CRC of a complete packet
///
/// # Arguments
/// * `packet` - Complete packet including CRC
/// * `len` - Packet length (24 for standard, 53 for pairing)
///
/// # Returns
/// `true` if CRC is valid
#[no_mangle]
pub extern "C" fn cca_verify_crc(packet: *const u8, len: usize) -> bool {
    if packet.is_null() || len < 24 {
        return false;
    }
    let slice = unsafe { std::slice::from_raw_parts(packet, len) };
    crc::verify_crc(slice)
}

// ============================================================================
// N81 encoding functions
// ============================================================================

/// Decode a single N81 byte from bitstream
///
/// # Arguments
/// * `bits` - Packed bit data (MSB-first byte order)
/// * `bit_offset` - Starting bit position
/// * `byte_out` - Output decoded byte
///
/// # Returns
/// `true` if valid N81 framing
#[no_mangle]
pub unsafe extern "C" fn cca_decode_n81_byte(
    bits: *const u8,
    bits_len: usize,
    bit_offset: usize,
    byte_out: *mut u8,
) -> bool {
    if bits.is_null() || byte_out.is_null() {
        return false;
    }

    let data = std::slice::from_raw_parts(bits, bits_len);
    match n81::decode_n81_byte(data, bit_offset) {
        Some(b) => {
            *byte_out = b;
            true
        }
        None => false,
    }
}

// ============================================================================
// Utility functions
// ============================================================================

/// Get human-readable packet type name
///
/// # Returns
/// Static string pointer (do not free)
#[no_mangle]
pub extern "C" fn cca_packet_type_name(pkt_type: u8) -> *const c_char {
    let name = match PacketType::from_byte(pkt_type) {
        PacketType::ButtonShortA => "BTN_SHORT_A\0",
        PacketType::ButtonLongA => "BTN_LONG_A\0",
        PacketType::ButtonShortB => "BTN_SHORT_B\0",
        PacketType::ButtonLongB => "BTN_LONG_B\0",
        PacketType::StateReport81 | PacketType::StateReport82 | PacketType::StateReport83 => "STATE_RPT\0",
        PacketType::Level => "SET_LEVEL\0",
        PacketType::ConfigA3 => "CONFIG_A3\0",
        PacketType::Beacon => "BEACON\0",
        PacketType::BeaconStop => "BEACON_STOP\0",
        PacketType::PairingB8 => "PAIR_B8\0",
        PacketType::PairingB9 => "PAIR_B9\0",
        PacketType::PairingBA => "PAIR_BA\0",
        PacketType::PairingBB => "PAIR_BB\0",
        PacketType::PairingB0 => "PAIR_B0\0",
        PacketType::PairRespC0 => "PAIR_RESP_C0\0",
        PacketType::PairRespC1 => "PAIR_RESP_C1\0",
        PacketType::PairRespC2 => "PAIR_RESP_C2\0",
        PacketType::PairRespC8 => "PAIR_RESP_C8\0",
        PacketType::Unpair => "UNPAIR\0",
        PacketType::UnpairPrep => "UNPAIR_PREP\0",
        PacketType::LedConfig => "LED_CONFIG\0",
        PacketType::Unknown => "UNKNOWN\0",
    };
    name.as_ptr() as *const c_char
}

/// Get human-readable button name
///
/// # Returns
/// Static string pointer (do not free)
#[no_mangle]
pub extern "C" fn cca_button_name(button: u8) -> *const c_char {
    let name = match Button::from_byte(button) {
        Button::On => "ON\0",
        Button::Favorite => "FAV\0",
        Button::Off => "OFF\0",
        Button::Raise => "RAISE\0",
        Button::Lower => "LOWER\0",
        Button::Scene1 => "SCENE1\0",
        Button::Scene2 => "SCENE2\0",
        Button::Scene3 => "SCENE3\0",
        Button::Scene4 => "SCENE4\0",
        Button::Reset => "RESET\0",
        Button::Unknown => "?\0",
    };
    name.as_ptr() as *const c_char
}

/// Get expected packet length for a type byte
///
/// # Returns
/// Expected length (24 or 53), or 0 for unknown types
#[no_mangle]
pub extern "C" fn cca_get_packet_length(type_byte: u8) -> usize {
    match type_byte {
        0x80..=0x8F => 24, // Button/state packets
        0x90..=0x9F => 24, // Beacons
        0xA0..=0xAF => 24, // Level commands
        0xB0..=0xBF => 53, // Pairing announcements
        0xC0..=0xCF => 24, // Pairing responses
        _ => 0,
    }
}

/// Format device ID as hex string
///
/// # Arguments
/// * `device_id` - 32-bit device ID
/// * `buffer` - Output buffer (at least 9 bytes)
/// * `buffer_len` - Buffer size
///
/// # Returns
/// Number of bytes written (excluding null terminator), or 0 on error
#[no_mangle]
pub unsafe extern "C" fn cca_format_device_id(
    device_id: u32,
    buffer: *mut c_char,
    buffer_len: usize,
) -> usize {
    if buffer.is_null() || buffer_len < 9 {
        return 0;
    }

    let formatted = format!("{:08X}\0", device_id);
    let bytes = formatted.as_bytes();

    if bytes.len() > buffer_len {
        return 0;
    }

    ptr::copy_nonoverlapping(bytes.as_ptr(), buffer as *mut u8, bytes.len());
    8 // Length excluding null terminator
}

// ============================================================================
// Helper functions
// ============================================================================

/// Fill C packet structure from Rust decoded packet
fn fill_c_packet(out: &mut CcaPacket, decoded: &crate::packet::DecodedPacket) {
    out.valid = decoded.valid;
    out.packet_type = decoded.type_byte;
    out.decoded_type = decoded.packet_type as u8;
    out.sequence = decoded.sequence;
    out.device_id = decoded.device_id;
    out.target_id = decoded.target_id.unwrap_or(0);
    out.button = decoded.button.map(|b| b as u8).unwrap_or(0);
    out.action = decoded.action.map(|a| a as u8).unwrap_or(0);
    out.level = decoded.level.unwrap_or(0);
    out.format_byte = decoded.format_byte.unwrap_or(0);
    out.crc = decoded.crc;
    out.crc_valid = decoded.crc_valid;

    out.raw_len = decoded.raw.len().min(CCA_MAX_PACKET_LEN);
    out.raw[..out.raw_len].copy_from_slice(&decoded.raw[..out.raw_len]);
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decoder_lifecycle() {
        unsafe {
            let decoder = cca_decoder_new();
            assert!(!decoder.is_null());
            cca_decoder_free(decoder);
        }
    }

    #[test]
    fn test_parse_bytes() {
        unsafe {
            let decoder = cca_decoder_new();
            assert!(!decoder.is_null());

            // Button press packet with valid CRC
            let payload: [u8; 22] = [
                0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04,
                0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC, 0xCC, 0xCC,
                0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC
            ];
            let crc = cca_calc_crc(payload.as_ptr(), payload.len());
            let mut packet_bytes = payload.to_vec();
            packet_bytes.push((crc >> 8) as u8);
            packet_bytes.push((crc & 0xFF) as u8);

            let mut packet = CcaPacket::default();
            let result = cca_parse_bytes(
                decoder,
                packet_bytes.as_ptr(),
                packet_bytes.len(),
                &mut packet,
            );

            assert!(result);
            assert!(packet.valid);
            assert_eq!(packet.packet_type, 0x88);
            assert_eq!(packet.button, 0x02); // ON button
            assert!(packet.crc_valid);

            cca_decoder_free(decoder);
        }
    }

    #[test]
    fn test_crc_functions() {
        let data: [u8; 4] = [0x88, 0x00, 0x8D, 0xE6];
        let crc = cca_calc_crc(data.as_ptr(), data.len());
        assert!(crc != 0);
    }

    #[test]
    fn test_packet_type_name() {
        let name = cca_packet_type_name(0x88);
        let s = unsafe { std::ffi::CStr::from_ptr(name) };
        assert_eq!(s.to_str().unwrap(), "BTN_SHORT_A");
    }
}
