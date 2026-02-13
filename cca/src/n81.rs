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

/// Decode N81 bytes with tolerance for framing errors.
///
/// On framing error (bad start/stop bit), pushes 0xCC placeholder and
/// increments the error counter. Stops after 3 consecutive errors
/// (indicates lost sync, not recoverable bit errors).
///
/// # Arguments
/// * `bits` - Packed bit data
/// * `bit_offset` - Starting bit position
/// * `max_bytes` - Maximum bytes to decode
///
/// # Returns
/// Tuple of (decoded bytes with 0xCC for errors, error count)
pub fn decode_n81_stream_tolerant(bits: &[u8], bit_offset: usize, max_bytes: usize) -> (Vec<u8>, u8) {
    let mut result = Vec::with_capacity(max_bytes);
    let total_bits = bits.len() * 8;
    let mut errors: u8 = 0;
    let mut consecutive_errors: u8 = 0;

    for i in 0..max_bytes {
        let pos = bit_offset + i * 10;
        if pos + 10 > total_bits {
            break;
        }
        match decode_n81_byte(bits, pos) {
            Some(b) => {
                result.push(b);
                consecutive_errors = 0;
            }
            None => {
                result.push(0xCC); // placeholder
                errors = errors.saturating_add(1);
                consecutive_errors += 1;
                if consecutive_errors >= 3 {
                    break; // lost sync
                }
            }
        }
    }

    (result, errors)
}

/// Find N81 sync pattern (0xFF 0xFA 0xDE) in bitstream
///
/// Searches up to `max_search` bit positions for the FF FA DE sync sequence.
/// Only matches the full 3-byte sync or FA DE followed by a valid packet type.
/// Does NOT match "direct packet start" heuristics which produce false positives.
///
/// Returns the bit offset where payload starts (after sync)
pub fn find_sync_offset(bits: &[u8]) -> Option<usize> {
    find_sync_offset_range(bits, 300)
}

/// Find N81 sync pattern searching up to `max_search` bit positions,
/// starting from `start_bit`.
pub fn find_sync_offset_from(bits: &[u8], start_bit: usize, max_search: usize) -> Option<usize> {
    let total_bits = bits.len() * 8;
    if total_bits < 50 {
        return None;
    }

    let search_limit = max_search.min(total_bits.saturating_sub(30));

    for bit_pos in start_bit..search_limit {
        let b1 = decode_n81_byte(bits, bit_pos);
        let b2 = decode_n81_byte(bits, bit_pos + 10);
        let b3 = decode_n81_byte(bits, bit_pos + 20);

        match (b1, b2, b3) {
            // Full sync: FF FA DE
            (Some(0xFF), Some(0xFA), Some(0xDE)) => {
                return Some(bit_pos + 30);
            }
            // Short sync: FA DE (FF may have been corrupted)
            // No type byte filtering — CRC validation is the only gate.
            (Some(0xFA), Some(0xDE), Some(_)) => {
                return Some(bit_pos + 20);
            }
            _ => continue,
        }
    }

    None
}

/// Find N81 sync pattern searching up to `max_search` bit positions from bit 0
pub fn find_sync_offset_range(bits: &[u8], max_search: usize) -> Option<usize> {
    find_sync_offset_from(bits, 0, max_search)
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

    #[test]
    fn test_decode_n81_stream_tolerant_clean() {
        // Clean stream with no errors
        let mut bits = vec![0u8; 4];
        write_n81_byte(&mut bits, 0, 0x88);
        write_n81_byte(&mut bits, 10, 0x00);
        write_n81_byte(&mut bits, 20, 0xFF);

        let (decoded, errors) = decode_n81_stream_tolerant(&bits, 0, 3);
        assert_eq!(decoded, vec![0x88, 0x00, 0xFF]);
        assert_eq!(errors, 0);
    }

    #[test]
    fn test_decode_n81_stream_tolerant_with_error() {
        // Stream with one corrupted byte in the middle
        let mut bits = vec![0u8; 4];
        write_n81_byte(&mut bits, 0, 0x88);
        // Corrupt byte at position 10: set start bit to 1 (should be 0)
        set_bit(&mut bits, 10, true);
        write_n81_byte(&mut bits, 20, 0xFF);

        let (decoded, errors) = decode_n81_stream_tolerant(&bits, 0, 3);
        assert_eq!(decoded.len(), 3);
        assert_eq!(decoded[0], 0x88);
        assert_eq!(decoded[1], 0xCC); // placeholder for error
        assert_eq!(decoded[2], 0xFF);
        assert_eq!(errors, 1);
    }

    #[test]
    fn test_decode_n81_stream_tolerant_stops_after_3() {
        // Stream where all bytes are corrupted - should stop after 3
        let bits = vec![0xFF; 10]; // All 1s = bad start bits
        let (decoded, errors) = decode_n81_stream_tolerant(&bits, 0, 10);
        assert_eq!(decoded.len(), 3); // stopped after 3 consecutive errors
        assert_eq!(errors, 3);
    }

    #[test]
    fn test_find_sync_offset_full_sync() {
        // FF FA DE at bit 0
        let mut bits = vec![0u8; 20];
        write_n81_byte(&mut bits, 0, 0xFF);
        write_n81_byte(&mut bits, 10, 0xFA);
        write_n81_byte(&mut bits, 20, 0xDE);

        assert_eq!(find_sync_offset(&bits), Some(30));
    }

    #[test]
    fn test_find_sync_offset_at_high_offset() {
        // FF FA DE at bit 100 (beyond old 30-bit search limit)
        let mut bits = vec![0u8; 40];
        write_n81_byte(&mut bits, 100, 0xFF);
        write_n81_byte(&mut bits, 110, 0xFA);
        write_n81_byte(&mut bits, 120, 0xDE);

        assert_eq!(find_sync_offset(&bits), Some(130));
    }

    #[test]
    fn test_find_sync_offset_at_200() {
        // FF FA DE at bit 200
        let mut bits = vec![0u8; 50];
        write_n81_byte(&mut bits, 200, 0xFF);
        write_n81_byte(&mut bits, 210, 0xFA);
        write_n81_byte(&mut bits, 220, 0xDE);

        assert_eq!(find_sync_offset(&bits), Some(230));
    }

    #[test]
    fn test_find_sync_no_direct_start_false_positive() {
        // Data that looks like a "direct packet start" (0x8A 0x05)
        // but has no FF FA DE sync — should NOT match
        let mut bits = vec![0u8; 10];
        write_n81_byte(&mut bits, 0, 0x8A);
        write_n81_byte(&mut bits, 10, 0x05);

        assert_eq!(find_sync_offset(&bits), None);
    }
}
