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

  /**
   * @brief Experimental pairing with configurable parameters
   *
   * Allows testing different protocol variants and packet counts.
   *
   * @param device_id 32-bit device ID
   * @param ba_count Number of 0xBA packets (capability announcement)
   * @param bb_count Number of 0xBB packets (pair request)
   * @param protocol_variant 0=new (0x25), 1=old (0x21/0x17)
   * @param pico_type 0=scene (4-btn), 1=5-button
   * @param button_scheme Byte 10 value - tells receiver what button codes to expect:
   *                      0x04 = 5-button scheme (codes 0x02-0x06)
   *                      0x0B = 4-button scheme (codes 0x08-0x0B)
   */
  void send_pairing_experimental(uint32_t device_id, int ba_count, int bb_count,
                                  int protocol_variant, int pico_type, int button_scheme);

  /**
   * @brief Direct-pair as 5-button Pico using B9 packets
   *
   * Matches REAL 5-button Pico pairing capture exactly. Uses B9 packet type
   * for direct pairing to Caseta dimmers/switches (no bridge required).
   *
   * Key discovery: Bytes 37-38 advertise button range (0x02-0x06).
   * This tells dimmer that button 0x03 (FAV) is a dedicated function.
   *
   * @param device_id 32-bit device ID
   * @param duration_seconds How long to transmit (default 10)
   */
  void send_pairing_5button(uint32_t device_id, int duration_seconds = 10);

  /**
   * @brief Fully configurable pairing - replicate ANY Pico type exactly
   *
   * Real Picos alternate between two packet types each transmission.
   * This function lets you specify BOTH packet types and ALL capability bytes.
   *
   * Captured values:
   * - 2-btn paddle: A=B9, B=BB, b10=04, b30=03, b31=08, b37=01, b38=01
   * - 5-button:     A=B9, B=BB, b10=04, b30=03, b31=00, b37=02, b38=06
   * - 4-btn R/L:    A=B9, B=BB, b10=0B, b30=02, b31=00, b37=02, b38=21
   * - 4-btn scene:  A=B9, B=BB, b10=0B, b30=04, b31=00, b37=02, b38=28 (custom)
   * - 4-btn scene:  A=B8, B=BA, b10=0B, b30=04, b31=00, b37=02, b38=27 (std/bridge)
   */
  void send_pairing_advanced(uint32_t device_id, int duration_seconds,
                             uint8_t pkt_type_a, uint8_t pkt_type_b,
                             uint8_t byte10, uint8_t byte30, uint8_t byte31,
                             uint8_t byte37, uint8_t byte38);

 private:
  CC1101Radio *radio_;
  LutronEncoder encoder_;
  uint8_t sequence_{0};

  uint8_t next_seq();
  void transmit_encoded(const uint8_t *packet, size_t len);
};

}  // namespace lutron_cc1101
}  // namespace esphome
