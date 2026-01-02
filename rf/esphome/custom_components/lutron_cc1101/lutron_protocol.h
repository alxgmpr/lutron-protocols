#pragma once

#include <cstdint>
#include <cstddef>

namespace esphome {
namespace lutron_cc1101 {

// Lutron Button Codes
static const uint8_t LUTRON_BUTTON_ON = 0x02;
static const uint8_t LUTRON_BUTTON_FAVORITE = 0x03;
static const uint8_t LUTRON_BUTTON_OFF = 0x04;
static const uint8_t LUTRON_BUTTON_RAISE = 0x05;
static const uint8_t LUTRON_BUTTON_LOWER = 0x06;

// Packet Types (from RF capture analysis)
static const uint8_t PKT_TYPE_BUTTON_SHORT_A = 0x88;
static const uint8_t PKT_TYPE_BUTTON_LONG_A = 0x89;
static const uint8_t PKT_TYPE_BUTTON_SHORT_B = 0x8A;
static const uint8_t PKT_TYPE_BUTTON_LONG_B = 0x8B;
static const uint8_t PKT_TYPE_PAIRING = 0xB9;  // Real Pico uses this

// CRC polynomial from lutron_hacks
static const uint16_t CRC_POLYNOMIAL = 0xCA0F;

/**
 * @brief Lutron CCA protocol encoder
 *
 * Handles CRC calculation and N81 serial encoding for Lutron packets.
 */
class LutronEncoder {
 public:
  LutronEncoder();

  /**
   * @brief Calculate CRC-16 for a packet
   * @param data Packet data (excluding CRC bytes)
   * @param len Length of data
   * @return 16-bit CRC value
   */
  uint16_t calc_crc(const uint8_t *data, size_t len);

  /**
   * @brief Encode a packet with preamble, sync, prefix, N81 data, and trailing
   *
   * Output format:
   * - Preamble: alternating 1010... (preamble_bits)
   * - Sync: 0xFF encoded as N81
   * - Prefix: 0xFA 0xDE encoded as N81
   * - Data: packet bytes encoded as N81
   * - Trailing: zeros (trailing_bits)
   *
   * @param packet Raw packet bytes (including CRC)
   * @param packet_len Packet length
   * @param output Output buffer for encoded bits (packed as bytes)
   * @param output_size Size of output buffer
   * @param preamble_bits Number of preamble bits (default 32)
   * @param trailing_bits Number of trailing bits (default 16)
   * @return Number of bytes written to output, or 0 on error
   */
  size_t encode_packet(const uint8_t *packet, size_t packet_len,
                       uint8_t *output, size_t output_size,
                       int preamble_bits = 32, int trailing_bits = 16);

 private:
  uint16_t crc_table_[256];
};

}  // namespace lutron_cc1101
}  // namespace esphome
