#include "lutron_protocol.h"

namespace esphome {
namespace lutron_cc1101 {

LutronEncoder::LutronEncoder() {
  // Generate CRC table for polynomial 0xCA0F
  for (int i = 0; i < 256; i++) {
    uint16_t crc = i << 8;
    for (int j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ CRC_POLYNOMIAL) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
    this->crc_table_[i] = crc;
  }
}

uint16_t LutronEncoder::calc_crc(const uint8_t *data, size_t len) {
  uint16_t crc_reg = 0;
  for (size_t i = 0; i < len; i++) {
    uint8_t crc_upper = crc_reg >> 8;
    crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ this->crc_table_[crc_upper];
  }
  return crc_reg;
}

size_t LutronEncoder::encode_packet(const uint8_t *packet, size_t packet_len,
                                     uint8_t *output, size_t output_size,
                                     int preamble_bits, int trailing_bits) {
  // Calculate required output size
  // Preamble + sync(10) + prefix(20) + data(packet_len*10) + trailing
  size_t total_bits = preamble_bits + 10 + 20 + (packet_len * 10) + trailing_bits;
  size_t required_bytes = (total_bits + 7) / 8;

  if (required_bytes > output_size) {
    return 0;  // Buffer too small
  }

  // Clear output buffer
  for (size_t i = 0; i < required_bytes; i++) {
    output[i] = 0;
  }

  int bit_pos = 0;

  // Helper to set a bit
  auto set_bit = [&output, &bit_pos](int val) {
    if (val) {
      output[bit_pos / 8] |= (1 << (7 - (bit_pos % 8)));
    }
    bit_pos++;
  };

  // Helper to encode a byte as N81
  // Start bit (0) + 8 data bits LSB first + Stop bit (1)
  auto encode_byte = [&set_bit](uint8_t byte) {
    set_bit(0);  // Start bit
    for (int i = 0; i < 8; i++) {
      set_bit((byte >> i) & 1);  // Data bits LSB first
    }
    set_bit(1);  // Stop bit
  };

  // Preamble: alternating bits starting with 1
  for (int i = 0; i < preamble_bits; i++) {
    set_bit((i + 1) % 2);  // 1,0,1,0,1,0...
  }

  // Sync byte 0xFF
  encode_byte(0xFF);

  // Prefix 0xFA 0xDE
  encode_byte(0xFA);
  encode_byte(0xDE);

  // Data bytes
  for (size_t i = 0; i < packet_len; i++) {
    encode_byte(packet[i]);
  }

  // Trailing zeros
  for (int i = 0; i < trailing_bits; i++) {
    set_bit(0);
  }

  return (bit_pos + 7) / 8;
}

}  // namespace lutron_cc1101
}  // namespace esphome
