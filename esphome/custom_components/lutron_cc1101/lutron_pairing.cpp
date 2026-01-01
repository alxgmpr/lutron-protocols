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
  ESP_LOGI(TAG, "=== PAIRING START ===");
  ESP_LOGI(TAG, "Device ID: 0x%08X", device_id);
  ESP_LOGI(TAG, "Matching REAL Pico: 0x88 OFF button, 5s gap, then B9");

  // Real Pico pairing sequence (from capture analysis):
  // 1. Send ~35 button press packets (0x88 only, button 4=OFF)
  //    - Groups of 3 packets with ~12ms gaps within group
  //    - ~50ms gaps between groups
  //    - Sequence: 0,1,2, 6,7,8, 12,13,14, ...
  // 2. SILENCE for 5+ seconds (user holding button)
  // 3. Send 0xB9 pairing packets

  // --- PHASE 1: Button presses (0x88 only, button OFF) ---
  ESP_LOGI(TAG, "Phase 1: Sending 0x88 OFF button presses...");

  uint8_t btn_packet[24];

  // Send 12 groups of 3 packets = 36 total
  // Sequence pattern: 0,1,2, 6,7,8, 12,13,14, 18,19,20, ...
  for (int group = 0; group < 12; group++) {
    uint8_t base_seq = group * 6;  // 0, 6, 12, 18, ...

    for (int pkt = 0; pkt < 3; pkt++) {
      uint8_t seq = base_seq + pkt;  // 0,1,2 or 6,7,8 etc.

      // Clear and build packet - 0x88 short format only
      memset(btn_packet, 0xCC, sizeof(btn_packet));

      btn_packet[0] = 0x88;  // Short format, variant A (ONLY this type)
      btn_packet[1] = seq;
      btn_packet[2] = (device_id >> 0) & 0xFF;
      btn_packet[3] = (device_id >> 8) & 0xFF;
      btn_packet[4] = (device_id >> 16) & 0xFF;
      btn_packet[5] = (device_id >> 24) & 0xFF;
      btn_packet[6] = 0x21;
      btn_packet[7] = 0x04;  // Short format marker
      btn_packet[8] = 0x03;
      btn_packet[9] = 0x00;
      btn_packet[10] = 0x04;  // Button 4 = OFF (real Pico uses this for pairing!)
      btn_packet[11] = 0x00;
      // Bytes 12-21 = 0xCC (padding, already set by memset)

      // CRC
      uint16_t crc = this->encoder_.calc_crc(btn_packet, 22);
      btn_packet[22] = (crc >> 8) & 0xFF;
      btn_packet[23] = crc & 0xFF;

      // Transmit
      uint8_t tx_buffer[64];
      size_t encoded_len = this->encoder_.encode_packet(btn_packet, 24, tx_buffer, sizeof(tx_buffer));
      if (encoded_len > 0) {
        this->radio_->transmit_raw(tx_buffer, encoded_len);
      }

      // Timing within group: ~12ms
      if (pkt < 2) {
        delay(12);
      }
    }

    // Timing between groups: ~50ms
    delay(50);
    yield();
  }

  ESP_LOGI(TAG, "Phase 1 complete (sent 36 x 0x88 OFF button presses)");

  // --- Short gap for testing (real Pico uses 5s, but that crashes ESP32) ---
  ESP_LOGI(TAG, "Brief pause before B9...");
  delay(100);
  yield();

  // --- PHASE 2: Pairing packets (0xB9) ---
  ESP_LOGI(TAG, "Phase 2: Sending 0xB9 pairing packets...");

  // Reset sequence for pairing
  this->sequence_ = 0x00;

  // Testing with fewer packets first
  int num_packets = 30;

  // Real Pico 0xB9 pairing packet structure (47 bytes total):
  //
  // From capture analysis of real_pico_ACTUAL_pairing.cu8:
  // [0]     0xB9        Type
  // [1]     seq         Sequence (00,06,0C,12,18,1E,24,2A,30,36,3C,42...)
  // [2-5]   DevID       Device ID (little-endian) - 1st instance
  // [6]     0x21        Protocol marker
  // [7]     0x25        Format marker (different from button 0x04/0x0E)
  // [8]     0x04
  // [9]     0x00
  // [10]    0x04        (NOT button code like in 0x88 packets)
  // [11]    0x03
  // [12]    0x00
  // [13-17] 0xFF x5     Broadcast address
  // [18]    0x0D
  // [19]    0x05
  // [20-23] DevID       Device ID - 2nd instance
  // [24-27] DevID       Device ID - 3rd instance
  // [28]    0x00
  // [29]    0x20
  // [30]    0x03        (button 3 = FAVORITE?)
  // [31]    0x00
  // [32]    0x08
  // [33]    0x07
  // [34]    0x03
  // [35]    0x01
  // [36]    0x07
  // [37]    0x02
  // [38]    0x06
  // [39]    0x00
  // [40-43] 0xFF x4     Broadcast
  // [44]    0xCC        Padding
  // [45-46] CRC         CRC-16

  uint8_t packet[47];

  for (int i = 0; i < num_packets; i++) {
    // Clear packet
    for (int j = 0; j < 47; j++) packet[j] = 0x00;

    // Build packet
    packet[0] = PKT_TYPE_PAIRING;  // 0xB9
    packet[1] = this->next_seq();

    // Device ID - 1st instance (little-endian)
    packet[2] = (device_id >> 0) & 0xFF;
    packet[3] = (device_id >> 8) & 0xFF;
    packet[4] = (device_id >> 16) & 0xFF;
    packet[5] = (device_id >> 24) & 0xFF;

    // Constants from capture
    packet[6] = 0x21;
    packet[7] = 0x25;
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = 0x04;
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast (5 bytes)
    packet[13] = 0xFF;
    packet[14] = 0xFF;
    packet[15] = 0xFF;
    packet[16] = 0xFF;
    packet[17] = 0xFF;

    packet[18] = 0x0D;
    packet[19] = 0x05;

    // Device ID - 2nd instance
    packet[20] = (device_id >> 0) & 0xFF;
    packet[21] = (device_id >> 8) & 0xFF;
    packet[22] = (device_id >> 16) & 0xFF;
    packet[23] = (device_id >> 24) & 0xFF;

    // Device ID - 3rd instance
    packet[24] = (device_id >> 0) & 0xFF;
    packet[25] = (device_id >> 8) & 0xFF;
    packet[26] = (device_id >> 16) & 0xFF;
    packet[27] = (device_id >> 24) & 0xFF;

    // More constants from capture
    packet[28] = 0x00;
    packet[29] = 0x20;
    packet[30] = 0x04;  // Button 4 = OFF (matching button press phase)
    packet[31] = 0x00;
    packet[32] = 0x08;
    packet[33] = 0x07;
    packet[34] = 0x03;
    packet[35] = 0x01;
    packet[36] = 0x07;
    packet[37] = 0x02;
    packet[38] = 0x06;
    packet[39] = 0x00;

    // Final broadcast (4 bytes)
    packet[40] = 0xFF;
    packet[41] = 0xFF;
    packet[42] = 0xFF;
    packet[43] = 0xFF;

    // Padding
    packet[44] = 0xCC;

    // Calculate and append CRC (bytes 0-44)
    uint16_t crc = this->encoder_.calc_crc(packet, 45);
    packet[45] = (crc >> 8) & 0xFF;
    packet[46] = crc & 0xFF;

    if (i % 10 == 0) {
      ESP_LOGD(TAG, "TX 0xB9 seq=0x%02X CRC=0x%04X (%d/%d)",
               packet[1], crc, i + 1, num_packets);
    }

    this->transmit_encoded(packet, 47);

    // Timing: groups of 3 packets every ~75ms (matching real Pico)
    if ((i + 1) % 3 == 0) {
      delay(50);  // Gap between groups
    } else {
      delay(15);  // Gap within group
    }
    yield();
  }

  ESP_LOGI(TAG, "=== PAIRING COMPLETE ===");
  ESP_LOGI(TAG, "Sent 36 button + 90 B9 packets with 5s gap");
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

}  // namespace lutron_cc1101
}  // namespace esphome
