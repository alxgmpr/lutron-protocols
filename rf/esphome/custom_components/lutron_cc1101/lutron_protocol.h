#pragma once

// Lutron CCA Protocol Encoder - C++ wrapper around Rust FFI
//
// This wraps the Rust CCA library (libcca.a) for ESPHome integration.
// The actual encoding logic is in rf/cca/src/

#include <cstdint>
#include <cstddef>

// Include the Rust-generated C header
extern "C" {
#include "cca.h"
}

namespace esphome {
namespace lutron_cc1101 {

// Lutron Button Codes (re-exported from Rust for compatibility)
static const uint8_t LUTRON_BUTTON_ON = 0x02;
static const uint8_t LUTRON_BUTTON_FAVORITE = 0x03;
static const uint8_t LUTRON_BUTTON_OFF = 0x04;
static const uint8_t LUTRON_BUTTON_RAISE = 0x05;
static const uint8_t LUTRON_BUTTON_LOWER = 0x06;

// Packet Types
static const uint8_t PKT_TYPE_BUTTON_SHORT_A = 0x88;
static const uint8_t PKT_TYPE_BUTTON_LONG_A = 0x89;
static const uint8_t PKT_TYPE_BUTTON_SHORT_B = 0x8A;
static const uint8_t PKT_TYPE_BUTTON_LONG_B = 0x8B;
static const uint8_t PKT_TYPE_PAIRING = 0xB9;

// CRC polynomial (for reference - actual calc done in Rust)
static const uint16_t CRC_POLYNOMIAL = 0xCA0F;

/**
 * @brief Lutron CCA protocol encoder (wraps Rust FFI)
 */
class LutronEncoder {
 public:
  LutronEncoder() = default;

  /**
   * @brief Calculate CRC-16 for a packet
   */
  uint16_t calc_crc(const uint8_t *data, size_t len) {
    return cca_calc_crc(data, len);
  }

  /**
   * @brief Encode a packet with preamble, sync, prefix, N81 data, and trailing
   *
   * Output format:
   * - Preamble: 32 alternating bits (1010...)
   * - Sync: 0xFF encoded as N81
   * - Prefix: 0xFA 0xDE encoded as N81
   * - Data: packet bytes encoded as N81
   * - Trailing: 16 zero bits
   *
   * @param packet Raw packet bytes (including CRC)
   * @param packet_len Packet length
   * @param output Output buffer for encoded bits (packed as bytes)
   * @param output_size Size of output buffer
   * @param preamble_bits Ignored (always 32 in Rust implementation)
   * @param trailing_bits Ignored (always 16 in Rust implementation)
   * @return Number of bytes written to output, or 0 on error
   */
  size_t encode_packet(const uint8_t *packet, size_t packet_len,
                       uint8_t *output, size_t output_size,
                       int preamble_bits = 32, int trailing_bits = 16) {
    (void)preamble_bits;  // Unused - Rust uses fixed 32
    (void)trailing_bits;  // Unused - Rust uses fixed 16
    return cca_encode_packet(packet, packet_len, output, output_size);
  }
};

}  // namespace lutron_cc1101
}  // namespace esphome
