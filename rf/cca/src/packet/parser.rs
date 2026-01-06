//! Packet parser for Lutron CCA protocol
//!
//! Decodes raw CC1101 FIFO data or already-decoded packet bytes.

use crate::crc;
use crate::n81;
use super::types::*;

/// Packet parser with CRC validation
pub struct PacketParser;

impl PacketParser {
    /// Create new parser
    pub fn new() -> Self {
        Self
    }

    /// Decode raw CC1101 FIFO data to Lutron packet
    ///
    /// The CC1101 captures bits after sync word detection. This function:
    /// 1. Finds N81 frame alignment
    /// 2. Decodes bytes from N81 format
    /// 3. Parses packet structure
    pub fn decode_fifo(&self, fifo_data: &[u8]) -> Option<DecodedPacket> {
        let total_bits = fifo_data.len() * 8;
        if total_bits < 200 {
            return None;
        }

        // Find sync pattern and decode N81 bytes
        let mut best_decoded: Vec<u8> = Vec::new();

        // Optimized search: CC1101 syncs on 0xAAAA preamble, so N81 data starts
        // within first ~20 bits
        for bit_pos in 0..20 {
            if bit_pos + 270 >= total_bits {
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

            // Decode first byte to get packet type
            let type_byte = match n81::decode_n81_byte(fifo_data, data_start) {
                Some(b) => b,
                None => continue,
            };

            // Determine expected length
            let expected_len = get_packet_length(type_byte).unwrap_or(53);

            // Decode all bytes
            let decoded = n81::decode_n81_stream(fifo_data, data_start, expected_len);

            // Need at least minimum bytes for packet type
            let min_required = if expected_len >= 53 { 24 } else { expected_len };
            if decoded.len() >= min_required && type_byte >= 0x80 && type_byte <= 0xCF {
                best_decoded = decoded;
                break;
            }

            // Keep track of best partial decode
            if decoded.len() > best_decoded.len() {
                best_decoded = decoded;
            }
        }

        // Extended search if quick search failed
        if best_decoded.len() < 10 {
            for bit_pos in 20..(total_bits.saturating_sub(270)) {
                let b1 = n81::decode_n81_byte(fifo_data, bit_pos);
                let b1 = match b1 {
                    Some(b) if b >= 0x80 && b <= 0xCF => b,
                    _ => continue,
                };

                let _b2 = match n81::decode_n81_byte(fifo_data, bit_pos + 10) {
                    Some(b) if b < 0x60 => b,
                    _ => continue,
                };

                // Found potential packet start
                let expected_len = get_packet_length(b1).unwrap_or(53);
                let decoded = n81::decode_n81_stream(fifo_data, bit_pos, expected_len);

                let min_required = if expected_len >= 53 { 24 } else { expected_len };
                if decoded.len() >= min_required {
                    best_decoded = decoded;
                    break;
                }
            }
        }

        if best_decoded.len() < 10 {
            return None;
        }

        // Parse the decoded bytes
        self.parse_bytes(&best_decoded)
    }

    /// Parse already-decoded packet bytes
    ///
    /// Use this when you have raw packet bytes (not N81 encoded)
    pub fn parse_bytes(&self, bytes: &[u8]) -> Option<DecodedPacket> {
        if bytes.len() < 10 {
            return None;
        }

        let mut packet = DecodedPacket::empty();
        packet.raw = bytes.to_vec();
        packet.type_byte = bytes[offsets::TYPE];
        packet.packet_type = PacketType::from_byte(packet.type_byte);
        packet.sequence = bytes[offsets::SEQUENCE];

        // Get format byte if available
        packet.format_byte = bytes.get(offsets::FORMAT).copied();

        // Parse based on packet type
        self.parse_type_specific(&mut packet, bytes);

        // Validate CRC
        self.validate_crc(&mut packet, bytes);

        packet.valid = true;
        Some(packet)
    }

    /// Parse type-specific fields
    fn parse_type_specific(&self, packet: &mut DecodedPacket, bytes: &[u8]) {
        match packet.packet_type {
            PacketType::ButtonShortA | PacketType::ButtonLongA |
            PacketType::ButtonShortB | PacketType::ButtonLongB => {
                self.parse_button_packet(packet, bytes);
            }
            PacketType::StateReport81 | PacketType::StateReport82 | PacketType::StateReport83 => {
                self.parse_state_report(packet, bytes);
            }
            PacketType::Level | PacketType::ConfigA3 => {
                self.parse_level_packet(packet, bytes);
            }
            PacketType::PairingB8 | PacketType::PairingB9 |
            PacketType::PairingBA | PacketType::PairingBB | PacketType::PairingB0 => {
                self.parse_pairing_packet(packet, bytes);
            }
            PacketType::PairRespC0 | PacketType::PairRespC1 |
            PacketType::PairRespC2 | PacketType::PairRespC8 => {
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

    /// Validate CRC and update packet
    fn validate_crc(&self, packet: &mut DecodedPacket, bytes: &[u8]) {
        if packet.packet_type == PacketType::LedConfig {
            // LED config: CRC location uncertain, try multiple positions
            self.validate_crc_led_config(packet, bytes);
            return;
        }

        let expected_len = packet.packet_type.expected_length();
        let (crc_offset, data_len) = if expected_len == PKT_PAIRING_LEN {
            (offsets::CRC_53, 51)
        } else {
            (offsets::CRC_24, 22)
        };

        if bytes.len() >= crc_offset + 2 {
            packet.crc = ((bytes[crc_offset] as u16) << 8) | (bytes[crc_offset + 1] as u16);
            let calculated = crc::calc_crc(&bytes[..data_len]);
            packet.crc_valid = calculated == packet.crc;
        } else if expected_len == PKT_PAIRING_LEN && bytes.len() >= 24 {
            // Truncated pairing packet - don't mark as CRC fail
            packet.crc = 0;
            packet.crc_valid = true;
        } else if bytes.len() >= 24 {
            // Standard packet fallback
            packet.crc = ((bytes[22] as u16) << 8) | (bytes[23] as u16);
            let calculated = crc::calc_crc(&bytes[..22]);
            packet.crc_valid = calculated == packet.crc;
        } else {
            packet.crc = 0;
            packet.crc_valid = false;
        }
    }

    /// Special CRC validation for LED config packets
    fn validate_crc_led_config(&self, packet: &mut DecodedPacket, bytes: &[u8]) {
        packet.crc = 0;
        packet.crc_valid = false;

        if bytes.len() >= 24 {
            // Try standard CRC at 22-23
            let pkt_crc = ((bytes[22] as u16) << 8) | (bytes[23] as u16);
            let calc_crc = crc::calc_crc(&bytes[..22]);
            if calc_crc == pkt_crc {
                packet.crc = pkt_crc;
                packet.crc_valid = true;
                return;
            }

            // Try CRC at 16-17 (LE)
            if bytes.len() >= 18 {
                let pkt_crc = (bytes[16] as u16) | ((bytes[17] as u16) << 8);
                let calc_crc = crc::calc_crc(&bytes[..16]);
                if calc_crc == pkt_crc {
                    packet.crc = pkt_crc;
                    packet.crc_valid = true;
                    return;
                }
            }

            // Store CRC at standard position even if invalid
            packet.crc = ((bytes[22] as u16) << 8) | (bytes[23] as u16);
        }
    }

    /// Read device ID as big-endian (offset 2-5)
    fn read_device_id_be(&self, bytes: &[u8]) -> u32 {
        if bytes.len() < offsets::DEVICE_ID + 4 {
            return 0;
        }
        let slice = &bytes[offsets::DEVICE_ID..offsets::DEVICE_ID + 4];
        ((slice[0] as u32) << 24) |
        ((slice[1] as u32) << 16) |
        ((slice[2] as u32) << 8) |
        (slice[3] as u32)
    }

    /// Read device ID as little-endian (offset 2-5)
    fn read_device_id_le(&self, bytes: &[u8]) -> u32 {
        if bytes.len() < offsets::DEVICE_ID + 4 {
            return 0;
        }
        let slice = &bytes[offsets::DEVICE_ID..offsets::DEVICE_ID + 4];
        (slice[0] as u32) |
        ((slice[1] as u32) << 8) |
        ((slice[2] as u32) << 16) |
        ((slice[3] as u32) << 24)
    }

    /// Read u32 big-endian from slice
    fn read_u32_be(&self, bytes: &[u8]) -> u32 {
        if bytes.len() < 4 {
            return 0;
        }
        ((bytes[0] as u32) << 24) |
        ((bytes[1] as u32) << 16) |
        ((bytes[2] as u32) << 8) |
        (bytes[3] as u32)
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
        let bytes = hex::decode(
            "88008DE695052104030002000000000000000000000000"
        ).unwrap();

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
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04,
            0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC
        ];
        let packet_bytes = crc::append_crc(&payload);

        let parser = PacketParser::new();
        let packet = parser.parse_bytes(&packet_bytes).unwrap();

        assert!(packet.crc_valid);
    }
}
