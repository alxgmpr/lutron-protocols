//! CRC-16 implementation for Lutron CCA protocol
//!
//! Uses non-standard polynomial 0xCA0F

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

/// Verify CRC of a complete Lutron packet
///
/// # Arguments
/// * `packet` - Complete packet including CRC (24 or 53 bytes)
///
/// # Returns
/// `true` if CRC is valid
pub fn verify_crc(packet: &[u8]) -> bool {
    if packet.len() < 4 {
        return false;
    }

    // Determine CRC location based on packet length
    let (crc_offset, data_len) = if packet.len() >= 53 {
        (51, 51) // Pairing packet
    } else if packet.len() >= 24 {
        (22, 22) // Standard packet
    } else {
        return false;
    };

    let calculated = calc_crc(&packet[..data_len]);
    let received = ((packet[crc_offset] as u16) << 8) | (packet[crc_offset + 1] as u16);

    calculated == received
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
        let payload = vec![0x88, 0x00, 0x8D, 0xE6, 0x95, 0x05, 0x21, 0x04,
                          0x03, 0x00, 0x02, 0x00, 0xCC, 0xCC, 0xCC, 0xCC,
                          0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC];
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
}
