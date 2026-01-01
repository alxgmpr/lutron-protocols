#include "lutron_cc1101.h"
#include "esphome/core/log.h"

namespace esphome {
namespace lutron_cc1101 {

static const char *const TAG = "lutron_cc1101";

void LutronCC1101::setup() {
  ESP_LOGI(TAG, "Setting up Lutron CC1101...");

  // Initialize SPI first
  this->spi_setup();

  // Initialize radio (pass this as SPI interface)
  this->radio_.init(this, this->gdo0_pin_);

  if (!this->radio_.is_initialized()) {
    ESP_LOGE(TAG, "Failed to initialize CC1101 radio");
    return;
  }

  // Create pairing handler
  this->pairing_ = new LutronPairing(&this->radio_);

  ESP_LOGI(TAG, "Lutron CC1101 ready");
}

void LutronCC1101::dump_config() {
  ESP_LOGCONFIG(TAG, "Lutron CC1101:");
  ESP_LOGCONFIG(TAG, "  Status: %s", this->radio_.is_initialized() ? "OK" : "FAILED");
}

void LutronCC1101::transmit_packet(const uint8_t *packet, size_t len) {
  uint8_t tx_buffer[128];

  size_t encoded_len = this->encoder_.encode_packet(
      packet, len, tx_buffer, sizeof(tx_buffer), 32, 16);

  if (encoded_len == 0) {
    ESP_LOGE(TAG, "Failed to encode packet");
    return;
  }

  this->radio_.transmit_raw(tx_buffer, encoded_len);
}

void LutronCC1101::send_button_press(uint32_t device_id, uint8_t button) {
  ESP_LOGI(TAG, "Button 0x%02X for device %08X", button, device_id);

  uint8_t packet[24];

  // Type alternates between presses
  uint8_t type_base = this->type_alternate_ ? PKT_TYPE_BUTTON_SHORT_B : PKT_TYPE_BUTTON_SHORT_A;
  this->type_alternate_ = !this->type_alternate_;

  bool is_dimming = (button == LUTRON_BUTTON_RAISE || button == LUTRON_BUTTON_LOWER);
  uint8_t seq = 0x00;

  // --- PHASE 1: SHORT FORMAT (6 packets) ---
  for (int rep = 0; rep < 6; rep++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = type_base;
    packet[1] = seq;
    packet[2] = (device_id >> 0) & 0xFF;
    packet[3] = (device_id >> 8) & 0xFF;
    packet[4] = (device_id >> 16) & 0xFF;
    packet[5] = (device_id >> 24) & 0xFF;
    packet[6] = 0x21;
    packet[8] = 0x03;
    packet[9] = 0x00;
    packet[10] = button;
    packet[11] = 0x00;

    if (is_dimming) {
      packet[7] = 0x0C;
      packet[12] = (device_id >> 0) & 0xFF;
      packet[13] = (device_id >> 8) & 0xFF;
      packet[14] = (device_id >> 16) & 0xFF;
      packet[15] = (device_id >> 24) & 0xFF;
      packet[16] = 0x00;
      packet[17] = 0x42;
      packet[18] = 0x00;
      packet[19] = 0x02;
    } else {
      packet[7] = 0x04;
    }

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);
    seq += (rep % 2 == 0) ? 2 : 4;
    delay(70);
  }

  // --- PHASE 2: LONG FORMAT (10 packets) ---
  seq = 0x0C;

  for (int rep = 0; rep < 10; rep++) {
    memset(packet, 0x00, sizeof(packet));

    packet[0] = type_base | 0x01;  // Long format
    packet[1] = seq;
    packet[2] = (device_id >> 0) & 0xFF;
    packet[3] = (device_id >> 8) & 0xFF;
    packet[4] = (device_id >> 16) & 0xFF;
    packet[5] = (device_id >> 24) & 0xFF;
    packet[6] = 0x21;
    packet[7] = 0x0E;
    packet[8] = 0x03;
    packet[9] = 0x00;
    packet[10] = button;
    packet[11] = 0x01;

    packet[12] = (device_id >> 0) & 0xFF;
    packet[13] = (device_id >> 8) & 0xFF;
    packet[14] = (device_id >> 16) & 0xFF;
    packet[15] = (device_id >> 24) & 0xFF;
    packet[16] = 0x00;

    if (button == LUTRON_BUTTON_RAISE) {
      packet[17] = 0x42; packet[18] = 0x02; packet[19] = 0x01;
      packet[20] = 0x00; packet[21] = 0x16;
    } else if (button == LUTRON_BUTTON_LOWER) {
      packet[17] = 0x42; packet[18] = 0x02; packet[19] = 0x00;
      packet[20] = 0x00; packet[21] = 0x43;
    } else {
      packet[17] = 0x40; packet[18] = 0x00;
      packet[19] = 0x1E + button;
      packet[20] = 0x00; packet[21] = 0x00;
    }

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);
    seq += 6;
    if (rep < 9) delay(70);
  }

  ESP_LOGI(TAG, "Button press complete");
}

void LutronCC1101::send_level(uint32_t device_id, uint8_t level_percent) {
  ESP_LOGI(TAG, "Level %d%% for device %08X", level_percent, device_id);

  if (level_percent > 100) level_percent = 100;

  uint16_t level_value;
  if (level_percent == 100) {
    level_value = 0xFEFF;
  } else {
    level_value = (uint16_t)((uint32_t)level_percent * 65279 / 100);
  }

  uint8_t packet[24];
  uint8_t seq = 0x00;

  for (int rep = 0; rep < 8; rep++) {
    memset(packet, 0x00, sizeof(packet));

    packet[0] = 0x81 + (rep % 3);
    packet[1] = seq;
    packet[2] = (device_id >> 0) & 0xFF;
    packet[3] = (device_id >> 8) & 0xFF;
    packet[4] = (device_id >> 16) & 0xFF;
    packet[5] = (device_id >> 24) & 0xFF;
    packet[6] = 0x21;
    packet[7] = 0x0E;
    packet[8] = 0x00;
    packet[9] = 0x07;
    packet[10] = 0x03;
    packet[11] = 0xC3;
    packet[12] = 0xC6;
    packet[13] = 0xFE;
    packet[14] = 0x40;
    packet[15] = 0x02;
    packet[16] = (level_value >> 8) & 0xFF;
    packet[17] = level_value & 0xFF;
    packet[18] = 0x00;
    packet[19] = 0x01;
    packet[20] = 0x00;
    packet[21] = 0x00;

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);
    seq += 6;
    if (rep < 7) delay(70);
  }

  ESP_LOGI(TAG, "Level command complete");
}

void LutronCC1101::send_pairing_b9(uint32_t device_id) {
  if (this->pairing_ != nullptr) {
    this->pairing_->send_pairing_b9(device_id, 5);
  }
}

void LutronCC1101::send_test_packet(uint32_t device_id) {
  ESP_LOGI(TAG, "=== TEST PACKET FOR RTL-SDR CAPTURE ===");
  ESP_LOGI(TAG, "Device ID: 0x%08X", device_id);
  ESP_LOGI(TAG, "Sending 5 copies of 0xB9 pairing packet...");

  // Build a 0xB9 pairing packet (47 bytes)
  uint8_t packet[47];
  memset(packet, 0x00, sizeof(packet));

  packet[0] = 0xB9;  // Type
  packet[1] = 0x00;  // Sequence

  // Device ID - 1st instance (little-endian)
  packet[2] = (device_id >> 0) & 0xFF;
  packet[3] = (device_id >> 8) & 0xFF;
  packet[4] = (device_id >> 16) & 0xFF;
  packet[5] = (device_id >> 24) & 0xFF;

  // Constants from real Pico capture
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
  packet[30] = 0x03;  // Button 3 = FAVORITE
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

  // Log the packet
  ESP_LOGI(TAG, "Packet (47 bytes):");
  char hex[150];
  int pos = 0;
  for (int i = 0; i < 47 && pos < 140; i++) {
    pos += snprintf(hex + pos, sizeof(hex) - pos, "%02X ", packet[i]);
  }
  ESP_LOGI(TAG, "%s", hex);
  ESP_LOGI(TAG, "CRC: 0x%04X", crc);

  // Send 5 times with gaps
  for (int i = 0; i < 5; i++) {
    ESP_LOGI(TAG, "TX %d/5", i + 1);
    this->transmit_packet(packet, 47);
    if (i < 4) delay(200);
  }

  ESP_LOGI(TAG, "=== TEST COMPLETE ===");
}

void LutronCC1101::send_beacon(uint32_t device_id, uint8_t beacon_type, int duration_seconds) {
  ESP_LOGI(TAG, "=== SENDING PAIRING BEACON ===");
  ESP_LOGI(TAG, "Device ID: 0x%08X, Type: 0x%02X, Duration: %ds", device_id, beacon_type, duration_seconds);

  // Validate beacon type
  if (beacon_type != 0x91 && beacon_type != 0x92 && beacon_type != 0x93) {
    ESP_LOGW(TAG, "Invalid beacon type, using 0x92");
    beacon_type = 0x92;
  }

  uint8_t packet[24];
  uint8_t seq = 1;

  // Calculate timing - real bridge sends at ~65ms intervals
  // We'll send pairs of packets (like the real bridge does)
  unsigned long start_time = millis();
  unsigned long end_time = start_time + (duration_seconds * 1000);
  int packet_count = 0;

  while (millis() < end_time) {
    // Build beacon packet (24 bytes with CRC)
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = beacon_type;
    packet[1] = seq;

    // Device ID (zone ID) - in big-endian like captures show
    // Bridge uses af902c00 format - we'll use similar with our device ID
    // Format the device_id as a zone ID (swap endianness for RF)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = device_id & 0xFF;

    packet[6] = 0x21;  // Protocol marker
    packet[7] = 0x08;  // Format
    packet[8] = 0x00;

    // Broadcast address
    packet[9] = 0xFF;
    packet[10] = 0xFF;
    packet[11] = 0xFF;
    packet[12] = 0xFF;
    packet[13] = 0xFF;

    // Pairing mode command marker
    packet[14] = 0x08;
    packet[15] = 0x01;

    // Padding (already 0xCC from memset)
    // packet[16-21] = 0xCC

    // Calculate CRC
    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    // Transmit
    this->transmit_packet(packet, 24);
    packet_count++;

    // Increment sequence (real bridge uses steps of 5-6)
    seq = (seq + 5) & 0xFF;

    // Send a second packet quickly (bridge sends pairs)
    packet[1] = seq;
    crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);
    packet_count++;
    seq = (seq + 1) & 0xFF;

    // Wait ~65ms between pairs (matching real bridge timing)
    delay(63);

    // Log progress every second
    if ((packet_count % 30) == 0) {
      ESP_LOGI(TAG, "Beacon TX: %d packets sent, %lds remaining",
               packet_count, (end_time - millis()) / 1000);
    }
  }

  ESP_LOGI(TAG, "=== BEACON COMPLETE: %d packets sent ===", packet_count);
}

}  // namespace lutron_cc1101
}  // namespace esphome
