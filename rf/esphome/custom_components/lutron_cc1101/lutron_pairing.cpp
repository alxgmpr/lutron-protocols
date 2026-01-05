#include "lutron_pairing.h"
#include "esphome/core/log.h"

namespace esphome {
namespace lutron_cc1101 {

static const char *const TAG = "lutron_pairing";

LutronPairing::LutronPairing(CC1101Radio *radio) : radio_(radio) {}

uint8_t LutronPairing::next_seq() {
  uint8_t current = this->sequence_;
  this->sequence_ = (this->sequence_ + 6) % 0x48;
  return current;
}

void LutronPairing::transmit_encoded(const uint8_t *packet, size_t len) {
  uint8_t tx_buffer[128];

  size_t encoded_len = this->encoder_.encode_packet(
      packet, len, tx_buffer, sizeof(tx_buffer), 32, 16);

  if (encoded_len == 0) {
    ESP_LOGE(TAG, "Failed to encode packet");
    return;
  }

  ESP_LOGD(TAG, "Transmitting %d encoded bytes", encoded_len);
  this->radio_->transmit_raw(tx_buffer, encoded_len);
}

void LutronPairing::send_pairing_b9(uint32_t device_id, int duration_seconds) {
  // DEPRECATED: Use send_pairing_5button or send_pairing_experimental instead
  // This function now properly alternates B9/BB like real picos do

  ESP_LOGI(TAG, "=== PAIRING (B9/BB ALTERNATING) ===");
  ESP_LOGI(TAG, "Device ID: 0x%08X, Duration: %ds", device_id, duration_seconds);
  ESP_LOGI(TAG, "Real Pico behavior: B9 -> BB -> B9 -> BB (not phases!)");

  uint8_t packet[53];
  this->sequence_ = 0x00;

  unsigned long start_time = millis();
  unsigned long end_time = start_time + (duration_seconds * 1000);
  int packet_count = 0;
  bool use_b9 = true;

  while (millis() < end_time) {
    memset(packet, 0xCC, sizeof(packet));

    // ALTERNATE between B9 and BB
    packet[0] = use_b9 ? 0xB9 : 0xBB;
    packet[1] = this->next_seq();

    // Device ID (big-endian)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;

    packet[6] = 0x21;
    packet[7] = 0x25;
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = 0x04;  // 5-button scheme
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast
    packet[13] = 0xFF; packet[14] = 0xFF; packet[15] = 0xFF;
    packet[16] = 0xFF; packet[17] = 0xFF;

    packet[18] = 0x0D;
    packet[19] = 0x05;

    // Device ID x2
    packet[20] = (device_id >> 24) & 0xFF;
    packet[21] = (device_id >> 16) & 0xFF;
    packet[22] = (device_id >> 8) & 0xFF;
    packet[23] = (device_id >> 0) & 0xFF;
    packet[24] = (device_id >> 24) & 0xFF;
    packet[25] = (device_id >> 16) & 0xFF;
    packet[26] = (device_id >> 8) & 0xFF;
    packet[27] = (device_id >> 0) & 0xFF;

    // 5-button capability bytes
    packet[28] = 0x00;
    packet[29] = 0x20;
    packet[30] = 0x03;
    packet[31] = 0x00;
    packet[32] = 0x08;
    packet[33] = 0x07;
    packet[34] = 0x03;
    packet[35] = 0x01;
    packet[36] = 0x07;
    packet[37] = 0x02;
    packet[38] = 0x06;
    packet[39] = 0x00;
    packet[40] = 0x00;
    packet[41] = 0xFF; packet[42] = 0xFF;
    packet[43] = 0xFF; packet[44] = 0xFF;

    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    this->transmit_encoded(packet, 53);
    packet_count++;
    use_b9 = !use_b9;

    delay(75);
    yield();
  }

  ESP_LOGI(TAG, "=== PAIRING COMPLETE ===");
  ESP_LOGI(TAG, "Sent %d alternating B9/BB packets", packet_count);
}

void LutronPairing::send_raw_packet(const uint8_t *packet, size_t len) {
  // Create buffer with space for CRC
  uint8_t pkt_with_crc[64];
  if (len + 2 > sizeof(pkt_with_crc)) {
    ESP_LOGE(TAG, "Packet too large");
    return;
  }

  // Copy packet data
  for (size_t i = 0; i < len; i++) {
    pkt_with_crc[i] = packet[i];
  }

  // Calculate and append CRC
  uint16_t crc = this->encoder_.calc_crc(pkt_with_crc, len);
  pkt_with_crc[len] = (crc >> 8) & 0xFF;
  pkt_with_crc[len + 1] = crc & 0xFF;

  ESP_LOGI(TAG, "Sending raw packet (%d bytes + CRC)", len);
  this->transmit_encoded(pkt_with_crc, len + 2);
}

void LutronPairing::replay_raw(const uint8_t *raw_encoded, size_t len) {
  ESP_LOGI(TAG, "Replaying %d raw encoded bytes", len);
  this->radio_->transmit_raw(raw_encoded, len);
}

void LutronPairing::send_pairing_experimental(uint32_t device_id, int ba_count, int bb_count,
                                               int protocol_variant, int pico_type, int button_scheme) {
  // Experimental pairing with configurable parameters - NOW WITH PROPER ALTERNATING!
  // protocol_variant: 0=new (0x25), 1=old (0x21/0x17)
  // pico_type: 0=scene/bridge-only (B8/BA), 1=direct-pair (B9/BB)
  // button_scheme: Byte 10 value - tells receiver what button codes to expect
  //   0x04 = 5-button scheme (button codes 0x02-0x06)
  //   0x0B = 4-button scheme (button codes 0x08-0x0B)

  // CRITICAL: Real picos ALTERNATE packet types!
  // Direct-pair (pico_type=1): B9 -> BB -> B9 -> BB...
  // Bridge-only (pico_type=0): B8 -> BA -> B8 -> BA...

  // Packet types based on pairing mode
  uint8_t pkt_type_a = (pico_type == 0) ? 0xB8 : 0xB9;  // Primary
  uint8_t pkt_type_b = (pico_type == 0) ? 0xBA : 0xBB;  // Secondary

  ESP_LOGI(TAG, "=== EXPERIMENTAL PAIRING (ALTERNATING %02X/%02X) ===",
           pkt_type_a, pkt_type_b);
  ESP_LOGI(TAG, "Device: 0x%08X, Count:%d, Proto:%d, Type:%d, BtnScheme:0x%02X",
           device_id, ba_count + bb_count, protocol_variant, pico_type, button_scheme);

  uint8_t packet[53];
  this->sequence_ = 0x00;

  // Protocol bytes based on variant
  uint8_t byte7 = (protocol_variant == 0) ? 0x25 : 0x21;
  uint8_t byte19 = (protocol_variant == 0) ? 0x05 : 0x00;

  // Capability bytes based on pico type
  // Scene Pico (4-btn): 00 20 04 00 08 07 04 01 07 02 27 00 00
  // 5-Button Pico:      00 20 03 00 08 07 03 01 07 02 06 00 00
  uint8_t cap_byte30 = (pico_type == 0) ? 0x04 : 0x03;
  uint8_t cap_byte34 = (pico_type == 0) ? 0x04 : 0x03;
  uint8_t cap_byte38 = (pico_type == 0) ? 0x27 : 0x06;

  ESP_LOGI(TAG, "Packets: %02X/%02X | byte10=0x%02X | cap[30]=0x%02X [38]=0x%02X",
           pkt_type_a, pkt_type_b, button_scheme, cap_byte30, cap_byte38);

  int total_packets = ba_count + bb_count;
  bool use_type_a = true;  // Alternate between type_a and type_b

  for (int i = 0; i < total_packets; i++) {
    memset(packet, 0xCC, sizeof(packet));

    // ALTERNATE packet type each time!
    packet[0] = use_type_a ? pkt_type_a : pkt_type_b;
    packet[1] = this->next_seq();

    // Device ID (big-endian)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;

    packet[6] = 0x21;
    packet[7] = byte7;
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = button_scheme;
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast
    packet[13] = 0xFF; packet[14] = 0xFF; packet[15] = 0xFF;
    packet[16] = 0xFF; packet[17] = 0xFF;

    packet[18] = 0x0D;
    packet[19] = byte19;

    // Device ID x2
    packet[20] = (device_id >> 24) & 0xFF;
    packet[21] = (device_id >> 16) & 0xFF;
    packet[22] = (device_id >> 8) & 0xFF;
    packet[23] = (device_id >> 0) & 0xFF;
    packet[24] = (device_id >> 24) & 0xFF;
    packet[25] = (device_id >> 16) & 0xFF;
    packet[26] = (device_id >> 8) & 0xFF;
    packet[27] = (device_id >> 0) & 0xFF;

    // Capability info
    packet[28] = 0x00;
    packet[29] = 0x20;
    packet[30] = cap_byte30;
    packet[31] = 0x00;
    packet[32] = 0x08;
    packet[33] = 0x07;
    packet[34] = cap_byte34;
    packet[35] = 0x01;
    packet[36] = 0x07;
    packet[37] = 0x02;
    packet[38] = cap_byte38;
    packet[39] = 0x00;
    packet[40] = 0x00;

    packet[41] = 0xFF; packet[42] = 0xFF;
    packet[43] = 0xFF; packet[44] = 0xFF;

    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    this->transmit_encoded(packet, 53);

    // Flip-flop for next packet
    use_type_a = !use_type_a;

    delay(75);
    yield();
  }

  ESP_LOGI(TAG, "=== EXPERIMENTAL PAIRING COMPLETE ===");
  ESP_LOGI(TAG, "Sent %d alternating %02X/%02X packets", total_packets, pkt_type_a, pkt_type_b);
}

void LutronPairing::send_pairing_5button(uint32_t device_id, int duration_seconds) {
  // Direct-pair using ALTERNATING B9/BB packets - matches REAL Pico behavior
  // Real picos flip-flop: B9 → BB → B9 → BB (not all B9 then all BB!)
  //
  // Key discovery: Bytes 37-38 advertise the button range (0x02-0x06)
  // This tells the dimmer that button 0x03 (FAV) is a dedicated function

  ESP_LOGI(TAG, "=== 5-BUTTON PICO PAIRING (B9/BB alternating) ===");
  ESP_LOGI(TAG, "Device ID: 0x%08X, Duration: %ds", device_id, duration_seconds);
  ESP_LOGI(TAG, "Button range: 0x02-0x06 (ON, FAV, OFF, RAISE, LOWER)");

  uint8_t packet[53];
  this->sequence_ = 0x00;

  unsigned long start_time = millis();
  unsigned long end_time = start_time + (duration_seconds * 1000);
  int packet_count = 0;
  bool use_b9 = true;  // Alternate between B9 and BB

  while (millis() < end_time) {
    memset(packet, 0xCC, sizeof(packet));

    // ALTERNATE between B9 and BB each packet!
    packet[0] = use_b9 ? 0xB9 : 0xBB;
    packet[1] = this->next_seq();

    // Device ID (big-endian)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;

    // Protocol bytes
    packet[6] = 0x21;
    packet[7] = 0x25;  // New protocol
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = 0x04;  // Button scheme: 5-button (codes 0x02-0x06)
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast address
    packet[13] = 0xFF;
    packet[14] = 0xFF;
    packet[15] = 0xFF;
    packet[16] = 0xFF;
    packet[17] = 0xFF;

    packet[18] = 0x0D;
    packet[19] = 0x05;

    // Device ID - 2nd occurrence
    packet[20] = (device_id >> 24) & 0xFF;
    packet[21] = (device_id >> 16) & 0xFF;
    packet[22] = (device_id >> 8) & 0xFF;
    packet[23] = (device_id >> 0) & 0xFF;

    // Device ID - 3rd occurrence
    packet[24] = (device_id >> 24) & 0xFF;
    packet[25] = (device_id >> 16) & 0xFF;
    packet[26] = (device_id >> 8) & 0xFF;
    packet[27] = (device_id >> 0) & 0xFF;

    // Capability bytes - EXACT MATCH to real 5-button Pico
    packet[28] = 0x00;
    packet[29] = 0x20;
    packet[30] = 0x03;  // Pico type: 5-button
    packet[31] = 0x00;  // 0x00 for most picos
    packet[32] = 0x08;
    packet[33] = 0x07;
    packet[34] = 0x03;
    packet[35] = 0x01;
    packet[36] = 0x07;  // Function count
    packet[37] = 0x02;  // First button code (ON)
    packet[38] = 0x06;  // Last button code (LOWER) - FAV (0x03) is in range!
    packet[39] = 0x00;
    packet[40] = 0x00;

    // Padding
    packet[41] = 0xFF;
    packet[42] = 0xFF;
    packet[43] = 0xFF;
    packet[44] = 0xFF;

    // CRC over bytes 0-50
    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    this->transmit_encoded(packet, 53);
    packet_count++;

    // Flip-flop for next packet
    use_b9 = !use_b9;

    delay(75);  // ~75ms between packets
    yield();
  }

  ESP_LOGI(TAG, "=== 5-BUTTON PAIRING COMPLETE ===");
  ESP_LOGI(TAG, "Sent %d B9/BB packets over %d seconds", packet_count, duration_seconds);
}

void LutronPairing::send_pairing_advanced(uint32_t device_id, int duration_seconds,
                                           uint8_t pkt_type_a, uint8_t pkt_type_b,
                                           uint8_t byte10, uint8_t byte30, uint8_t byte31,
                                           uint8_t byte37, uint8_t byte38) {
  // Fully configurable pairing - replicate ANY Pico type
  // Real Picos alternate: pkt_type_a -> pkt_type_b -> pkt_type_a -> ...

  ESP_LOGI(TAG, "=== ADVANCED PAIRING ===");
  ESP_LOGI(TAG, "Device: 0x%08X, Duration: %ds", device_id, duration_seconds);
  ESP_LOGI(TAG, "Packets: %02X <-> %02X (alternating)", pkt_type_a, pkt_type_b);
  ESP_LOGI(TAG, "Bytes: [10]=0x%02X [30]=0x%02X [31]=0x%02X [37]=0x%02X [38]=0x%02X",
           byte10, byte30, byte31, byte37, byte38);

  uint8_t packet[53];
  this->sequence_ = 0x00;

  unsigned long start_time = millis();
  unsigned long end_time = start_time + (duration_seconds * 1000);
  int packet_count = 0;
  bool use_type_a = true;

  while (millis() < end_time) {
    memset(packet, 0xCC, sizeof(packet));

    // ALTERNATE packet type
    packet[0] = use_type_a ? pkt_type_a : pkt_type_b;
    packet[1] = this->next_seq();

    // Device ID (big-endian)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;

    // Protocol bytes
    packet[6] = 0x21;
    packet[7] = 0x25;  // New protocol
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = byte10;  // CONFIGURABLE: button scheme
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast
    packet[13] = 0xFF; packet[14] = 0xFF; packet[15] = 0xFF;
    packet[16] = 0xFF; packet[17] = 0xFF;

    packet[18] = 0x0D;
    packet[19] = 0x05;

    // Device ID x2
    packet[20] = (device_id >> 24) & 0xFF;
    packet[21] = (device_id >> 16) & 0xFF;
    packet[22] = (device_id >> 8) & 0xFF;
    packet[23] = (device_id >> 0) & 0xFF;
    packet[24] = (device_id >> 24) & 0xFF;
    packet[25] = (device_id >> 16) & 0xFF;
    packet[26] = (device_id >> 8) & 0xFF;
    packet[27] = (device_id >> 0) & 0xFF;

    // Capability bytes - ALL CONFIGURABLE
    packet[28] = 0x00;
    packet[29] = 0x20;
    packet[30] = byte30;  // CONFIGURABLE: pico type (0x02, 0x03, 0x04)
    packet[31] = byte31;  // CONFIGURABLE: 0x00 or 0x08
    packet[32] = 0x08;
    packet[33] = 0x07;
    packet[34] = byte30;  // Same as byte30
    packet[35] = 0x01;
    packet[36] = 0x07;
    packet[37] = byte37;  // CONFIGURABLE: first button/capability
    packet[38] = byte38;  // CONFIGURABLE: last button/capability
    packet[39] = 0x00;
    packet[40] = 0x00;

    packet[41] = 0xFF; packet[42] = 0xFF;
    packet[43] = 0xFF; packet[44] = 0xFF;

    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    this->transmit_encoded(packet, 53);
    packet_count++;
    use_type_a = !use_type_a;

    delay(75);
    yield();
  }

  ESP_LOGI(TAG, "=== ADVANCED PAIRING COMPLETE ===");
  ESP_LOGI(TAG, "Sent %d alternating %02X/%02X packets", packet_count, pkt_type_a, pkt_type_b);
}

}  // namespace lutron_cc1101
}  // namespace esphome
