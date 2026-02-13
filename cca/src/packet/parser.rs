//! Packet parser for Lutron CCA protocol
//!
//! Decodes raw CC1101 FIFO data or already-decoded packet bytes.

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

use super::types::*;
use crate::crc;
use crate::n81;

/// Packet parser with CRC validation
pub struct PacketParser;

impl PacketParser {
    /// Create new parser
    pub fn new() -> Self {
        Self
    }

    /// Maximum bytes to attempt decoding from FIFO
    const MAX_DECODE_LEN: usize = 56;

    /// Known CCA packet lengths for CRC validation
    const CCA_LENGTHS: &'static [usize] = &[24, 53];

    /// Maximum bit position to search for sync patterns in FIFO data
    const MAX_SYNC_SEARCH: usize = 500;

    /// Decode raw CC1101 FIFO data to Lutron packet
    ///
    /// Multi-sync decoding strategy:
    /// 1. Search for N81 FF FA DE sync patterns across the FIFO
    /// 2. At each sync, try strict N81 decode → CRC at [24, 53]
    /// 3. If strict fails, try tolerant decoder → CRC at [24, 53]
    /// 4. If neither produces CRC match, continue searching for next sync
    /// 5. Never return unverified packets — CRC must match
    ///
    /// This handles the common case where the CC1101 captures TWO
    /// transmissions in one 80-byte FIFO fill. The first sync may be
    /// from a short packet that hits framing errors, while the actual
    /// 53-byte config packet has its own sync later in the FIFO.
    pub fn decode_fifo(&self, fifo_data: &[u8]) -> Option<DecodedPacket> {
        let total_bits = fifo_data.len() * 8;
        if total_bits < 200 {
            return None;
        }

        let mut search_from: usize = 0;
        let mut dimmer_ack: Option<DecodedPacket> = None;

        loop {
            // Find next FF FA DE sync pattern
            let data_start = match n81::find_sync_offset_from(
                fifo_data,
                search_from,
                Self::MAX_SYNC_SEARCH,
            ) {
                Some(offset) => offset,
                None => break, // No more syncs — check dimmer ACK fallback
            };

            // Try strict N81 decode
            let decoded = n81::decode_n81_stream(fifo_data, data_start, Self::MAX_DECODE_LEN);

            // CRC-valid packets always take priority
            if decoded.len() >= 10 {
                if let Some(len) = crc::check_crc_at_lengths(&decoded, Self::CCA_LENGTHS) {
                    return self.parse_bytes_at_length(&decoded, len, 0);
                }
            }

            // Try tolerant decoder as fallback
            let (tolerant, errors) =
                n81::decode_n81_stream_tolerant(fifo_data, data_start, Self::MAX_DECODE_LEN);

            if tolerant.len() >= 10 && tolerant.len() > decoded.len() {
                if let Some(len) = crc::check_crc_at_lengths(&tolerant, Self::CCA_LENGTHS) {
                    return self.parse_bytes_at_length(&tolerant, len, errors);
                }
            }

            // Save first 0x0B dimmer ACK candidate (only used if no CRC packet found)
            if dimmer_ack.is_none() && decoded.len() >= 5 && decoded[0] == 0x0B {
                dimmer_ack = self.try_parse_dimmer_ack(&decoded);
            }

            // This sync didn't produce a CRC match — advance past it
            // and search for the next one. Move at least 10 bits forward
            // (one N81 byte) to avoid re-matching the same sync.
            search_from = data_start + 10;
        }

        // No CRC-valid packet at any sync — return dimmer ACK if found
        dimmer_ack
    }

    /// Parse already-decoded packet bytes
    ///
    /// Uses fixed-length CRC checking at known CCA sizes [24, 53].
    /// Falls back to exhaustive CRC scanning for compatibility with
    /// RTL-SDR decoder and other callers that may pass unusual lengths.
    /// If no CRC match is found, the packet is still returned with `crc_valid = false`.
    pub fn parse_bytes(&self, bytes: &[u8]) -> Option<DecodedPacket> {
        if bytes.len() < 10 {
            return None;
        }

        // Try fixed-length CRC first (fast path, no false positives)
        if let Some(len) = crc::check_crc_at_lengths(bytes, Self::CCA_LENGTHS) {
            return self.parse_bytes_at_length(bytes, len, 0);
        }

        // Fall back to exhaustive scan for backward compatibility
        // (RTL-SDR decoder may produce non-standard lengths)
        let (packet_bytes, crc_valid, crc_value) = match crc::find_packet_boundary(bytes) {
            Some(len) => {
                let crc_offset = len - 2;
                let crc_val =
                    ((bytes[crc_offset] as u16) << 8) | (bytes[crc_offset + 1] as u16);
                (&bytes[..len], true, crc_val)
            }
            None => (bytes, false, 0u16),
        };

        let mut packet = DecodedPacket::empty();
        packet.raw = packet_bytes.to_vec();
        packet.type_byte = packet_bytes[offsets::TYPE];
        packet.packet_type = PacketType::from_byte(packet.type_byte);
        packet.sequence = packet_bytes[offsets::SEQUENCE];
        packet.crc = crc_value;
        packet.crc_valid = crc_valid;

        // Get format byte if available
        packet.format_byte = packet_bytes.get(offsets::FORMAT).copied();

        // Parse based on packet type
        self.parse_type_specific(&mut packet, packet_bytes);

        packet.valid = true;
        Some(packet)
    }

    /// Parse packet bytes with a known CRC-validated length
    fn parse_bytes_at_length(&self, bytes: &[u8], len: usize, n81_errors: u8) -> Option<DecodedPacket> {
        if len < 10 || bytes.len() < len {
            return None;
        }

        let packet_bytes = &bytes[..len];
        let crc_offset = len - 2;
        let crc_value = ((packet_bytes[crc_offset] as u16) << 8) | (packet_bytes[crc_offset + 1] as u16);

        let mut packet = DecodedPacket::empty();
        packet.raw = packet_bytes.to_vec();
        packet.type_byte = packet_bytes[offsets::TYPE];
        packet.packet_type = PacketType::from_byte(packet.type_byte);
        packet.sequence = packet_bytes[offsets::SEQUENCE];
        packet.crc = crc_value;
        packet.crc_valid = true;
        packet.n81_errors = n81_errors;

        // Get format byte if available
        packet.format_byte = packet_bytes.get(offsets::FORMAT).copied();

        // Parse based on packet type
        self.parse_type_specific(&mut packet, packet_bytes);

        packet.valid = true;
        Some(packet)
    }

    /// Try to parse a 0x0B dimmer ACK packet
    ///
    /// Dimmer ACK format (5 bytes, no CRC):
    ///   byte[0] = 0x0B (type)
    ///   byte[1] = sequence
    ///   byte[2] = response class (0x00=set-level, 0xD0=config)
    ///   byte[3] = byte[1] XOR 0x26 (integrity check)
    ///   byte[4] = response subtype (0x55=set-level, 0x85=config)
    ///
    /// CC1101 has systematic demodulation error on bytes 2 and 4
    /// (XOR 0xFE offset). Corrected here.
    fn try_parse_dimmer_ack(&self, decoded: &[u8]) -> Option<DecodedPacket> {
        if decoded.len() < 5 || decoded[0] != 0x0B {
            return None;
        }

        // Validate XOR integrity check (bytes 1,3 are correct on CC1101)
        if decoded[3] != decoded[1] ^ 0x26 {
            return None;
        }

        // Correct CC1101 demodulation error on bytes 2 and 4
        let mut corrected = decoded[..5].to_vec();
        corrected[2] ^= 0xFE;
        corrected[4] ^= 0xFE;

        let mut packet = DecodedPacket::empty();
        packet.valid = true;
        packet.type_byte = 0x0B;
        packet.packet_type = PacketType::DimmerAck;
        packet.sequence = corrected[1];
        packet.format_byte = Some(corrected[2]); // response class
        packet.level = Some(corrected[4]);        // response subtype
        packet.crc_valid = true; // XOR-validated (no CRC in this format)
        packet.raw = corrected;

        Some(packet)
    }

    /// Parse type-specific fields
    fn parse_type_specific(&self, packet: &mut DecodedPacket, bytes: &[u8]) {
        match packet.packet_type {
            PacketType::ButtonShortA
            | PacketType::ButtonLongA
            | PacketType::ButtonShortB
            | PacketType::ButtonLongB => {
                self.parse_button_packet(packet, bytes);
            }
            PacketType::StateReport81 | PacketType::StateReport82 | PacketType::StateReport83 => {
                self.parse_state_report(packet, bytes);
            }
            PacketType::Level | PacketType::ConfigA3 => {
                self.parse_level_packet(packet, bytes);
            }
            PacketType::PairingB8
            | PacketType::PairingB9
            | PacketType::PairingBA
            | PacketType::PairingBB
            | PacketType::PairingB0 => {
                self.parse_pairing_packet(packet, bytes);
            }
            PacketType::PairRespC0
            | PacketType::HandshakeC1
            | PacketType::HandshakeC2
            | PacketType::HandshakeC7
            | PacketType::HandshakeC8
            | PacketType::HandshakeCD
            | PacketType::HandshakeCE
            | PacketType::HandshakeD3
            | PacketType::HandshakeD4
            | PacketType::HandshakeD9
            | PacketType::HandshakeDA
            | PacketType::HandshakeDF
            | PacketType::HandshakeE0 => {
                self.parse_pairing_response(packet, bytes);
            }
            _ => {
                // Default: little-endian device ID
                packet.device_id = self.read_device_id_le(bytes);
            }
        }
    }

    /// Parse button press packet
    fn parse_button_packet(&self, packet: &mut DecodedPacket, bytes: &[u8]) {
        // Button packets use big-endian device ID (as printed on label)
        packet.device_id = self.read_device_id_be(bytes);

        if bytes.len() > offsets::ACTION {
            packet.button = Some(Button::from_byte(bytes[offsets::BUTTON]));
            packet.action = Some(Action::from_byte(bytes[offsets::ACTION]));
        }
    }

    /// Parse state report packet (0x81-0x83)
    fn parse_state_report(&self, packet: &mut DecodedPacket, bytes: &[u8]) {
        // Device ID is little-endian for state reports
        packet.device_id = self.read_device_id_le(bytes);

        let format_byte = packet.format_byte.unwrap_or(0);

        match format_byte {
            0x0E => {
                // Bridge level command
                packet.packet_type = PacketType::Level;
                if bytes.len() >= 18 {
                    let raw_level = ((bytes[16] as u16) << 8) | (bytes[17] as u16);
                    let calc = (raw_level as u32) * 100 + 32639;
                    let level = (calc / 65279) as u8;
                    packet.level = Some(level.min(100));
                }
                if bytes.len() >= 13 {
                    packet.target_id = Some(self.read_u32_be(&bytes[9..13]));
                }
            }
            0x0C => {
                // Unpair flood
                packet.packet_type = PacketType::Unpair;
                if bytes.len() >= 20 {
                    packet.target_id = Some(self.read_u32_be(&bytes[16..20]));
                }
            }
            0x09 => {
                // Unpair prepare
                packet.packet_type = PacketType::UnpairPrep;
                if bytes.len() >= 13 {
                    packet.target_id = Some(self.read_u32_be(&bytes[9..13]));
                }
            }
            0x08 => {
                // True state report
                if bytes.len() > offsets::LEVEL {
                    let raw_level = bytes[offsets::LEVEL];
                    let level = ((raw_level as u32) * 100 + 127) / 254;
                    packet.level = Some(level as u8);
                }
            }
            _ => {
                // Unknown format - leave as state report
            }
        }
    }

    /// Parse level/config packet (0xA2/0xA3)
    fn parse_level_packet(&self, packet: &mut DecodedPacket, bytes: &[u8]) {
        // Device ID is little-endian
        packet.device_id = self.read_device_id_le(bytes);

        let format_byte = packet.format_byte.unwrap_or(0);

        if format_byte == 0x11 {
            // LED config command
            packet.packet_type = PacketType::LedConfig;
            if bytes.len() >= 24 {
                packet.level = Some(bytes[23]); // LED state at byte 23
            }
            if bytes.len() >= 13 {
                packet.target_id = Some(self.read_u32_be(&bytes[9..13]));
            }
        } else {
            // Standard level command
            packet.packet_type = PacketType::Level;
            if bytes.len() >= 10 {
                packet.level = Some(bytes[9]);
            }
            if bytes.len() >= 14 {
                packet.target_id = Some(self.read_device_id_le(&bytes[10..14]));
            }
        }
    }

    /// Parse pairing announcement packet (0xB8-0xBB, 0xB0)
    fn parse_pairing_packet(&self, packet: &mut DecodedPacket, bytes: &[u8]) {
        // Pairing packets use big-endian device ID
        packet.device_id = self.read_device_id_be(bytes);
    }

    /// Parse pairing response packet (0xC0-0xC8)
    fn parse_pairing_response(&self, packet: &mut DecodedPacket, bytes: &[u8]) {
        // Pairing responses use big-endian device ID
        packet.device_id = self.read_device_id_be(bytes);
    }

    /// Read device ID as big-endian (offset 2-5)
    fn read_device_id_be(&self, bytes: &[u8]) -> u32 {
        if bytes.len() < offsets::DEVICE_ID + 4 {
            return 0;
        }
        let slice = &bytes[offsets::DEVICE_ID..offsets::DEVICE_ID + 4];
        ((slice[0] as u32) << 24)
            | ((slice[1] as u32) << 16)
            | ((slice[2] as u32) << 8)
            | (slice[3] as u32)
    }

    /// Read device ID as little-endian (offset 2-5)
    fn read_device_id_le(&self, bytes: &[u8]) -> u32 {
        if bytes.len() < offsets::DEVICE_ID + 4 {
            return 0;
        }
        let slice = &bytes[offsets::DEVICE_ID..offsets::DEVICE_ID + 4];
        (slice[0] as u32)
            | ((slice[1] as u32) << 8)
            | ((slice[2] as u32) << 16)
            | ((slice[3] as u32) << 24)
    }

    /// Read u32 big-endian from slice
    fn read_u32_be(&self, bytes: &[u8]) -> u32 {
        if bytes.len() < 4 {
            return 0;
        }
        ((bytes[0] as u32) << 24)
            | ((bytes[1] as u32) << 16)
            | ((bytes[2] as u32) << 8)
            | (bytes[3] as u32)
    }
}

impl Default for PacketParser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_button_packet() {
        // Example button press: ON button, device 0595E68D
        let bytes = hex::decode("88008DE695052104030002000000000000000000000000").unwrap();

        let parser = PacketParser::new();
        let packet = parser.parse_bytes(&bytes).unwrap();

        assert!(packet.valid);
        assert_eq!(packet.packet_type, PacketType::ButtonShortA);
        assert_eq!(packet.type_byte, 0x88);
        assert_eq!(packet.sequence, 0x00);
        // Note: device ID depends on endianness interpretation
        assert_eq!(packet.button, Some(Button::On));
        assert_eq!(packet.action, Some(Action::Press));
    }

    #[test]
    fn test_crc_validation() {
        // Create a packet with correct CRC
        let payload = vec![
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04, 0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        ];
        let packet_bytes = crc::append_crc(&payload);

        let parser = PacketParser::new();
        let packet = parser.parse_bytes(&packet_bytes).unwrap();

        assert!(packet.crc_valid);
    }

    #[test]
    fn test_decode_fifo_24byte_packet() {
        // Build a proper N81-encoded FIFO stream: preamble + FF FA DE + 24-byte packet
        let payload = vec![
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04, 0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        ];
        let packet_bytes = crc::append_crc(&payload);
        let fifo = n81::encode_packet(&packet_bytes);

        let parser = PacketParser::new();
        let packet = parser.decode_fifo(&fifo).unwrap();

        assert!(packet.valid);
        assert!(packet.crc_valid);
        assert_eq!(packet.type_byte, 0x88);
        assert_eq!(packet.raw.len(), 24);
        assert_eq!(packet.n81_errors, 0);
    }

    #[test]
    fn test_decode_fifo_53byte_packet() {
        // Build a 53-byte config packet (type 0xB9)
        let mut payload = vec![0xB9; 51];
        payload[1] = 0x06; // sequence
        let packet_bytes = crc::append_crc(&payload);
        assert_eq!(packet_bytes.len(), 53);

        let fifo = n81::encode_packet(&packet_bytes);

        let parser = PacketParser::new();
        let packet = parser.decode_fifo(&fifo).unwrap();

        assert!(packet.valid);
        assert!(packet.crc_valid);
        assert_eq!(packet.type_byte, 0xB9);
        assert_eq!(packet.raw.len(), 53);
    }

    #[test]
    fn test_decode_fifo_rejects_garbage() {
        // Garbage data that looks like a "direct packet start" (0x2C at byte 0)
        // but has no FF FA DE sync — should be rejected
        let garbage = vec![0x2C, 0x05, 0xAB, 0xCD, 0xEF, 0x01, 0x02, 0x03,
                           0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
                           0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13,
                           0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B,
                           0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23];

        let parser = PacketParser::new();
        let result = parser.decode_fifo(&garbage);

        assert!(result.is_none());
    }

    #[test]
    fn test_decode_fifo_sync_at_high_offset() {
        // Sync beyond bit 20 — the old code would have missed this
        // Put 10 bytes of junk, then the real packet
        let payload = vec![
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04, 0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        ];
        let packet_bytes = crc::append_crc(&payload);
        let encoded = n81::encode_packet(&packet_bytes);

        // Prepend junk bytes to push the sync later
        let mut fifo = vec![0x55; 10]; // 80 bits of junk
        fifo.extend_from_slice(&encoded);

        let parser = PacketParser::new();
        let packet = parser.decode_fifo(&fifo).unwrap();

        assert!(packet.valid);
        assert!(packet.crc_valid);
        assert_eq!(packet.type_byte, 0x88);
    }

    #[test]
    fn test_decode_fifo_real_config_packet_sync_search() {
        // Real FIFO data from ESP32 log (first 20 bytes of 80)
        // This is a Vive fade config packet: AA AA AA AB FE 5F 9E ED 09 82 0B 81 2A 1B 73 6E 10 15 14 A8
        let fifo_prefix: Vec<u8> = vec![
            0xAA, 0xAA, 0xAA, 0xAB, 0xFE, 0x5F, 0x9E, 0xED,
            0x09, 0x82, 0x0B, 0x81, 0x2A, 0x1B, 0x73, 0x6E,
            0x10, 0x15, 0x14, 0xA8,
        ];

        // Verify find_sync_offset can find FF FA DE in this data
        let sync_offset = n81::find_sync_offset(&fifo_prefix);
        assert!(sync_offset.is_some(), "Should find FF FA DE sync in real FIFO data");

        let data_start = sync_offset.unwrap();
        // With 20 bytes = 160 bits, verify we can decode some N81 bytes after sync
        let decoded = n81::decode_n81_stream(&fifo_prefix, data_start, 10);
        assert!(decoded.len() >= 3, "Should decode at least 3 bytes after sync, got {}", decoded.len());

        // Print the decoded bytes for analysis
        println!("Sync at bit {}, decoded {} bytes: {:02X?}", data_start, decoded.len(), decoded);
    }

    /// Brute-force diagnostic: search every bit position in real dimmer FIFO data
    /// for ANY valid CCA packet (24 or 53 bytes with valid CRC).
    ///
    /// This answers definitively: is there a valid CCA packet hiding anywhere
    /// in the dimmer's FIFO data, regardless of sync pattern?
    #[test]
    fn test_bruteforce_dimmer_fifo_search() {
        // Real dimmer state report FIFO data from ESP32 log (RSSI=-61)
        // This is the packet that decodes as 0B 05 FE 23 AB with strict=5
        let fifo: Vec<u8> = vec![
            // FIFO[0..40]
            0xAA, 0xAA, 0xAB, 0xFE, 0x5F, 0x9E, 0xED, 0x0A,
            0x82, 0x7F, 0xB1, 0x2D, 0x5E, 0xB7, 0xCE, 0xB2,
            0x88, 0x31, 0x8F, 0x8A, 0xBE, 0xC2, 0x3A, 0x1D,
            0x10, 0xD1, 0x0C, 0x9C, 0x82, 0x3A, 0xB9, 0xA1,
            0x1B, 0x1F, 0x44, 0x32, 0xA7, 0x64, 0x0C, 0x71,
            // FIFO[40..80]
            0x86, 0xEA, 0x14, 0x6E, 0x8A, 0x27, 0x34, 0xFE,
            0x6E, 0x80, 0xFE, 0x28, 0x82, 0x4B, 0x6A, 0xD4,
            0x88, 0x30, 0xC9, 0x03, 0x60, 0x8C, 0xD6, 0xBE,
            0xE8, 0x30, 0x09, 0x47, 0xBC, 0x00, 0x66, 0x06,
            0x42, 0xC8, 0x64, 0x1A, 0x92, 0xA2, 0x23, 0xA7,
            // FIFO[80..110]
            0xFC, 0xEF, 0x5F, 0x25, 0x58, 0xF2, 0xA4, 0x31,
            0xE0, 0x58, 0xA9, 0x61, 0xB8, 0xD8, 0x52, 0x0C,
            0x01, 0x24, 0x52, 0x1F, 0xE6, 0x80, 0x3A, 0xF9,
            0x55, 0x5D, 0x5A, 0x0B, 0xFC, 0x9D,
        ];

        let total_bits = fifo.len() * 8;
        let mut found_any = false;

        println!("\n=== BRUTE FORCE N81 SCAN: dimmer FIFO (110 bytes, {} bits) ===", total_bits);

        // Strategy 1: N81 decode at every bit position, check CRC at [24, 53]
        for bit_pos in 0..total_bits.saturating_sub(240) {
            let decoded = n81::decode_n81_stream(&fifo, bit_pos, 56);
            if decoded.len() >= 24 {
                if let Some(len) = crc::check_crc_at_lengths(&decoded, &[24, 53]) {
                    println!("*** CRC MATCH at bit {} (N81): len={} type=0x{:02X} first8={:02X?}",
                             bit_pos, len, decoded[0], &decoded[..8.min(decoded.len())]);
                    found_any = true;
                }
            }
        }

        // Strategy 2: Also try tolerant N81 at every bit position
        for bit_pos in 0..total_bits.saturating_sub(240) {
            let (decoded, errors) = n81::decode_n81_stream_tolerant(&fifo, bit_pos, 56);
            if errors > 0 && decoded.len() >= 24 {
                if let Some(len) = crc::check_crc_at_lengths(&decoded, &[24, 53]) {
                    println!("*** CRC MATCH at bit {} (tolerant, {} errors): len={} type=0x{:02X} first8={:02X?}",
                             bit_pos, errors, len, decoded[0], &decoded[..8.min(decoded.len())]);
                    found_any = true;
                }
            }
        }

        // Strategy 3: Treat FIFO as raw bytes (no N81), scan for CRC at every offset
        println!("\n--- RAW BYTE CRC SCAN (no N81) ---");
        for offset in 0..fifo.len().saturating_sub(24) {
            let slice = &fifo[offset..];
            if let Some(len) = crc::check_crc_at_lengths(slice, &[24, 53]) {
                println!("*** RAW CRC MATCH at byte {} len={} type=0x{:02X} first8={:02X?}",
                         offset, len, slice[0], &slice[..8.min(slice.len())]);
                found_any = true;
            }
        }

        // Strategy 4: Exhaustive CRC scan (any length) on N81-decoded data at sync position
        println!("\n--- EXHAUSTIVE CRC AT SYNC POSITION ---");
        if let Some(data_start) = n81::find_sync_offset_range(&fifo, 500) {
            let decoded = n81::decode_n81_stream(&fifo, data_start, 56);
            let (tolerant, _) = n81::decode_n81_stream_tolerant(&fifo, data_start, 56);
            println!("Sync found, data_start={}, strict={} bytes, tolerant={} bytes",
                     data_start, decoded.len(), tolerant.len());
            println!("Strict decoded: {:02X?}", &decoded);
            println!("Tolerant decoded: {:02X?}", &tolerant);

            // Try exhaustive on tolerant data
            if let Some(len) = crc::find_packet_boundary(&tolerant) {
                println!("*** EXHAUSTIVE CRC MATCH on tolerant data: len={}", len);
                found_any = true;
            }
        }

        // Strategy 5: Report longest strict N81 runs at each bit position
        println!("\n--- LONGEST N81 RUNS (>= 10 bytes) ---");
        for bit_pos in 0..total_bits.saturating_sub(100) {
            let decoded = n81::decode_n81_stream(&fifo, bit_pos, 56);
            if decoded.len() >= 10 {
                println!("bit {}: {} bytes, first8={:02X?}",
                         bit_pos, decoded.len(),
                         &decoded[..8.min(decoded.len())]);
            }
        }

        if !found_any {
            println!("\n*** NO VALID CCA PACKET FOUND IN DIMMER FIFO ***");
            println!("The dimmer may not be sending standard CCA packets for state reports.");
        }
    }

    /// Same brute-force search on a SECOND dimmer packet for confirmation
    #[test]
    fn test_bruteforce_dimmer_fifo_search_2() {
        // Second dimmer packet (different retransmission, RSSI=-62)
        let fifo: Vec<u8> = vec![
            // FIFO[0..40]
            0xAA, 0xAA, 0xAA, 0xFF, 0x97, 0xE7, 0xBB, 0x42,
            0xEC, 0x9F, 0xE8, 0x8B, 0x57, 0xDE, 0x1F, 0x47,
            0x90, 0x7A, 0x6D, 0xE0, 0x9D, 0x80, 0xB1, 0x80,
            0x1C, 0x7F, 0xAE, 0xEF, 0x60, 0x56, 0x6C, 0x07,
            0xEF, 0xAB, 0xF3, 0x40, 0x13, 0x11, 0x70, 0xBD,
            // FIFO[40..80]
            0xEB, 0x36, 0x74, 0x05, 0xBB, 0x33, 0x8E, 0x9B,
            0x63, 0xDD, 0x81, 0xA0, 0x44, 0xA3, 0x68, 0x90,
            0x06, 0x19, 0x2E, 0xFE, 0x60, 0xBF, 0x02, 0xDA,
            0x18, 0x4A, 0xCE, 0xC3, 0x31, 0x88, 0x58, 0x27,
            0x6C, 0x5A, 0xCD, 0xF7, 0x42, 0xEF, 0x09, 0xEC,
            // FIFO[80..110]
            0x58, 0xDE, 0x40, 0x91, 0x98, 0xAA, 0xAF, 0xED,
            0x98, 0x1F, 0xE1, 0x61, 0xEE, 0xC0, 0xC0, 0x61,
            0x45, 0xD7, 0xAB, 0x48, 0x09, 0x6E, 0xA2, 0x10,
            0x62, 0x93, 0x67, 0x70, 0x74, 0x6A,
        ];

        let total_bits = fifo.len() * 8;

        println!("\n=== BRUTE FORCE N81 SCAN: dimmer FIFO #2 ({} bits) ===", total_bits);

        let mut found_any = false;

        // N81 at every bit position
        for bit_pos in 0..total_bits.saturating_sub(240) {
            let decoded = n81::decode_n81_stream(&fifo, bit_pos, 56);
            if decoded.len() >= 24 {
                if let Some(len) = crc::check_crc_at_lengths(&decoded, &[24, 53]) {
                    println!("*** CRC MATCH at bit {} (N81): len={} type=0x{:02X}", bit_pos, len, decoded[0]);
                    found_any = true;
                }
            }
        }

        // Tolerant N81
        for bit_pos in 0..total_bits.saturating_sub(240) {
            let (decoded, errors) = n81::decode_n81_stream_tolerant(&fifo, bit_pos, 56);
            if errors > 0 && decoded.len() >= 24 {
                if let Some(len) = crc::check_crc_at_lengths(&decoded, &[24, 53]) {
                    println!("*** CRC MATCH at bit {} (tolerant): len={} type=0x{:02X}", bit_pos, len, decoded[0]);
                    found_any = true;
                }
            }
        }

        // Raw byte scan
        for offset in 0..fifo.len().saturating_sub(24) {
            if let Some(len) = crc::check_crc_at_lengths(&fifo[offset..], &[24, 53]) {
                println!("*** RAW CRC at byte {}: len={} type=0x{:02X}", offset, len, fifo[offset]);
                found_any = true;
            }
        }

        // Report longest N81 runs
        println!("\n--- LONGEST N81 RUNS (>= 10 bytes) ---");
        for bit_pos in 0..total_bits.saturating_sub(100) {
            let decoded = n81::decode_n81_stream(&fifo, bit_pos, 56);
            if decoded.len() >= 10 {
                println!("bit {}: {} bytes, first8={:02X?}",
                         bit_pos, decoded.len(),
                         &decoded[..8.min(decoded.len())]);
            }
        }

        if !found_any {
            println!("\n*** NO VALID CCA PACKET FOUND IN DIMMER FIFO #2 ***");
        }
    }

    /// Brute-force search on a BRIDGE packet from same session (RSSI=-75, should find valid CCA)
    /// This serves as a control test — if the bridge packet contains valid CCA, the scan works.
    #[test]
    fn test_bruteforce_bridge_fifo_control() {
        // Bridge packet at RSSI=-75, strict=20, first8=8399AF902C00214E
        let fifo: Vec<u8> = vec![
            // FIFO[0..40]
            0xAA, 0xAA, 0xAA, 0xBF, 0xE5, 0xF9, 0xEE, 0xC1,
            0xA6, 0x6F, 0x58, 0x26, 0x34, 0x80, 0x28, 0x49,
            0xCA, 0x00, 0xB8, 0x25, 0x28, 0x46, 0x83, 0x9F,
            0xE2, 0x29, 0x02, 0x7F, 0xBF, 0xE0, 0x0A, 0x03,
            0x00, 0x80, 0x0E, 0x48, 0xF2, 0xE0, 0x27, 0x75,
            // FIFO[40..80]
            0xA0, 0x46, 0x00, 0x79, 0xFA, 0x13, 0xF8, 0xF1,
            0x80, 0x57, 0xBE, 0x17, 0x53, 0x5C, 0x43, 0x8B,
            0x07, 0x7E, 0x3E, 0x9D, 0xD1, 0x99, 0xDB, 0xDE,
            0xD8, 0x02, 0xF3, 0x70, 0xC1, 0x02, 0x9F, 0xDF,
            0xEA, 0x20, 0xE4, 0xF0, 0x98, 0xCE, 0xAA, 0xAA,
            // FIFO[80..110]
            0xAA, 0xAA, 0xAA, 0xFF, 0xFF, 0x97, 0xE7, 0xBB,
            0x42, 0x98, 0x9F, 0xEF, 0xCB, 0x57, 0xC0, 0x5F,
            0x0A, 0xEB, 0x93, 0x11, 0xE2, 0x90, 0x1F, 0x8D,
            0xF4, 0x1E, 0xFC, 0x36, 0xD8, 0x4B,
        ];

        let total_bits = fifo.len() * 8;
        println!("\n=== BRUTE FORCE N81 SCAN: BRIDGE FIFO (control, {} bits) ===", total_bits);

        let mut found_any = false;

        for bit_pos in 0..total_bits.saturating_sub(240) {
            let decoded = n81::decode_n81_stream(&fifo, bit_pos, 56);
            if decoded.len() >= 24 {
                if let Some(len) = crc::check_crc_at_lengths(&decoded, &[24, 53]) {
                    println!("*** CRC MATCH at bit {} (N81): len={} type=0x{:02X} first8={:02X?}",
                             bit_pos, len, decoded[0], &decoded[..8.min(decoded.len())]);
                    found_any = true;
                }
            }
        }

        // Also try tolerant
        for bit_pos in 0..total_bits.saturating_sub(240) {
            let (decoded, errors) = n81::decode_n81_stream_tolerant(&fifo, bit_pos, 56);
            if errors > 0 && decoded.len() >= 24 {
                if let Some(len) = crc::check_crc_at_lengths(&decoded, &[24, 53]) {
                    println!("*** CRC MATCH at bit {} (tolerant, {} errors): len={} type=0x{:02X}",
                             bit_pos, errors, len, decoded[0]);
                    found_any = true;
                }
            }
        }

        // Report longest N81 runs
        println!("\n--- LONGEST N81 RUNS (>= 15 bytes) ---");
        for bit_pos in 0..total_bits.saturating_sub(100) {
            let decoded = n81::decode_n81_stream(&fifo, bit_pos, 56);
            if decoded.len() >= 15 {
                println!("bit {}: {} bytes, first8={:02X?}",
                         bit_pos, decoded.len(),
                         &decoded[..8.min(decoded.len())]);
            }
        }

        if !found_any {
            println!("\n*** NO CRC MATCH IN BRIDGE FIFO (even at 812 kHz too noisy) ***");
        }
    }

    #[test]
    fn test_decode_fifo_dimmer_ack() {
        // Real dimmer ACK FIFO data - the N81-decoded bytes at the sync position
        // are 0B 05 FE 23 AB (CC1101 demodulation error on bytes 2,4).
        // After correction: 0B 05 00 23 55
        // Use the actual FIFO data from test_bruteforce_dimmer_fifo_search
        let fifo: Vec<u8> = vec![
            0xAA, 0xAA, 0xAB, 0xFE, 0x5F, 0x9E, 0xED, 0x0A,
            0x82, 0x7F, 0xB1, 0x2D, 0x5E, 0xB7, 0xCE, 0xB2,
            0x88, 0x31, 0x8F, 0x8A, 0xBE, 0xC2, 0x3A, 0x1D,
            0x10, 0xD1, 0x0C, 0x9C, 0x82, 0x3A, 0xB9, 0xA1,
            0x1B, 0x1F, 0x44, 0x32, 0xA7, 0x64, 0x0C, 0x71,
            0x86, 0xEA, 0x14, 0x6E, 0x8A, 0x27, 0x34, 0xFE,
            0x6E, 0x80, 0xFE, 0x28, 0x82, 0x4B, 0x6A, 0xD4,
            0x88, 0x30, 0xC9, 0x03, 0x60, 0x8C, 0xD6, 0xBE,
            0xE8, 0x30, 0x09, 0x47, 0xBC, 0x00, 0x66, 0x06,
            0x42, 0xC8, 0x64, 0x1A, 0x92, 0xA2, 0x23, 0xA7,
            0xFC, 0xEF, 0x5F, 0x25, 0x58, 0xF2, 0xA4, 0x31,
            0xE0, 0x58, 0xA9, 0x61, 0xB8, 0xD8, 0x52, 0x0C,
            0x01, 0x24, 0x52, 0x1F, 0xE6, 0x80, 0x3A, 0xF9,
            0x55, 0x5D, 0x5A, 0x0B, 0xFC, 0x9D,
        ];

        let parser = PacketParser::new();
        let packet = parser.decode_fifo(&fifo);

        assert!(packet.is_some(), "Should detect 0x0B dimmer ACK in FIFO");
        let pkt = packet.unwrap();
        assert!(pkt.valid);
        assert!(pkt.crc_valid);
        assert_eq!(pkt.packet_type, PacketType::DimmerAck);
        assert_eq!(pkt.type_byte, 0x0B);
        assert_eq!(pkt.sequence, 0x05);
        // Corrected bytes: response class and subtype
        assert_eq!(pkt.format_byte, Some(0x00)); // set-level ACK
        assert_eq!(pkt.level, Some(0x55));        // set-level subtype
        assert_eq!(pkt.raw.len(), 5);
        // Corrected raw bytes
        assert_eq!(pkt.raw, vec![0x0B, 0x05, 0x00, 0x23, 0x55]);
    }

    #[test]
    fn test_dimmer_ack_xor_validation() {
        // Build a synthetic 0x0B packet in N81-encoded FIFO
        // CC1101 raw bytes: 0B 09 FE 2F AB
        // (byte3 = 0x09 XOR 0x26 = 0x2F, bytes 2,4 have 0xFE error)
        let raw_ack = vec![0x0B, 0x09, 0xFE, 0x2F, 0xAB];
        let mut fifo = n81::encode_packet(&raw_ack);
        // Pad to 30+ bytes so total_bits >= 200 (CC1101 FIFO is always 110 bytes)
        fifo.resize(40, 0x00);

        let parser = PacketParser::new();
        let packet = parser.decode_fifo(&fifo);

        assert!(packet.is_some(), "Should detect synthetic 0x0B ACK");
        let pkt = packet.unwrap();
        assert_eq!(pkt.packet_type, PacketType::DimmerAck);
        assert_eq!(pkt.sequence, 0x09);
        assert_eq!(pkt.raw, vec![0x0B, 0x09, 0x00, 0x2F, 0x55]);
    }

    #[test]
    fn test_dimmer_ack_rejects_bad_xor() {
        // 0x0B packet with wrong XOR check — should be rejected
        let raw_bad = vec![0x0B, 0x09, 0xFE, 0x99, 0xAB]; // byte3 != byte1^0x26
        let mut fifo = n81::encode_packet(&raw_bad);
        fifo.resize(40, 0x00);

        let parser = PacketParser::new();
        let packet = parser.decode_fifo(&fifo);

        assert!(packet.is_none(), "Should reject 0x0B with invalid XOR check");
    }

    #[test]
    fn test_parse_bytes_uses_fixed_lengths() {
        // 24-byte packet with trailing data that could cause a false CRC at len 15
        let payload = vec![
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04, 0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        ];
        let packet_bytes = crc::append_crc(&payload);

        let parser = PacketParser::new();
        let packet = parser.parse_bytes(&packet_bytes).unwrap();

        assert!(packet.crc_valid);
        assert_eq!(packet.raw.len(), 24);
    }
}
