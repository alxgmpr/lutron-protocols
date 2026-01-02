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
  ESP_LOGI(TAG, "=== PAIRING START (0xBA/BB) ===");
  ESP_LOGI(TAG, "Device ID: 0x%08X", device_id);
  ESP_LOGI(TAG, "Matching REAL Pico: 0xBA capability + 0xBB pair request");

  // Real Pico pairing sequence (from pico_pairrequest.txt capture):
  // 1. Send ~60 x 0xBA packets (capability announcement)
  // 2. Send ~12 x 0xBB packets (pair request)
  //
  // Real Pico 0xBA packet structure (52 bytes with CRC):
  // ba 00 02 a2 4c 77 21 21 04 00 07 03 00 ff ff ff ff ff 0d 00
  //    02 a2 4c 77 02 a2 4c 77 00 20 03 00 08 07 03 00 07 ff ff ff ff
  //    cc cc cc cc cc cc cc cc cc cc 87 b5

  // Real packet is 53 bytes: 51 data + 2 CRC
  uint8_t packet[53];
  this->sequence_ = 0x00;

  // --- PHASE 1: 0xBA capability announcement packets ---
  ESP_LOGI(TAG, "Phase 1: Sending 0xBA capability packets...");

  int ba_count = 60;  // Match real Pico
  for (int i = 0; i < ba_count; i++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = 0xBA;  // Capability announcement
    packet[1] = this->next_seq();

    // Device ID (big-endian)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;

    // Protocol header for 0xBA (from real capture)
    packet[6] = 0x21;
    packet[7] = 0x25;  // Real Pico uses 0x25!
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = 0x0B;  // Real Pico uses 0x0B for BA
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast address (5 bytes)
    packet[13] = 0xFF;
    packet[14] = 0xFF;
    packet[15] = 0xFF;
    packet[16] = 0xFF;
    packet[17] = 0xFF;

    packet[18] = 0x0D;
    packet[19] = 0x05;  // Real Pico uses 0x05!

    // Device ID - 2nd instance
    packet[20] = (device_id >> 24) & 0xFF;
    packet[21] = (device_id >> 16) & 0xFF;
    packet[22] = (device_id >> 8) & 0xFF;
    packet[23] = (device_id >> 0) & 0xFF;

    // Device ID - 3rd instance
    packet[24] = (device_id >> 24) & 0xFF;
    packet[25] = (device_id >> 16) & 0xFF;
    packet[26] = (device_id >> 8) & 0xFF;
    packet[27] = (device_id >> 0) & 0xFF;

    // 0xBA capability info at bytes 28-40 (5-button Pico)
    // MUST MATCH BB capability bytes for consistent pairing!
    // 00 20 03 00 08 07 03 01 07 02 06 00 00
    packet[28] = 0x00;
    packet[29] = 0x20;
    packet[30] = 0x03;  // 5-button Pico
    packet[31] = 0x00;
    packet[32] = 0x08;
    packet[33] = 0x07;
    packet[34] = 0x03;  // 5-button Pico
    packet[35] = 0x01;
    packet[36] = 0x07;
    packet[37] = 0x02;
    packet[38] = 0x06;  // 5-button OFF code
    packet[39] = 0x00;
    packet[40] = 0x00;
    // Bytes 41-44 = 0xFF (not CC!)
    packet[41] = 0xFF;
    packet[42] = 0xFF;
    packet[43] = 0xFF;
    packet[44] = 0xFF;
    // Bytes 45-50 = 0xCC padding (already set by memset)

    // CRC over bytes 0-50 (51 bytes)
    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    if (i % 12 == 0) {
      ESP_LOGD(TAG, "TX 0xBA seq=0x%02X CRC=0x%04X (%d/%d)",
               packet[1], crc, i + 1, ba_count);
    }

    this->transmit_encoded(packet, 53);

    // ~75ms between packets (matching real Pico timing)
    delay(75);
    yield();
  }

  ESP_LOGI(TAG, "Phase 1 complete (sent %d x 0xBA)", ba_count);

  // --- PHASE 2: 0xBB pair request packets ---
  ESP_LOGI(TAG, "Phase 2: Sending 0xBB pair request packets...");

  // Reset sequence for BB phase
  this->sequence_ = 0x00;

  // BB packet is also 53 bytes (51 data + 2 CRC)
  // bb 00 02 a2 4c 77 21 17 04 00 07 03 00 ff ff ff ff ff 0d 01
  //    02 a2 4c 77 02 a2 4c 77 00 ff ff cc cc cc cc cc cc cc cc
  //    cc cc cc cc cc cc cc cc cc cc cc cc a3 51
  int bb_count = 12;  // Match real Pico
  for (int i = 0; i < bb_count; i++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = 0xBB;  // Pair request
    packet[1] = this->next_seq();

    // Device ID (big-endian)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;

    // Protocol header for 0xBB (from real capture - same as BA!)
    packet[6] = 0x21;
    packet[7] = 0x25;  // Real Pico uses 0x25 for BB too!
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = 0x04;  // Real Pico uses 0x04 for BB
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast address (5 bytes)
    packet[13] = 0xFF;
    packet[14] = 0xFF;
    packet[15] = 0xFF;
    packet[16] = 0xFF;
    packet[17] = 0xFF;

    packet[18] = 0x0D;
    packet[19] = 0x05;  // Real Pico uses 0x05!

    // Device ID - 2nd instance
    packet[20] = (device_id >> 24) & 0xFF;
    packet[21] = (device_id >> 16) & 0xFF;
    packet[22] = (device_id >> 8) & 0xFF;
    packet[23] = (device_id >> 0) & 0xFF;

    // Device ID - 3rd instance
    packet[24] = (device_id >> 24) & 0xFF;
    packet[25] = (device_id >> 16) & 0xFF;
    packet[26] = (device_id >> 8) & 0xFF;
    packet[27] = (device_id >> 0) & 0xFF;

    // 0xBB payload at bytes 28-40 (5-button Pico capture)
    // 00 20 03 00 08 07 03 01 07 02 06 00 00
    // NOTE: This is 5-button capability - for Scene Pico use experimental pairing
    packet[28] = 0x00;
    packet[29] = 0x20;
    packet[30] = 0x03;  // 5-button Pico
    packet[31] = 0x00;
    packet[32] = 0x08;
    packet[33] = 0x07;
    packet[34] = 0x03;  // 5-button Pico
    packet[35] = 0x01;
    packet[36] = 0x07;
    packet[37] = 0x02;
    packet[38] = 0x06;  // 5-button OFF code
    packet[39] = 0x00;
    packet[40] = 0x00;
    // Bytes 41-44 = 0xFF (not CC!)
    packet[41] = 0xFF;
    packet[42] = 0xFF;
    packet[43] = 0xFF;
    packet[44] = 0xFF;
    // Bytes 45-50 = 0xCC padding (already set by memset)

    // CRC over bytes 0-50 (51 bytes)
    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    ESP_LOGD(TAG, "TX 0xBB seq=0x%02X CRC=0x%04X (%d/%d)",
             packet[1], crc, i + 1, bb_count);

    this->transmit_encoded(packet, 53);

    // ~75ms between packets
    delay(75);
    yield();
  }

  ESP_LOGI(TAG, "=== PAIRING COMPLETE ===");
  ESP_LOGI(TAG, "Sent %d x 0xBA + %d x 0xBB packets", ba_count, bb_count);
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
                                               int protocol_variant, int pico_type) {
  // Experimental pairing with configurable parameters
  // protocol_variant: 0=new (0x25), 1=old (0x21/0x17)
  // pico_type: 0=scene (4-btn), 1=5-button

  ESP_LOGI(TAG, "=== EXPERIMENTAL PAIRING ===");
  ESP_LOGI(TAG, "Device: 0x%08X, BA:%d, BB:%d, Proto:%d, Type:%d",
           device_id, ba_count, bb_count, protocol_variant, pico_type);

  uint8_t packet[53];
  this->sequence_ = 0x00;

  // Protocol bytes based on variant
  uint8_t ba_byte7 = (protocol_variant == 0) ? 0x25 : 0x21;
  uint8_t bb_byte7 = (protocol_variant == 0) ? 0x25 : 0x17;
  uint8_t ba_byte10 = (protocol_variant == 0) ? 0x0B : 0x07;
  uint8_t bb_byte10 = (protocol_variant == 0) ? 0x04 : 0x07;
  uint8_t byte19 = (protocol_variant == 0) ? 0x05 : 0x00;  // BA
  uint8_t bb_byte19 = (protocol_variant == 0) ? 0x05 : 0x01;  // BB

  // Capability bytes based on pico type
  // Scene Pico (4-btn): 00 20 04 00 08 07 04 01 07 02 27 00 00
  // 5-Button Pico:      00 20 03 00 08 07 03 01 07 02 06 00 00
  uint8_t cap_byte30 = (pico_type == 0) ? 0x04 : 0x03;
  uint8_t cap_byte34 = (pico_type == 0) ? 0x04 : 0x03;
  uint8_t cap_byte35 = (pico_type == 0) ? 0x01 : 0x01;  // Same
  uint8_t cap_byte38 = (pico_type == 0) ? 0x27 : 0x06;

  ESP_LOGI(TAG, "Proto bytes: BA[7]=0x%02X BB[7]=0x%02X [19]=0x%02X/0x%02X",
           ba_byte7, bb_byte7, byte19, bb_byte19);
  ESP_LOGI(TAG, "Cap bytes: [30]=0x%02X [34]=0x%02X [38]=0x%02X",
           cap_byte30, cap_byte34, cap_byte38);

  // --- PHASE 1: 0xBA capability announcement ---
  ESP_LOGI(TAG, "Phase 1: Sending %d x 0xBA...", ba_count);

  for (int i = 0; i < ba_count; i++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = 0xBA;
    packet[1] = this->next_seq();
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;

    packet[6] = 0x21;
    packet[7] = ba_byte7;
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = ba_byte10;
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
    packet[35] = cap_byte35;
    packet[36] = 0x07;
    packet[37] = 0x02;
    packet[38] = cap_byte38;
    packet[39] = 0x00;
    packet[40] = 0x00;

    // Must be 0xFF for new protocol
    packet[41] = 0xFF; packet[42] = 0xFF;
    packet[43] = 0xFF; packet[44] = 0xFF;

    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    this->transmit_encoded(packet, 53);
    delay(75);
    yield();
  }

  ESP_LOGI(TAG, "Phase 1 complete");

  // --- PHASE 2: 0xBB pair request ---
  ESP_LOGI(TAG, "Phase 2: Sending %d x 0xBB...", bb_count);
  this->sequence_ = 0x00;  // Reset sequence

  for (int i = 0; i < bb_count; i++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = 0xBB;
    packet[1] = this->next_seq();
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;

    packet[6] = 0x21;
    packet[7] = bb_byte7;
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = bb_byte10;
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast
    packet[13] = 0xFF; packet[14] = 0xFF; packet[15] = 0xFF;
    packet[16] = 0xFF; packet[17] = 0xFF;

    packet[18] = 0x0D;
    packet[19] = bb_byte19;

    // Device ID x2
    packet[20] = (device_id >> 24) & 0xFF;
    packet[21] = (device_id >> 16) & 0xFF;
    packet[22] = (device_id >> 8) & 0xFF;
    packet[23] = (device_id >> 0) & 0xFF;
    packet[24] = (device_id >> 24) & 0xFF;
    packet[25] = (device_id >> 16) & 0xFF;
    packet[26] = (device_id >> 8) & 0xFF;
    packet[27] = (device_id >> 0) & 0xFF;

    // BB capability/payload (same structure, different values)
    packet[28] = 0x00;
    packet[29] = 0x20;
    packet[30] = cap_byte30;
    packet[31] = 0x00;
    packet[32] = 0x08;
    packet[33] = 0x07;
    packet[34] = cap_byte34;
    packet[35] = cap_byte35;
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
    delay(75);
    yield();
  }

  ESP_LOGI(TAG, "=== EXPERIMENTAL PAIRING COMPLETE ===");
}

}  // namespace lutron_cc1101
}  // namespace esphome
