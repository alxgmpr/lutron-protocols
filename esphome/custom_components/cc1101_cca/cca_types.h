#pragma once

// CCA packet type definitions and decoded packet structure
// Ported from cca/src/packet/types.rs

#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>

namespace esphome {
namespace cc1101_cca {

// Maximum raw packet size
static const size_t CCA_MAX_PACKET_LEN = 56;
static const size_t CCA_PKT_STANDARD_LEN = 24;
static const size_t CCA_PKT_PAIRING_LEN = 53;

// Packet type constants
static const uint8_t PKT_BUTTON_SHORT_A = 0x88;
static const uint8_t PKT_BUTTON_LONG_A = 0x89;
static const uint8_t PKT_BUTTON_SHORT_B = 0x8A;
static const uint8_t PKT_BUTTON_LONG_B = 0x8B;
static const uint8_t PKT_STATE_REPORT_80 = 0x80;
static const uint8_t PKT_STATE_REPORT_81 = 0x81;
static const uint8_t PKT_STATE_REPORT_82 = 0x82;
static const uint8_t PKT_STATE_REPORT_83 = 0x83;
static const uint8_t PKT_BEACON_91 = 0x91;
static const uint8_t PKT_BEACON_STOP = 0x92;
static const uint8_t PKT_BEACON_93 = 0x93;
static const uint8_t PKT_CONFIG_A1 = 0xA1;
static const uint8_t PKT_LEVEL = 0xA2;
static const uint8_t PKT_CONFIG_A3 = 0xA3;
static const uint8_t PKT_DIMMER_ACK = 0x0B;
static const uint8_t PKT_PAIRING_B0 = 0xB0;
static const uint8_t PKT_PAIRING_B8 = 0xB8;
static const uint8_t PKT_PAIRING_B9 = 0xB9;
static const uint8_t PKT_PAIRING_BA = 0xBA;
static const uint8_t PKT_PAIRING_BB = 0xBB;
static const uint8_t PKT_PAIR_RESP_C0 = 0xC0;
static const uint8_t PKT_UNPAIR = 0xF0;
static const uint8_t PKT_UNPAIR_PREP = 0xF1;
static const uint8_t PKT_LED_CONFIG = 0xF2;

// Button codes
static const uint8_t BTN_ON = 0x02;
static const uint8_t BTN_FAVORITE = 0x03;
static const uint8_t BTN_OFF = 0x04;
static const uint8_t BTN_RAISE = 0x05;
static const uint8_t BTN_LOWER = 0x06;
static const uint8_t BTN_SCENE1 = 0x0B;
static const uint8_t BTN_SCENE2 = 0x0A;
static const uint8_t BTN_SCENE3 = 0x09;
static const uint8_t BTN_SCENE4 = 0x08;

// Aliases for constants from old lutron_protocol.h (used in cc1101_cca.cpp)
static const uint8_t PKT_TYPE_BUTTON_SHORT_A = 0x88;
static const uint8_t PKT_TYPE_BUTTON_SHORT_B = 0x8A;
static const uint8_t PKT_TYPE_BUTTON_LONG_A = 0x89;
static const uint8_t PKT_TYPE_BUTTON_LONG_B = 0x8B;
static const uint8_t PKT_TYPE_PAIRING = 0xB9;
static const uint8_t LUTRON_BUTTON_ON = 0x02;
static const uint8_t LUTRON_BUTTON_FAVORITE = 0x03;
static const uint8_t LUTRON_BUTTON_OFF = 0x04;
static const uint8_t LUTRON_BUTTON_RAISE = 0x05;
static const uint8_t LUTRON_BUTTON_LOWER = 0x06;
static const uint16_t CRC_POLYNOMIAL = 0xCA0F;

// Action codes
static const uint8_t ACTION_PRESS = 0x00;
static const uint8_t ACTION_RELEASE = 0x01;

// Packet structure offsets
static const uint8_t PKT_OFFSET_TYPE = 0;
static const uint8_t PKT_OFFSET_SEQ = 1;
static const uint8_t PKT_OFFSET_DEVICE_ID = 2;
static const uint8_t PKT_OFFSET_FORMAT = 7;
static const uint8_t PKT_OFFSET_BUTTON = 10;
static const uint8_t PKT_OFFSET_ACTION = 11;
static const uint8_t PKT_OFFSET_LEVEL = 11;
static const uint8_t PKT_OFFSET_CRC_24 = 22;
static const uint8_t PKT_OFFSET_CRC_53 = 51;

// CRC polynomial
static const uint16_t LUTRON_CRC_POLY = 0xCA0F;

// Get human-readable packet type name
inline const char *cca_packet_type_name(uint8_t type_byte) {
  switch (type_byte) {
    case 0x88: return "BTN_SHORT_A";
    case 0x89: return "BTN_LONG_A";
    case 0x8A: return "BTN_SHORT_B";
    case 0x8B: return "BTN_LONG_B";
    case 0x80: return "STATE_80";
    case 0x81: case 0x82: case 0x83: return "STATE_RPT";
    case 0x91: return "BEACON_91";
    case 0x92: return "BEACON_STOP";
    case 0x93: return "BEACON_93";
    case 0xA1: return "CONFIG_A1";
    case 0xA2: return "SET_LEVEL";
    case 0xA3: return "CONFIG_A3";
    case 0x0B: return "DIMMER_ACK";
    case 0xB0: return "DIMMER_DISC";
    case 0xB8: return "PAIR_B8";
    case 0xB9: return "PAIR_B9";
    case 0xBA: return "PAIR_BA";
    case 0xBB: return "PAIR_BB";
    case 0xC0: return "PAIR_RESP_C0";
    case 0xC1: return "HS_C1";
    case 0xC2: return "HS_C2";
    case 0xC7: return "HS_C7";
    case 0xC8: return "HS_C8";
    case 0xCD: return "HS_CD";
    case 0xCE: return "HS_CE";
    case 0xD3: return "HS_D3";
    case 0xD4: return "HS_D4";
    case 0xD9: return "HS_D9";
    case 0xDA: return "HS_DA";
    case 0xDF: return "HS_DF";
    case 0xE0: return "HS_E0";
    case 0xF0: return "UNPAIR";
    case 0xF1: return "UNPAIR_PREP";
    case 0xF2: return "LED_CONFIG";
    default: return "UNKNOWN";
  }
}

// Get expected packet length for a type byte.
// Returns 5, 24, or 53; or 0 for unknown.
inline int cca_get_packet_length(uint8_t type_byte) {
  if (type_byte == 0x0B) return 5;
  if (type_byte >= 0x80 && type_byte <= 0x9F) return 24;
  if (type_byte >= 0xA0 && type_byte <= 0xBF) return 53;
  if (type_byte >= 0xC0 && type_byte <= 0xEF) return 24;
  return 0;
}

// Check if type byte is a button press
inline bool cca_is_button_type(uint8_t type_byte) {
  return type_byte >= 0x88 && type_byte <= 0x8B;
}

// Check if type byte is a pairing announcement
inline bool cca_is_pairing_type(uint8_t type_byte) {
  return type_byte == 0xB0 || type_byte == 0xB8 || type_byte == 0xB9 ||
         type_byte == 0xBA || type_byte == 0xBB;
}

// Check if type byte is a handshake
inline bool cca_is_handshake_type(uint8_t type_byte) {
  return (type_byte >= 0xC1 && type_byte <= 0xE0 &&
          type_byte != 0xC0 &&
          ((type_byte >= 0xC1 && type_byte <= 0xC2) ||
           (type_byte >= 0xC7 && type_byte <= 0xC8) ||
           (type_byte >= 0xCD && type_byte <= 0xCE) ||
           (type_byte >= 0xD3 && type_byte <= 0xD4) ||
           (type_byte >= 0xD9 && type_byte <= 0xDA) ||
           (type_byte >= 0xDF && type_byte <= 0xE0)));
}

// Check if type byte uses big-endian device ID
inline bool cca_uses_be_device_id(uint8_t type_byte) {
  return cca_is_button_type(type_byte) || cca_is_pairing_type(type_byte) ||
         cca_is_handshake_type(type_byte) || type_byte == 0xC0;
}

// Get human-readable button name
inline const char *cca_button_name(uint8_t button) {
  switch (button) {
    case 0x02: return "ON";
    case 0x03: return "FAV";
    case 0x04: return "OFF";
    case 0x05: return "RAISE";
    case 0x06: return "LOWER";
    case 0x08: return "SCENE4";
    case 0x09: return "SCENE3";
    case 0x0A: return "SCENE2";
    case 0x0B: return "SCENE1";
    case 0xFF: return "RESET";
    default: return "?";
  }
}

// Format device ID as hex string (needs buffer of at least 9 bytes)
inline void cca_format_device_id(uint32_t device_id, char *buffer, size_t buffer_len) {
  if (buffer_len >= 9) {
    snprintf(buffer, buffer_len, "%08X", device_id);
  }
}

// Decoded packet structure
struct DecodedPacket {
  bool valid;
  uint8_t type;            // decoded type (may be reclassified from wire type)
  uint8_t type_byte;       // original wire type
  uint8_t sequence;
  uint32_t device_id;
  uint8_t button;
  uint8_t action;
  uint8_t level;
  uint32_t target_id;
  uint8_t format_byte;
  bool has_format;
  uint16_t crc;
  bool crc_valid;
  uint8_t n81_errors;
  uint8_t raw[CCA_MAX_PACKET_LEN];
  size_t raw_len;

  void clear() {
    valid = false;
    type = 0xFF;
    type_byte = 0;
    sequence = 0;
    device_id = 0;
    button = 0;
    action = 0;
    level = 0;
    target_id = 0;
    format_byte = 0;
    has_format = false;
    crc = 0;
    crc_valid = false;
    n81_errors = 0;
    raw_len = 0;
    memset(raw, 0, sizeof(raw));
  }
};

}  // namespace cc1101_cca
}  // namespace esphome
