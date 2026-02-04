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

    /// Decode raw CC1101 FIFO data to Lutron packet
    ///
    /// The CC1101 captures bits after sync word detection. This function:
    /// 1. Finds N81 frame alignment
    /// 2. Decodes as many bytes as possible from N81 format
    /// 3. Uses CRC scanning to find the true packet boundary
    pub fn decode_fifo(&self, fifo_data: &[u8]) -> Option<DecodedPacket> {
        let total_bits = fifo_data.len() * 8;
        if total_bits < 200 {
            return None;
        }

        // Find sync pattern and decode N81 bytes
        let mut best_unverified: Option<DecodedPacket> = None;

        // Optimized search: CC1101 syncs on 0xAAAA preamble, so N81 data starts
        // within first ~20 bits
        for bit_pos in 0..20 {
            if bit_pos + 100 >= total_bits {
                break;
            }

            // Try to decode first 3 bytes to identify start pattern
            let b1 = n81::decode_n81_byte(fifo_data, bit_pos);
            let b2 = n81::decode_n81_byte(fifo_data, bit_pos + 10);
            let b3 = n81::decode_n81_byte(fifo_data, bit_pos + 20);

            let (b1, b2, b3) = match (b1, b2, b3) {
                (Some(a), Some(b), Some(c)) => (a, b, c),
                _ => continue,
            };

            // Determine data start based on pattern found
            let data_start = if b1 == 0xFF && b2 == 0xFA && b3 == 0xDE {
                // Full sync: FF FA DE
                bit_pos + 30
            } else if b1 == 0xFA && b2 == 0xDE && b3 >= 0x80 && b3 <= 0xCF {
                // Short sync: FA DE + packet type
                bit_pos + 20
            } else if b1 >= 0x80 && b1 <= 0xCF && b2 < 0x60 {
                // Direct packet start
                bit_pos
            } else {
                continue;
            };

            // Decode as many bytes as possible (CRC scanning will find the boundary)
            let decoded = n81::decode_n81_stream(fifo_data, data_start, Self::MAX_DECODE_LEN);

            if decoded.len() < 10 {
                continue;
            }

            // Parse with CRC boundary scanning
            if let Some(packet) = self.parse_bytes(&decoded) {
                if packet.crc_valid {
                    return Some(packet); // CRC-verified packet, done
                }
                // Keep best unverified candidate
                if best_unverified
                    .as_ref()
                    .map_or(true, |p| decoded.len() > p.raw.len())
                {
                    best_unverified = Some(packet);
                }
            }
        }

        // Extended search if quick search failed
        if best_unverified.as_ref().map_or(true, |p| p.raw.len() < 10) {
            for bit_pos in 20..(total_bits.saturating_sub(100)) {
                let _b1 = match n81::decode_n81_byte(fifo_data, bit_pos) {
                    Some(b) if b >= 0x80 && b <= 0xCF => b,
                    _ => continue,
                };

                let _b2 = match n81::decode_n81_byte(fifo_data, bit_pos + 10) {
                    Some(b) if b < 0x60 => b,
                    _ => continue,
                };

                let decoded =
                    n81::decode_n81_stream(fifo_data, bit_pos, Self::MAX_DECODE_LEN);

                if decoded.len() < 10 {
                    continue;
                }

                if let Some(packet) = self.parse_bytes(&decoded) {
                    if packet.crc_valid {
                        return Some(packet);
                    }
                    if best_unverified
                        .as_ref()
                        .map_or(true, |p| decoded.len() > p.raw.len())
                    {
                        best_unverified = Some(packet);
                    }
                    break;
                }
            }
        }

        best_unverified
    }

    /// Parse already-decoded packet bytes
    ///
    /// Uses CRC-16 boundary scanning to determine the true packet length.
    /// Bytes beyond the CRC are stripped. If no CRC match is found,
    /// the packet is still returned with `crc_valid = false`.
    pub fn parse_bytes(&self, bytes: &[u8]) -> Option<DecodedPacket> {
        if bytes.len() < 10 {
            return None;
        }

        // Find true packet boundary via CRC scan
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
}
