//! N81 bitstream encoding/decoding for Lutron CCA protocol
//!
//! N81 format: 10 bits per byte
//! - Start bit: 0
//! - 8 data bits: LSB first
//! - Stop bit: 1
//!
//! Wire format example for byte 0x88:
//! Bit positions:  0   1   2   3   4   5   6   7   8   9
//! Values:         0   0   0   0   1   0   0   0   1   1
//!                 ^   ^-----------------------^   ^
//!               start      data (LSB first)    stop

#[cfg(not(feature = "std"))]
use alloc::vec;
#[cfg(not(feature = "std"))]
use alloc::vec::Vec;

/// Get a single bit from packed bytes (MSB-first byte order)
#[inline]
fn get_bit(data: &[u8], bit_index: usize) -> bool {
    let byte_idx = bit_index / 8;
    let bit_offset = 7 - (bit_index % 8);
    if byte_idx >= data.len() {
        return false;
    }
    (data[byte_idx] >> bit_offset) & 1 == 1
}

/// Set a single bit in packed bytes (MSB-first byte order)
#[inline]
fn set_bit(data: &mut [u8], bit_index: usize, value: bool) {
    let byte_idx = bit_index / 8;
    let bit_offset = 7 - (bit_index % 8);
    if byte_idx < data.len() {
        if value {
            data[byte_idx] |= 1 << bit_offset;
        } else {
            data[byte_idx] &= !(1 << bit_offset);
        }
    }
}

/// Decode a single N81 byte from bitstream
///
/// # Arguments
/// * `bits` - Packed bit data (MSB-first byte order)
/// * `bit_offset` - Starting bit position
///
/// # Returns
/// `Some(byte)` if valid N81 framing, `None` if invalid
pub fn decode_n81_byte(bits: &[u8], bit_offset: usize) -> Option<u8> {
    // Check start bit (must be 0)
    if get_bit(bits, bit_offset) {
        return None;
    }

    // Extract 8 data bits LSB first
    let mut byte_out: u8 = 0;
    for i in 0..8 {
        if get_bit(bits, bit_offset + 1 + i) {
            byte_out |= 1 << i;
        }
    }

    // Check stop bit (must be 1)
    if !get_bit(bits, bit_offset + 9) {
        return None;
    }

    Some(byte_out)
}

/// Encode a single byte to N81 format (10 bits)
///
/// Returns the 10-bit value packed into u16 (MSB-aligned)
pub fn encode_n81_byte(byte: u8) -> u16 {
    let mut result: u16 = 0;
    // Start bit (0) at MSB position
    // Data bits LSB first in positions 1-8
    for i in 0..8 {
        if byte & (1 << i) != 0 {
            result |= 1 << (14 - i); // Position 14,13,12...7 for bits 0,1,2...7
        }
    }
    // Stop bit (1) at position 6 (10th bit)
    result |= 1 << 6;
    result
}

/// Decode N81 bytes from a bitstream starting at given offset
///
/// Attempts to decode `max_bytes` N81 bytes from the bitstream.
/// Stops on first decode error.
///
/// # Arguments
/// * `bits` - Packed bit data
/// * `bit_offset` - Starting bit position
/// * `max_bytes` - Maximum bytes to decode
///
/// # Returns
/// Vector of decoded bytes (may be shorter than max_bytes if decode fails)
pub fn decode_n81_stream(bits: &[u8], bit_offset: usize, max_bytes: usize) -> Vec<u8> {
    let mut result = Vec::with_capacity(max_bytes);
    let total_bits = bits.len() * 8;

    for i in 0..max_bytes {
        let pos = bit_offset + i * 10;
        if pos + 10 > total_bits {
            break;
        }
        match decode_n81_byte(bits, pos) {
            Some(b) => result.push(b),
            None => break,
        }
    }

    result
}

/// Encode payload to complete N81 bitstream with preamble and prefix
///
/// Packet structure:
/// - Preamble: 32 alternating bits (0xAA pattern)
/// - Sync: 0xFF as N81
/// - Prefix: 0xFA 0xDE as N81
/// - Payload: data bytes as N81
/// - Trailing: 16 zero bits
pub fn encode_packet(payload: &[u8]) -> Vec<u8> {
    // Calculate total bits needed
    // 32 preamble + 10*3 (FF FA DE) + 10*payload.len() + 16 trailing
    let total_bits = 32 + 30 + (payload.len() * 10) + 16;
    let total_bytes = (total_bits + 7) / 8;
    let mut result = vec![0u8; total_bytes];

    let mut bit_pos = 0;

    // Preamble: 32 alternating bits (1010...)
    for i in 0..32 {
        set_bit(&mut result, bit_pos + i, i % 2 == 0);
    }
    bit_pos += 32;

    // Sync byte 0xFF as N81
    write_n81_byte(&mut result, bit_pos, 0xFF);
    bit_pos += 10;

    // Prefix 0xFA as N81
    write_n81_byte(&mut result, bit_pos, 0xFA);
    bit_pos += 10;

    // Prefix 0xDE as N81
    write_n81_byte(&mut result, bit_pos, 0xDE);
    bit_pos += 10;

    // Payload bytes as N81
    for &byte in payload {
        write_n81_byte(&mut result, bit_pos, byte);
        bit_pos += 10;
    }

    // Trailing zeros (already zeroed)
    // bit_pos += 16;

    result
}

/// Write a single N81 byte to bitstream at given offset
fn write_n81_byte(bits: &mut [u8], bit_offset: usize, byte: u8) {
    // Start bit (0) - already zeroed
    // set_bit(bits, bit_offset, false);

    // Data bits LSB first
    for i in 0..8 {
        let bit_val = (byte >> i) & 1 == 1;
        set_bit(bits, bit_offset + 1 + i, bit_val);
    }

    // Stop bit (1)
    set_bit(bits, bit_offset + 9, true);
}

/// Find N81 sync pattern (0xFF 0xFA 0xDE) in bitstream
///
/// Returns the bit offset where payload starts (after 0xDE)
pub fn find_sync_offset(bits: &[u8]) -> Option<usize> {
    let total_bits = bits.len() * 8;
    if total_bits < 50 {
        return None;
    }

    // Search first 30 bits for sync pattern
    for bit_pos in 0..30.min(total_bits - 30) {
        // Try to decode three consecutive bytes
        let b1 = decode_n81_byte(bits, bit_pos);
        let b2 = decode_n81_byte(bits, bit_pos + 10);
        let b3 = decode_n81_byte(bits, bit_pos + 20);

        match (b1, b2, b3) {
            // Full sync: FF FA DE
            (Some(0xFF), Some(0xFA), Some(0xDE)) => {
                return Some(bit_pos + 30);
            }
            // Short sync: FA DE + valid packet type
            (Some(0xFA), Some(0xDE), Some(pkt_type)) if pkt_type >= 0x80 && pkt_type <= 0xCF => {
                return Some(bit_pos + 20);
            }
            // Direct packet start
            (Some(pkt_type), Some(seq), _)
                if pkt_type >= 0x80 && pkt_type <= 0xCF && seq < 0x60 =>
            {
                return Some(bit_pos);
            }
            _ => continue,
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_set_bit() {
        let mut data = vec![0u8; 2];

        // Test setting individual bits
        set_bit(&mut data, 0, true); // MSB of first byte
        assert_eq!(data[0], 0x80);

        set_bit(&mut data, 7, true); // LSB of first byte
        assert_eq!(data[0], 0x81);

        set_bit(&mut data, 8, true); // MSB of second byte
        assert_eq!(data[1], 0x80);
    }

    #[test]
    fn test_decode_n81_byte() {
        // N81 encoding of 0x88:
        // start(0) + 00010001 (LSB first of 0x88) + stop(1)
        // = 0 00010001 1 = 0x08 0xC0 (when packed MSB-first)
        let bits = [0x08, 0xC0]; // 0000 1000 1100 0000
        let result = decode_n81_byte(&bits, 0);
        assert_eq!(result, Some(0x88));
    }

    #[test]
    fn test_encode_n81_byte_roundtrip() {
        for byte in [0x00, 0x88, 0xFF, 0xFA, 0xDE, 0x55, 0xAA] {
            // Encode byte to N81
            let encoded = encode_n81_byte(byte);

            // Pack into byte array
            let packed = [(encoded >> 8) as u8, (encoded & 0xFF) as u8];

            // Decode back
            let decoded = decode_n81_byte(&packed, 0);
            assert_eq!(
                decoded,
                Some(byte),
                "Round-trip failed for byte 0x{:02X}",
                byte
            );
        }
    }

    #[test]
    fn test_decode_stream() {
        // Create a simple N81 stream with two bytes
        let mut bits = vec![0u8; 3];
        write_n81_byte(&mut bits, 0, 0x88);
        write_n81_byte(&mut bits, 10, 0x00);

        let decoded = decode_n81_stream(&bits, 0, 2);
        assert_eq!(decoded, vec![0x88, 0x00]);
    }
}
