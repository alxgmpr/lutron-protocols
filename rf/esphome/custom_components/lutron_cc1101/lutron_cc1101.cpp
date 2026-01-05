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

  // Set up RX callback for packet decoding
  this->radio_.set_rx_callback([this](const uint8_t *data, size_t len, int8_t rssi) {
    this->handle_rx_packet(data, len, rssi);
  });

  // Create pairing handler
  this->pairing_ = new LutronPairing(&this->radio_);

  // Auto-start RX mode if enabled (default: on)
  if (this->rx_auto_) {
    ESP_LOGI(TAG, "Auto-starting RX mode...");
    this->start_rx();
  }

  ESP_LOGI(TAG, "Lutron CC1101 ready");
}

// Echo detection moved to backend - ESP32 just streams all valid packets

void LutronCC1101::handle_rx_packet(const uint8_t *data, size_t len, int8_t rssi) {
  // Filter out noise - real Lutron packets have RSSI > -70 typically
  // Noise floor is around -80 to -95
  if (rssi < -70) {
    return;  // Silently ignore noise
  }

  // Try to decode the packet
  DecodedPacket pkt;
  if (!this->decoder_.decode(data, len, pkt)) {
    return;  // Silently ignore undecoded packets
  }

  // Echo filtering is handled by backend using raw byte matching
  // ESP32 just logs all valid packets for simplicity

  // Only log successfully decoded packets
  char dev_id[9];
  LutronDecoder::format_device_id(pkt.device_id, dev_id);
  const char *type_name = LutronDecoder::packet_type_name(pkt.type);

  // Log decoded packet info
  if (pkt.type == PKT_BUTTON_SHORT_A || pkt.type == PKT_BUTTON_LONG_A ||
      pkt.type == PKT_BUTTON_SHORT_B || pkt.type == PKT_BUTTON_LONG_B) {
    // Button press packet
    const char *btn_name = LutronDecoder::button_name(pkt.button);
    const char *action = (pkt.action == ACTION_RELEASE) ? "RELEASE" : "PRESS";

    ESP_LOGI(TAG, "RX: %s | %s | 0x%02X %s %s | Seq=%d | RSSI=%d | CRC=%s",
             type_name, dev_id, pkt.button, btn_name, action, pkt.sequence, rssi,
             pkt.crc_valid ? "OK" : "BAD");
  } else if (pkt.type == PKT_STATE_REPORT_81 || pkt.type == PKT_STATE_REPORT_82 ||
             pkt.type == PKT_STATE_REPORT_83) {
    // State report from dimmer
    ESP_LOGI(TAG, "RX: %s | %s | Level=%d%% | Seq=%d | RSSI=%d | CRC=%s",
             type_name, dev_id, pkt.level, pkt.sequence, rssi,
             pkt.crc_valid ? "OK" : "BAD");
  } else if (pkt.type == PKT_LEVEL) {
    // Level command to dimmer
    char target_id[9];
    LutronDecoder::format_device_id(pkt.target_id, target_id);
    ESP_LOGI(TAG, "RX: %s | %s -> %s | Level=%d%% | Seq=%d | RSSI=%d | CRC=%s",
             type_name, dev_id, target_id, pkt.level, pkt.sequence, rssi,
             pkt.crc_valid ? "OK" : "BAD");
  } else {
    // Other packet types (pairing, beacon, etc.)
    ESP_LOGI(TAG, "RX: %s | %s | Seq=%d | RSSI=%d | CRC=%s",
             type_name, dev_id, pkt.sequence, rssi,
             pkt.crc_valid ? "OK" : "BAD");
  }

  // Log raw decoded bytes for web UI packet display
  if (pkt.raw_len > 0) {
    char hex[180];  // 56 bytes * 3 chars + margin
    int pos = 0;
    // Show up to 53 bytes for pairing packets (capability bytes at 28-40)
    size_t max_bytes = (pkt.type >= 0xB0 && pkt.type <= 0xBF) ? 53 : 24;
    for (size_t i = 0; i < pkt.raw_len && i < max_bytes && pos < 170; i++) {
      pos += snprintf(hex + pos, sizeof(hex) - pos, "%02X ", pkt.raw[i]);
    }
    ESP_LOGI(TAG, "  Bytes: %s", hex);
  }
}

void LutronCC1101::dump_config() {
  ESP_LOGCONFIG(TAG, "Lutron CC1101:");
  ESP_LOGCONFIG(TAG, "  Status: %s", this->radio_.is_initialized() ? "OK" : "FAILED");
  ESP_LOGCONFIG(TAG, "  RX Enabled: %s", this->rx_enabled_ ? "YES" : "NO");
  ESP_LOGCONFIG(TAG, "  RX Auto: %s", this->rx_auto_ ? "YES" : "NO");
}

void LutronCC1101::loop() {
  // Only poll RX when enabled - poll every iteration to keep up with data rate
  if (this->rx_enabled_) {
    this->radio_.check_rx();
  }

  // Continuous pairing beacon transmission
  if (this->pairing_active_) {
    uint32_t now = millis();
    if (now - this->last_pairing_beacon_ >= 65) {  // ~65ms interval like working beacon
      this->last_pairing_beacon_ = now;

      // Construct device ID from subnet for send_beacon_single
      // For subnet 0x2C90, we want packet bytes: AF 90 2C 00
      // send_beacon_single sends big-endian, so device_id = 0xAF902C00
      // Alternate between AF and AD zone suffixes
      uint8_t zone_suffix = (this->pairing_seq_ % 2 == 0) ? 0xAF : 0xAD;
      uint32_t device_id = ((uint32_t)zone_suffix << 24) |
                           ((this->pairing_subnet_ & 0xFF) << 16) |
                           ((this->pairing_subnet_ >> 8) << 8) |
                           0x01;  // Zone number (use 01 like working beacon)

      // Use the working send_beacon_single function
      this->pairing_seq_ = this->send_beacon_single(device_id, this->pairing_seq_);
    }
  }
}

void LutronCC1101::start_rx() {
  ESP_LOGI(TAG, "=== STARTING RX MODE ===");
  this->radio_.start_rx();
  this->rx_enabled_ = true;
  this->rx_auto_ = true;  // Re-enable auto-resume when manually started
  this->last_rx_check_ = millis();
}

void LutronCC1101::stop_rx() {
  ESP_LOGI(TAG, "=== STOPPING RX MODE ===");
  this->radio_.stop_rx();
  this->rx_enabled_ = false;
  this->rx_auto_ = false;  // Disable auto-resume when manually stopped
}

void LutronCC1101::transmit_packet(const uint8_t *packet, size_t len) {
  // Log decoded packet bytes for backend echo detection
  char hex[180];
  int pos = 0;
  size_t max_log = (len > 53) ? 53 : len;
  for (size_t i = 0; i < max_log && pos < 170; i++) {
    pos += snprintf(hex + pos, sizeof(hex) - pos, "%02X ", packet[i]);
  }
  ESP_LOGI(TAG, "TX %d bytes: %s", (int)len, hex);

  uint8_t tx_buffer[128];

  // For large packets, use shorter preamble to fit in FIFO (64 bytes)
  // Standard: 32 bit preamble + 10 sync + 20 prefix + data + 16 trailing
  // For 52-byte packet with 32-bit preamble: (32+10+20+520+16)/8 = 75 bytes (too big!)
  // With 16-bit preamble: (16+10+20+520+16)/8 = 73 bytes (still too big)
  // With 8-bit preamble: (8+10+20+520+16)/8 = 72 bytes (still too big)

  // Calculate required encoded size with various preamble lengths
  // N81: each data byte = 10 bits
  // Overhead: preamble + sync(10) + prefix(20) + trailing(16)

  int preamble_bits = 32;  // Default
  int trailing_bits = 16;

  // If packet would be too large for FIFO, reduce preamble
  size_t estimated_bits = preamble_bits + 10 + 20 + (len * 10) + trailing_bits;
  size_t estimated_bytes = (estimated_bits + 7) / 8;

  if (estimated_bytes > 64) {
    // Try minimal preamble (8 bits = 1 byte)
    // Real Pico seems to use ~32 bits, but let's see if receiver tolerates less
    preamble_bits = 8;
    estimated_bits = preamble_bits + 10 + 20 + (len * 10) + trailing_bits;
    estimated_bytes = (estimated_bits + 7) / 8;

    // If still too large, we need streaming
    if (estimated_bytes > 64) {
      ESP_LOGW(TAG, "Packet too large even with min preamble (%d bytes encoded), will stream", estimated_bytes);
      preamble_bits = 32;  // Use full preamble and rely on streaming
    }
  }

  size_t encoded_len = this->encoder_.encode_packet(
      packet, len, tx_buffer, sizeof(tx_buffer), preamble_bits, trailing_bits);

  if (encoded_len == 0) {
    ESP_LOGE(TAG, "Failed to encode packet");
    return;
  }

  // Debug: Log packet and encoded sizes
  ESP_LOGD(TAG, "TX: %d data -> %d encoded (preamble=%d, FIFO=%s)",
           len, encoded_len, preamble_bits, encoded_len > 64 ? "STREAM" : "DIRECT");

  this->radio_.transmit_raw(tx_buffer, encoded_len);

  // Auto-resume RX after TX if auto mode enabled
  // (transmit_raw leaves radio in IDLE, we need to restart RX)
  if (this->rx_auto_) {
    this->radio_.start_rx();
    this->rx_enabled_ = true;
  }
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
    // Device ID in big-endian (matching pairing format)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = device_id & 0xFF;
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
      packet[15] = device_id & 0xFF;
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
    // Device ID in big-endian (matching pairing format)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = device_id & 0xFF;
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
    packet[15] = device_id & 0xFF;
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

void LutronCC1101::send_save_favorite(uint32_t device_id, uint8_t button, int hold_seconds) {
  // Save favorite - just send the SAVE command packets
  // The hold detection happens on the Pico itself, not over RF
  // Dimmer only needs to see the save command
  //
  // Real Pico SAVE packet (captured):
  // 8B 00 05 85 11 17 21 0D 04 00 03 03 00 05 85 11 17 00 40 04 21 CC [CRC]
  (void)hold_seconds;  // Not used - save is instant

  ESP_LOGI(TAG, "=== SAVE FAVORITE/SCENE ===");
  ESP_LOGI(TAG, "Device: 0x%08X, Button: 0x%02X", device_id, button);

  uint8_t packet[24];
  uint8_t type_base = this->type_alternate_ ? PKT_TYPE_BUTTON_SHORT_B : PKT_TYPE_BUTTON_SHORT_A;
  this->type_alternate_ = !this->type_alternate_;

  uint8_t seq = 0x00;

  // Send 12 SAVE packets like real Pico does
  for (int rep = 0; rep < 12; rep++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = type_base | 0x01;  // LONG format (0x89 or 0x8B)
    packet[1] = seq;
    // Device ID in big-endian
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = device_id & 0xFF;
    packet[6] = 0x21;
    packet[7] = 0x0D;  // SAVE format
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = button;
    packet[11] = 0x03;  // SAVE action
    packet[12] = 0x00;

    // Device ID repeated at bytes 13-16
    packet[13] = (device_id >> 24) & 0xFF;
    packet[14] = (device_id >> 16) & 0xFF;
    packet[15] = (device_id >> 8) & 0xFF;
    packet[16] = device_id & 0xFF;

    packet[17] = 0x00;
    packet[18] = 0x40;
    packet[19] = 0x04;
    packet[20] = 0x21;
    // packet[21] = 0xCC (already set by memset)

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);
    seq = (seq + 6) & 0xFF;
    if (rep < 11) delay(75);
  }

  ESP_LOGI(TAG, "=== SAVE COMPLETE ===");
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
    // Device ID in little-endian (LEVEL COMMANDS ONLY)
    packet[2] = device_id & 0xFF;
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

    // Bridge zone ID in little-endian (LEVEL COMMANDS ONLY)
    packet[2] = bridge_zone_id & 0xFF;
    packet[3] = (bridge_zone_id >> 8) & 0xFF;
    packet[4] = (bridge_zone_id >> 16) & 0xFF;
    packet[5] = (bridge_zone_id >> 24) & 0xFF;

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

void LutronCC1101::send_pairing_pico(uint32_t device_id, int duration_seconds) {
  ESP_LOGI(TAG, "=== PICO-STYLE PAIRING (0xBA + 0xBB) ===");
  ESP_LOGI(TAG, "Device ID: 0x%08X, Duration: %ds", device_id, duration_seconds);
  ESP_LOGI(TAG, "Real Pico sends 0xBA packets first, then 0xBB packets");

  // Real Pico pairing sequence from research/CC1101_captures/pico_pairrequest.txt:
  // 1. Send ~60 packets of 0xBA type (with capability info)
  // 2. Send ~12 packets of 0xBB type (pair request)
  // Each packet is 53 bytes (51 data + 2 CRC), ~75ms apart

  uint8_t packet[53];
  uint8_t seq = 0;
  int packet_count = 0;

  unsigned long start_time = millis();
  // Use 80% of duration for 0xBA, 20% for 0xBB
  unsigned long ba_end_time = start_time + (duration_seconds * 800);
  unsigned long bb_end_time = start_time + (duration_seconds * 1000);

  // === PHASE 1: Send 0xBA packets (capability announcement) ===
  ESP_LOGI(TAG, "Phase 1: Sending 0xBA packets...");

  while (millis() < ba_end_time) {
    memset(packet, 0xCC, sizeof(packet));

    // Type: 0xBA = Pico pairing with capability info
    packet[0] = 0xBA;
    packet[1] = seq;

    // Device ID - 1st instance (big-endian)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = device_id & 0xFF;

    // Protocol header for 0xBA (from real capture)
    packet[6] = 0x21;
    packet[7] = 0x25;  // Real Pico uses 0x25!
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = 0x0B;  // Real Pico uses 0x0B for BA
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast (5 bytes)
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
    packet[23] = device_id & 0xFF;

    // Device ID - 3rd instance
    packet[24] = (device_id >> 24) & 0xFF;
    packet[25] = (device_id >> 16) & 0xFF;
    packet[26] = (device_id >> 8) & 0xFF;
    packet[27] = device_id & 0xFF;

    // 0xBA capability info at bytes 28-40 (from real capture)
    // 00 20 04 00 08 07 04 01 07 02 27 00 00
    packet[28] = 0x00;
    packet[29] = 0x20;
    packet[30] = 0x04;  // Was 0x03
    packet[31] = 0x00;
    packet[32] = 0x08;
    packet[33] = 0x07;
    packet[34] = 0x04;  // Was 0x03
    packet[35] = 0x01;  // Was 0x00
    packet[36] = 0x07;
    packet[37] = 0x02;  // Was 0xFF
    packet[38] = 0x27;  // Was 0xFF
    packet[39] = 0x00;  // Was 0xFF
    packet[40] = 0x00;  // Was 0xFF
    // Bytes 41-44 = 0xFF (not CC!)
    packet[41] = 0xFF;
    packet[42] = 0xFF;
    packet[43] = 0xFF;
    packet[44] = 0xFF;
    // Bytes 45-50 = 0xCC padding (already set by memset)

    // Calculate CRC over bytes 0-50 (51 bytes)
    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    this->transmit_packet(packet, 53);
    packet_count++;

    // Sequence increments by 6
    seq = (seq + 6) & 0xFF;

    // ~75ms between packets
    delay(75);

    if ((packet_count % 20) == 0) {
      ESP_LOGI(TAG, "0xBA: Sent %d packets", packet_count);
    }

    // Reset sequence every 12 packets (real Pico: 0x00 to 0x42 by 6)
    if (seq > 0x42) {
      seq = 0;
    }
  }

  int ba_count = packet_count;
  ESP_LOGI(TAG, "Phase 1 complete: %d x 0xBA packets", ba_count);

  // === PHASE 2: Send 0xBB packets (pair request) ===
  ESP_LOGI(TAG, "Phase 2: Sending 0xBB packets...");
  seq = 0;  // Reset sequence for BB phase

  while (millis() < bb_end_time) {
    memset(packet, 0xCC, sizeof(packet));

    // Type: 0xBB = Pair request
    packet[0] = 0xBB;
    packet[1] = seq;

    // Device ID - 1st instance (big-endian)
    packet[2] = (device_id >> 24) & 0xFF;
    packet[3] = (device_id >> 16) & 0xFF;
    packet[4] = (device_id >> 8) & 0xFF;
    packet[5] = device_id & 0xFF;

    // Protocol header for 0xBB (from real capture - same as BA!)
    packet[6] = 0x21;
    packet[7] = 0x25;  // Real Pico uses 0x25 for BB too!
    packet[8] = 0x04;
    packet[9] = 0x00;
    packet[10] = 0x04;  // Real Pico uses 0x04 for BB
    packet[11] = 0x03;
    packet[12] = 0x00;

    // Broadcast (5 bytes)
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
    packet[23] = device_id & 0xFF;

    // Device ID - 3rd instance
    packet[24] = (device_id >> 24) & 0xFF;
    packet[25] = (device_id >> 16) & 0xFF;
    packet[26] = (device_id >> 8) & 0xFF;
    packet[27] = device_id & 0xFF;

    // 0xBB payload at bytes 28-40 (from real capture)
    // 00 20 03 00 08 07 03 01 07 02 06 00 00
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
    // Bytes 41-44 = 0xFF (not CC!)
    packet[41] = 0xFF;
    packet[42] = 0xFF;
    packet[43] = 0xFF;
    packet[44] = 0xFF;
    // Bytes 45-50 = 0xCC padding (already set by memset)

    // Calculate CRC over bytes 0-50 (51 bytes)
    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    this->transmit_packet(packet, 53);
    packet_count++;

    // Sequence increments by 6
    seq = (seq + 6) & 0xFF;

    // ~75ms between packets
    delay(75);

    if (seq > 0x42) {
      seq = 0;
    }
  }

  int bb_count = packet_count - ba_count;
  ESP_LOGI(TAG, "=== PICO PAIRING COMPLETE: %d x 0xBA + %d x 0xBB ===", ba_count, bb_count);
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

void LutronCC1101::send_bridge_pair_sequence(uint32_t bridge_id, uint32_t target_factory_id,
                                              int beacon_seconds) {
  ESP_LOGI(TAG, "=== BRIDGE PAIRING SEQUENCE ===");
  ESP_LOGI(TAG, "Bridge ID: 0x%08X, Target: 0x%08X, Duration: %ds",
           bridge_id, target_factory_id, beacon_seconds);
  ESP_LOGI(TAG, ">>> HOLD OFF ON DIMMER FOR 10 SECONDS NOW <<<");

  uint8_t packet[53];
  uint8_t seq = 1;
  uint8_t beacon_type = 0xB1;  // Rotates B1 -> B2 -> B3 -> B1

  // Extract bridge ID bytes (big-endian)
  uint8_t b0 = (bridge_id >> 24) & 0xFF;
  uint8_t b1 = (bridge_id >> 16) & 0xFF;
  uint8_t b2 = (bridge_id >> 8) & 0xFF;
  uint8_t b3 = bridge_id & 0xFF;

  // Phase 1: Send 0xB1/B2/B3 beacon packets
  // Real bridge format: b3 XX a1 85 5f 00 21 10 00 ff ff ff ff ff 08 02 85 5f 1a 02 ff...
  unsigned long start_time = millis();
  unsigned long end_time = start_time + (beacon_seconds * 1000);
  int packet_count = 0;

  ESP_LOGI(TAG, "Phase 1: Sending 0xB1/B2/B3 beacons...");

  while (millis() < end_time) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = beacon_type;
    packet[1] = seq;

    // Zone ID (bridge ID with last byte as 00)
    packet[2] = b0;
    packet[3] = b1;
    packet[4] = b2;
    packet[5] = 0x00;  // Real capture shows 00 here

    packet[6] = 0x21;  // Protocol marker
    packet[7] = 0x10;  // Format byte - CRITICAL: 0x10 for beacon, not 0x0C!
    packet[8] = 0x00;

    // Broadcast address
    packet[9] = 0xFF;
    packet[10] = 0xFF;
    packet[11] = 0xFF;
    packet[12] = 0xFF;
    packet[13] = 0xFF;

    packet[14] = 0x08;
    packet[15] = 0x02;

    // Zone info bytes (from capture: 85 5f 1a 02)
    packet[16] = b1;  // Middle bytes of bridge ID
    packet[17] = b2;
    packet[18] = 0x1A;
    packet[19] = 0x02;  // Version/type indicator

    // Rest is FF then CC padding
    packet[20] = 0xFF;
    packet[21] = 0xFF;
    packet[22] = 0xFF;
    packet[23] = 0xFF;
    // bytes 24-50 are already 0xCC from memset

    // Calculate CRC for 51 bytes
    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    this->transmit_packet(packet, 53);
    packet_count++;

    // Increment sequence by 6 like real bridge
    seq = (seq + 6) & 0xFF;

    // Rotate beacon type: B1 -> B2 -> B3 -> B1
    if (beacon_type == 0xB1) beacon_type = 0xB2;
    else if (beacon_type == 0xB2) beacon_type = 0xB3;
    else beacon_type = 0xB1;

    // ~75ms between packets like real bridge
    delay(75);

    // Log progress every ~5 seconds
    if ((packet_count % 66) == 0) {
      ESP_LOGI(TAG, "Beacon: %d packets, %lds remaining",
               packet_count, (end_time - millis()) / 1000);
    }
  }

  ESP_LOGI(TAG, "Phase 1 complete: %d beacon packets", packet_count);

  // Phase 2: Send 0xA1/A2/A3 assignment packets
  // Real format: a1 01 a1 85 5f 00 21 0f 00 01 2c 0f 7c fe 06 70 00 06 7c b0 7c 00 00
  ESP_LOGI(TAG, "Phase 2: Sending assignment packets for 0x%08X...", target_factory_id);

  uint8_t assign_type = 0xA1;
  seq = 1;

  // Send 60 assignment packets (like real bridge does multiple passes)
  for (int i = 0; i < 60; i++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = assign_type;
    packet[1] = seq;

    // Zone ID
    packet[2] = b0;
    packet[3] = b1;
    packet[4] = b2;
    packet[5] = 0x00;

    packet[6] = 0x21;
    packet[7] = 0x0F;  // Format for assignment packets
    packet[8] = 0x00;

    // Bridge internal ID (using our bridge_id bytes rearranged)
    // From capture: 01 2c 0f 7c fe
    packet[9] = b3;   // Last byte of bridge ID
    packet[10] = b2;
    packet[11] = b1;
    packet[12] = b0;
    packet[13] = 0xFE;

    // Command bytes
    packet[14] = 0x06;
    packet[15] = 0x70;  // Assignment command
    packet[16] = 0x00;

    // Target factory ID (big-endian)
    packet[17] = (target_factory_id >> 24) & 0xFF;
    packet[18] = (target_factory_id >> 16) & 0xFF;
    packet[19] = (target_factory_id >> 8) & 0xFF;
    packet[20] = target_factory_id & 0xFF;

    packet[21] = 0x00;
    packet[22] = 0x00;
    // Rest is 0xCC padding

    // CRC
    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    this->transmit_packet(packet, 53);

    seq = (seq + 5) & 0xFF;

    // Rotate: A1 -> A2 -> A3 -> A1
    if (assign_type == 0xA1) assign_type = 0xA2;
    else if (assign_type == 0xA2) assign_type = 0xA3;
    else assign_type = 0xA1;

    delay(75);
  }

  ESP_LOGI(TAG, "=== BRIDGE PAIRING SEQUENCE COMPLETE ===");
  ESP_LOGI(TAG, "Try sending level commands to 0x%08X now!", target_factory_id);
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

    // Device ID in little-endian (STATE REPORTS ONLY)
    packet[2] = device_id & 0xFF;
    packet[3] = (device_id >> 8) & 0xFF;
    packet[4] = (device_id >> 16) & 0xFF;
    packet[5] = (device_id >> 24) & 0xFF;

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

    // Sequence increments by 2 like real dimmer
    seq = (seq + 2) & 0xFF;

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

void LutronCC1101::test_decode_packet(const std::string &hex_bytes) {
  ESP_LOGI(TAG, "=== TEST DECODE PACKET ===");
  ESP_LOGI(TAG, "Input: %s", hex_bytes.c_str());

  // Parse hex string to bytes
  uint8_t bytes[56];
  size_t byte_count = 0;

  const char *ptr = hex_bytes.c_str();
  while (*ptr && byte_count < sizeof(bytes)) {
    // Skip whitespace and separators
    while (*ptr && (*ptr == ' ' || *ptr == '\t' || *ptr == ',' || *ptr == ':')) {
      ptr++;
    }
    if (!*ptr) break;

    // Parse two hex characters
    char hex[3] = {0, 0, 0};
    if (ptr[0] && ptr[1]) {
      hex[0] = ptr[0];
      hex[1] = ptr[1];
      char *end;
      unsigned long val = strtoul(hex, &end, 16);
      if (end != hex) {
        bytes[byte_count++] = (uint8_t)val;
        ptr += 2;
      } else {
        ptr++;  // Skip invalid character
      }
    } else {
      break;
    }
  }

  ESP_LOGI(TAG, "Parsed %d bytes", byte_count);

  if (byte_count < 10) {
    ESP_LOGE(TAG, "Too few bytes to parse (minimum 10)");
    ESP_LOGI("TEST_RESULT", "{\"error\":\"too_few_bytes\",\"count\":%d}", byte_count);
    return;
  }

  // Log raw bytes for verification
  char hex_out[180];
  int pos = 0;
  for (size_t i = 0; i < byte_count && pos < 170; i++) {
    pos += snprintf(hex_out + pos, sizeof(hex_out) - pos, "%02X ", bytes[i]);
  }
  ESP_LOGI(TAG, "Raw bytes: %s", hex_out);

  // Parse the bytes
  DecodedPacket pkt;
  if (!this->decoder_.parse_bytes(bytes, byte_count, pkt)) {
    ESP_LOGE(TAG, "Failed to parse packet");
    ESP_LOGI("TEST_RESULT", "{\"error\":\"parse_failed\"}");
    return;
  }

  // Log parsed result as JSON
  this->decoder_.log_packet_json(pkt);

  ESP_LOGI(TAG, "=== TEST DECODE COMPLETE ===");
}

void LutronCC1101::send_pairing_experimental(uint32_t device_id, int ba_count, int bb_count,
                                              int protocol_variant, int pico_type, int button_scheme) {
  if (this->pairing_) {
    this->pairing_->send_pairing_experimental(device_id, ba_count, bb_count,
                                               protocol_variant, pico_type, button_scheme);
  }
}

void LutronCC1101::send_pairing_5button(uint32_t device_id, int duration_seconds) {
  if (this->pairing_) {
    this->pairing_->send_pairing_5button(device_id, duration_seconds);
  }
}

void LutronCC1101::send_pairing_advanced(uint32_t device_id, int duration_seconds,
                                          uint8_t pkt_type_a, uint8_t pkt_type_b,
                                          uint8_t byte10, uint8_t byte30, uint8_t byte31,
                                          uint8_t byte37, uint8_t byte38) {
  if (this->pairing_) {
    this->pairing_->send_pairing_advanced(device_id, duration_seconds,
                                           pkt_type_a, pkt_type_b,
                                           byte10, byte30, byte31, byte37, byte38);
  }
}

void LutronCC1101::send_reset(uint32_t source_id, uint32_t paired_id) {
  // For Pico reset, we only use source_id (the Pico saying "forget about me")
  // paired_id is ignored - kept for API compatibility
  (void)paired_id;

  ESP_LOGI(TAG, "=== PICO RESET PACKET ===");
  ESP_LOGI(TAG, "Pico ID: 0x%08X broadcasting 'forget me'", source_id);

  // Pico reset format from captured pico_reset.cu8:
  // 89 00 05 85 11 17 21 0c 00 ff ff ff ff ff 02 08 05 85 11 17 cc cc [CRC]
  // Type 0x89, seq +6, Pico ID appears twice (source AND payload)

  uint8_t packet[24];
  uint8_t seq = 0x00;

  for (int rep = 0; rep < 12; rep++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = 0x89;  // Pico reset type
    packet[1] = seq;
    packet[2] = (source_id >> 24) & 0xFF;
    packet[3] = (source_id >> 16) & 0xFF;
    packet[4] = (source_id >> 8) & 0xFF;
    packet[5] = source_id & 0xFF;
    packet[6] = 0x21;
    packet[7] = 0x0C;
    packet[8] = 0x00;
    packet[9] = 0xFF;
    packet[10] = 0xFF;
    packet[11] = 0xFF;
    packet[12] = 0xFF;
    packet[13] = 0xFF;
    packet[14] = 0x02;
    packet[15] = 0x08;
    // Same Pico ID again in payload
    packet[16] = (source_id >> 24) & 0xFF;
    packet[17] = (source_id >> 16) & 0xFF;
    packet[18] = (source_id >> 8) & 0xFF;
    packet[19] = source_id & 0xFF;

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);
    seq = (seq + 6) & 0xFF;  // +6 like captured
    if (rep < 11) delay(75);  // ~75ms between packets
  }

  ESP_LOGI(TAG, "=== RESET COMPLETE (12 packets) ===");
}

void LutronCC1101::send_bridge_unpair(uint32_t bridge_zone_id, uint32_t target_device_id) {
  // Call the two-zone version with alternate zone = 0 (disabled)
  send_bridge_unpair_dual(bridge_zone_id, 0, target_device_id);
}

void LutronCC1101::send_bridge_unpair_dual(uint32_t zone_id_1, uint32_t zone_id_2, uint32_t target_device_id) {
  ESP_LOGI(TAG, "=== BRIDGE UNPAIR ===");
  ESP_LOGI(TAG, "Zone 1: %08X, Zone 2: %08X, Target: %08X", zone_id_1, zone_id_2, target_device_id);

  // Real bridge unpair sequence has TWO phases:
  // Phase 1: Format 0x09 / cmd 02 02 - "prepare" packets to specific device
  // Phase 2: Format 0x0C / cmd 02 08 - actual unpair flood with broadcast
  //
  // Phase 1 packet structure (format 0x09):
  // 81 01 AD 90 2C 00 21 09 00 07 01 6F CE FE 02 02 00 CC CC CC CC CC [CRC]
  //       ^^^^^^^^^^^    ^^    ^^^^^^^^^^^    ^^^^^
  //       Zone (LE)      09    Device (BE)    02 02

  uint8_t packet[24];
  bool use_dual = (zone_id_2 != 0);
  uint32_t zones[2] = {zone_id_1, use_dual ? zone_id_2 : zone_id_1};

  // ========== PHASE 1: Format 0x09 / cmd 02 02 packets ==========
  ESP_LOGI(TAG, "Phase 1: Sending prepare packets (format 0x09)");

  uint8_t seq = 0x01;
  for (int i = 0; i < 4; i++) {
    uint32_t zone = zones[i % 2];

    memset(packet, 0xCC, sizeof(packet));
    packet[0] = 0x81 + (i % 3);
    packet[1] = seq;
    // Zone ID little-endian at [2-5]
    packet[2] = zone & 0xFF;
    packet[3] = (zone >> 8) & 0xFF;
    packet[4] = (zone >> 16) & 0xFF;
    packet[5] = (zone >> 24) & 0xFF;
    packet[6] = 0x21;
    packet[7] = 0x09;  // Format 0x09 (prepare/query)
    packet[8] = 0x00;
    // Target device ID big-endian at [9-12]
    packet[9] = (target_device_id >> 24) & 0xFF;
    packet[10] = (target_device_id >> 16) & 0xFF;
    packet[11] = (target_device_id >> 8) & 0xFF;
    packet[12] = target_device_id & 0xFF;
    packet[13] = 0xFE;  // Value seen in captures
    packet[14] = 0x02;
    packet[15] = 0x02;  // Command 02 02
    packet[16] = 0x00;
    // [17-21] = CC padding (already set)

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);
    seq = (seq + 12 + (i % 2) * 6) & 0xFF;  // Sequence pattern from capture
    delay(100);
  }

  // Gap between phases (~1 second like real bridge)
  delay(800);

  // ========== PHASE 2: Format 0x0C / cmd 02 08 packets ==========
  ESP_LOGI(TAG, "Phase 2: Sending unpair packets (format 0x0C)");

  // 3 full bursts like the real bridge
  for (int burst = 0; burst < 3; burst++) {
    // First packet of burst from zone 1
    {
      memset(packet, 0xCC, sizeof(packet));
      packet[0] = 0x82;
      packet[1] = 0x01;
      packet[2] = zone_id_1 & 0xFF;
      packet[3] = (zone_id_1 >> 8) & 0xFF;
      packet[4] = (zone_id_1 >> 16) & 0xFF;
      packet[5] = (zone_id_1 >> 24) & 0xFF;
      packet[6] = 0x21;
      packet[7] = 0x0C;  // Format 0x0C (unpair)
      packet[8] = 0x00;
      // Broadcast at [9-13]
      packet[9] = 0xFF; packet[10] = 0xFF; packet[11] = 0xFF;
      packet[12] = 0xFF; packet[13] = 0xFF;
      packet[14] = 0x02;
      packet[15] = 0x08;  // Command 02 08 (unpair)
      // Target device ID big-endian at [16-19]
      packet[16] = (target_device_id >> 24) & 0xFF;
      packet[17] = (target_device_id >> 16) & 0xFF;
      packet[18] = (target_device_id >> 8) & 0xFF;
      packet[19] = target_device_id & 0xFF;

      uint16_t crc = this->encoder_.calc_crc(packet, 22);
      packet[22] = (crc >> 8) & 0xFF;
      packet[23] = crc & 0xFF;
      this->transmit_packet(packet, 24);
      delay(60);
    }

    // Then ~10 packets from zone 2 (or zone 1 if no zone 2)
    uint32_t zone = use_dual ? zone_id_2 : zone_id_1;
    seq = 7 + burst;

    for (int i = 0; i < 10; i++) {
      memset(packet, 0xCC, sizeof(packet));
      packet[0] = 0x82;
      packet[1] = seq;
      packet[2] = zone & 0xFF;
      packet[3] = (zone >> 8) & 0xFF;
      packet[4] = (zone >> 16) & 0xFF;
      packet[5] = (zone >> 24) & 0xFF;
      packet[6] = 0x21;
      packet[7] = 0x0C;
      packet[8] = 0x00;
      packet[9] = 0xFF; packet[10] = 0xFF; packet[11] = 0xFF;
      packet[12] = 0xFF; packet[13] = 0xFF;
      packet[14] = 0x02;
      packet[15] = 0x08;
      packet[16] = (target_device_id >> 24) & 0xFF;
      packet[17] = (target_device_id >> 16) & 0xFF;
      packet[18] = (target_device_id >> 8) & 0xFF;
      packet[19] = target_device_id & 0xFF;

      uint16_t crc = this->encoder_.calc_crc(packet, 22);
      packet[22] = (crc >> 8) & 0xFF;
      packet[23] = crc & 0xFF;
      this->transmit_packet(packet, 24);

      seq = (seq + 5 + (i % 2)) & 0xFF;
      delay(60);
    }
  }

  ESP_LOGI(TAG, "=== BRIDGE UNPAIR COMPLETE ===");
}

// ========== BRIDGE PAIRING (based on real RadioRA3 captures) ==========

void LutronCC1101::start_bridge_pairing(uint16_t subnet) {
  ESP_LOGI(TAG, "=== START BRIDGE PAIRING MODE ===");
  ESP_LOGI(TAG, "Subnet: 0x%04X", subnet);

  // Set up continuous beaconing - loop() handles the rest
  this->pairing_active_ = true;
  this->pairing_subnet_ = subnet;
  this->pairing_seq_ = 1;
  this->last_pairing_beacon_ = 0;  // Force immediate first beacon

  ESP_LOGI(TAG, "Continuous pairing beacons started. Devices should flash.");
  ESP_LOGI(TAG, ">>> HOLD OFF BUTTON ON DEVICE FOR 10 SECONDS <<<");
}

void LutronCC1101::stop_bridge_pairing(uint16_t subnet) {
  ESP_LOGI(TAG, "=== STOP BRIDGE PAIRING MODE ===");

  this->pairing_active_ = false;

  // Send stop beacon burst
  // Real bridge: 92 XX AF 90 2C 00 21 0C 00 FF FF FF FF FF 08 04 90 2C 1A 04 CC CC [crc]
  // Note: byte[15] = 0x04 (stop) instead of 0x02 (active)
  uint8_t packet[24];
  uint8_t seq = 1;

  for (int i = 0; i < 10; i++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = 0x92;
    packet[1] = seq;

    packet[2] = (i % 2 == 0) ? 0xAF : 0xAD;
    packet[3] = subnet & 0xFF;
    packet[4] = (subnet >> 8) & 0xFF;
    packet[5] = 0x00;

    packet[6] = 0x21;
    packet[7] = 0x0C;
    packet[8] = 0x00;

    packet[9] = 0xFF;
    packet[10] = 0xFF;
    packet[11] = 0xFF;
    packet[12] = 0xFF;
    packet[13] = 0xFF;

    packet[14] = 0x08;
    packet[15] = 0x04;  // Mode: 0x04 = STOP pairing

    packet[16] = subnet & 0xFF;
    packet[17] = (subnet >> 8) & 0xFF;
    packet[18] = 0x1A;
    packet[19] = 0x04;

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);

    seq = (seq + 6) & 0xFF;
    delay(70);
  }

  ESP_LOGI(TAG, "Stop beacons sent. Devices should stop flashing.");
}

void LutronCC1101::send_pair_assignment(uint16_t subnet, uint32_t factory_id, uint8_t zone_suffix) {
  ESP_LOGI(TAG, "=== SEND PAIR ASSIGNMENT (B0) ===");
  ESP_LOGI(TAG, "Subnet: 0x%04X, Factory ID: 0x%08X, Zone: 0x06%04X%02X",
           subnet, factory_id, subnet, zone_suffix);

  // Real bridge captures:
  // Switch (DVRF-5NS): B0 XX A2 90 2C 7F 21 17 00 FF..FF 08 05 07 07 DF 6A 04 64 01 01 FF 00 00 01 03 15 00
  // Dimmer (DVRF-6L):  B0 XX A0 90 2C 7F 21 17 00 FF..FF 08 05 07 03 C3 C6 04 63 02 01 FF 00 00 01 03 15 00
  // Key differences: byte 21-22 = 0x64/0x01 for switch, 0x63/0x02 for dimmer

  uint8_t packet[48];
  uint8_t seq = 0;

  // Zone prefixes used by real bridge (alternating)
  static const uint8_t zone_prefixes[] = {0xA0, 0xA2, 0xAF};

  for (int i = 0; i < 30; i++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = 0xB0;  // Pairing assignment type
    packet[1] = seq;

    // Zone ID: Use alternating prefixes like real bridge (A0, A2, AF)
    // Real bridge: A0 90 2C 7F, A2 90 2C 7F, AF 90 2C 7F
    packet[2] = zone_prefixes[i % 3];
    packet[3] = subnet & 0xFF;          // Subnet low byte
    packet[4] = (subnet >> 8) & 0xFF;   // Subnet high byte
    packet[5] = 0x7F;  // Special pairing suffix (always 7F in captures)

    packet[6] = 0x21;
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

    // Factory ID (big-endian, as printed on device label)
    packet[16] = (factory_id >> 24) & 0xFF;
    packet[17] = (factory_id >> 16) & 0xFF;
    packet[18] = (factory_id >> 8) & 0xFF;
    packet[19] = factory_id & 0xFF;

    // Device type/configuration
    // Dimmer (DVRF-6L): 0x63, 0x02
    // Switch (DVRF-5NS): 0x64, 0x01
    // Default to dimmer since it's more common
    packet[20] = 0x04;
    packet[21] = 0x63;  // Dimmer type
    packet[22] = 0x02;  // Dimmer config
    packet[23] = 0x01;
    packet[24] = 0xFF;
    packet[25] = 0x00;
    packet[26] = 0x00;
    packet[27] = 0x01;
    packet[28] = 0x03;
    packet[29] = 0x15;
    packet[30] = 0x00;

    // CRC at 31-32 (for 31-byte payload)
    uint16_t crc = this->encoder_.calc_crc(packet, 31);
    packet[31] = (crc >> 8) & 0xFF;
    packet[32] = crc & 0xFF;

    this->transmit_packet(packet, 33);

    seq = (seq + 4) & 0xFF;
    delay(50);
  }

  ESP_LOGI(TAG, "Pair assignment packets sent.");
}

void LutronCC1101::pair_device(uint16_t subnet, uint32_t factory_id, uint8_t zone_suffix) {
  ESP_LOGI(TAG, "=== COMPLETE BRIDGE PAIRING SEQUENCE ===");
  ESP_LOGI(TAG, "Subnet: 0x%04X, Factory: 0x%08X, Zone suffix: 0x%02X",
           subnet, factory_id, zone_suffix);

  // Step 1: Send active pairing beacons
  ESP_LOGI(TAG, "Step 1: Sending active pairing beacons...");
  this->start_bridge_pairing(subnet);

  // Step 2: Brief pause for device to respond
  delay(500);

  // Step 3: Send B0 assignment packets
  ESP_LOGI(TAG, "Step 2: Sending B0 pairing assignment packets...");
  this->send_pair_assignment(subnet, factory_id, zone_suffix);

  // Step 4: Send stop beacons
  ESP_LOGI(TAG, "Step 3: Sending stop beacons...");
  this->stop_bridge_pairing(subnet);

  ESP_LOGI(TAG, "=== PAIRING SEQUENCE COMPLETE ===");
  ESP_LOGI(TAG, "Device 0x%08X should now respond to zone 0x06%04X%02X",
           factory_id, subnet, zone_suffix);
}

}  // namespace lutron_cc1101
}  // namespace esphome
