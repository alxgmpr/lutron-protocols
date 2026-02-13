#pragma once

// CCA packet decoder - multi-sync FIFO decoder with CRC validation
// Ported from cca/src/packet/parser.rs

#include "cca_crc.h"
#include "cca_n81.h"
#include "cca_types.h"

namespace esphome {
namespace cc1101_cca {

class CcaDecoder {
 public:
  CcaDecoder() = default;

  // Maximum bytes to attempt decoding from FIFO
  static const size_t MAX_DECODE_LEN = 56;

  // Maximum bit position to search for sync patterns
  static const size_t MAX_SYNC_SEARCH = 500;

  // Known CCA packet lengths for CRC validation
  static constexpr size_t CCA_LENGTHS[] = {24, 53};
  static const size_t N_CCA_LENGTHS = 2;

  // Decode raw CC1101 FIFO data to Lutron packet.
  // Multi-sync strategy: search all sync positions, CRC-valid packets take priority.
  // Falls back to 0x0B dimmer ACK if no CRC match found.
  bool decode(const uint8_t *fifo_data, size_t len, DecodedPacket &packet) {
    size_t total_bits = len * 8;
    if (total_bits < 200) return false;

    size_t search_from = 0;
    bool have_dimmer_ack = false;
    DecodedPacket dimmer_ack;
    dimmer_ack.clear();

    while (true) {
      // Find next FF FA DE sync pattern
      int data_start = n81_find_sync_offset_from(fifo_data, len, search_from, MAX_SYNC_SEARCH);
      if (data_start < 0) break;

      // Try strict N81 decode
      uint8_t decoded[MAX_DECODE_LEN];
      size_t decoded_len = n81_decode_stream(fifo_data, len,
                                             static_cast<size_t>(data_start),
                                             MAX_DECODE_LEN, decoded);

      // CRC-valid packets always take priority
      if (decoded_len >= 10) {
        int match = cca_check_crc_at_lengths(decoded, decoded_len, CCA_LENGTHS, N_CCA_LENGTHS);
        if (match > 0) {
          return parse_bytes_at_length(decoded, static_cast<size_t>(match), 0, packet);
        }
      }

      // Try tolerant decoder as fallback
      uint8_t tolerant[MAX_DECODE_LEN];
      uint8_t errors = 0;
      size_t tolerant_len = n81_decode_stream_tolerant(fifo_data, len,
                                                       static_cast<size_t>(data_start),
                                                       MAX_DECODE_LEN, tolerant, &errors);

      if (tolerant_len >= 10 && tolerant_len > decoded_len) {
        int match = cca_check_crc_at_lengths(tolerant, tolerant_len, CCA_LENGTHS, N_CCA_LENGTHS);
        if (match > 0) {
          return parse_bytes_at_length(tolerant, static_cast<size_t>(match), errors, packet);
        }
      }

      // Save first 0x0B dimmer ACK candidate
      if (!have_dimmer_ack && decoded_len >= 5 && decoded[0] == 0x0B) {
        if (try_parse_dimmer_ack(decoded, decoded_len, dimmer_ack)) {
          have_dimmer_ack = true;
        }
      }

      // Advance past this sync and search for next
      search_from = static_cast<size_t>(data_start) + 10;
    }

    // No CRC-valid packet found — return dimmer ACK if available
    if (have_dimmer_ack) {
      packet = dimmer_ack;
      return true;
    }
    return false;
  }

  // Parse already-decoded packet bytes.
  // Uses fixed-length CRC checking at known CCA sizes [24, 53].
  bool parse_bytes(const uint8_t *bytes, size_t len, DecodedPacket &packet) {
    if (len < 10) return false;

    // Try fixed-length CRC first
    int match = cca_check_crc_at_lengths(bytes, len, CCA_LENGTHS, N_CCA_LENGTHS);
    if (match > 0) {
      return parse_bytes_at_length(bytes, static_cast<size_t>(match), 0, packet);
    }

    // No CRC match — still return packet with crc_valid=false
    packet.clear();
    size_t copy_len = len < CCA_MAX_PACKET_LEN ? len : CCA_MAX_PACKET_LEN;
    memcpy(packet.raw, bytes, copy_len);
    packet.raw_len = copy_len;
    packet.type_byte = bytes[PKT_OFFSET_TYPE];
    packet.type = bytes[PKT_OFFSET_TYPE];
    packet.sequence = bytes[PKT_OFFSET_SEQ];
    packet.crc_valid = false;
    if (len > PKT_OFFSET_FORMAT) {
      packet.format_byte = bytes[PKT_OFFSET_FORMAT];
      packet.has_format = true;
    }
    parse_type_specific(packet, bytes, copy_len);
    packet.valid = true;
    return true;
  }

  // Diagnostic: decode FIFO and report debug info about all syncs found.
  void decode_fifo_debug(const uint8_t *fifo_data, size_t len,
                         int32_t *sync_offset, uint8_t *sync_count,
                         uint8_t *strict_len, uint8_t *tolerant_len,
                         uint8_t *decoded_out, size_t decoded_out_size) {
    *sync_offset = -1;
    *sync_count = 0;
    *strict_len = 0;
    *tolerant_len = 0;

    size_t best_total = 0;
    size_t search_from = 0;

    while (true) {
      int data_start = n81_find_sync_offset_from(fifo_data, len, search_from, MAX_SYNC_SEARCH);
      if (data_start < 0) break;

      (*sync_count)++;

      uint8_t strict_buf[MAX_DECODE_LEN];
      size_t s_len = n81_decode_stream(fifo_data, len,
                                       static_cast<size_t>(data_start),
                                       MAX_DECODE_LEN, strict_buf);

      uint8_t tolerant_buf[MAX_DECODE_LEN];
      uint8_t errors = 0;
      size_t t_len = n81_decode_stream_tolerant(fifo_data, len,
                                                static_cast<size_t>(data_start),
                                                MAX_DECODE_LEN, tolerant_buf, &errors);

      size_t total = (s_len > t_len) ? s_len : t_len;
      if (total > best_total) {
        best_total = total;
        *sync_offset = data_start;
        *strict_len = static_cast<uint8_t>(s_len > 255 ? 255 : s_len);
        *tolerant_len = static_cast<uint8_t>(t_len > 255 ? 255 : t_len);

        // Copy best decoded bytes
        const uint8_t *best = (s_len >= t_len) ? strict_buf : tolerant_buf;
        size_t copy = total < decoded_out_size ? total : decoded_out_size;
        memcpy(decoded_out, best, copy);
      }

      search_from = static_cast<size_t>(data_start) + 10;
    }
  }

 private:
  // Parse packet bytes with a known CRC-validated length
  bool parse_bytes_at_length(const uint8_t *bytes, size_t len, uint8_t n81_errors,
                             DecodedPacket &packet) {
    if (len < 10) return false;

    packet.clear();
    size_t copy_len = len < CCA_MAX_PACKET_LEN ? len : CCA_MAX_PACKET_LEN;
    memcpy(packet.raw, bytes, copy_len);
    packet.raw_len = copy_len;
    packet.type_byte = bytes[PKT_OFFSET_TYPE];
    packet.type = bytes[PKT_OFFSET_TYPE];
    packet.sequence = bytes[PKT_OFFSET_SEQ];
    packet.n81_errors = n81_errors;

    size_t crc_offset = len - 2;
    packet.crc = (static_cast<uint16_t>(bytes[crc_offset]) << 8) | bytes[crc_offset + 1];
    packet.crc_valid = true;

    if (len > PKT_OFFSET_FORMAT) {
      packet.format_byte = bytes[PKT_OFFSET_FORMAT];
      packet.has_format = true;
    }

    parse_type_specific(packet, bytes, len);
    packet.valid = true;
    return true;
  }

  // Try to parse a 0x0B dimmer ACK packet
  bool try_parse_dimmer_ack(const uint8_t *decoded, size_t decoded_len,
                            DecodedPacket &packet) {
    if (decoded_len < 5 || decoded[0] != 0x0B) return false;

    // Validate XOR integrity check
    if (decoded[3] != (decoded[1] ^ 0x26)) return false;

    // Correct CC1101 demodulation error on bytes 2 and 4
    packet.clear();
    packet.valid = true;
    packet.type_byte = 0x0B;
    packet.type = 0x0B;
    packet.sequence = decoded[1];

    uint8_t corrected_2 = decoded[2] ^ 0xFE;
    uint8_t corrected_4 = decoded[4] ^ 0xFE;

    packet.format_byte = corrected_2;  // response class
    packet.has_format = true;
    packet.level = corrected_4;        // response subtype
    packet.crc_valid = true;           // XOR-validated

    packet.raw[0] = 0x0B;
    packet.raw[1] = decoded[1];
    packet.raw[2] = corrected_2;
    packet.raw[3] = decoded[3];
    packet.raw[4] = corrected_4;
    packet.raw_len = 5;

    return true;
  }

  // Read 4 bytes as big-endian uint32
  static uint32_t read_u32_be(const uint8_t *p) {
    return (static_cast<uint32_t>(p[0]) << 24) |
           (static_cast<uint32_t>(p[1]) << 16) |
           (static_cast<uint32_t>(p[2]) << 8) |
           static_cast<uint32_t>(p[3]);
  }

  // Read device ID as big-endian (offset 2-5)
  static uint32_t read_device_id_be(const uint8_t *bytes, size_t len) {
    if (len < PKT_OFFSET_DEVICE_ID + 4) return 0;
    return read_u32_be(bytes + PKT_OFFSET_DEVICE_ID);
  }

  // Read device ID as little-endian (offset 2-5)
  static uint32_t read_device_id_le(const uint8_t *bytes, size_t len) {
    if (len < PKT_OFFSET_DEVICE_ID + 4) return 0;
    const uint8_t *p = bytes + PKT_OFFSET_DEVICE_ID;
    return static_cast<uint32_t>(p[0]) |
           (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
  }

  // Parse type-specific fields
  void parse_type_specific(DecodedPacket &packet, const uint8_t *bytes, size_t len) {
    uint8_t type = packet.type_byte;

    if (cca_is_button_type(type)) {
      // Button packets: big-endian device ID
      packet.device_id = read_device_id_be(bytes, len);
      if (len > PKT_OFFSET_ACTION) {
        packet.button = bytes[PKT_OFFSET_BUTTON];
        packet.action = bytes[PKT_OFFSET_ACTION];
      }
    } else if (type >= 0x81 && type <= 0x83) {
      // State reports: little-endian device ID
      packet.device_id = read_device_id_le(bytes, len);
      uint8_t fmt = packet.has_format ? packet.format_byte : 0;

      if (fmt == 0x0E) {
        // Bridge level command
        packet.type = PKT_LEVEL;
        if (len >= 18) {
          uint16_t raw_level = (static_cast<uint16_t>(bytes[16]) << 8) | bytes[17];
          uint32_t calc = static_cast<uint32_t>(raw_level) * 100 + 32639;
          uint8_t level = static_cast<uint8_t>(calc / 65279);
          packet.level = level < 100 ? level : 100;
        }
        if (len >= 13) {
          packet.target_id = read_u32_be(bytes + 9);
        }
      } else if (fmt == 0x0C) {
        // Unpair flood
        packet.type = PKT_UNPAIR;
        if (len >= 20) {
          packet.target_id = read_u32_be(bytes + 16);
        }
      } else if (fmt == 0x09) {
        // Unpair prepare
        packet.type = PKT_UNPAIR_PREP;
        if (len >= 13) {
          packet.target_id = read_u32_be(bytes + 9);
        }
      } else if (fmt == 0x08) {
        // True state report
        if (len > PKT_OFFSET_LEVEL) {
          uint8_t raw_level = bytes[PKT_OFFSET_LEVEL];
          packet.level = static_cast<uint8_t>((static_cast<uint32_t>(raw_level) * 100 + 127) / 254);
        }
      }
    } else if (type == 0xA2 || type == 0xA3) {
      // Level/config packets: little-endian device ID
      packet.device_id = read_device_id_le(bytes, len);
      uint8_t fmt = packet.has_format ? packet.format_byte : 0;

      if (fmt == 0x11) {
        packet.type = PKT_LED_CONFIG;
        if (len >= 24) packet.level = bytes[23];
        if (len >= 13) packet.target_id = read_u32_be(bytes + 9);
      } else {
        packet.type = PKT_LEVEL;
        if (len >= 10) packet.level = bytes[9];
        if (len >= 14) {
          // Little-endian target ID at offset 10
          const uint8_t *p = bytes + 10;
          packet.target_id = static_cast<uint32_t>(p[0]) |
                             (static_cast<uint32_t>(p[1]) << 8) |
                             (static_cast<uint32_t>(p[2]) << 16) |
                             (static_cast<uint32_t>(p[3]) << 24);
        }
      }
    } else if (cca_is_pairing_type(type)) {
      // Pairing packets: big-endian device ID
      packet.device_id = read_device_id_be(bytes, len);
    } else if (type == 0xC0 || cca_is_handshake_type(type)) {
      // Pairing response / handshake: big-endian device ID
      packet.device_id = read_device_id_be(bytes, len);
    } else {
      // Default: little-endian device ID
      packet.device_id = read_device_id_le(bytes, len);
    }
  }
};

// Static member definition
constexpr size_t CcaDecoder::CCA_LENGTHS[];

}  // namespace cc1101_cca
}  // namespace esphome
