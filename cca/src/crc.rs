//! CRC-16 implementation for Lutron CCA protocol
//!
//! Uses non-standard polynomial 0xCA0F

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

/// CRC-16 polynomial used by Lutron (non-standard)
pub const CRC_POLY: u16 = 0xCA0F;

/// Pre-computed CRC-16 lookup table
const CRC_TABLE: [u16; 256] = {
    let mut table = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = (i as u16) << 8;
        let mut j = 0;
        while j < 8 {
            if crc & 0x8000 != 0 {
                crc = ((crc << 1) ^ CRC_POLY) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
            j += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
};

/// Calculate CRC-16 for the given data
///
/// # Arguments
/// * `data` - Bytes to calculate CRC over (typically bytes 0..len-2 of packet)
///
/// # Returns
/// 16-bit CRC value
pub fn calc_crc(data: &[u8]) -> u16 {
    let mut crc_reg: u16 = 0;
    for &byte in data {
        let crc_upper = (crc_reg >> 8) as usize;
        crc_reg = (((crc_reg << 8) & 0xFF00) + byte as u16) ^ CRC_TABLE[crc_upper];
    }
    crc_reg
}

/// Find the true packet boundary by scanning for a valid CRC-16 match.
///
/// Computes CRC-16 over bytes[0..L-2] for each candidate length L and checks
/// if it matches the big-endian u16 at bytes[L-2..L]. The first (shortest)
/// match is the true packet boundary.
///
/// # Arguments
/// * `bytes` - Decoded packet bytes (potentially with trailing data beyond CRC)
///
/// # Returns
/// `Some(length)` if a valid CRC boundary was found, `None` otherwise
pub fn find_packet_boundary(bytes: &[u8]) -> Option<usize> {
    // Minimum: type + seq + device_id(4) + protocol + format + CRC(2) = 10
    let min_len = 10;
    if bytes.len() < min_len {
        return None;
    }

    let mut crc_reg: u16 = 0;
    // Pre-compute CRC incrementally up to min_len - 2
    for &byte in &bytes[..min_len - 2] {
        let crc_upper = (crc_reg >> 8) as usize;
        crc_reg = (((crc_reg << 8) & 0xFF00) + byte as u16) ^ CRC_TABLE[crc_upper];
    }

    for len in min_len..=bytes.len() {
        // crc_reg is the CRC over bytes[0..len-2]
        let crc_offset = len - 2;
        let received = ((bytes[crc_offset] as u16) << 8) | (bytes[crc_offset + 1] as u16);
        if crc_reg == received {
            return Some(len);
        }

        // Extend CRC by one byte for next iteration
        if len < bytes.len() {
            let next_byte = bytes[len - 2];
            let crc_upper = (crc_reg >> 8) as usize;
            crc_reg = (((crc_reg << 8) & 0xFF00) + next_byte as u16) ^ CRC_TABLE[crc_upper];
        }
    }

    None
}

/// Check CRC at specific known packet lengths only.
///
/// Unlike `find_packet_boundary()` which scans every possible length,
/// this checks CRC only at the two known CCA packet sizes (24 and 53 bytes).
/// This prevents false CRC matches at intermediate lengths that would
/// truncate 53-byte config packets.
///
/// # Arguments
/// * `bytes` - Decoded packet bytes
/// * `lengths` - Slice of candidate lengths to check (e.g., `&[24, 53]`)
///
/// # Returns
/// `Some(length)` if CRC matches at one of the given lengths, `None` otherwise
pub fn check_crc_at_lengths(bytes: &[u8], lengths: &[usize]) -> Option<usize> {
    for &len in lengths {
        if bytes.len() < len || len < 4 {
            continue;
        }
        let crc_offset = len - 2;
        let computed = calc_crc(&bytes[..crc_offset]);
        let received = ((bytes[crc_offset] as u16) << 8) | (bytes[crc_offset + 1] as u16);
        if computed == received {
            return Some(len);
        }
    }
    None
}

/// Verify CRC of a complete Lutron packet using boundary scanning.
///
/// # Arguments
/// * `packet` - Complete packet including CRC
///
/// # Returns
/// `true` if CRC is valid at any position
pub fn verify_crc(packet: &[u8]) -> bool {
    find_packet_boundary(packet).is_some()
}

/// Append CRC-16 to payload (big-endian)
///
/// # Arguments
/// * `payload` - Payload bytes (22 or 51 bytes)
///
/// # Returns
/// Payload with CRC appended (24 or 53 bytes)
pub fn append_crc(payload: &[u8]) -> Vec<u8> {
    let crc = calc_crc(payload);
    let mut result = payload.to_vec();
    result.push((crc >> 8) as u8);
    result.push((crc & 0xFF) as u8);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc_table_generation() {
        // Verify first few table entries match Python implementation
        assert_eq!(CRC_TABLE[0], 0x0000);
        assert_eq!(CRC_TABLE[1], 0xCA0F);
        assert_eq!(CRC_TABLE[255], 0x4543);
    }

    #[test]
    fn test_calc_crc_known_packet() {
        // Known button press packet (bytes 0-21)
        let data = hex::decode("88008DE6950521040300020000CCCCCCCCCCCCCCCCCCCC").unwrap();
        let crc = calc_crc(&data);
        // Expected CRC would be at bytes 22-23 of real packet
        assert!(crc != 0); // Just verify it calculates something
    }

    #[test]
    fn test_verify_crc() {
        // Create a packet with valid CRC
        let payload = vec![
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04, 0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        ];
        let packet = append_crc(&payload);
        assert!(verify_crc(&packet));
    }

    #[test]
    fn test_append_crc() {
        let payload = vec![0x00; 22];
        let packet = append_crc(&payload);
        assert_eq!(packet.len(), 24);
        assert!(verify_crc(&packet));
    }

    #[test]
    fn test_find_packet_boundary_exact() {
        // 22-byte payload + 2-byte CRC = 24 bytes, no trailing data
        let payload = vec![
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04, 0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        ];
        let packet = append_crc(&payload);
        assert_eq!(find_packet_boundary(&packet), Some(24));
    }

    #[test]
    fn test_find_packet_boundary_with_trailing() {
        // 24-byte packet followed by trailing junk bytes
        let payload = vec![
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04, 0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        ];
        let mut packet = append_crc(&payload);
        // Append trailing garbage
        packet.extend_from_slice(&[0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC]);
        assert_eq!(find_packet_boundary(&packet), Some(24));
    }

    #[test]
    fn test_find_packet_boundary_53_byte() {
        // 51-byte payload + 2-byte CRC = 53 bytes
        let mut payload = vec![0xB9; 51]; // Pairing packet type
        payload[1] = 0x00; // seq
        let packet = append_crc(&payload);
        assert_eq!(packet.len(), 53);
        assert_eq!(find_packet_boundary(&packet), Some(53));
    }

    #[test]
    fn test_find_packet_boundary_no_match() {
        // Random data with no valid CRC
        let data = vec![0x88, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A];
        assert_eq!(find_packet_boundary(&data), None);
    }

    #[test]
    fn test_find_packet_boundary_too_short() {
        let data = vec![0x88, 0x00, 0x01];
        assert_eq!(find_packet_boundary(&data), None);
    }

    #[test]
    fn test_check_crc_at_lengths_24() {
        let payload = vec![
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04, 0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        ];
        let packet = append_crc(&payload);
        assert_eq!(packet.len(), 24);
        assert_eq!(check_crc_at_lengths(&packet, &[24, 53]), Some(24));
    }

    #[test]
    fn test_check_crc_at_lengths_53() {
        let mut payload = vec![0xB9; 51];
        payload[1] = 0x00;
        let packet = append_crc(&payload);
        assert_eq!(packet.len(), 53);
        assert_eq!(check_crc_at_lengths(&packet, &[24, 53]), Some(53));
    }

    #[test]
    fn test_check_crc_at_lengths_with_trailing() {
        let payload = vec![
            0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04, 0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC,
            0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
        ];
        let mut packet = append_crc(&payload);
        packet.extend_from_slice(&[0xCC; 29]); // trailing data up to 53 bytes
        // Should still find CRC at 24, not be confused by trailing
        assert_eq!(check_crc_at_lengths(&packet, &[24, 53]), Some(24));
    }

    #[test]
    fn test_check_crc_at_lengths_no_match() {
        let data = vec![0x88, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
                        0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13,
                        0x14, 0x15, 0x16, 0x17];
        assert_eq!(check_crc_at_lengths(&data, &[24, 53]), None);
    }

    #[test]
    fn test_check_crc_at_lengths_too_short() {
        let data = vec![0x88, 0x00, 0x01];
        assert_eq!(check_crc_at_lengths(&data, &[24, 53]), None);
    }
}
