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
    // Device ID in big-endian (matches real Pico)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;
    packet[6] = 0x21;
    packet[8] = 0x03;
    packet[9] = 0x00;
    packet[10] = button;
    packet[11] = 0x00;

    if (is_dimming) {
      packet[7] = 0x0C;
      packet[12] = (device_id >> 24) & 0xFF;
      packet[13] = (device_id >> 16) & 0xFF;
      packet[14] = (device_id >> 8) & 0xFF;
      packet[15] = (device_id >> 0) & 0xFF;
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
    // Device ID in big-endian (matches real Pico)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;
    packet[6] = 0x21;
    packet[7] = 0x0E;
    packet[8] = 0x03;
    packet[9] = 0x00;
    packet[10] = button;
    packet[11] = 0x01;

    // Second device ID instance also in big-endian
    packet[12] = (device_id >> 24) & 0xFF;
    packet[13] = (device_id >> 16) & 0xFF;
    packet[14] = (device_id >> 8) & 0xFF;
    packet[15] = (device_id >> 0) & 0xFF;
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
    // Device ID in big-endian (matches real devices)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = (device_id >> 0) & 0xFF;
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

void LutronCC1101::send_bridge_level(uint32_t bridge_zone_id, uint32_t target_device_id, uint8_t level_percent) {
  ESP_LOGI(TAG, "=== BRIDGE-STYLE LEVEL COMMAND ===");
  ESP_LOGI(TAG, "Bridge zone: %08X, Target: %08X, Level: %d%%",
           bridge_zone_id, target_device_id, level_percent);

  if (level_percent > 100) level_percent = 100;

  uint16_t level_value;
  if (level_percent == 100) {
    level_value = 0xFEFF;
  } else if (level_percent == 0) {
    level_value = 0x0000;
  } else {
    level_value = (uint16_t)((uint32_t)level_percent * 65279 / 100);
  }

  uint8_t packet[24];
  uint8_t seq = 0x01;

  // Send ~20 packets like the real bridge does
  for (int rep = 0; rep < 20; rep++) {
    memset(packet, 0x00, sizeof(packet));

    // Packet structure from captured bridge traffic:
    // 83 02 af 90 2c 00 21 0e 00 06 fd ef f4 fe 40 02 fe ff 00 01 00 00

    packet[0] = 0x81 + (rep % 3);  // Rotate through 0x81, 0x82, 0x83
    packet[1] = seq;

    // Bridge zone ID (big-endian as seen in captures)
    packet[2] = (bridge_zone_id >> 24) & 0xFF;
    packet[3] = (bridge_zone_id >> 16) & 0xFF;
    packet[4] = (bridge_zone_id >> 8) & 0xFF;
    packet[5] = bridge_zone_id & 0xFF;

    packet[6] = 0x21;  // Protocol marker
    packet[7] = 0x0E;  // Format
    packet[8] = 0x00;

    // TARGET DEVICE ID (the dimmer's printed label ID)
    packet[9] = (target_device_id >> 24) & 0xFF;
    packet[10] = (target_device_id >> 16) & 0xFF;
    packet[11] = (target_device_id >> 8) & 0xFF;
    packet[12] = target_device_id & 0xFF;

    packet[13] = 0xFE;
    packet[14] = 0x40;
    packet[15] = 0x02;

    // Level value (big-endian)
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

    // Sequence increments by 5-6 like bridge
    seq = (seq + 5 + (rep % 2)) & 0xFF;

    if (rep < 19) delay(60);
  }

  ESP_LOGI(TAG, "=== BRIDGE LEVEL COMPLETE ===");
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

  // Device ID - 1st instance (big-endian, matches real devices)
  packet[2] = (device_id >> 24) & 0xFF;
  packet[3] = (device_id >> 16) & 0xFF;
  packet[4] = (device_id >> 8) & 0xFF;
  packet[5] = (device_id >> 0) & 0xFF;

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

  // Device ID - 2nd instance (big-endian)
  packet[20] = (device_id >> 24) & 0xFF;
  packet[21] = (device_id >> 16) & 0xFF;
  packet[22] = (device_id >> 8) & 0xFF;
  packet[23] = (device_id >> 0) & 0xFF;

  // Device ID - 3rd instance (big-endian)
  packet[24] = (device_id >> 24) & 0xFF;
  packet[25] = (device_id >> 16) & 0xFF;
  packet[26] = (device_id >> 8) & 0xFF;
  packet[27] = (device_id >> 0) & 0xFF;

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
    packet[7] = 0x0C;  // Format (0x0C for beacon, not 0x08!)
    packet[8] = 0x00;

    // Broadcast address
    packet[9] = 0xFF;
    packet[10] = 0xFF;
    packet[11] = 0xFF;
    packet[12] = 0xFF;
    packet[13] = 0xFF;

    // Beacon payload from real bridge capture
    packet[14] = 0x08;
    packet[15] = 0x02;  // 0x02, not 0x01!

    // Bytes 16-19 contain partial load ID info from real capture
    // Real bridge sends: 90 2C 1A 04 (bytes 3-4 of load ID + 1A 04)
    packet[16] = (device_id >> 16) & 0xFF;  // Middle bytes of load ID
    packet[17] = (device_id >> 8) & 0xFF;
    packet[18] = 0x1A;
    packet[19] = 0x04;
    // packet[20-21] = 0xCC (already set by memset)

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

uint8_t LutronCC1101::send_beacon_single(uint32_t device_id, uint8_t seq) {
  uint8_t packet[24];
  memset(packet, 0xCC, sizeof(packet));

  packet[0] = 0x92;  // Beacon type
  packet[1] = seq;

  // Device ID (zone ID) - big-endian
  packet[2] = (device_id >> 24) & 0xFF;
  packet[3] = (device_id >> 16) & 0xFF;
  packet[4] = (device_id >> 8) & 0xFF;
  packet[5] = device_id & 0xFF;

  packet[6] = 0x21;  // Protocol marker
  packet[7] = 0x0C;  // Format
  packet[8] = 0x00;

  // Broadcast address
  packet[9] = 0xFF;
  packet[10] = 0xFF;
  packet[11] = 0xFF;
  packet[12] = 0xFF;
  packet[13] = 0xFF;

  packet[14] = 0x08;
  packet[15] = 0x02;

  // Middle bytes of load ID + fixed trailer
  packet[16] = (device_id >> 16) & 0xFF;
  packet[17] = (device_id >> 8) & 0xFF;
  packet[18] = 0x1A;
  packet[19] = 0x04;

  // Calculate CRC
  uint16_t crc = this->encoder_.calc_crc(packet, 22);
  packet[22] = (crc >> 8) & 0xFF;
  packet[23] = crc & 0xFF;

  // Transmit
  this->transmit_packet(packet, 24);

  // Return next sequence
  return (seq + 5) & 0xFF;
}

void LutronCC1101::send_pairing_b0(uint32_t load_id, uint32_t target_factory_id) {
  ESP_LOGI(TAG, "=== SENDING 0xB1 PAIRING ASSIGNMENT ===");
  ESP_LOGI(TAG, "Load ID: 0x%08X, Target: 0x%08X", load_id, target_factory_id);

  uint8_t packet[24];
  uint8_t seq = 1;

  // Send multiple copies like real bridge does
  for (int rep = 0; rep < 30; rep++) {
    memset(packet, 0x00, sizeof(packet));

    // 0xB1 packet structure from real bridge capture:
    // B1 07 AF 90 2C 7F 21 17 00 FF FF FF FF FF 08 05 06 FD EF F4 04 63 02 01

    packet[0] = 0xB1;  // Pairing assignment type (B1, not B0!)
    packet[1] = seq;

    // Load ID with 0x7F suffix (like af902c7f)
    packet[2] = (load_id >> 24) & 0xFF;
    packet[3] = (load_id >> 16) & 0xFF;
    packet[4] = (load_id >> 8) & 0xFF;
    packet[5] = 0x7F;  // Special suffix for B0 packets

    packet[6] = 0x21;  // Protocol marker
    packet[7] = 0x17;  // Pairing format
    packet[8] = 0x00;

    // Broadcast address
    packet[9] = 0xFF;
    packet[10] = 0xFF;
    packet[11] = 0xFF;
    packet[12] = 0xFF;
    packet[13] = 0xFF;

    packet[14] = 0x08;
    packet[15] = 0x05;

    // Target factory ID
    packet[16] = (target_factory_id >> 24) & 0xFF;
    packet[17] = (target_factory_id >> 16) & 0xFF;
    packet[18] = (target_factory_id >> 8) & 0xFF;
    packet[19] = target_factory_id & 0xFF;

    // Unknown trailer (from capture)
    packet[20] = 0x04;
    packet[21] = 0x63;

    // Calculate CRC
    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);

    // Increment sequence
    seq = (seq + 5) & 0xFF;

    delay(50);  // ~50ms between packets
  }

  ESP_LOGI(TAG, "=== 0xB0 PAIRING COMPLETE ===");
}

void LutronCC1101::send_state_report(uint32_t device_id, uint8_t level_percent) {
  ESP_LOGI(TAG, "=== FAKE STATE REPORT ===");
  ESP_LOGI(TAG, "Device ID: 0x%08X, Level: %d%%", device_id, level_percent);

  if (level_percent > 100) level_percent = 100;

  // Convert percent to 0x00-0xFE range (0xFE = 100%)
  uint8_t level_byte = (uint8_t)((uint32_t)level_percent * 254 / 100);
  if (level_percent == 100) level_byte = 0xFE;

  uint8_t packet[24];
  uint8_t seq = 0x00;

  // Send ~20 packets like real dimmer does when physically adjusted
  for (int rep = 0; rep < 20; rep++) {
    memset(packet, 0xCC, sizeof(packet));

    // Packet structure from captured dimmer state reports:
    // 83 01 8F 90 2C 08 00 08 00 1B 01 XX 00 1B 92 XX CC CC CC CC CC CC [CRC]
    // Where XX = level byte (appears twice at [11] and [15])

    packet[0] = 0x81 + (rep % 3);  // Rotate through 0x81, 0x82, 0x83
    packet[1] = seq;

    // Device ID (big-endian)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = device_id & 0xFF;

    // Constants from captured packets
    packet[6] = 0x00;
    packet[7] = 0x08;
    packet[8] = 0x00;
    packet[9] = 0x1B;
    packet[10] = 0x01;

    // LEVEL (first instance)
    packet[11] = level_byte;

    packet[12] = 0x00;
    packet[13] = 0x1B;
    packet[14] = 0x92;

    // LEVEL (second instance - duplicated)
    packet[15] = level_byte;

    // Padding (already 0xCC from memset)
    // packet[16-21] = 0xCC

    // Calculate CRC
    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);

    // Sequence increments by 5 like real dimmer
    seq = (seq + 5) & 0xFF;

    if (rep < 19) delay(50);
  }

  ESP_LOGI(TAG, "=== STATE REPORT COMPLETE ===");
}

void LutronCC1101::send_debug_pattern() {
  ESP_LOGI(TAG, "=== DEBUG: Sending raw 0xAA pattern ===");

  // Send 32 bytes of 0xAA (alternating bits) directly to CC1101
  // This bypasses the encoder to test raw CC1101 transmission
  uint8_t raw_data[32];
  for (int i = 0; i < 32; i++) {
    raw_data[i] = 0xAA;  // 10101010
  }

  ESP_LOGI(TAG, "Sending 32 bytes of 0xAA raw to CC1101...");
  this->radio_.transmit_raw(raw_data, 32);
  delay(200);

  // Also test with 0x55 (inverted alternating)
  for (int i = 0; i < 32; i++) {
    raw_data[i] = 0x55;  // 01010101
  }
  ESP_LOGI(TAG, "Sending 32 bytes of 0x55 raw to CC1101...");
  this->radio_.transmit_raw(raw_data, 32);
  delay(200);

  // Test with encoded packet (what we normally send)
  ESP_LOGI(TAG, "Sending encoded preamble pattern...");
  uint8_t test_packet[8] = {0x88, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  uint8_t tx_buffer[64];
  size_t encoded_len = this->encoder_.encode_packet(test_packet, 8, tx_buffer, sizeof(tx_buffer), 64, 16);

  ESP_LOGI(TAG, "Encoded length: %d bytes", encoded_len);
  ESP_LOGI(TAG, "Bytes  0-7:  %02X %02X %02X %02X %02X %02X %02X %02X",
           tx_buffer[0], tx_buffer[1], tx_buffer[2], tx_buffer[3],
           tx_buffer[4], tx_buffer[5], tx_buffer[6], tx_buffer[7]);
  ESP_LOGI(TAG, "Bytes  8-15: %02X %02X %02X %02X %02X %02X %02X %02X",
           tx_buffer[8], tx_buffer[9], tx_buffer[10], tx_buffer[11],
           tx_buffer[12], tx_buffer[13], tx_buffer[14], tx_buffer[15]);
  ESP_LOGI(TAG, "Bytes 16-23: %02X %02X %02X %02X %02X %02X %02X %02X",
           tx_buffer[16], tx_buffer[17], tx_buffer[18], tx_buffer[19],
           tx_buffer[20], tx_buffer[21], tx_buffer[22], tx_buffer[23]);

  this->radio_.transmit_raw(tx_buffer, encoded_len);

  ESP_LOGI(TAG, "=== DEBUG COMPLETE ===");
}

}  // namespace lutron_cc1101
}  // namespace esphome
