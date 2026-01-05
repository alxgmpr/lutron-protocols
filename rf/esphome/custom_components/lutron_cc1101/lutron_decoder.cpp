#include "lutron_decoder.h"
#include "esphome/core/log.h"

namespace esphome {
namespace lutron_cc1101 {

static const char *TAG = "lutron_decoder";

LutronDecoder::LutronDecoder() {
  // Generate CRC table for polynomial 0xCA0F
  for (int i = 0; i < 256; i++) {
    uint16_t crc = i << 8;
    for (int j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ LUTRON_CRC_POLY) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
    this->crc_table_[i] = crc;
  }
}

uint16_t LutronDecoder::calc_crc(const uint8_t *data, size_t len) {
  uint16_t crc_reg = 0;
  for (size_t i = 0; i < len; i++) {
    uint8_t crc_upper = crc_reg >> 8;
    crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ this->crc_table_[crc_upper];
  }
  return crc_reg;
}

int LutronDecoder::get_bit(const uint8_t *data, size_t bit_index) {
  return (data[bit_index / 8] >> (7 - (bit_index % 8))) & 1;
}

bool LutronDecoder::decode_n81_byte(const uint8_t *bits, size_t bit_offset, uint8_t &byte_out) {
  // N81 format: start(0) + 8 data bits LSB first + stop(1)
  int start_bit = get_bit(bits, bit_offset);
  if (start_bit != 0) {
    return false;  // Invalid start bit
  }

  // Extract 8 data bits LSB first
  byte_out = 0;
  for (int i = 0; i < 8; i++) {
    int data_bit = get_bit(bits, bit_offset + 1 + i);
    if (data_bit) {
      byte_out |= (1 << i);
    }
  }

  int stop_bit = get_bit(bits, bit_offset + 9);
  if (stop_bit != 1) {
    return false;  // Invalid stop bit
  }

  return true;
}

bool LutronDecoder::decode(const uint8_t *fifo_data, size_t len, DecodedPacket &packet) {
  // Initialize packet
  packet.valid = false;
  packet.raw_len = 0;

  // We have 'len' bytes = len*8 bits from CC1101
  size_t total_bits = len * 8;
  if (total_bits < 200) {  // Reduced from 240 to allow more decode attempts
    ESP_LOGD(TAG, "Not enough bits: %d", total_bits);
    return false;
  }

  // Lutron packet structure:
  // - Preamble: 0xAAAA... (CC1101 syncs here)
  // - N81 0xFF (sync byte): start(0) + 11111111 + stop(1) = 0111111111
  // - N81 0xFA (prefix 1): start(0) + 01011111 + stop(1) = 0101111111
  // - N81 0xDE (prefix 2): start(0) + 01111011 + stop(1) = 0011110111
  // - N81 data bytes...
  //
  // We need to find where the N81 data starts in the captured bitstream.
  // Search for the 0xFA 0xDE prefix pattern, or directly for packet type bytes.

  size_t best_decoded = 0;
  uint8_t best_bytes[56];  // Expanded for pairing packets (up to 53 bytes)

  // OPTIMIZED: Since CC1101 syncs on 0xAAAA preamble, the N81 data starts
  // within the first ~20 bits. Only check bit offsets 0-15 instead of 0-242.
  // This reduces search from O(n) to O(1) effectively.

  // Also use fast path: look for 0xFF sync byte pattern first (0x7F in raw bytes)
  // 0xFF in N81 = 0111111111 binary, which appears as 0x7F 0xFx in byte stream

  for (size_t bit_pos = 0; bit_pos < 20 && bit_pos + 270 < total_bits; bit_pos++) {
    uint8_t byte1, byte2, byte3;

    // Try to decode 3 consecutive bytes
    if (!decode_n81_byte(fifo_data, bit_pos, byte1)) continue;
    if (!decode_n81_byte(fifo_data, bit_pos + 10, byte2)) continue;
    if (!decode_n81_byte(fifo_data, bit_pos + 20, byte3)) continue;

    // Check for 0xFF 0xFA 0xDE (sync + prefix)
    bool found_prefix = (byte1 == 0xFF && byte2 == 0xFA && byte3 == 0xDE);

    // Check for 0xFA 0xDE + packet type (0x80-0xCF range)
    bool found_prefix_short = (byte1 == 0xFA && byte2 == 0xDE &&
                                byte3 >= 0x80 && byte3 <= 0xCF);

    // Check for direct packet type start (0x80-0xCF includes pairing responses)
    bool found_packet = (byte1 >= 0x80 && byte1 <= 0xCF &&
                         (byte2 < 0x60));  // Sequence number is usually < 0x60

    size_t data_start;
    if (found_prefix) {
      data_start = bit_pos + 30;  // Skip 0xFF 0xFA 0xDE (3 bytes = 30 bits)
    } else if (found_prefix_short) {
      data_start = bit_pos + 20;  // Skip 0xFA 0xDE (2 bytes = 20 bits)
    } else if (found_packet) {
      data_start = bit_pos;  // Start from packet type byte
    } else {
      continue;  // No valid start found
    }

    // Try to decode the packet
    uint8_t decoded_bytes[56];  // Expanded for pairing packets
    size_t decoded_count = 0;

    // Decode first byte to get packet type, then determine expected length
    uint8_t type_byte;
    if (!decode_n81_byte(fifo_data, data_start, type_byte)) continue;
    decoded_bytes[0] = type_byte;
    decoded_count = 1;

    // Use type byte to determine expected packet length
    size_t expected_len = get_packet_length(type_byte);
    size_t max_decode = (expected_len > 0) ? expected_len : 53;  // Default to max if unknown type

    for (size_t byte_idx = 1; byte_idx < max_decode; byte_idx++) {
      size_t bp = data_start + byte_idx * 10;
      if (bp + 10 > total_bits) break;

      uint8_t bv;
      if (!decode_n81_byte(fifo_data, bp, bv)) break;
      decoded_bytes[decoded_count++] = bv;
    }

    // Validate packet based on expected length
    // For known types, we need at least the expected length (or close to it for partial pairing)
    // For unknown types, need at least 24 bytes (standard packet size)
    size_t min_required = (expected_len > 0) ? (expected_len < 30 ? expected_len : 24) : 24;
    if (decoded_count >= min_required) {
      // Verify it looks like a Lutron packet (type byte in valid range)
      if (type_byte >= 0x80 && type_byte <= 0xCF) {
        // This is likely a valid packet! (0x80-0xBF = standard, 0xC0-0xCF = pairing response)
        best_decoded = decoded_count;
        for (size_t i = 0; i < decoded_count; i++) {
          best_bytes[i] = decoded_bytes[i];
        }
        break;  // Found a good packet, stop searching
      }
    }

    // Keep track of best partial decode
    if (decoded_count > best_decoded) {
      best_decoded = decoded_count;
      for (size_t i = 0; i < decoded_count && i < 56; i++) {
        best_bytes[i] = decoded_bytes[i];
      }
    }
  }

  // If quick search failed, do extended search (for edge cases)
  if (best_decoded < 10) {
    for (size_t bit_pos = 20; bit_pos + 270 < total_bits; bit_pos++) {
      uint8_t byte1;
      if (!decode_n81_byte(fifo_data, bit_pos, byte1)) continue;

      // Quick filter: only continue if first byte looks like packet type (0x80-0xCF)
      if (byte1 < 0x80 || byte1 > 0xCF) continue;

      uint8_t byte2;
      if (!decode_n81_byte(fifo_data, bit_pos + 10, byte2)) continue;
      if (byte2 >= 0x60) continue;  // Sequence must be < 0x60

      // Found potential packet start, decode rest
      uint8_t decoded_bytes[56];
      decoded_bytes[0] = byte1;
      decoded_bytes[1] = byte2;
      size_t decoded_count = 2;

      // Use type byte to determine expected packet length
      size_t expected_len = get_packet_length(byte1);
      size_t max_decode = (expected_len > 0) ? expected_len : 53;

      for (size_t byte_idx = 2; byte_idx < max_decode; byte_idx++) {
        size_t bp = bit_pos + byte_idx * 10;
        if (bp + 10 > total_bits) break;
        uint8_t bv;
        if (!decode_n81_byte(fifo_data, bp, bv)) break;
        decoded_bytes[decoded_count++] = bv;
      }

      // Validate based on expected length
      size_t min_required = (expected_len > 0) ? (expected_len < 30 ? expected_len : 24) : 24;
      if (decoded_count >= min_required) {
        best_decoded = decoded_count;
        for (size_t i = 0; i < decoded_count; i++) {
          best_bytes[i] = decoded_bytes[i];
        }
        break;
      }
    }
  }

  if (best_decoded < 10) {  // Need at least some bytes to be useful
    // Log decode failure with first few raw bytes for debugging
    char hex[32];
    int pos = 0;
    for (size_t i = 0; i < len && i < 8 && pos < 28; i++) {
      pos += snprintf(hex + pos, sizeof(hex) - pos, "%02X ", fifo_data[i]);
    }
    ESP_LOGV(TAG, "Decode fail: %d bytes, raw: %s", (int)best_decoded, hex);
    return false;
  }

  // Copy decoded bytes to packet
  packet.raw_len = best_decoded;
  for (size_t i = 0; i < best_decoded && i < sizeof(packet.raw); i++) {
    packet.raw[i] = best_bytes[i];
  }

  // Parse packet structure
  packet.type = best_bytes[PKT_OFFSET_TYPE];
  packet.sequence = best_bytes[PKT_OFFSET_SEQ];

  // Initialize optional fields
  packet.button = 0;
  packet.action = 0;
  packet.level = 0;
  packet.target_id = 0;

  // Parse type-specific fields - device ID endianness depends on packet type
  if (packet.type == PKT_BUTTON_SHORT_A || packet.type == PKT_BUTTON_LONG_A ||
      packet.type == PKT_BUTTON_SHORT_B || packet.type == PKT_BUTTON_LONG_B) {
    // Button press packets - Pico IDs are BIG-endian (as printed on device)
    packet.device_id = (best_bytes[PKT_OFFSET_DEVICE_ID] << 24) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 1] << 16) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 2] << 8) |
                       best_bytes[PKT_OFFSET_DEVICE_ID + 3];
    packet.button = best_bytes[PKT_OFFSET_BUTTON];
    packet.action = best_bytes[PKT_OFFSET_ACTION];
  } else if (packet.type == PKT_STATE_REPORT_81 || packet.type == PKT_STATE_REPORT_82 ||
             packet.type == PKT_STATE_REPORT_83) {
    // Types 0x81/0x82/0x83 - check format byte at [7] to determine actual packet type:
    // - Format 0x08 = STATE_RPT (dimmer reporting level)
    // - Format 0x09 = UNPAIR_PREP (unpair phase 1)
    // - Format 0x0C = UNPAIR (unpair phase 2 flood)
    // - Format 0x0E = LEVEL (bridge setting level)
    uint8_t format_byte = best_bytes[7];

    // Source ID is always little-endian for 0x81-0x83 packets
    packet.device_id = best_bytes[PKT_OFFSET_DEVICE_ID] |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);

    if (format_byte == 0x0E) {
      // Bridge level command - reclassify as LEVEL type
      packet.type = PKT_LEVEL;
      // Level is 16-bit big-endian at bytes 16-17
      uint16_t raw_level = (best_bytes[16] << 8) | best_bytes[17];
      uint32_t calc = (uint32_t)raw_level * 100 + 32639;
      uint8_t level = (uint8_t)(calc / 65279);
      packet.level = (level > 100) ? 100 : level;
      // Target device ID at bytes 9-12 (big-endian in bridge commands)
      packet.target_id = (best_bytes[9] << 24) |
                         (best_bytes[10] << 16) |
                         (best_bytes[11] << 8) |
                         best_bytes[12];
    } else if (format_byte == 0x0C) {
      // UNPAIR flood packet - reclassify
      packet.type = PKT_UNPAIR;
      // Target device ID at bytes 16-19 (big-endian)
      if (best_decoded >= 20) {
        packet.target_id = (best_bytes[16] << 24) |
                           (best_bytes[17] << 16) |
                           (best_bytes[18] << 8) |
                           best_bytes[19];
      }
    } else if (format_byte == 0x09) {
      // UNPAIR prepare packet - reclassify
      packet.type = PKT_UNPAIR_PREP;
      // Target device ID at bytes 9-12 (big-endian)
      if (best_decoded >= 13) {
        packet.target_id = (best_bytes[9] << 24) |
                           (best_bytes[10] << 16) |
                           (best_bytes[11] << 8) |
                           best_bytes[12];
      }
    } else if (format_byte == 0x08) {
      // True state report - level at byte 11 (0x00-0xFE = 0-100%)
      uint8_t raw_level = best_bytes[PKT_OFFSET_LEVEL];
      packet.level = (uint8_t)(((uint32_t)raw_level * 100 + 127) / 254);
    } else {
      // Unknown format - leave as STATE_RPT but don't parse level
      // This prevents garbage data from being interpreted
    }
  } else if (packet.type == PKT_LEVEL) {
    // Level commands use LITTLE-endian device IDs
    packet.device_id = best_bytes[PKT_OFFSET_DEVICE_ID] |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);
    // Level command packets (0xA2) - different format, level at offset 9
    packet.level = best_bytes[9];
    // Target device ID at offset 10-13 (little-endian)
    if (best_decoded >= 14) {
      packet.target_id = best_bytes[10] |
                         (best_bytes[11] << 8) |
                         (best_bytes[12] << 16) |
                         (best_bytes[13] << 24);
    }
  } else if (packet.type == PKT_PAIRING_B8 || packet.type == PKT_PAIRING_B9 ||
             packet.type == PKT_PAIRING_BA || packet.type == PKT_PAIRING_BB ||
             packet.type == PKT_PAIRING_B0) {
    // Pairing packets use BIG-endian (like Pico button packets)
    packet.device_id = (best_bytes[PKT_OFFSET_DEVICE_ID] << 24) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 1] << 16) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 2] << 8) |
                       best_bytes[PKT_OFFSET_DEVICE_ID + 3];
  } else if (packet.type >= 0xC0 && packet.type <= 0xCF) {
    // Pairing response packets (from device during pairing handshake)
    // Likely use BIG-endian like other pairing packets
    packet.device_id = (best_bytes[PKT_OFFSET_DEVICE_ID] << 24) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 1] << 16) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 2] << 8) |
                       best_bytes[PKT_OFFSET_DEVICE_ID + 3];
  } else {
    // All other packets - default to LITTLE-endian
    packet.device_id = best_bytes[PKT_OFFSET_DEVICE_ID] |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);
  }

  // CRC from packet (if we have enough bytes)
  if (best_decoded >= 24) {
    packet.crc = (best_bytes[PKT_OFFSET_CRC] << 8) | best_bytes[PKT_OFFSET_CRC + 1];

    // Calculate CRC on first 22 bytes
    uint16_t calc = this->calc_crc(best_bytes, 22);
    packet.crc_valid = (calc == packet.crc);
  } else {
    packet.crc = 0;
    packet.crc_valid = false;
  }

  packet.valid = true;
  return true;
}

const char *LutronDecoder::packet_type_name(uint8_t type) {
  switch (type) {
    case PKT_BUTTON_SHORT_A: return "BTN_SHORT_A";
    case PKT_BUTTON_LONG_A: return "BTN_LONG_A";
    case PKT_BUTTON_SHORT_B: return "BTN_SHORT_B";
    case PKT_BUTTON_LONG_B: return "BTN_LONG_B";
    case PKT_LEVEL: return "SET_LEVEL";
    case PKT_STATE_REPORT_81: return "STATE_RPT";
    case PKT_STATE_REPORT_82: return "STATE_RPT";
    case PKT_STATE_REPORT_83: return "STATE_RPT";
    case PKT_UNPAIR: return "UNPAIR";
    case PKT_UNPAIR_PREP: return "UNPAIR_PREP";
    case PKT_PAIRING_B8: return "PAIR_B8";
    case PKT_PAIRING_B9: return "PAIR_B9";
    case PKT_PAIRING_BA: return "PAIR_BA";
    case PKT_PAIRING_BB: return "PAIR_BB";
    case PKT_PAIRING_B0: return "PAIR_B0";
    case PKT_BEACON: return "BEACON";
    case PKT_BEACON_STOP: return "BEACON_STOP";
    case PKT_PAIR_RESP_C0: return "PAIR_RESP_C0";
    case PKT_PAIR_RESP_C1: return "PAIR_RESP_C1";
    case PKT_PAIR_RESP_C2: return "PAIR_RESP_C2";
    case PKT_PAIR_RESP_C8: return "PAIR_RESP_C8";
    default:
      // Handle any other 0xC0-0xCF as generic pairing response
      if (type >= 0xC0 && type <= 0xCF) return "PAIR_RESP";
      return "UNKNOWN";
  }
}

const char *LutronDecoder::button_name(uint8_t button) {
  switch (button) {
    // 5-button Pico (PJ2-3BRL)
    case BTN_ON: return "ON";           // 0x02
    case BTN_FAVORITE: return "FAV";    // 0x03
    case BTN_OFF: return "OFF";         // 0x04
    case BTN_RAISE: return "RAISE";     // 0x05
    case BTN_LOWER: return "LOWER";     // 0x06
    // 4-button Picos: Scene (PJ2-4B-S) or Raise/Lower (PJ2-4B)
    // 0x08/0x0B = ON/OFF on both types
    // 0x09/0x0A = Scene2/Scene3 on scene pico, RAISE/LOWER on raise/lower pico
    case BTN_SCENE4: return "ON";       // 0x08 - top button
    case BTN_SCENE3: return "RAISE";    // 0x09 - second from top (raise on PJ2-4B)
    case BTN_SCENE2: return "LOWER";    // 0x0A - third (lower on PJ2-4B)
    case BTN_SCENE1: return "OFF";      // 0x0B - bottom button
    // Special
    case 0xFF: return "RESET";          // Pico unpair/reset broadcast
    default: return "?";
  }
}

void LutronDecoder::format_device_id(uint32_t device_id, char *buffer) {
  // Format as 8 hex digits (like printed on Pico label)
  // Device ID stored little-endian, we display big-endian
  snprintf(buffer, 9, "%08X", device_id);
}

bool LutronDecoder::parse_bytes(const uint8_t *bytes, size_t len, DecodedPacket &packet) {
  // Initialize packet
  packet.valid = false;
  packet.raw_len = 0;

  if (len < 10) {  // Need at least some bytes to be useful
    ESP_LOGD(TAG, "parse_bytes: too few bytes (%d)", len);
    return false;
  }

  // Copy raw bytes
  packet.raw_len = len;
  for (size_t i = 0; i < len && i < sizeof(packet.raw); i++) {
    packet.raw[i] = bytes[i];
  }

  // Parse packet structure (same logic as decode())
  packet.type = bytes[PKT_OFFSET_TYPE];
  packet.sequence = bytes[PKT_OFFSET_SEQ];

  // Initialize optional fields
  packet.button = 0;
  packet.action = 0;
  packet.level = 0;
  packet.target_id = 0;

  // Parse type-specific fields - device ID endianness depends on packet type
  if (packet.type == PKT_BUTTON_SHORT_A || packet.type == PKT_BUTTON_LONG_A ||
      packet.type == PKT_BUTTON_SHORT_B || packet.type == PKT_BUTTON_LONG_B) {
    // Button press packets - stored LITTLE-endian (all source IDs are LE)
    packet.device_id = bytes[PKT_OFFSET_DEVICE_ID] |
                       (bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);
    packet.button = bytes[PKT_OFFSET_BUTTON];
    packet.action = bytes[PKT_OFFSET_ACTION];
  } else if (packet.type == PKT_STATE_REPORT_81 || packet.type == PKT_STATE_REPORT_82 ||
             packet.type == PKT_STATE_REPORT_83) {
    // Types 0x81/0x82/0x83 - check format byte at [7] to determine actual packet type:
    // - Format 0x08 = STATE_RPT (dimmer reporting level)
    // - Format 0x09 = UNPAIR_PREP (unpair phase 1)
    // - Format 0x0C = UNPAIR (unpair phase 2 flood)
    // - Format 0x0E = LEVEL (bridge setting level)
    uint8_t format_byte = (len >= 8) ? bytes[7] : 0;

    // Source ID is always little-endian for 0x81-0x83 packets
    packet.device_id = bytes[PKT_OFFSET_DEVICE_ID] |
                       (bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);

    if (format_byte == 0x0E) {
      // Bridge level command - reclassify as LEVEL type
      packet.type = PKT_LEVEL;
      if (len >= 18) {
        uint16_t raw_level = (bytes[16] << 8) | bytes[17];
        uint32_t calc = (uint32_t)raw_level * 100 + 32639;
        uint8_t level = (uint8_t)(calc / 65279);
        packet.level = (level > 100) ? 100 : level;
      }
      if (len >= 13) {
        packet.target_id = (bytes[9] << 24) |
                           (bytes[10] << 16) |
                           (bytes[11] << 8) |
                           bytes[12];
      }
    } else if (format_byte == 0x0C) {
      // UNPAIR flood packet - reclassify
      packet.type = PKT_UNPAIR;
      if (len >= 20) {
        packet.target_id = (bytes[16] << 24) |
                           (bytes[17] << 16) |
                           (bytes[18] << 8) |
                           bytes[19];
      }
    } else if (format_byte == 0x09) {
      // UNPAIR prepare packet - reclassify
      packet.type = PKT_UNPAIR_PREP;
      if (len >= 13) {
        packet.target_id = (bytes[9] << 24) |
                           (bytes[10] << 16) |
                           (bytes[11] << 8) |
                           bytes[12];
      }
    } else if (format_byte == 0x08) {
      // True state report - level at byte 11 (0x00-0xFE = 0-100%)
      if (len >= 12) {
        uint8_t raw_level = bytes[PKT_OFFSET_LEVEL];
        packet.level = (uint8_t)(((uint32_t)raw_level * 100 + 127) / 254);
      }
    }
    // else: Unknown format - leave as STATE_RPT but don't parse level
  } else if (packet.type == PKT_LEVEL) {
    // Level commands use LITTLE-endian device IDs
    packet.device_id = bytes[PKT_OFFSET_DEVICE_ID] |
                       (bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);
    // Level command packets (0xA2) - different format, level at offset 9
    if (len >= 10) {
      packet.level = bytes[9];
    }
    // Target device ID at offset 10-13 (little-endian)
    if (len >= 14) {
      packet.target_id = bytes[10] |
                         (bytes[11] << 8) |
                         (bytes[12] << 16) |
                         (bytes[13] << 24);
    }
  } else if (packet.type == PKT_PAIRING_B8 || packet.type == PKT_PAIRING_B9 ||
             packet.type == PKT_PAIRING_BA || packet.type == PKT_PAIRING_BB ||
             packet.type == PKT_PAIRING_B0) {
    // Pairing packets - stored LITTLE-endian (source ID)
    packet.device_id = bytes[PKT_OFFSET_DEVICE_ID] |
                       (bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);
  } else if (packet.type == PKT_BEACON) {
    // Beacon packets - LITTLE-endian load ID
    packet.device_id = bytes[PKT_OFFSET_DEVICE_ID] |
                       (bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);
  } else {
    // All other packets - default to LITTLE-endian
    packet.device_id = bytes[PKT_OFFSET_DEVICE_ID] |
                       (bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);
  }

  // CRC from packet (if we have enough bytes)
  if (len >= 24) {
    packet.crc = (bytes[PKT_OFFSET_CRC] << 8) | bytes[PKT_OFFSET_CRC + 1];
    // Calculate CRC on first 22 bytes
    uint16_t calc = this->calc_crc(bytes, 22);
    packet.crc_valid = (calc == packet.crc);
  } else {
    packet.crc = 0;
    packet.crc_valid = false;
  }

  packet.valid = true;
  return true;
}

void LutronDecoder::log_packet_json(const DecodedPacket &packet) {
  char device_id_str[9];
  format_device_id(packet.device_id, device_id_str);

  const char *type_name = packet_type_name(packet.type);
  const char *btn_name = button_name(packet.button);

  // Build JSON output - format suitable for parsing by test framework
  // TEST_RESULT: prefix makes it easy to find in log stream
  ESP_LOGI("TEST_RESULT", "{\"type\":\"%s\",\"type_byte\":\"0x%02X\",\"sequence\":%d,"
           "\"device_id\":\"%s\",\"button\":\"%s\",\"button_code\":\"0x%02X\","
           "\"action\":%d,\"level\":%d,\"target_id\":\"0x%08X\","
           "\"crc\":\"0x%04X\",\"crc_valid\":%s,\"raw_len\":%d}",
           type_name, packet.type, packet.sequence,
           device_id_str, btn_name, packet.button,
           packet.action, packet.level, packet.target_id,
           packet.crc, packet.crc_valid ? "true" : "false", (int)packet.raw_len);
}

}  // namespace lutron_cc1101
}  // namespace esphome
