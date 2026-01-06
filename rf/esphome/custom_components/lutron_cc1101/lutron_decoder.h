#pragma once

#include <cstdint>
#include <cstddef>

namespace esphome {
namespace lutron_cc1101 {

// Packet types
static const uint8_t PKT_BUTTON_SHORT_A = 0x88;
static const uint8_t PKT_BUTTON_LONG_A = 0x89;
static const uint8_t PKT_BUTTON_SHORT_B = 0x8A;
static const uint8_t PKT_BUTTON_LONG_B = 0x8B;
static const uint8_t PKT_LEVEL = 0xA2;
static const uint8_t PKT_CONFIG_A3 = 0xA3;  // Device config command variant
static const uint8_t PKT_STATE_REPORT_81 = 0x81;
static const uint8_t PKT_STATE_REPORT_82 = 0x82;
static const uint8_t PKT_STATE_REPORT_83 = 0x83;
// Pairing packet types - determine remote capabilities:
//   B9/BB: Direct-pair capable (2-button, 5-button, 4-button raise/lower)
//          These picos can pair directly to switches/dimmers without a bridge.
//   BA/B8: Bridge-only pairing (4-button scene picos)
//          These picos must pair through a RadioRA3/Homeworks bridge.
// During pairing, picos alternate between the two packet types in their category:
//   Direct-pair: B9 <-> BB
//   Bridge-only: BA <-> B8
static const uint8_t PKT_PAIRING_B8 = 0xB8;  // Bridge-only (scene pico)
static const uint8_t PKT_PAIRING_B9 = 0xB9;  // Direct-pair capable
static const uint8_t PKT_PAIRING_BA = 0xBA;  // Bridge-only (scene pico)
static const uint8_t PKT_PAIRING_BB = 0xBB;  // Direct-pair capable
static const uint8_t PKT_PAIRING_B0 = 0xB0;  // Unknown/legacy
static const uint8_t PKT_BEACON = 0x91;
static const uint8_t PKT_BEACON_STOP = 0x92;

// Pairing response/acknowledgement packets from devices during pairing
// Devices send these after receiving B0 assignment packets
static const uint8_t PKT_PAIR_RESP_C0 = 0xC0;
static const uint8_t PKT_PAIR_RESP_C1 = 0xC1;
static const uint8_t PKT_PAIR_RESP_C2 = 0xC2;
static const uint8_t PKT_PAIR_RESP_C8 = 0xC8;

// Virtual packet types (assigned during decode, not actual wire types)
// Used when format byte at [7] distinguishes packet subtype
static const uint8_t PKT_UNPAIR = 0xF0;       // Format 0x0C - bridge unpair command
static const uint8_t PKT_UNPAIR_PREP = 0xF1;  // Format 0x09 - unpair prepare phase
static const uint8_t PKT_LED_CONFIG = 0xF2;   // Format 0x11 - LED config command (A2/A3)

// Button codes - 5-button Pico
static const uint8_t BTN_ON = 0x02;
static const uint8_t BTN_FAVORITE = 0x03;
static const uint8_t BTN_OFF = 0x04;
static const uint8_t BTN_RAISE = 0x05;
static const uint8_t BTN_LOWER = 0x06;
// Button codes - Scene Pico (4-button) - numbered top to bottom
static const uint8_t BTN_SCENE1 = 0x0B;  // Top button (Bright)
static const uint8_t BTN_SCENE2 = 0x0A;  // Second (Entertain)
static const uint8_t BTN_SCENE3 = 0x09;  // Third (Relax)
static const uint8_t BTN_SCENE4 = 0x08;  // Bottom (Off)

// Action codes
static const uint8_t ACTION_PRESS = 0x00;
static const uint8_t ACTION_RELEASE = 0x01;

// Packet structure offsets (in decoded packet)
static const uint8_t PKT_OFFSET_TYPE = 0;
static const uint8_t PKT_OFFSET_SEQ = 1;
static const uint8_t PKT_OFFSET_DEVICE_ID = 2;  // 4 bytes, little-endian
static const uint8_t PKT_OFFSET_BUTTON = 10;
static const uint8_t PKT_OFFSET_ACTION = 11;
static const uint8_t PKT_OFFSET_LEVEL = 11;     // Level byte for STATE_REPORT packets
static const uint8_t PKT_OFFSET_TARGET_ID = 10; // Target device ID for bridge commands
static const uint8_t PKT_OFFSET_CRC = 22;       // 2 bytes, big-endian

static const size_t PKT_STANDARD_LEN = 24;
static const size_t PKT_PAIRING_LEN = 53;

// Packet length lookup - returns expected N81 byte count for a type byte
// Returns 0 for unknown types
inline size_t get_packet_length(uint8_t type_byte) {
  // 0x80-0x8F: State reports, button packets - 24 bytes
  if (type_byte >= 0x80 && type_byte <= 0x8F) return PKT_STANDARD_LEN;
  // 0x90-0x9F: Beacons - 24 bytes
  if (type_byte >= 0x90 && type_byte <= 0x9F) return PKT_STANDARD_LEN;
  // 0xA0-0xAF: Level commands - 24 bytes
  if (type_byte >= 0xA0 && type_byte <= 0xAF) return PKT_STANDARD_LEN;
  // 0xB0-0xBF: Pairing announcements - 53 bytes
  if (type_byte >= 0xB0 && type_byte <= 0xBF) return PKT_PAIRING_LEN;
  // 0xC0-0xCF: Pairing responses - 24 bytes
  if (type_byte >= 0xC0 && type_byte <= 0xCF) return PKT_STANDARD_LEN;
  return 0;  // Unknown
}

// Minimum CC1101 bytes needed to decode a packet of given N81 length
// Formula: (n81_bytes * 10 + 30) / 8, rounded up, plus margin
inline size_t get_min_cc1101_bytes(size_t n81_len) {
  // Each N81 byte = 10 bits, plus ~30 bits for sync prefix search
  // Add margin for bit alignment search
  return ((n81_len * 10 + 50) / 8) + 5;
}

// CRC polynomial
static const uint16_t LUTRON_CRC_POLY = 0xCA0F;

/**
 * @brief Decoded Lutron packet
 */
struct DecodedPacket {
  bool valid;
  uint8_t type;
  uint8_t sequence;
  uint32_t device_id;    // 32-bit device ID (source)
  uint8_t button;
  uint8_t action;
  uint8_t level;         // Level 0-100 for LEVEL/STATE packets
  uint32_t target_id;    // Target device ID for bridge commands
  uint16_t crc;
  bool crc_valid;
  uint8_t raw[56];       // Raw decoded bytes (expanded for pairing packets)
  size_t raw_len;
};

/**
 * @brief Lutron CCA protocol decoder
 *
 * Decodes N81-encoded packets from CC1101 FIFO data.
 */
class LutronDecoder {
 public:
  LutronDecoder();

  /**
   * @brief Decode raw CC1101 FIFO data to Lutron packet
   *
   * The CC1101 captures bits after sync word detection. This function:
   * 1. Converts bytes to bitstream
   * 2. Finds N81 frame alignment
   * 3. Decodes bytes from N81 format
   * 4. Parses packet structure
   *
   * @param fifo_data Raw bytes from CC1101 RXFIFO
   * @param len Number of bytes (typically 32)
   * @param packet Output decoded packet
   * @return true if a valid packet was decoded
   */
  bool decode(const uint8_t *fifo_data, size_t len, DecodedPacket &packet);

  /**
   * @brief Get human-readable packet type name
   */
  static const char *packet_type_name(uint8_t type);

  /**
   * @brief Get human-readable button name
   */
  static const char *button_name(uint8_t button);

  /**
   * @brief Format device ID as hex string (like printed on Pico label)
   * @param device_id 32-bit device ID
   * @param buffer Output buffer (at least 9 bytes)
   */
  static void format_device_id(uint32_t device_id, char *buffer);

  /**
   * @brief Calculate CRC-16 for packet data
   */
  uint16_t calc_crc(const uint8_t *data, size_t len);

  /**
   * @brief Parse already-decoded packet bytes (skip N81 decoding)
   * Used for testing packet parsing without RF reception
   * @param bytes Decoded packet bytes (24-53 bytes)
   * @param len Number of bytes
   * @param packet Output decoded packet
   * @return true if valid packet structure
   */
  bool parse_bytes(const uint8_t *bytes, size_t len, DecodedPacket &packet);

  /**
   * @brief Log packet as JSON for test verification
   * Format: TEST_RESULT: {"type": "BTN_SHORT_A", "device_id": "0595E68D", ...}
   */
  void log_packet_json(const DecodedPacket &packet);

 private:
  uint16_t crc_table_[256];

  /**
   * @brief Decode a single N81 byte from bitstream
   * @param bits Pointer to 10 bits (as packed bytes)
   * @param bit_offset Starting bit offset
   * @param byte_out Output decoded byte
   * @return true if valid N81 framing (start=0, stop=1)
   */
  bool decode_n81_byte(const uint8_t *bits, size_t bit_offset, uint8_t &byte_out);

  /**
   * @brief Get bit value from packed bytes
   */
  int get_bit(const uint8_t *data, size_t bit_index);
};

}  // namespace lutron_cc1101
}  // namespace esphome
