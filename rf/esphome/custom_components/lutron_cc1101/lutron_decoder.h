#pragma once

// Lutron CCA Decoder - C++ wrapper around Rust FFI
//
// This wraps the Rust CCA library (libcca.a) for ESPHome integration.
// The actual decoding logic is in rf/cca/src/

#include <cstdint>
#include <cstddef>
#include <cstring>

// Include the Rust-generated C header
extern "C" {
#include "cca.h"
}

namespace esphome {
namespace lutron_cc1101 {

// Re-export constants from Rust for compatibility with existing code
static const uint8_t PKT_BUTTON_SHORT_A = 0x88;
static const uint8_t PKT_BUTTON_LONG_A = 0x89;
static const uint8_t PKT_BUTTON_SHORT_B = 0x8A;
static const uint8_t PKT_BUTTON_LONG_B = 0x8B;
static const uint8_t PKT_LEVEL = 0xA2;
static const uint8_t PKT_CONFIG_A3 = 0xA3;
static const uint8_t PKT_STATE_REPORT_81 = 0x81;
static const uint8_t PKT_STATE_REPORT_82 = 0x82;
static const uint8_t PKT_STATE_REPORT_83 = 0x83;
static const uint8_t PKT_PAIRING_B8 = 0xB8;
static const uint8_t PKT_PAIRING_B9 = 0xB9;
static const uint8_t PKT_PAIRING_BA = 0xBA;
static const uint8_t PKT_PAIRING_BB = 0xBB;
static const uint8_t PKT_PAIRING_B0 = 0xB0;
static const uint8_t PKT_BEACON = 0x91;
static const uint8_t PKT_BEACON_STOP = 0x92;
static const uint8_t PKT_PAIR_RESP_C0 = 0xC0;
static const uint8_t PKT_PAIR_RESP_C1 = 0xC1;
static const uint8_t PKT_PAIR_RESP_C2 = 0xC2;
static const uint8_t PKT_PAIR_RESP_C8 = 0xC8;
static const uint8_t PKT_UNPAIR = 0xF0;
static const uint8_t PKT_UNPAIR_PREP = 0xF1;
static const uint8_t PKT_LED_CONFIG = 0xF2;

static const uint8_t BTN_ON = 0x02;
static const uint8_t BTN_FAVORITE = 0x03;
static const uint8_t BTN_OFF = 0x04;
static const uint8_t BTN_RAISE = 0x05;
static const uint8_t BTN_LOWER = 0x06;
static const uint8_t BTN_SCENE1 = 0x0B;
static const uint8_t BTN_SCENE2 = 0x0A;
static const uint8_t BTN_SCENE3 = 0x09;
static const uint8_t BTN_SCENE4 = 0x08;

static const uint8_t ACTION_PRESS = 0x00;
static const uint8_t ACTION_RELEASE = 0x01;

static const uint8_t PKT_OFFSET_TYPE = 0;
static const uint8_t PKT_OFFSET_SEQ = 1;
static const uint8_t PKT_OFFSET_DEVICE_ID = 2;
static const uint8_t PKT_OFFSET_BUTTON = 10;
static const uint8_t PKT_OFFSET_ACTION = 11;
static const uint8_t PKT_OFFSET_LEVEL = 11;
static const uint8_t PKT_OFFSET_TARGET_ID = 10;
static const uint8_t PKT_OFFSET_CRC = 22;

static const uint16_t LUTRON_CRC_POLY = 0xCA0F;

// Minimum CC1101 bytes needed to decode a packet of given N81 length
inline size_t get_min_cc1101_bytes(size_t n81_len) {
  return ((n81_len * 10 + 50) / 8) + 5;
}

/**
 * @brief Decoded Lutron packet (compatible with existing code)
 *
 * This struct maps directly to the Rust CcaPacket via FFI.
 */
struct DecodedPacket {
  bool valid;
  uint8_t type;            // decoded_type from CcaPacket
  uint8_t sequence;
  uint32_t device_id;
  uint8_t button;
  uint8_t action;
  uint8_t level;
  uint32_t target_id;
  uint16_t crc;
  bool crc_valid;
  uint8_t raw[CCA_MAX_PACKET_LEN];
  size_t raw_len;

  // Convert from CcaPacket (FFI struct)
  void from_cca_packet(const CcaPacket &pkt) {
    valid = pkt.valid;
    type = pkt.decoded_type;
    sequence = pkt.sequence;
    device_id = pkt.device_id;
    button = pkt.button;
    action = pkt.action;
    level = pkt.level;
    target_id = pkt.target_id;
    crc = pkt.crc;
    crc_valid = pkt.crc_valid;
    raw_len = pkt.raw_len;
    memcpy(raw, pkt.raw, pkt.raw_len);
  }
};

/**
 * @brief Lutron CCA protocol decoder (wraps Rust FFI)
 */
class LutronDecoder {
 public:
  LutronDecoder() {
    decoder_ = cca_decoder_new();
  }

  ~LutronDecoder() {
    if (decoder_) {
      cca_decoder_free(decoder_);
    }
  }

  // Non-copyable
  LutronDecoder(const LutronDecoder &) = delete;
  LutronDecoder &operator=(const LutronDecoder &) = delete;

  /**
   * @brief Decode raw CC1101 FIFO data to Lutron packet
   */
  bool decode(const uint8_t *fifo_data, size_t len, DecodedPacket &packet) {
    if (!decoder_) return false;

    CcaPacket cca_pkt;
    bool result = cca_decode_fifo(decoder_, fifo_data, len, &cca_pkt);
    if (result) {
      packet.from_cca_packet(cca_pkt);
    }
    return result;
  }

  /**
   * @brief Get human-readable packet type name
   */
  static const char *packet_type_name(uint8_t type) {
    return cca_packet_type_name(type);
  }

  /**
   * @brief Get human-readable button name
   */
  static const char *button_name(uint8_t button) {
    return cca_button_name(button);
  }

  /**
   * @brief Format device ID as hex string
   */
  static void format_device_id(uint32_t device_id, char *buffer) {
    cca_format_device_id(device_id, buffer, 9);
  }

  /**
   * @brief Calculate CRC-16 for packet data
   */
  uint16_t calc_crc(const uint8_t *data, size_t len) {
    return cca_calc_crc(data, len);
  }

  /**
   * @brief Parse already-decoded packet bytes
   */
  bool parse_bytes(const uint8_t *bytes, size_t len, DecodedPacket &packet) {
    if (!decoder_) return false;

    CcaPacket cca_pkt;
    bool result = cca_parse_bytes(decoder_, bytes, len, &cca_pkt);
    if (result) {
      packet.from_cca_packet(cca_pkt);
    }
    return result;
  }

  /**
   * @brief Log packet as JSON for test verification
   */
  void log_packet_json(const DecodedPacket &packet);

 private:
  CcaDecoder *decoder_;
};

}  // namespace lutron_cc1101
}  // namespace esphome
