#pragma once

// N81 bitstream encoding/decoding for Lutron CCA protocol
// Ported from cca/src/n81.rs
//
// N81 format: 10 bits per byte
// - Start bit: 0
// - 8 data bits: LSB first
// - Stop bit: 1

#include <cstdint>
#include <cstddef>
#include <cstring>

namespace esphome {
namespace cc1101_cca {

// Get a single bit from packed bytes (MSB-first byte order)
inline bool n81_get_bit(const uint8_t *data, size_t data_len, size_t bit_index) {
  size_t byte_idx = bit_index / 8;
  if (byte_idx >= data_len) return false;
  int bit_offset = 7 - (bit_index % 8);
  return (data[byte_idx] >> bit_offset) & 1;
}

// Set a single bit in packed bytes (MSB-first byte order)
inline void n81_set_bit(uint8_t *data, size_t data_len, size_t bit_index, bool value) {
  size_t byte_idx = bit_index / 8;
  if (byte_idx >= data_len) return;
  int bit_offset = 7 - (bit_index % 8);
  if (value) {
    data[byte_idx] |= (1 << bit_offset);
  } else {
    data[byte_idx] &= ~(1 << bit_offset);
  }
}

// Decode a single N81 byte from bitstream.
// Returns decoded byte via *out, returns true on valid framing.
inline bool n81_decode_byte(const uint8_t *bits, size_t bits_len, size_t bit_offset, uint8_t *out) {
  // Need 10 bits: start + 8 data + stop
  if (bit_offset + 10 > bits_len * 8) return false;

  // Check start bit (must be 0)
  if (n81_get_bit(bits, bits_len, bit_offset)) return false;

  // Extract 8 data bits LSB first
  uint8_t byte_out = 0;
  for (int i = 0; i < 8; i++) {
    if (n81_get_bit(bits, bits_len, bit_offset + 1 + i)) {
      byte_out |= (1 << i);
    }
  }

  // Check stop bit (must be 1)
  if (!n81_get_bit(bits, bits_len, bit_offset + 9)) return false;

  *out = byte_out;
  return true;
}

// Decode N81 bytes from bitstream (strict - stops on first error).
// Returns number of bytes decoded into output[].
inline size_t n81_decode_stream(const uint8_t *bits, size_t bits_len,
                                size_t bit_offset, size_t max_bytes,
                                uint8_t *output) {
  size_t total_bits = bits_len * 8;
  size_t count = 0;
  for (size_t i = 0; i < max_bytes; i++) {
    size_t pos = bit_offset + i * 10;
    if (pos + 10 > total_bits) break;
    uint8_t b;
    if (!n81_decode_byte(bits, bits_len, pos, &b)) break;
    output[count++] = b;
  }
  return count;
}

// Decode N81 bytes with tolerance for framing errors.
// On error, pushes 0xCC placeholder and increments *errors.
// Stops after 3 consecutive errors (lost sync).
// Returns number of bytes decoded into output[].
inline size_t n81_decode_stream_tolerant(const uint8_t *bits, size_t bits_len,
                                         size_t bit_offset, size_t max_bytes,
                                         uint8_t *output, uint8_t *errors) {
  size_t total_bits = bits_len * 8;
  size_t count = 0;
  *errors = 0;
  uint8_t consecutive_errors = 0;

  for (size_t i = 0; i < max_bytes; i++) {
    size_t pos = bit_offset + i * 10;
    if (pos + 10 > total_bits) break;
    uint8_t b;
    if (n81_decode_byte(bits, bits_len, pos, &b)) {
      output[count++] = b;
      consecutive_errors = 0;
    } else {
      output[count++] = 0xCC;  // placeholder
      if (*errors < 255) (*errors)++;
      consecutive_errors++;
      if (consecutive_errors >= 3) break;  // lost sync
    }
  }
  return count;
}

// Write a single N81 byte to bitstream at given offset
inline void n81_write_byte(uint8_t *bits, size_t bits_len, size_t bit_offset, uint8_t byte_val) {
  // Start bit (0) - buffer should be pre-zeroed, but clear explicitly
  n81_set_bit(bits, bits_len, bit_offset, false);

  // Data bits LSB first
  for (int i = 0; i < 8; i++) {
    bool bit_val = (byte_val >> i) & 1;
    n81_set_bit(bits, bits_len, bit_offset + 1 + i, bit_val);
  }

  // Stop bit (1)
  n81_set_bit(bits, bits_len, bit_offset + 9, true);
}

// Encode payload to complete N81 bitstream with preamble and prefix.
// Output: preamble(32) + FF(10) + FA(10) + DE(10) + payload(10*len) + trailing(16)
// Returns number of bytes written to output.
inline size_t n81_encode_packet(const uint8_t *payload, size_t payload_len,
                                uint8_t *output, size_t output_size) {
  size_t total_bits = 32 + 30 + (payload_len * 10) + 16;
  size_t total_bytes = (total_bits + 7) / 8;
  if (total_bytes > output_size) return 0;

  memset(output, 0, total_bytes);
  size_t bit_pos = 0;

  // Preamble: 32 alternating bits (1010...)
  for (int i = 0; i < 32; i++) {
    n81_set_bit(output, total_bytes, bit_pos + i, (i % 2) == 0);
  }
  bit_pos += 32;

  // Sync byte 0xFF
  n81_write_byte(output, total_bytes, bit_pos, 0xFF);
  bit_pos += 10;

  // Prefix 0xFA
  n81_write_byte(output, total_bytes, bit_pos, 0xFA);
  bit_pos += 10;

  // Prefix 0xDE
  n81_write_byte(output, total_bytes, bit_pos, 0xDE);
  bit_pos += 10;

  // Payload bytes
  for (size_t i = 0; i < payload_len; i++) {
    n81_write_byte(output, total_bytes, bit_pos, payload[i]);
    bit_pos += 10;
  }

  // Trailing zeros (already zeroed by memset)
  return total_bytes;
}

// Find N81 sync pattern (FF FA DE or FA DE) starting from start_bit.
// Returns bit offset where payload starts (after sync), or -1 if not found.
inline int n81_find_sync_offset_from(const uint8_t *bits, size_t bits_len,
                                     size_t start_bit, size_t max_search) {
  size_t total_bits = bits_len * 8;
  if (total_bits < 50) return -1;

  size_t search_limit = max_search;
  if (search_limit > total_bits - 30) {
    search_limit = total_bits > 30 ? total_bits - 30 : 0;
  }

  for (size_t bit_pos = start_bit; bit_pos < search_limit; bit_pos++) {
    uint8_t b1, b2, b3;
    bool ok1 = n81_decode_byte(bits, bits_len, bit_pos, &b1);
    bool ok2 = n81_decode_byte(bits, bits_len, bit_pos + 10, &b2);
    bool ok3 = n81_decode_byte(bits, bits_len, bit_pos + 20, &b3);

    // Full sync: FF FA DE
    if (ok1 && ok2 && ok3 && b1 == 0xFF && b2 == 0xFA && b3 == 0xDE) {
      return static_cast<int>(bit_pos + 30);
    }

    // Short sync: FA DE (FF may have been corrupted)
    if (ok1 && ok2 && ok3 && b1 == 0xFA && b2 == 0xDE) {
      return static_cast<int>(bit_pos + 20);
    }
  }

  return -1;
}

}  // namespace cc1101_cca
}  // namespace esphome
