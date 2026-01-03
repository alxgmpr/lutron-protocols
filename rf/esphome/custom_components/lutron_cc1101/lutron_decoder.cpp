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
  if (total_bits < 240) {  // Need at least 24 bytes * 10 bits/byte
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

  size_t best_offset = 0;
  size_t best_decoded = 0;
  uint8_t best_bytes[56];  // Expanded for pairing packets (up to 53 bytes)

  // Strategy 1: Search every bit position for valid N81 sequence starting with known packet types
  for (size_t bit_pos = 0; bit_pos + 270 < total_bits; bit_pos++) {
    uint8_t byte1, byte2, byte3;

    // Try to decode 3 consecutive bytes
    if (!decode_n81_byte(fifo_data, bit_pos, byte1)) continue;
    if (!decode_n81_byte(fifo_data, bit_pos + 10, byte2)) continue;
    if (!decode_n81_byte(fifo_data, bit_pos + 20, byte3)) continue;

    // Check for 0xFF 0xFA 0xDE (sync + prefix)
    bool found_prefix = (byte1 == 0xFF && byte2 == 0xFA && byte3 == 0xDE);

    // Check for 0xFA 0xDE + packet type
    bool found_prefix_short = (byte1 == 0xFA && byte2 == 0xDE &&
                                byte3 >= 0x80 && byte3 <= 0xBF);

    // Check for direct packet type start (0x88, 0x89, 0x8A, 0x8B, 0xB9, etc.)
    bool found_packet = (byte1 >= 0x80 && byte1 <= 0xBF &&
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

    // Determine max bytes based on packet type hint
    // Pairing packets (B0-BF) can be up to 53 bytes
    // Standard button packets are 24 bytes
    size_t max_decode = 53;  // Decode as many as possible

    for (size_t byte_idx = 0; byte_idx < max_decode; byte_idx++) {
      size_t bp = data_start + byte_idx * 10;
      if (bp + 10 > total_bits) break;

      uint8_t bv;
      if (!decode_n81_byte(fifo_data, bp, bv)) break;
      decoded_bytes[decoded_count++] = bv;
    }

    // Check if this looks like a valid Lutron packet
    if (decoded_count >= 24) {
      // Verify it looks like a Lutron packet (type byte in valid range)
      uint8_t pkt_type = decoded_bytes[0];
      if (pkt_type >= 0x80 && pkt_type <= 0xBF) {
        // This is likely a valid packet!
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
    // State reports use LITTLE-endian device IDs
    packet.device_id = best_bytes[PKT_OFFSET_DEVICE_ID] |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 1] << 8) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 2] << 16) |
                       (best_bytes[PKT_OFFSET_DEVICE_ID + 3] << 24);
    // Types 0x81/0x82/0x83 can be either:
    // - State report: bytes 6-7 = 0x00 0x08, level at byte 11
    // - Bridge level command: bytes 6-7 = 0x21 0x0E, level at bytes 16-17
    if (best_bytes[6] == 0x21 && best_bytes[7] == 0x0E) {
      // Bridge level command - reclassify as LEVEL type
      packet.type = PKT_LEVEL;
      // Level is 16-bit big-endian at bytes 16-17 (0x0000-0xFEFF)
      uint16_t raw_level = (best_bytes[16] << 8) | best_bytes[17];
      packet.level = (uint8_t)((uint32_t)raw_level * 100 / 65279);
      // Target device ID at bytes 9-12 (big-endian in bridge commands)
      packet.target_id = (best_bytes[9] << 24) |
                         (best_bytes[10] << 16) |
                         (best_bytes[11] << 8) |
                         best_bytes[12];
    } else {
      // True state report - level at byte 11 (0x00-0xFE = 0-100%)
      uint8_t raw_level = best_bytes[PKT_OFFSET_LEVEL];
      packet.level = (raw_level * 100) / 254;
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
    case PKT_LEVEL: return "LEVEL";
    case PKT_STATE_REPORT_81: return "STATE_RPT";
    case PKT_STATE_REPORT_82: return "STATE_RPT";
    case PKT_STATE_REPORT_83: return "STATE_RPT";
    case PKT_PAIRING_B8: return "PAIR_B8";
    case PKT_PAIRING_B9: return "PAIR_B9";
    case PKT_PAIRING_BA: return "PAIR_BA";
    case PKT_PAIRING_BB: return "PAIR_BB";
    case PKT_PAIRING_B0: return "PAIR_B0";
    case PKT_BEACON: return "BEACON";
    default: return "UNKNOWN";
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

}  // namespace lutron_cc1101
}  // namespace esphome
