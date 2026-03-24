#pragma once

/**
 * Auto-generated from protocol/cca.protocol.ts
 * DO NOT EDIT - regenerate with: npm run codegen
 */

#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <cstring>

#ifdef __cplusplus
extern "C" {
#endif

// Maximum raw packet size
static const size_t CCA_MAX_PACKET_LEN = 64;
static const size_t CCA_PKT_STANDARD_LEN = 24;
static const size_t CCA_PKT_PAIRING_LEN = 53;

// Packet type constants
static const uint8_t PKT_STATE_REPORT_80 = 0x80;
static const uint8_t PKT_STATE_REPORT_81 = 0x81;
static const uint8_t PKT_STATE_REPORT_82 = 0x82;
static const uint8_t PKT_STATE_REPORT_83 = 0x83;
static const uint8_t PKT_BTN_SHORT_A = 0x88;
static const uint8_t PKT_BTN_LONG_A = 0x89;
static const uint8_t PKT_BTN_SHORT_B = 0x8A;
static const uint8_t PKT_BTN_LONG_B = 0x8B;
static const uint8_t PKT_BEACON_91 = 0x91;
static const uint8_t PKT_BEACON_STOP = 0x92;
static const uint8_t PKT_BEACON_93 = 0x93;
static const uint8_t PKT_CONFIG_A1 = 0xA1;
static const uint8_t PKT_LEVEL = 0xA2;
static const uint8_t PKT_SET_LEVEL = 0xA2;
static const uint8_t PKT_CONFIG_A3 = 0xA3;
static const uint8_t PKT_PAIRING_B0 = 0xB0;
static const uint8_t PKT_PAIRING_B8 = 0xB8;
static const uint8_t PKT_PAIRING_B9 = 0xB9;
static const uint8_t PKT_PAIRING_BA = 0xBA;
static const uint8_t PKT_PAIRING_BB = 0xBB;
static const uint8_t PKT_PAIR_RESP_C0 = 0xC0;
static const uint8_t PKT_HS_C1 = 0xC1;
static const uint8_t PKT_HS_C2 = 0xC2;
static const uint8_t PKT_HS_C5 = 0xC5;
static const uint8_t PKT_HS_C7 = 0xC7;
static const uint8_t PKT_HS_C8 = 0xC8;
static const uint8_t PKT_HS_CD = 0xCD;
static const uint8_t PKT_HS_CE = 0xCE;
static const uint8_t PKT_HS_D3 = 0xD3;
static const uint8_t PKT_HS_D4 = 0xD4;
static const uint8_t PKT_HS_D9 = 0xD9;
static const uint8_t PKT_HS_DA = 0xDA;
static const uint8_t PKT_HS_DF = 0xDF;
static const uint8_t PKT_HS_E0 = 0xE0;
static const uint8_t PKT_DEVICE_CTRL = 0xE0;
static const uint8_t PKT_DIM_STEP = 0xE1;
static const uint8_t PKT_DIM_STOP = 0xE2;
static const uint8_t PKT_PICO_HOLD = 0xE3;
static const uint8_t PKT_PICO_EXTENDED = 0xE4;
static const uint8_t PKT_UNPAIR = 0xF0;
static const uint8_t PKT_UNPAIR_PREP = 0xF1;
static const uint8_t PKT_LED_CONFIG = 0xF2;
static const uint8_t PKT_ZONE_BIND = 0xF3;
static const uint8_t PKT_DIM_CONFIG = 0xF4;
static const uint8_t PKT_FUNC_MAP = 0xF5;
static const uint8_t PKT_TRIM_CONFIG = 0xF6;
static const uint8_t PKT_SCENE_CONFIG = 0xF7;
static const uint8_t PKT_FADE_CONFIG = 0xF8;
static const uint8_t PKT_ZONE_ASSIGN = 0xF9;
static const uint8_t PKT_SENSOR_LEVEL = 0xFA;
static const uint8_t PKT_SENSOR_TEST = 0xFB;
static const uint8_t PKT_SENSOR_VACANT = 0xFC;
static const uint8_t PKT_PICO_RESET = 0xFD;

// Button codes
static const uint8_t BTN_ON = 0x02;
static const uint8_t BTN_FAVORITE = 0x03;
static const uint8_t BTN_OFF = 0x04;
static const uint8_t BTN_RAISE = 0x05;
static const uint8_t BTN_LOWER = 0x06;
static const uint8_t BTN_SCENE4 = 0x08;
static const uint8_t BTN_SCENE3 = 0x09;
static const uint8_t BTN_SCENE2 = 0x0A;
static const uint8_t BTN_SCENE1 = 0x0B;
static const uint8_t BTN_RESET = 0xFF;

// Action codes
static const uint8_t ACTION_PRESS = 0x00;
static const uint8_t ACTION_RELEASE = 0x01;
static const uint8_t ACTION_HOLD = 0x02;
static const uint8_t ACTION_SAVE = 0x03;

// Common Packet structure offsets
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

// QS Link protocol constants

// Protocol byte — radio IC TX command
static const uint8_t QS_PROTO_RADIO_TX = 0x21;

// Addressing modes (QS Link payload offset 5)
static const uint8_t QS_ADDR_COMPONENT = 0xFE;  /* Unicast to specific component/zone */
static const uint8_t QS_ADDR_GROUP = 0xEF;  /* Multicast to all devices in a group */
static const uint8_t QS_ADDR_BROADCAST = 0xFF;  /* Broadcast to all devices on the link */

// Command classes (QS Link payload offset 6)
static const uint8_t QS_CLASS_LEVEL = 0x40;  /* Level control (GoToLevel) — unchanged since 2009 */
static const uint8_t QS_CLASS_DIM = 0x42;  /* Dim control (raise/lower/stop) — modern CCA */
static const uint8_t QS_CLASS_LEGACY = 0x06;  /* Original 2009 dim/config class — persists in pairing packets */
static const uint8_t QS_CLASS_DEVICE = 0x01;  /* Device control (identify, mode changes) */
static const uint8_t QS_CLASS_SELECT = 0x03;  /* Select / query component */
static const uint8_t QS_CLASS_BUTTON = 0x05;  /* Button / programming master events */
static const uint8_t QS_CLASS_ASSIGN = 0x08;  /* Address assignment / component binding */
static const uint8_t QS_CLASS_SCENE = 0x09;  /* Scene activation */

// Command types (QS Link payload offset 7)
static const uint8_t QS_TYPE_EXECUTE = 0x02;  /* Set / execute */
static const uint8_t QS_TYPE_HOLD = 0x00;  /* Hold / start */
static const uint8_t QS_TYPE_STEP = 0x02;  /* Dim step (same value as execute, context-dependent) */
static const uint8_t QS_TYPE_IDENTIFY = 0x22;  /* Flash LEDs / self-identify */
static const uint8_t QS_TYPE_CONFIG = 0x33;  /* Configuration */
static const uint8_t QS_TYPE_ADDR_SET = 0xA3;  /* Address assign */
static const uint8_t QS_TYPE_ADDR_QRY = 0xA5;  /* Address query */
static const uint8_t QS_TYPE_PROP_SET_FIXED = 0x64;  /* Property set (fixed-size) */
static const uint8_t QS_TYPE_PROP_SET_VAR = 0x65;  /* Property set (variable-size) */
static const uint8_t QS_TYPE_DIM_CONFIG = 0x78;  /* Dimming config sub-type */

// Component types
static const uint8_t QS_COMP_DIMMER = 0x50;
static const uint8_t QS_COMP_RELAY = 0x38;
static const uint8_t QS_COMP_SCENE = 0x40;

// Format byte values (= payload length in bytes)
static const uint8_t QS_FMT_TAP = 0x04;  /* Button tap (4 bytes) */
static const uint8_t QS_FMT_STATE = 0x08;  /* State report (8 bytes) */
static const uint8_t QS_FMT_CTRL = 0x09;  /* Device control / hold-start (9 bytes) */
static const uint8_t QS_FMT_ADDR = 0x0A;  /* Address assign (10 bytes) */
static const uint8_t QS_FMT_DIM_STEP = 0x0B;  /* Dim step (11 bytes) */
static const uint8_t QS_FMT_BEACON = 0x0C;  /* Beacon / unpair / dim-stop (12 bytes) */
static const uint8_t QS_FMT_LEVEL = 0x0E;  /* GoToLevel / button extended (14 bytes) */
static const uint8_t QS_FMT_ACCEPT = 0x10;  /* Pairing accept (16 bytes) */
static const uint8_t QS_FMT_LED = 0x11;  /* LED config (17 bytes) */
static const uint8_t QS_FMT_FINAL = 0x12;  /* Final config with zone (18 bytes) */
static const uint8_t QS_FMT_DIM_CAP = 0x13;  /* Dimming capability (19 bytes) */
static const uint8_t QS_FMT_FUNC_MAP = 0x14;  /* Function mapping (20 bytes) */
static const uint8_t QS_FMT_TRIM = 0x15;  /* Trim / phase config (21 bytes) */
static const uint8_t QS_FMT_SCENE_CFG = 0x1A;  /* Scene config (26 bytes) */
static const uint8_t QS_FMT_FADE = 0x1C;  /* Fade config (28 bytes) */
static const uint8_t QS_FMT_ZONE = 0x28;  /* Zone assignment (40 bytes, format at byte 6) */

// Pico device framing
static const uint8_t QS_PICO_FRAME = 0x03;

// Level encoding (16-bit)
static const uint16_t QS_LEVEL_MAX = 0xFEFF;  /* 100% as 16-bit */

// Level encoding (8-bit)
static const uint8_t QS_LEVEL_MAX_8 = 0xFE;  /* 100% as 8-bit */

// State report field values
static const uint8_t QS_STATE_ENTITY_COMP = 0x1B;  /* Component entity marker (state rpt bytes 9/13) */
static const uint8_t QS_STATE_STATUS_FLAG = 0x92;  /* Status flag (state rpt byte 14) */

// Preset base offset (button → preset mapping in pico long format)
static const uint8_t QS_PRESET_BASE = 0x1E;

// Padding
static const uint8_t QS_PADDING = 0x00;

// Sensor constants (OWT daylight/occupancy sensors)
static const uint16_t QS_SENSOR_COMPONENT_DAYLIGHT = 0x00D5;  /* Daylight sensor component type (byte 14) */
static const uint16_t QS_SENSOR_TEST_BUTTON = 0x0011;  /* Test button ID (byte 15 in format 0x09) */
static const uint16_t QS_SENSOR_LUX_MAX_RAW = 0x07FE;  /* Raw 16-bit max (0x07FE = 1600 lux, FE-not-FF pattern) */
static const uint16_t QS_SENSOR_LUX_MAX = 0x0640;  /* Maximum sensor range in lux */

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus

// Get human-readable packet type name
inline const char *cca_packet_type_name(uint8_t type_byte) {
  switch (type_byte) {
    case 0x80: return "STATE_80";
    case 0x81: return "STATE_RPT_81";
    case 0x82: return "STATE_RPT_82";
    case 0x83: return "STATE_RPT_83";
    case 0x88: return "BTN_SHORT_A";
    case 0x89: return "BTN_LONG_A";
    case 0x8A: return "BTN_SHORT_B";
    case 0x8B: return "BTN_LONG_B";
    case 0x91: return "BEACON_91";
    case 0x92: return "BEACON_92";
    case 0x93: return "BEACON_93";
    case 0xA1: return "CONFIG_A1";
    case 0xA2: return "SET_LEVEL";
    case 0xA3: return "CONFIG_A3";
    case 0xB0: return "PAIR_B0";
    case 0xB8: return "PAIR_B8";
    case 0xB9: return "PAIR_B9";
    case 0xBA: return "PAIR_BA";
    case 0xBB: return "PAIR_BB";
    case 0xC0: return "PAIR_RESP_C0";
    case 0xC1: return "HS_C1";
    case 0xC2: return "HS_C2";
    case 0xC5: return "HS_C5";
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
    default: return "UNKNOWN";
  }
}

// Get expected packet length for a type byte.
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
  return (type_byte >= 0xC1 && type_byte <= 0xE0 && type_byte != 0xC0);
}

// Check if type byte uses big-endian device ID
inline bool cca_uses_be_device_id(uint8_t type_byte) {
  switch (type_byte) {
    case 0x88:
    case 0x89:
    case 0x8A:
    case 0x8B:
    case 0x91:
    case 0x92:
    case 0x93:
    case 0xB0:
    case 0xB8:
    case 0xB9:
    case 0xBA:
    case 0xBB:
    case 0xC0:
    case 0xC1:
    case 0xC2:
    case 0xC5:
    case 0xC7:
    case 0xC8:
    case 0xCD:
    case 0xCE:
    case 0xD3:
    case 0xD4:
    case 0xD9:
    case 0xDA:
    case 0xDF:
    case 0xE0:
      return true;
    default:
      return false;
  }
}

// Get human-readable button name
inline const char *cca_button_name(uint8_t button) {
  switch (button) {
    case 0x02: return "ON";
    case 0x03: return "FAVORITE";
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
    snprintf(buffer, buffer_len, "%08X", (unsigned)device_id);
  }
}

// Decoded packet structure
struct DecodedPacket {
  bool valid;
  uint8_t type;
  uint8_t type_byte;
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
  uint8_t raw[64];
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

#endif
