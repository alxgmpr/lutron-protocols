#pragma once

#include "cc1101_radio.h"
#include "lutron_protocol.h"

namespace esphome {
namespace lutron_cc1101 {

/**
 * @brief Lutron Clear Connect pairing handler
 *
 * Implements the pairing protocol for associating a virtual Pico with
 * Lutron devices. This is experimental and under development.
 *
 * KNOWN FROM CAPTURES:
 * - Real Pico uses packet type 0xB9 for pairing
 * - Packet size: 47 bytes (45 data + 2 CRC)
 * - Device ID appears 3 times in packet
 * - Packets sent at ~8 Hz (125ms interval)
 * - Sequence increments by 6: 00, 06, 0C, 12, 18...
 *
 * UNKNOWN:
 * - Exact meaning of bytes 8-12, 18-19, 28-39
 * - Why CRC doesn't match our calculation
 * - Whether receiver checks packet length/format strictly
 */
class LutronPairing {
 public:
  LutronPairing(CC1101Radio *radio);

  /**
   * @brief Send pairing sequence using real Pico format (0xB9)
   *
   * Attempts to pair using the exact packet structure captured from
   * a real Pico remote.
   *
   * @param device_id 32-bit device ID to pair
   * @param duration_seconds How long to transmit (default 5)
   */
  void send_pairing_b9(uint32_t device_id, int duration_seconds = 5);

  /**
   * @brief Send raw pairing packet for testing
   *
   * Sends a single packet with custom content for protocol analysis.
   *
   * @param packet Raw packet bytes (will add CRC)
   * @param len Length of packet data (excluding CRC)
   */
  void send_raw_packet(const uint8_t *packet, size_t len);

  /**
   * @brief Replay exact bytes from capture (no re-encoding)
   *
   * For testing: sends the exact raw encoded bytes from a capture.
   * This bypasses our encoding to test if the issue is encoding-related.
   *
   * @param raw_encoded Already-encoded bytes (preamble+sync+data)
   * @param len Length of raw data
   */
  void replay_raw(const uint8_t *raw_encoded, size_t len);

 private:
  CC1101Radio *radio_;
  LutronEncoder encoder_;
  uint8_t sequence_{0};

  uint8_t next_seq();
  void transmit_encoded(const uint8_t *packet, size_t len);
};

}  // namespace lutron_cc1101
}  // namespace esphome
