#pragma once

// CCA packet encoder - preamble + sync + N81 + CRC
// Ported from cca/src/n81.rs encode_packet + cca/src/crc.rs

#include "cca_crc.h"
#include "cca_n81.h"

namespace esphome {
namespace cc1101_cca {

class CcaEncoder {
 public:
  CcaEncoder() = default;

  // Calculate CRC-16 for packet data
  uint16_t calc_crc(const uint8_t *data, size_t len) {
    return cca_calc_crc(data, len);
  }

  // Encode a packet with preamble, sync, prefix, N81 data, and trailing.
  // preamble_bits and trailing_bits are accepted for API compatibility
  // but the implementation always uses the values that produce correct output.
  size_t encode_packet(const uint8_t *packet, size_t packet_len,
                       uint8_t *output, size_t output_size,
                       int preamble_bits = 32, int trailing_bits = 16) {
    (void)preamble_bits;
    (void)trailing_bits;
    return n81_encode_packet(packet, packet_len, output, output_size);
  }
};

}  // namespace cc1101_cca
}  // namespace esphome
