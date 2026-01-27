// Lutron CCA Decoder - ESPHome logging wrapper
//
// All decoding logic is now handled by the Rust CCA library (libcca.a).
// This file only provides ESPHome-specific logging functions.

#include "lutron_decoder.h"
#include "esphome/core/log.h"

namespace esphome {
namespace cc1101_cca {

void LutronDecoder::log_packet_json(const DecodedPacket &packet) {
  char device_id_str[9];
  format_device_id(packet.device_id, device_id_str);

  const char *type_name = packet_type_name(packet.type);
  const char *btn_name = button_name(packet.button);

  // Build JSON output - format suitable for parsing by test framework
  // TEST_RESULT: prefix makes it easy to find in log stream
  ESP_LOGI("TEST_RESULT", "{\"type\":\"%s\",\"type_byte\":\"0x%02X\",\"sequence\":%d,"
           "\"device_id\":\"%s\",\"button\":\"%s\",\"button_code\":\"0x%02X\","
           "\"action\":%d,\"level\":%d,\"target_id\":\"0x%08X\","
           "\"crc\":\"0x%04X\",\"crc_valid\":%s,\"raw_len\":%d}",
           type_name, packet.type, packet.sequence,
           device_id_str, btn_name, packet.button,
           packet.action, packet.level, packet.target_id,
           packet.crc, packet.crc_valid ? "true" : "false", (int)packet.raw_len);
}

}  // namespace cc1101_cca
}  // namespace esphome
