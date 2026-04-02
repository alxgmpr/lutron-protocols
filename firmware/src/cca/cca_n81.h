#pragma once

// N81 bitstream encoding/decoding for Lutron CCA protocol
// Ported from esphome/custom_components/cc1101_cca/cca_n81.h
// Changes: stripped esphome::cc1101_cca namespace

#include <cstdint>
#include <cstddef>
#include <cstring>

// Get a single bit from packed bytes (MSB-first byte order)
inline bool n81_get_bit(const uint8_t* data, size_t data_len, size_t bit_index)
{
    size_t byte_idx = bit_index / 8;
    if (byte_idx >= data_len) return false;
    int bit_offset = 7 - (bit_index % 8);
    return (data[byte_idx] >> bit_offset) & 1;
}

// Set a single bit in packed bytes (MSB-first byte order)
inline void n81_set_bit(uint8_t* data, size_t data_len, size_t bit_index, bool value)
{
    size_t byte_idx = bit_index / 8;
    if (byte_idx >= data_len) return;
    int bit_offset = 7 - (bit_index % 8);
    if (value) {
        data[byte_idx] |= (1 << bit_offset);
    }
    else {
        data[byte_idx] &= ~(1 << bit_offset);
    }
}

// Decode a single N81 byte from bitstream.
// Returns decoded byte via *out, returns true on valid framing.
inline bool n81_decode_byte(const uint8_t* bits, size_t bits_len, size_t bit_offset, uint8_t* out)
{
    if (bit_offset + 10 > bits_len * 8) return false;
    if (n81_get_bit(bits, bits_len, bit_offset)) return false;

    uint8_t byte_out = 0;
    for (int i = 0; i < 8; i++) {
        if (n81_get_bit(bits, bits_len, bit_offset + 1 + i)) {
            byte_out |= (1 << i);
        }
    }

    if (!n81_get_bit(bits, bits_len, bit_offset + 9)) return false;

    *out = byte_out;
    return true;
}

// Decode N81 bytes from bitstream (strict — stops on first error).
inline size_t n81_decode_stream(const uint8_t* bits, size_t bits_len, size_t bit_offset, size_t max_bytes,
                                uint8_t* output)
{
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
// Also records up to err_pos_max error byte positions for CRC recovery.
inline size_t n81_decode_stream_tolerant(const uint8_t* bits, size_t bits_len, size_t bit_offset, size_t max_bytes,
                                         uint8_t* output, uint8_t* errors, uint8_t* err_pos = nullptr,
                                         size_t err_pos_max = 0)
{
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
        }
        else {
            if (err_pos && *errors < err_pos_max) {
                err_pos[*errors] = static_cast<uint8_t>(count);
            }
            output[count++] = 0xCC;
            if (*errors < 255) (*errors)++;
            consecutive_errors++;
            if (consecutive_errors >= 3) break;
        }
    }
    return count;
}

// Decode 8N1 bytes with position tracking (matches Lutron QSM FUN_9068).
// Instead of fixed 10-bit stride, searches for start bit within a small
// window per byte.  Handles clock drift that fixed-stride misses.
// Returns number of decoded bytes.  Sets *errors to count of framing errors.
inline size_t n81_decode_stream_tracked(const uint8_t* bits, size_t bits_len, size_t bit_offset, size_t max_bytes,
                                        uint8_t* output, uint8_t* errors, uint8_t* err_pos = nullptr,
                                        size_t err_pos_max = 0)
{
    size_t total_bits = bits_len * 8;
    size_t pos = bit_offset;
    size_t count = 0;
    *errors = 0;
    uint8_t consecutive_errors = 0;

    while (count < max_bytes && pos + 10 <= total_bits) {
        // Search for start bit (0) within a ±3 bit window.
        // 8N1 stop bit is 1, so after a good byte at pos, the next start
        // bit should be at pos+10.  Clock drift may shift it ±1-2 bits.
        size_t search_end = pos + 4;
        if (search_end + 10 > total_bits) search_end = total_bits - 10;
        bool found_start = false;

        for (size_t s = pos; s <= search_end; s++) {
            if (!n81_get_bit(bits, bits_len, s)) {
                // Found a 0 (start bit) — try strict decode
                uint8_t b;
                if (n81_decode_byte(bits, bits_len, s, &b)) {
                    output[count++] = b;
                    pos = s + 10;
                    found_start = true;
                    consecutive_errors = 0;
                    break;
                }
                // Start bit found but framing invalid — extract data bits anyway.
                // The CRC will catch real corruption; framing errors are often
                // recoverable when only the stop bit is wrong.
                b = 0;
                for (int i = 0; i < 8; i++) {
                    if (n81_get_bit(bits, bits_len, s + 1 + (size_t)i)) b |= (1 << i);
                }
                if (err_pos && *errors < err_pos_max) {
                    err_pos[*errors] = static_cast<uint8_t>(count);
                }
                output[count++] = b;
                if (*errors < 255) (*errors)++;
                consecutive_errors++;
                pos = s + 10;
                found_start = true;
                break;
            }
        }

        if (!found_start) {
            // No start bit in window — emit placeholder, advance
            if (err_pos && *errors < err_pos_max) {
                err_pos[*errors] = static_cast<uint8_t>(count);
            }
            output[count++] = 0xCC;
            if (*errors < 255) (*errors)++;
            consecutive_errors++;
            pos += 10;
        }

        if (consecutive_errors >= 3) break;
    }
    return count;
}

// Write a single 8N1 byte to bitstream at given offset
inline void n81_write_byte(uint8_t* bits, size_t bits_len, size_t bit_offset, uint8_t byte_val)
{
    n81_set_bit(bits, bits_len, bit_offset, false);
    for (int i = 0; i < 8; i++) {
        bool bit_val = (byte_val >> i) & 1;
        n81_set_bit(bits, bits_len, bit_offset + 1 + i, bit_val);
    }
    n81_set_bit(bits, bits_len, bit_offset + 9, true);
}

// Encode payload to complete N81 bitstream with preamble and prefix.
inline size_t n81_encode_packet(const uint8_t* payload, size_t payload_len, uint8_t* output, size_t output_size)
{
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

    return total_bytes;
}

// Find N81 sync pattern (FF FA DE or FA DE) starting from start_bit.
inline int n81_find_sync_offset_from(const uint8_t* bits, size_t bits_len, size_t start_bit, size_t max_search)
{
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

        if (ok1 && ok2 && ok3 && b1 == 0xFF && b2 == 0xFA && b3 == 0xDE) {
            return static_cast<int>(bit_pos + 30);
        }

        if (ok1 && ok2 && ok3 && b1 == 0xFA && b2 == 0xDE) {
            return static_cast<int>(bit_pos + 20);
        }
    }

    return -1;
}
