#pragma once

// CCA CRC-16 implementation (polynomial 0xCA0F)
// Ported from cca/src/crc.rs

#include <cstdint>
#include <cstddef>

namespace esphome {
namespace cc1101_cca {

static const uint16_t CCA_CRC_POLY = 0xCA0F;

namespace detail {

struct CrcTable {
  uint16_t data[256];

  constexpr CrcTable() : data{} {
    for (int i = 0; i < 256; i++) {
      uint16_t crc = static_cast<uint16_t>(i) << 8;
      for (int j = 0; j < 8; j++) {
        if (crc & 0x8000) {
          crc = ((crc << 1) ^ CCA_CRC_POLY) & 0xFFFF;
        } else {
          crc = (crc << 1) & 0xFFFF;
        }
      }
      data[i] = crc;
    }
  }
};

static constexpr CrcTable CRC_TABLE{};

}  // namespace detail

// Calculate CRC-16 over data[0..len)
inline uint16_t cca_calc_crc(const uint8_t *data, size_t len) {
  uint16_t crc_reg = 0;
  for (size_t i = 0; i < len; i++) {
    uint8_t crc_upper = static_cast<uint8_t>(crc_reg >> 8);
    crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ detail::CRC_TABLE.data[crc_upper];
  }
  return crc_reg;
}

// Check CRC at specific known packet lengths.
// Returns matching length, or -1 if no match.
// candidates[] is an array of n_candidates lengths to try (e.g. {24, 53}).
inline int cca_check_crc_at_lengths(const uint8_t *bytes, size_t bytes_len,
                                    const size_t *candidates, size_t n_candidates) {
  for (size_t i = 0; i < n_candidates; i++) {
    size_t len = candidates[i];
    if (bytes_len < len || len < 4) continue;
    size_t crc_offset = len - 2;
    uint16_t computed = cca_calc_crc(bytes, crc_offset);
    uint16_t received = (static_cast<uint16_t>(bytes[crc_offset]) << 8) | bytes[crc_offset + 1];
    if (computed == received) {
      return static_cast<int>(len);
    }
  }
  return -1;
}

// Append 2-byte big-endian CRC to payload.
// output must have room for len+2 bytes.
inline void cca_append_crc(const uint8_t *payload, size_t len, uint8_t *output) {
  for (size_t i = 0; i < len; i++) output[i] = payload[i];
  uint16_t crc = cca_calc_crc(payload, len);
  output[len] = static_cast<uint8_t>(crc >> 8);
  output[len + 1] = static_cast<uint8_t>(crc & 0xFF);
}

}  // namespace cc1101_cca
}  // namespace esphome
