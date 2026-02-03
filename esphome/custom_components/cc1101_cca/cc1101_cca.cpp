#include "cc1101_cca.h"
#include "esphome/core/log.h"

namespace esphome {
namespace cc1101_cca {

static const char *const TAG = "lutron_cc1101";

void CC1101CCA::setup() {
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

  // Set up TX callback for pairing packets (route through main TX callbacks)
  this->pairing_->set_tx_callback([this](const std::vector<uint8_t> &data) {
    for (auto &callback : this->on_tx_callbacks_) {
      callback(data);
    }
  });

  // Auto-start RX mode if enabled (default: on)
  if (this->rx_auto_) {
    ESP_LOGV(TAG, "Auto-starting RX mode...");
    this->start_rx();
  }

  ESP_LOGV(TAG, "Lutron CC1101 ready");
}

// Echo detection moved to backend - ESP32 just streams all valid packets

void CC1101CCA::handle_rx_packet(const uint8_t *data, size_t len, int8_t rssi) {
  // Filter out noise - real Lutron packets have RSSI > -70 typically
  // Noise floor is around -80 to -95
  if (rssi < -70) {
    return;  // Silently ignore noise
  }

  // Try to decode the packet (N81 decoding only)
  DecodedPacket pkt;
  if (!this->decoder_.decode(data, len, pkt)) {
    return;  // Silently ignore undecoded packets
  }

  // Auto-accept Vive pairing requests when in pairing mode
  // Device sends B9 with format=0x23 (byte 7), command=0x02 (byte 15)
  // Device ID is in bytes 2-5 (big-endian)
  if (this->vive_pairing_active_ && pkt.raw_len >= 16) {
    uint8_t pkt_type = pkt.raw[0];
    uint8_t format = pkt.raw[7];
    uint8_t command = pkt.raw[15];

    // B9 with format=0x23 is a device pairing request (not 0x11 which is beacon)
    // B8 is also a pairing request type
    if ((pkt_type == 0xB9 && format == 0x23 && command == 0x02) ||
        (pkt_type == 0xB8)) {
      // Extract device ID from bytes 2-5 (big-endian)
      uint32_t device_id = ((uint32_t)pkt.raw[2] << 24) |
                           ((uint32_t)pkt.raw[3] << 16) |
                           ((uint32_t)pkt.raw[4] << 8) |
                           (uint32_t)pkt.raw[5];

      ESP_LOGI(TAG, "=== VIVE PAIRING REQUEST DETECTED ===");
      ESP_LOGI(TAG, "Device 0x%08X requesting to pair (type=0x%02X, format=0x%02X)",
               device_id, pkt_type, format);

      // Auto-accept the device
      this->send_vive_accept(this->vive_hub_id_, device_id);
    }
  }

  // Call registered callbacks (for UDP streaming)
  // Backend handles all logging and packet processing
  ESP_LOGD(TAG, "RX packet len=%d rssi=%d callbacks=%d", pkt.raw_len, rssi, this->on_packet_callbacks_.size());
  if (!this->on_packet_callbacks_.empty()) {
    std::vector<uint8_t> packet_data(pkt.raw, pkt.raw + pkt.raw_len);
    for (auto &callback : this->on_packet_callbacks_) {
      callback(packet_data, rssi);
    }
  }
}

void CC1101CCA::dump_config() {
  ESP_LOGCONFIG(TAG, "Lutron CC1101:");
  ESP_LOGCONFIG(TAG, "  Status: %s", this->radio_.is_initialized() ? "OK" : "FAILED");
  ESP_LOGCONFIG(TAG, "  RX Enabled: %s", this->rx_enabled_ ? "YES" : "NO");
  ESP_LOGCONFIG(TAG, "  RX Auto: %s", this->rx_auto_ ? "YES" : "NO");
}

void CC1101CCA::loop() {
  // Only poll RX when enabled - poll every iteration to keep up with data rate
  if (this->rx_enabled_) {
    this->radio_.check_rx();
  }

  // Continuous pairing beacon transmission with RX gaps
  if (this->pairing_active_) {
    uint32_t now = millis();

    // RX gap: after every 8 beacons, pause for 200ms to listen for B0 discovery
    if (this->pairing_beacon_count_ >= 8) {
      if (now - this->last_pairing_beacon_ >= 200) {  // 200ms RX gap
        this->pairing_beacon_count_ = 0;  // Reset counter, resume beaconing
        ESP_LOGD(TAG, "RX gap complete, resuming beacons");
      }
      // During RX gap, just poll RX (already done above)
      return;
    }

    if (now - this->last_pairing_beacon_ >= 65) {  // ~65ms interval like working beacon
      this->last_pairing_beacon_ = now;
      this->pairing_beacon_count_++;

      // Construct device ID from subnet for send_beacon_single
      // For subnet 0x2C90, we want packet bytes: AF 90 2C 00
      // Real bridge capture shows: 92 XX AD/AF 90 2C 00 21 0C 00...
      // Alternate between AF and AD zone suffixes
      uint8_t zone_suffix = (this->pairing_seq_ % 2 == 0) ? 0xAF : 0xAD;
      uint32_t device_id = ((uint32_t)zone_suffix << 24) |
                           ((this->pairing_subnet_ & 0xFF) << 16) |
                           ((this->pairing_subnet_ >> 8) << 8) |
                           0x00;  // Byte 5 is 0x00 in real bridge captures

      // Send beacon with current type, then cycle: 0x93 -> 0x91 -> 0x92 -> repeat
      this->pairing_seq_ = this->send_beacon_single(device_id, this->pairing_seq_, this->pairing_beacon_type_);

      // Cycle to next beacon type
      if (this->pairing_beacon_type_ == 0x93) {
        this->pairing_beacon_type_ = 0x91;
      } else if (this->pairing_beacon_type_ == 0x91) {
        this->pairing_beacon_type_ = 0x92;
      } else {
        this->pairing_beacon_type_ = 0x93;  // Back to initial
      }
    }
  }

  // Vive pairing: send beacon bursts every ~30 seconds
  if (this->vive_pairing_active_) {
    uint32_t now = millis();
    // 30 second interval between bursts (Vive doesn't beacon continuously)
    if (now - this->vive_last_burst_ >= 30000) {
      ESP_LOGI(TAG, "Vive pairing: sending periodic beacon burst");
      this->send_vive_beacon_burst(this->vive_hub_id_, false);
      this->vive_last_burst_ = now;
    }
  }
}

void CC1101CCA::start_rx() {
  ESP_LOGI(TAG, "=== STARTING RX MODE ===");
  this->radio_.start_rx();
  this->rx_enabled_ = true;
  this->rx_auto_ = true;  // Re-enable auto-resume when manually started
  this->last_rx_check_ = millis();
}

void CC1101CCA::stop_rx() {
  ESP_LOGI(TAG, "=== STOPPING RX MODE ===");
  this->radio_.stop_rx();
  this->rx_enabled_ = false;
  this->rx_auto_ = false;  // Disable auto-resume when manually stopped
}

void CC1101CCA::transmit_packet(const uint8_t *packet, size_t len) {
  // TX logging handled by backend - it knows what it's sending
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

  this->radio_.transmit_raw(tx_buffer, encoded_len);

  // Notify TX callbacks (for UDP streaming)
  if (!this->on_tx_callbacks_.empty()) {
    std::vector<uint8_t> packet_data(packet, packet + len);
    for (auto &callback : this->on_tx_callbacks_) {
      callback(packet_data);
    }
  }

  // Auto-resume RX after TX if auto mode enabled
  // (transmit_raw leaves radio in IDLE, we need to restart RX)
  if (this->rx_auto_) {
    this->radio_.start_rx();
    this->rx_enabled_ = true;
  }
}

void CC1101CCA::send_button_press(uint32_t device_id, uint8_t button) {
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

void CC1101CCA::send_save_favorite(uint32_t device_id, uint8_t button, int hold_seconds) {
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

void CC1101CCA::send_level(uint32_t device_id, uint8_t level_percent) {
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

void CC1101CCA::send_bridge_level(uint32_t bridge_zone_id, uint32_t target_device_id, uint8_t level_percent) {
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

void CC1101CCA::send_pairing_b9(uint32_t device_id) {
  if (this->pairing_ != nullptr) {
    this->pairing_->send_pairing_b9(device_id, 5);
  }
}

void CC1101CCA::send_pairing_pico(uint32_t device_id, int duration_seconds) {
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

void CC1101CCA::send_beacon(uint32_t device_id, uint8_t beacon_type, int duration_seconds) {
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

uint8_t CC1101CCA::send_beacon_single(uint32_t device_id, uint8_t seq, uint8_t beacon_type) {
  uint8_t packet[24];
  memset(packet, 0xCC, sizeof(packet));

  // Beacon type: 0x93=initial, 0x91=active, 0x92=continue
  packet[0] = beacon_type;
  packet[1] = seq;

  // Device ID (zone ID) - big-endian
  packet[2] = (device_id >> 24) & 0xFF;
  packet[3] = (device_id >> 16) & 0xFF;
  packet[4] = (device_id >> 8) & 0xFF;
  packet[5] = device_id & 0xFF;

  packet[6] = 0x21;  // Protocol marker

  // Format and mode bytes differ by beacon type:
  // 0x93 (initial): format=0x08, mode=0x01
  // 0x91 (active):  format=0x0C, mode=0x02
  // 0x92 (continue): format=0x0C, mode=0x02
  if (beacon_type == 0x93) {
    packet[7] = 0x08;  // Initial beacon format
  } else {
    packet[7] = 0x0C;  // Active beacon format (0x91, 0x92)
  }
  packet[8] = 0x00;

  // Broadcast address
  packet[9] = 0xFF;
  packet[10] = 0xFF;
  packet[11] = 0xFF;
  packet[12] = 0xFF;
  packet[13] = 0xFF;

  packet[14] = 0x08;

  // Mode byte differs by beacon type
  if (beacon_type == 0x93) {
    packet[15] = 0x01;  // Initial mode
  } else {
    packet[15] = 0x02;  // Active mode (0x91, 0x92)
  }

  // Additional zone info for 0x91/0x92 beacons
  if (beacon_type != 0x93) {
    packet[16] = (device_id >> 16) & 0xFF;  // Subnet low byte
    packet[17] = (device_id >> 8) & 0xFF;   // Subnet high byte
    packet[18] = 0x1A;
    packet[19] = 0x04;
  }
  // 0x93 leaves bytes 16-21 as 0xCC (padding)

  // Calculate CRC
  uint16_t crc = this->encoder_.calc_crc(packet, 22);
  packet[22] = (crc >> 8) & 0xFF;
  packet[23] = crc & 0xFF;

  // Transmit
  this->transmit_packet(packet, 24);

  // Return next sequence
  return (seq + 5) & 0xFF;
}

void CC1101CCA::send_pairing_b0(uint32_t load_id, uint32_t target_factory_id) {
  ESP_LOGI(TAG, "=== SENDING 0xB0 PAIRING ASSIGNMENT ===");
  ESP_LOGI(TAG, "Load ID: 0x%08X, Target: 0x%08X", load_id, target_factory_id);

  // Real bridge B0 packet is 31 bytes + 2 CRC = 33 bytes total
  // B0 02 A2 90 2C 7F 21 17 00 FF FF FF FF FF 08 05 07 07 DF 6A 04 63 02 01 FF 00 00 01 03 15 00 [CRC CRC]
  uint8_t packet[33];
  uint8_t seq = 0;  // Start at 0 like real bridge

  // Zone prefix rotation: A0 -> A2 -> AF (then stays AF)
  static const uint8_t zone_prefixes[] = {0xA0, 0xA2, 0xAF};
  int prefix_idx = 0;

  // Send multiple copies like real bridge does
  for (int rep = 0; rep < 30; rep++) {
    memset(packet, 0x00, sizeof(packet));

    // Real bridge B0 structure (31 bytes before CRC):
    // [0] B0 - packet type
    // [1] seq
    // [2] A0/A2/AF - zone prefix (rotates)
    // [3-4] subnet (little-endian)
    // [5] 7F - special suffix
    // [6] 21 - protocol marker
    // [7] 17 - pairing format
    // [8] 00
    // [9-13] FF FF FF FF FF - broadcast
    // [14] 08
    // [15] 05
    // [16-19] factory ID (big-endian)
    // [20] 04
    // [21] 63 (dimmer) or 64 (switch) - device type
    // [22] 02 (dimmer) or 01 (switch) - device subtype
    // [23] 01
    // [24] FF
    // [25-26] 00 00
    // [27] 01
    // [28] 03
    // [29] 15
    // [30] 00

    packet[0] = 0xB0;  // Pairing assignment type (B0, NOT B1!)
    packet[1] = seq;

    // Zone prefix with rotation
    packet[2] = zone_prefixes[prefix_idx];
    if (prefix_idx < 2) prefix_idx++;  // A0 -> A2 -> AF (stay on AF)

    // Subnet from load_id (bytes 3-4)
    packet[3] = (load_id >> 16) & 0xFF;  // Subnet low
    packet[4] = (load_id >> 8) & 0xFF;   // Subnet high
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

    // Target factory ID (big-endian)
    packet[16] = (target_factory_id >> 24) & 0xFF;
    packet[17] = (target_factory_id >> 16) & 0xFF;
    packet[18] = (target_factory_id >> 8) & 0xFF;
    packet[19] = target_factory_id & 0xFF;

    // Device type info
    packet[20] = 0x04;
    packet[21] = 0x63;  // Dimmer type (use 0x64 for switch)
    packet[22] = 0x02;  // Dimmer subtype (use 0x01 for switch)

    // Critical trailer bytes (from real bridge capture)
    packet[23] = 0x01;
    packet[24] = 0xFF;
    packet[25] = 0x00;
    packet[26] = 0x00;
    packet[27] = 0x01;
    packet[28] = 0x03;
    packet[29] = 0x15;
    packet[30] = 0x00;

    // Calculate CRC over 31 bytes
    uint16_t crc = this->encoder_.calc_crc(packet, 31);
    packet[31] = (crc >> 8) & 0xFF;
    packet[32] = crc & 0xFF;

    this->transmit_packet(packet, 33);

    // Increment sequence by 2 (real bridge pattern: 00, 02, 06, 08, 0C...)
    seq = (seq + 2) & 0xFF;
    if (rep % 2 == 1) seq = (seq + 2) & 0xFF;  // Extra +2 every other packet

    delay(50);  // ~50ms between packets
  }

  ESP_LOGI(TAG, "=== 0xB0 PAIRING COMPLETE ===");
}

void CC1101CCA::send_bridge_pair_sequence(uint32_t bridge_id, uint32_t target_factory_id,
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

void CC1101CCA::send_state_report(uint32_t device_id, uint8_t level_percent) {
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

void CC1101CCA::send_pairing_5button(uint32_t device_id, int duration_seconds) {
  if (this->pairing_) {
    this->pairing_->send_pairing_5button(device_id, duration_seconds);
  }
}

void CC1101CCA::send_pairing_advanced(uint32_t device_id, int duration_seconds,
                                          uint8_t pkt_type_a, uint8_t pkt_type_b,
                                          uint8_t byte10, uint8_t byte30, uint8_t byte31,
                                          uint8_t byte37, uint8_t byte38) {
  if (this->pairing_) {
    this->pairing_->send_pairing_advanced(device_id, duration_seconds,
                                           pkt_type_a, pkt_type_b,
                                           byte10, byte30, byte31, byte37, byte38);
  }
}

void CC1101CCA::send_reset(uint32_t source_id, uint32_t paired_id) {
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

// ========== DEVICE CONFIGURATION (from CCA Playground captures) ==========

void CC1101CCA::send_led_config(uint32_t bridge_zone_id, uint32_t target_device_id, uint8_t mode) {
  ESP_LOGI(TAG, "=== LED CONFIG ===");
  ESP_LOGI(TAG, "Bridge: %08X, Target: %08X, Mode: %d", bridge_zone_id, target_device_id, mode);

  // LED modes from capture analysis:
  // Mode 0 (Both Off):       Type A3, byte[23]=0x00
  // Mode 1 (Both On):        Type A1, byte[23]=0xFF
  // Mode 2 (On when load on): Type A2, byte[23]=0xFF
  // Mode 3 (On when load off): Type A3, byte[23]=0x00
  // Note: Modes 0 and 3 have same wire encoding but different semantic meaning

  uint8_t type_byte;
  uint8_t led_value;
  switch (mode) {
    case 0:  // Both Off
      type_byte = 0xA3;
      led_value = 0x00;
      break;
    case 1:  // Both On
      type_byte = 0xA1;
      led_value = 0xFF;
      break;
    case 2:  // On when load on
      type_byte = 0xA2;
      led_value = 0xFF;
      break;
    case 3:  // On when load off
    default:
      type_byte = 0xA3;
      led_value = 0x00;
      break;
  }

  // Captured packet structure (format 0x11):
  // A1 01 AD 90 2C 00 21 11 00 06 FE 80 06 FE 06 50 00 04 06 00 00 00 00 FF
  // [0]     Type (A1/A2/A3)
  // [1]     Sequence
  // [2-5]   Bridge zone ID (little-endian)
  // [6]     0x21 protocol marker
  // [7]     0x11 format (LED config)
  // [8]     0x00
  // [9-12]  Target device ID (big-endian)
  // [13]    0xFE (part of target? or separator)
  // [14-22] Static bytes from capture
  // [23]    LED value (0x00 or 0xFF)

  uint8_t packet[24];
  uint8_t seq = 0x01;

  // Send ~20 packets like bridge does
  for (int rep = 0; rep < 20; rep++) {
    memset(packet, 0x00, sizeof(packet));

    packet[0] = type_byte;
    packet[1] = seq;

    // Bridge zone ID little-endian
    packet[2] = bridge_zone_id & 0xFF;
    packet[3] = (bridge_zone_id >> 8) & 0xFF;
    packet[4] = (bridge_zone_id >> 16) & 0xFF;
    packet[5] = (bridge_zone_id >> 24) & 0xFF;

    packet[6] = 0x21;
    packet[7] = 0x11;  // LED config format
    packet[8] = 0x00;

    // Target device ID big-endian
    packet[9] = (target_device_id >> 24) & 0xFF;
    packet[10] = (target_device_id >> 16) & 0xFF;
    packet[11] = (target_device_id >> 8) & 0xFF;
    packet[12] = target_device_id & 0xFF;

    // Static bytes from capture (06 FE 06 50 00 04 06 00 00 00 00)
    packet[13] = 0xFE;
    packet[14] = 0x06;
    packet[15] = 0x50;
    packet[16] = 0x00;
    packet[17] = 0x04;
    packet[18] = 0x06;
    packet[19] = 0x00;
    packet[20] = 0x00;
    packet[21] = 0x00;

    // CRC placeholder (will be overwritten)
    // Note: Config packets don't seem to use standard CRC
    // Real bridge packets have crc_ok=false but devices still respond
    packet[22] = 0x00;

    // LED value
    packet[23] = led_value;

    this->transmit_packet(packet, 24);

    seq = (seq + 6) & 0xFF;
    if (rep < 19) delay(60);
  }

  ESP_LOGI(TAG, "=== LED CONFIG COMPLETE ===");
}

void CC1101CCA::send_fade_config(uint32_t bridge_zone_id, uint32_t target_device_id,
                                     uint8_t fade_on_qs, uint8_t fade_off_qs) {
  ESP_LOGI(TAG, "=== FADE CONFIG ===");
  ESP_LOGI(TAG, "Bridge: %08X, Target: %08X, FadeOn: %d qs (%.2fs), FadeOff: %d qs (%.2fs)",
           bridge_zone_id, target_device_id,
           fade_on_qs, fade_on_qs / 4.0f,
           fade_off_qs, fade_off_qs / 4.0f);

  // Captured packet structure (format 0x1C):
  // A1 01 AD 90 2C 00 21 1C 00 06 FE 80 06 FE 06 50 00 03 11 80 FF 31 00 3C
  // [0]     Type (A1/A2/A3 rotating)
  // [1]     Sequence
  // [2-5]   Bridge zone ID (little-endian)
  // [6]     0x21 protocol marker
  // [7]     0x1C format (Fade config)
  // [8]     0x00
  // [9-12]  Target device ID (big-endian)
  // [13-22] Static bytes
  // [23]    Fade-on value (quarter-seconds)
  // [24]    Fade-off value (quarter-seconds) - packet extends to 25 bytes

  uint8_t packet[26];  // 24 data + 2 for extended fade bytes
  uint8_t seq = 0x01;

  for (int rep = 0; rep < 20; rep++) {
    memset(packet, 0x00, sizeof(packet));

    // Rotate through A1, A2, A3
    packet[0] = 0xA1 + (rep % 3);
    packet[1] = seq;

    // Bridge zone ID little-endian
    packet[2] = bridge_zone_id & 0xFF;
    packet[3] = (bridge_zone_id >> 8) & 0xFF;
    packet[4] = (bridge_zone_id >> 16) & 0xFF;
    packet[5] = (bridge_zone_id >> 24) & 0xFF;

    packet[6] = 0x21;
    packet[7] = 0x1C;  // Fade config format
    packet[8] = 0x00;

    // Target device ID big-endian
    packet[9] = (target_device_id >> 24) & 0xFF;
    packet[10] = (target_device_id >> 16) & 0xFF;
    packet[11] = (target_device_id >> 8) & 0xFF;
    packet[12] = target_device_id & 0xFF;

    // Static bytes from capture (FE 06 50 00 03 11 80 FF 31 00)
    packet[13] = 0xFE;
    packet[14] = 0x06;
    packet[15] = 0x50;
    packet[16] = 0x00;
    packet[17] = 0x03;
    packet[18] = 0x11;
    packet[19] = 0x80;
    packet[20] = 0xFF;
    packet[21] = 0x31;
    packet[22] = 0x00;

    // Fade values
    packet[23] = fade_on_qs;
    packet[24] = fade_off_qs;

    // Note: Using 25 bytes - CRC not appended as config packets don't use standard CRC
    this->transmit_packet(packet, 25);

    seq = (seq + 6) & 0xFF;
    if (rep < 19) delay(60);
  }

  ESP_LOGI(TAG, "=== FADE CONFIG COMPLETE ===");
}

void CC1101CCA::send_device_state(uint32_t bridge_zone_id, uint32_t target_device_id,
                                      uint8_t high_trim, uint8_t low_trim, bool phase_reverse) {
  ESP_LOGI(TAG, "=== DEVICE STATE CONFIG ===");
  ESP_LOGI(TAG, "Bridge: %08X, Target: %08X", bridge_zone_id, target_device_id);
  ESP_LOGI(TAG, "HighTrim: %d%%, LowTrim: %d%%, Phase: %s",
           high_trim, low_trim, phase_reverse ? "Reverse" : "Forward");

  // Convert percentages to byte values (% * 254 / 100)
  uint8_t high_byte = (high_trim >= 100) ? 0xFE : (uint8_t)((uint32_t)high_trim * 254 / 100);
  uint8_t low_byte = (low_trim >= 100) ? 0xFE : (uint8_t)((uint32_t)low_trim * 254 / 100);

  // Phase encoding: Forward = 0x03, Reverse = 0x23 (bit 5 set)
  uint8_t phase_byte = phase_reverse ? 0x23 : 0x03;

  // Captured packet structure (format 0x15 / STATE_RPT):
  // A3 01 AD 90 2C 00 21 15 00 06 FE 80 06 FE 06 50 00 02 08 13 FE 03 03 0B
  // [0]     Type (A1/A2/A3 rotating)
  // [1]     Sequence
  // [2-5]   Bridge zone ID (little-endian)
  // [6]     0x21 protocol marker
  // [7]     0x15 format (STATE_RPT / device state)
  // [8]     0x00
  // [9-12]  Target device ID (big-endian)
  // [13-19] Static bytes
  // [20]    High-end trim value
  // [21]    Low-end trim value
  // [22]    Phase mode (0x03=Forward, 0x23=Reverse)
  // [23]    0x0B (constant)

  uint8_t packet[24];
  uint8_t seq = 0x01;

  for (int rep = 0; rep < 20; rep++) {
    memset(packet, 0x00, sizeof(packet));

    // Rotate through A1, A2, A3
    packet[0] = 0xA1 + (rep % 3);
    packet[1] = seq;

    // Bridge zone ID little-endian
    packet[2] = bridge_zone_id & 0xFF;
    packet[3] = (bridge_zone_id >> 8) & 0xFF;
    packet[4] = (bridge_zone_id >> 16) & 0xFF;
    packet[5] = (bridge_zone_id >> 24) & 0xFF;

    packet[6] = 0x21;
    packet[7] = 0x15;  // STATE_RPT / device state format
    packet[8] = 0x00;

    // Target device ID big-endian
    packet[9] = (target_device_id >> 24) & 0xFF;
    packet[10] = (target_device_id >> 16) & 0xFF;
    packet[11] = (target_device_id >> 8) & 0xFF;
    packet[12] = target_device_id & 0xFF;

    // Static bytes from capture (FE 06 50 00 02 08 13)
    packet[13] = 0xFE;
    packet[14] = 0x06;
    packet[15] = 0x50;
    packet[16] = 0x00;
    packet[17] = 0x02;
    packet[18] = 0x08;
    packet[19] = 0x13;

    // Trim and phase values
    packet[20] = high_byte;
    packet[21] = low_byte;
    packet[22] = phase_byte;
    packet[23] = 0x0B;  // Constant from captures

    this->transmit_packet(packet, 24);

    seq = (seq + 6) & 0xFF;
    if (rep < 19) delay(60);
  }

  ESP_LOGI(TAG, "=== DEVICE STATE CONFIG COMPLETE ===");
}

void CC1101CCA::send_bridge_unpair(uint32_t bridge_zone_id, uint32_t target_device_id) {
  // Call the two-zone version with alternate zone = 0 (disabled)
  send_bridge_unpair_dual(bridge_zone_id, 0, target_device_id);
}

void CC1101CCA::send_bridge_unpair_dual(uint32_t zone_id_1, uint32_t zone_id_2, uint32_t target_device_id) {
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

void CC1101CCA::start_bridge_pairing(uint16_t subnet) {
  ESP_LOGI(TAG, "=== START BRIDGE PAIRING MODE ===");
  ESP_LOGI(TAG, "Subnet: 0x%04X", subnet);
  ESP_LOGI(TAG, "Beacon rotation: 0x93 (initial) -> 0x91 (active) -> 0x92 (continue)");

  // Set up continuous beaconing - loop() handles the rest
  this->pairing_active_ = true;
  this->pairing_subnet_ = subnet;
  this->pairing_seq_ = 1;
  this->pairing_beacon_type_ = 0x93;  // Start with initial beacon
  this->pairing_beacon_count_ = 0;
  this->last_pairing_beacon_ = 0;  // Force immediate first beacon

  ESP_LOGI(TAG, "Continuous pairing beacons started. Devices should flash.");
  ESP_LOGI(TAG, ">>> HOLD OFF BUTTON ON DEVICE FOR 10 SECONDS <<<");
}

void CC1101CCA::stop_bridge_pairing(uint16_t subnet) {
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

    // Poll RX during delay to catch any device responses
    uint32_t delay_start = millis();
    while (millis() - delay_start < 70) {
      this->radio_.check_rx();
      delay(1);
    }
  }

  ESP_LOGI(TAG, "Stop beacons sent. Devices should stop flashing.");
}

// ========== VIVE DEVICE COMMANDS (0x8A/0x8B/0x89 format 0x0e) ==========

void CC1101CCA::send_vive_zone_command(uint32_t hub_id, uint8_t zone_id, bool turn_on) {
  // Vive hub controls devices by ZONE/ROOM, not device ID!
  // Captured from real hub (2026-01-28):
  //
  // ON command (0x8A):
  //   8a [seq] [hub_id:4] 21 0e 00 00 00 00 [zone] ef 40 02 fe ff 00 00 00 00 [crc:2]
  //
  // OFF command (0x8B):
  //   8b [seq] [hub_id:4] 21 0e 00 00 00 00 [zone] ef 40 02 00 00 00 00 00 00 [crc:2]
  //
  // Zone IDs from pairing capture:
  //   0x38 = Room 1 (device 020ae675)
  //   0x47 = Room 2 (device 09626657)
  //   0x4b = Room 3 (device 021ad0c3)

  ESP_LOGI(TAG, "=== VIVE ZONE COMMAND ===");
  ESP_LOGI(TAG, "Hub: 0x%08X, Zone: 0x%02X, Action: %s",
           hub_id, zone_id, turn_on ? "ON" : "OFF");

  uint8_t h0 = (hub_id >> 24) & 0xFF;
  uint8_t h1 = (hub_id >> 16) & 0xFF;
  uint8_t h2 = (hub_id >> 8) & 0xFF;
  uint8_t h3 = hub_id & 0xFF;

  uint8_t packet[24];

  // Send burst of packets with incrementing sequence (like real hub)
  // Real hub uses seq: 01, 07, 0d, 13, 19, 1f, 25, 2b, 31, 37, 3d, 43 (increment by 6)
  static uint8_t vive_cmd_seq = 0x01;

  for (int rep = 0; rep < 12; rep++) {
    memset(packet, 0x00, sizeof(packet));

    packet[0] = turn_on ? 0x8A : 0x8B;  // 0x8A=ON, 0x8B=OFF
    packet[1] = vive_cmd_seq;           // Sequence
    packet[2] = h0;                     // Hub ID
    packet[3] = h1;
    packet[4] = h2;
    packet[5] = h3;
    packet[6] = 0x21;                   // Protocol
    packet[7] = 0x0E;                   // Format = 0x0e (NOT 0x0c!)
    packet[8] = 0x00;
    packet[9] = 0x00;                   // Zeros (not broadcast FF)
    packet[10] = 0x00;
    packet[11] = 0x00;
    packet[12] = zone_id;               // Zone/room ID!
    packet[13] = 0xEF;
    packet[14] = 0x40;
    packet[15] = 0x02;
    if (turn_on) {
      packet[16] = 0xFE;                // ON = fe ff
      packet[17] = 0xFF;
    } else {
      packet[16] = 0x00;                // OFF = 00 00
      packet[17] = 0x00;
    }
    packet[18] = 0x00;
    packet[19] = 0x00;
    packet[20] = 0x00;
    packet[21] = 0x00;

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);

    vive_cmd_seq += 6;  // Increment by 6 like real hub
    if (vive_cmd_seq > 0x43) vive_cmd_seq = 0x01;

    delay(15);  // ~15ms between packets
  }

  ESP_LOGI(TAG, "Vive zone command sent (12 packets)");
}

void CC1101CCA::send_vive_on(uint32_t hub_id, uint8_t zone_id) {
  send_vive_zone_command(hub_id, zone_id, true);
}

void CC1101CCA::send_vive_off(uint32_t hub_id, uint8_t zone_id) {
  send_vive_zone_command(hub_id, zone_id, false);
}

void CC1101CCA::send_vive_raise(uint32_t hub_id, uint8_t zone_id) {
  // Raise command - needs capture verification
  // Hypothesis: same format but different packet type or command bytes
  ESP_LOGI(TAG, "=== VIVE RAISE ===");
  ESP_LOGI(TAG, "Hub: 0x%08X, Zone: 0x%02X", hub_id, zone_id);

  uint8_t h0 = (hub_id >> 24) & 0xFF;
  uint8_t h1 = (hub_id >> 16) & 0xFF;
  uint8_t h2 = (hub_id >> 8) & 0xFF;
  uint8_t h3 = hub_id & 0xFF;

  uint8_t packet[24];
  static uint8_t vive_cmd_seq = 0x01;

  for (int rep = 0; rep < 12; rep++) {
    memset(packet, 0x00, sizeof(packet));

    packet[0] = 0x89;                   // Try 0x89 for raise (BTN_LONG_A)
    packet[1] = vive_cmd_seq;
    packet[2] = h0; packet[3] = h1; packet[4] = h2; packet[5] = h3;
    packet[6] = 0x21;
    packet[7] = 0x0E;
    packet[8] = 0x00;
    packet[9] = 0x00; packet[10] = 0x00; packet[11] = 0x00;
    packet[12] = zone_id;
    packet[13] = 0xEF;
    packet[14] = 0x40;
    packet[15] = 0x02;
    packet[16] = 0xFE;                  // Raise = fe ff (like ON, held)
    packet[17] = 0xFF;
    packet[18] = 0x00; packet[19] = 0x00; packet[20] = 0x00; packet[21] = 0x00;

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);
    vive_cmd_seq += 6;
    if (vive_cmd_seq > 0x43) vive_cmd_seq = 0x01;
    delay(15);
  }
  ESP_LOGI(TAG, "Vive raise sent");
}

void CC1101CCA::send_vive_lower(uint32_t hub_id, uint8_t zone_id) {
  // Lower command - needs capture verification
  ESP_LOGI(TAG, "=== VIVE LOWER ===");
  ESP_LOGI(TAG, "Hub: 0x%08X, Zone: 0x%02X", hub_id, zone_id);

  uint8_t h0 = (hub_id >> 24) & 0xFF;
  uint8_t h1 = (hub_id >> 16) & 0xFF;
  uint8_t h2 = (hub_id >> 8) & 0xFF;
  uint8_t h3 = hub_id & 0xFF;

  uint8_t packet[24];
  static uint8_t vive_cmd_seq = 0x01;

  for (int rep = 0; rep < 12; rep++) {
    memset(packet, 0x00, sizeof(packet));

    packet[0] = 0x89;                   // Try 0x89 for lower too
    packet[1] = vive_cmd_seq;
    packet[2] = h0; packet[3] = h1; packet[4] = h2; packet[5] = h3;
    packet[6] = 0x21;
    packet[7] = 0x0E;
    packet[8] = 0x00;
    packet[9] = 0x00; packet[10] = 0x00; packet[11] = 0x00;
    packet[12] = zone_id;
    packet[13] = 0xEF;
    packet[14] = 0x40;
    packet[15] = 0x02;
    packet[16] = 0x00;                  // Lower = 00 00 (like OFF, held)
    packet[17] = 0x00;
    packet[18] = 0x00; packet[19] = 0x00; packet[20] = 0x00; packet[21] = 0x00;

    uint16_t crc = this->encoder_.calc_crc(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    this->transmit_packet(packet, 24);
    vive_cmd_seq += 6;
    if (vive_cmd_seq > 0x43) vive_cmd_seq = 0x01;
    delay(15);
  }
  ESP_LOGI(TAG, "Vive lower sent");
}

// Legacy functions - keep for compatibility but they use wrong format
void CC1101CCA::send_vive_command(uint32_t hub_id, uint32_t device_id, uint8_t command, uint8_t subcommand) {
  ESP_LOGW(TAG, "send_vive_command is deprecated - use send_vive_zone_command instead");
  // Try to use zone command with device_id as zone (won't work for real device IDs)
  send_vive_zone_command(hub_id, device_id & 0xFF, true);
}

void CC1101CCA::send_vive_toggle(uint32_t hub_id, uint32_t device_id) {
  ESP_LOGW(TAG, "send_vive_toggle is deprecated - use send_vive_on/send_vive_off instead");
  send_vive_zone_command(hub_id, device_id & 0xFF, true);
}

// ========== VIVE PAIRING (0xBA/0xBB beacon protocol) ==========

void CC1101CCA::start_vive_pairing(uint32_t hub_id) {
  ESP_LOGI(TAG, "=== START VIVE PAIRING MODE ===");
  ESP_LOGI(TAG, "Hub ID: 0x%08X", hub_id);
  ESP_LOGI(TAG, "Sending 0xBA beacon bursts every ~30 seconds");
  ESP_LOGI(TAG, ">>> PUT DEVICE IN PAIRING MODE (hold button 5-10s) <<<");

  this->vive_pairing_active_ = true;
  this->vive_hub_id_ = hub_id;
  this->vive_seq_ = 0;
  this->vive_last_burst_ = 0;  // Force immediate first burst

  // Send first burst immediately
  this->send_vive_beacon_burst(hub_id, false);
  this->vive_last_burst_ = millis();

  ESP_LOGI(TAG, "Vive pairing started. Devices in range should flash.");
}

void CC1101CCA::stop_vive_pairing() {
  if (!this->vive_pairing_active_) {
    ESP_LOGW(TAG, "Vive pairing not active");
    return;
  }

  ESP_LOGI(TAG, "=== STOP VIVE PAIRING MODE ===");

  // Send stop beacon burst (0xBB with timer=0x00)
  this->send_vive_beacon_burst(this->vive_hub_id_, true);

  this->vive_pairing_active_ = false;
  this->vive_hub_id_ = 0;

  ESP_LOGI(TAG, "Vive pairing stopped. Devices should exit pairing mode.");
}

void CC1101CCA::send_vive_beacon_burst(uint32_t hub_id, bool is_stop, int count) {
  // Vive beacon packet structure (from real capture 2026-01-27):
  // ba [seq] [hub_id:4] 21 11 00 ff ff ff ff ff 60 00 [hub_id:4] ff ff ff ff [timer] cc...
  //
  // Real Vive hub uses 0xBA for beacon (verified from capture!)
  // 0xBA = Pairing beacon (timer=0x3C = 60 seconds active, 0x00 = exit)
  // Sequence increments by 8, wraps at 0x48 (0, 8, 16, 24, 32, 40, 48, 56, 64, 0...)

  uint8_t pkt_type = 0xBA;  // BA for both enter and exit beacon
  uint8_t timer = is_stop ? 0x00 : 0x3C;  // 0x3C = 60 seconds

  ESP_LOGI(TAG, "Sending 0x%02X burst: hub=0x%08X, timer=0x%02X, count=%d",
           pkt_type, hub_id, timer, count);

  // Extract hub ID bytes (big-endian)
  uint8_t h0 = (hub_id >> 24) & 0xFF;
  uint8_t h1 = (hub_id >> 16) & 0xFF;
  uint8_t h2 = (hub_id >> 8) & 0xFF;
  uint8_t h3 = hub_id & 0xFF;

  // Real Vive packets: b9 [seq] [hub:4] 21 11 00 [bcast:5] 60 00 [hub:4] [bcast:4] [timer] [cc padding...]
  // Try exact match to real capture - 53 bytes like other pairing packets
  uint8_t packet[53];

  for (int i = 0; i < count; i++) {
    memset(packet, 0xCC, sizeof(packet));

    // Packet type - BA for Vive beacon (verified from real hub capture)
    packet[0] = pkt_type;

    // Sequence (increments by 8 for Vive, wraps at 0x48)
    packet[1] = this->vive_seq_;

    // Hub ID (big-endian)
    packet[2] = h0;
    packet[3] = h1;
    packet[4] = h2;
    packet[5] = h3;

    // Protocol and format
    packet[6] = 0x21;   // Protocol version
    packet[7] = 0x11;   // Pairing mode format
    packet[8] = 0x00;   // Unknown

    // Broadcast target (5 bytes)
    packet[9] = 0xFF;
    packet[10] = 0xFF;
    packet[11] = 0xFF;
    packet[12] = 0xFF;
    packet[13] = 0xFF;

    // Flags and command
    packet[14] = 0x60;  // Flags
    packet[15] = 0x00;  // Command (0x00 for both enter and exit)

    // Hub ID repeated (big-endian)
    packet[16] = h0;
    packet[17] = h1;
    packet[18] = h2;
    packet[19] = h3;

    // Broadcast target (4 bytes)
    packet[20] = 0xFF;
    packet[21] = 0xFF;
    packet[22] = 0xFF;
    packet[23] = 0xFF;

    // Timer byte (0x3C=active, 0x00=stop)
    packet[24] = timer;

    // Bytes 25-50 are CC padding (already set by memset)

    // CRC at bytes 51-52 (standard 53-byte pairing packet format)
    uint16_t crc = this->encoder_.calc_crc(packet, 51);
    packet[51] = (crc >> 8) & 0xFF;
    packet[52] = crc & 0xFF;

    // Transmit 53-byte packet (standard pairing packet length)
    this->transmit_packet(packet, 53);

    // Increment sequence by 8 (Vive pattern)
    this->vive_seq_ = (this->vive_seq_ + 8) % 0x48;

    // ~90ms between packets in burst (based on capture timing)
    if (i < count - 1) {
      delay(90);
    }
  }

  ESP_LOGD(TAG, "Burst complete, next seq=0x%02X", this->vive_seq_);
}

void CC1101CCA::send_vive_accept(uint32_t hub_id, uint32_t device_id, uint8_t zone_id) {
  // Vive pairing accept sequence (from real hub capture 2026-01-28):
  //
  // Real hub sends BB accept, then config packets: 87, 99, a5, a9, aa, ab, 8d, 93, 9f, b7, bd, c3
  // Device keeps retrying B8 until it receives the config packets.
  //
  // Zone ID determines which "room" the device responds to:
  //   0x38 = Room 1, 0x47 = Room 2, 0x4b = Room 3, etc.
  //
  // Config packets use same base structure but different type bytes and some have
  // additional data for zone assignment, function mapping, etc.

  ESP_LOGI(TAG, "=== VIVE ACCEPT DEVICE ===");
  ESP_LOGI(TAG, "Hub: 0x%08X, Device: 0x%08X, Zone: 0x%02X", hub_id, device_id, zone_id);

  uint8_t h0 = (hub_id >> 24) & 0xFF;
  uint8_t h1 = (hub_id >> 16) & 0xFF;
  uint8_t h2 = (hub_id >> 8) & 0xFF;
  uint8_t h3 = hub_id & 0xFF;

  uint8_t d0 = (device_id >> 24) & 0xFF;
  uint8_t d1 = (device_id >> 16) & 0xFF;
  uint8_t d2 = (device_id >> 8) & 0xFF;
  uint8_t d3 = device_id & 0xFF;

  // Helper to build packet WITH seq byte (used by BB, A9, AA, AB)
  // Format: type + seq + hub_id + rest...
  auto build_packet_with_seq = [&](uint8_t* pkt, uint8_t type, uint8_t proto, uint8_t fmt) {
    memset(pkt, 0xCC, 37);
    pkt[0] = type;
    pkt[1] = 0x01;           // Seq=1 for response
    pkt[2] = h0; pkt[3] = h1; pkt[4] = h2; pkt[5] = h3;  // Hub ID
    pkt[6] = proto;          // Protocol byte (0x21 for accept, 0x28 for zone)
    pkt[7] = fmt;            // Format byte
    pkt[8] = 0x00;
    pkt[9] = d0; pkt[10] = d1; pkt[11] = d2; pkt[12] = d3;  // Device ID
    pkt[13] = 0xFE;          // Paired flag
    pkt[14] = 0x60;          // Flags
    pkt[15] = 0x0A;          // Accept command
    pkt[16] = h0; pkt[17] = h1; pkt[18] = h2; pkt[19] = h3;  // Hub ID
    pkt[20] = h0; pkt[21] = h1; pkt[22] = h2; pkt[23] = h3;  // Hub ID again
    // Bytes 24-34 are CC padding
    uint16_t crc = this->encoder_.calc_crc(pkt, 35);
    pkt[35] = (crc >> 8) & 0xFF;
    pkt[36] = crc & 0xFF;
  };

  // Helper to build packet WITHOUT seq byte (used by 87, 99, a5, 8d, 93, 9f, b7, bd, c3)
  // Format: type + hub_id + rest... (NO seq byte - one byte shorter!)
  // Real example: 87 01 7d 53 63 21 10 00 02 1a d0 c3 fe 60 0a 01 7d 53 63 01 7d 53 63 cc
  auto build_packet_no_seq = [&](uint8_t* pkt, uint8_t type, uint8_t proto, uint8_t fmt) {
    memset(pkt, 0xCC, 36);  // One byte shorter (no seq)
    pkt[0] = type;
    pkt[1] = h0; pkt[2] = h1; pkt[3] = h2; pkt[4] = h3;  // Hub ID starts at byte 1!
    pkt[5] = proto;          // Protocol byte
    pkt[6] = fmt;            // Format byte
    pkt[7] = 0x00;
    pkt[8] = d0; pkt[9] = d1; pkt[10] = d2; pkt[11] = d3;  // Device ID
    pkt[12] = 0xFE;          // Paired flag
    pkt[13] = 0x60;          // Flags
    pkt[14] = 0x0A;          // Accept command
    pkt[15] = h0; pkt[16] = h1; pkt[17] = h2; pkt[18] = h3;  // Hub ID
    pkt[19] = h0; pkt[20] = h1; pkt[21] = h2; pkt[22] = h3;  // Hub ID again
    // Bytes 23-33 are CC padding
    uint16_t crc = this->encoder_.calc_crc(pkt, 34);
    pkt[34] = (crc >> 8) & 0xFF;
    pkt[35] = crc & 0xFF;
  };

  uint8_t packet[37];

  // Phase 1: Send BB accept burst (like real hub)
  // BB packets HAVE seq byte: bb 01 01 7d 53 63 21 10 00...
  ESP_LOGI(TAG, "Phase 1: Sending BB accept packets (with seq)");
  for (int i = 0; i < 3; i++) {
    build_packet_with_seq(packet, 0xBB, 0x21, 0x10);
    this->transmit_packet(packet, 37);
    delay(70);
  }

  // Phase 2: Send config packets (87, 99, a5) - NO seq byte!
  // Real: 87 01 7d 53 63 21 10 00... (hub ID at byte 1, no seq)
  ESP_LOGI(TAG, "Phase 2: Sending config packets (87, 99, a5) - no seq");
  uint8_t config_types_1[] = {0x87, 0x99, 0xa5};
  for (uint8_t type : config_types_1) {
    build_packet_no_seq(packet, type, 0x21, 0x10);
    this->transmit_packet(packet, 36);  // 36 bytes (no seq)
    delay(70);
  }

  // Phase 3: Send A9 zone assignment packet (format 0x28)
  // Real captures show: a9 01 01 7d 53 63 28 03 01 39 6c 21 1a 00 [device:4] fe 06 40 00 00 00
  // Where bytes 8-10 are "01 39 XX" with XX being a zone reference counter
  // The zone reference (6c, 72, 7a) varies by zone but doesn't need to match exactly
  ESP_LOGI(TAG, "Phase 3: Sending A9 zone assignment (format 0x28)");
  {
    uint8_t a9_pkt[26];
    memset(a9_pkt, 0x00, sizeof(a9_pkt));
    a9_pkt[0] = 0xA9;
    a9_pkt[1] = 0x01;  // seq
    a9_pkt[2] = h0; a9_pkt[3] = h1; a9_pkt[4] = h2; a9_pkt[5] = h3;
    a9_pkt[6] = 0x28;  // Zone assignment protocol
    a9_pkt[7] = 0x03;  // Format
    a9_pkt[8] = 0x01;  // Constant
    a9_pkt[9] = 0x39;  // Constant (was incorrectly 0x38!)
    a9_pkt[10] = zone_id + 0x30;  // Zone reference (derived from zone_id)
    a9_pkt[11] = 0x21;
    a9_pkt[12] = 0x1A;
    a9_pkt[13] = 0x00;
    a9_pkt[14] = d0; a9_pkt[15] = d1; a9_pkt[16] = d2; a9_pkt[17] = d3;
    a9_pkt[18] = 0xFE;
    a9_pkt[19] = 0x06;
    a9_pkt[20] = 0x40;
    a9_pkt[21] = 0x00;
    a9_pkt[22] = 0x00;
    a9_pkt[23] = 0x00;
    uint16_t crc = this->encoder_.calc_crc(a9_pkt, 24);
    a9_pkt[24] = (crc >> 8) & 0xFF;
    a9_pkt[25] = crc & 0xFF;
    this->transmit_packet(a9_pkt, 26);
    delay(70);
  }

  // Phase 4: Send AA function mapping
  // Real: aa 01 01 7d 53 63 21 14 00 02 1a d0 c3 fe 06 50 00 0b 09 fe ff 00 00 00
  ESP_LOGI(TAG, "Phase 4: Sending AA function mapping");
  {
    uint8_t aa_pkt[26];
    memset(aa_pkt, 0x00, sizeof(aa_pkt));
    aa_pkt[0] = 0xAA;
    aa_pkt[1] = 0x01;
    aa_pkt[2] = h0; aa_pkt[3] = h1; aa_pkt[4] = h2; aa_pkt[5] = h3;
    aa_pkt[6] = 0x21;
    aa_pkt[7] = 0x14;
    aa_pkt[8] = 0x00;
    aa_pkt[9] = d0; aa_pkt[10] = d1; aa_pkt[11] = d2; aa_pkt[12] = d3;
    aa_pkt[13] = 0xFE;
    aa_pkt[14] = 0x06;
    aa_pkt[15] = 0x50;
    aa_pkt[16] = 0x00;
    aa_pkt[17] = 0x0B;
    aa_pkt[18] = 0x09;
    aa_pkt[19] = 0xFE;
    aa_pkt[20] = 0xFF;
    aa_pkt[21] = 0x00;
    aa_pkt[22] = 0x00;
    aa_pkt[23] = 0x00;
    uint16_t crc = this->encoder_.calc_crc(aa_pkt, 24);
    aa_pkt[24] = (crc >> 8) & 0xFF;
    aa_pkt[25] = crc & 0xFF;
    this->transmit_packet(aa_pkt, 26);
    delay(70);
  }

  // Phase 4b: Send AB packet (format 0x28, similar to A9 but alternate zone ref)
  // Real: ab 01 01 7d 53 63 28 03 01 39 7c 21 1a 00 [device:4] fe 06 40 00 00 00
  // Zone reference byte is slightly different (+2 from A9)
  ESP_LOGI(TAG, "Phase 4b: Sending AB zone packet (format 0x28)");
  {
    uint8_t ab_pkt[26];
    memset(ab_pkt, 0x00, sizeof(ab_pkt));
    ab_pkt[0] = 0xAB;
    ab_pkt[1] = 0x01;  // seq
    ab_pkt[2] = h0; ab_pkt[3] = h1; ab_pkt[4] = h2; ab_pkt[5] = h3;
    ab_pkt[6] = 0x28;  // Zone assignment protocol
    ab_pkt[7] = 0x03;  // Format
    ab_pkt[8] = 0x01;  // Constant
    ab_pkt[9] = 0x39;  // Constant (was incorrectly 0x38!)
    ab_pkt[10] = zone_id + 0x32;  // Zone reference (slightly different from A9)
    ab_pkt[11] = 0x21;
    ab_pkt[12] = 0x1A;
    ab_pkt[13] = 0x00;
    ab_pkt[14] = d0; ab_pkt[15] = d1; ab_pkt[16] = d2; ab_pkt[17] = d3;
    ab_pkt[18] = 0xFE;
    ab_pkt[19] = 0x06;
    ab_pkt[20] = 0x40;
    ab_pkt[21] = 0x00;
    ab_pkt[22] = 0x00;
    ab_pkt[23] = 0x00;
    uint16_t crc = this->encoder_.calc_crc(ab_pkt, 24);
    ab_pkt[24] = (crc >> 8) & 0xFF;
    ab_pkt[25] = crc & 0xFF;
    this->transmit_packet(ab_pkt, 26);
    delay(70);
  }

  // Phase 5: Send remaining config packets
  // A9 (second one) HAS seq: a9 01 01 7d 53 63 21 12 00...
  // 8D, 93, 9F, B7, BD, C3 do NOT have seq: 8d 01 7d 53 63 21 12 00...
  ESP_LOGI(TAG, "Phase 5: Sending final config packets");

  // First send A9 with seq (format 0x12)
  {
    // Real: a9 01 01 7d 53 63 21 12 00 02 1a d0 c3 fe 06 6e 01 00 07 00 02 00 00 00
    uint8_t a9_final[26];
    memset(a9_final, 0x00, sizeof(a9_final));
    a9_final[0] = 0xA9;
    a9_final[1] = 0x01;  // seq
    a9_final[2] = h0; a9_final[3] = h1; a9_final[4] = h2; a9_final[5] = h3;
    a9_final[6] = 0x21;
    a9_final[7] = 0x12;
    a9_final[8] = 0x00;
    a9_final[9] = d0; a9_final[10] = d1; a9_final[11] = d2; a9_final[12] = d3;
    a9_final[13] = 0xFE;
    a9_final[14] = 0x06;
    a9_final[15] = 0x6E;
    a9_final[16] = 0x01;
    a9_final[17] = 0x00;
    a9_final[18] = 0x07;
    a9_final[19] = 0x00;
    a9_final[20] = 0x02;
    a9_final[21] = 0x00;
    a9_final[22] = 0x00;
    a9_final[23] = 0x00;
    uint16_t crc = this->encoder_.calc_crc(a9_final, 24);
    a9_final[24] = (crc >> 8) & 0xFF;
    a9_final[25] = crc & 0xFF;
    this->transmit_packet(a9_final, 26);
    delay(50);
  }

  // Then send 8D, 93, 9F, C3 WITHOUT seq byte (24 bytes data, no extra suffix)
  // Real: 8d 01 7d 53 63 21 12 00 [device:4] fe 06 6e 01 00 07 00 02 00 00 00 [ZONE]
  // And B7, BD with 0xef suffix (25 bytes data)
  // Real: b7 01 7d 53 63 21 12 00 [device:4] fe 06 6e 01 00 07 00 02 00 00 00 [ZONE] ef
  // ZONE at byte 23 is the zone ID the device will respond to!
  ESP_LOGI(TAG, "Sending format 0x12 config packets with zone=0x%02X", zone_id);
  {
    uint8_t final_pkt[28];  // Max size needed
    memset(final_pkt, 0x00, sizeof(final_pkt));
    // No seq byte - hub ID starts at byte 1
    final_pkt[1] = h0; final_pkt[2] = h1; final_pkt[3] = h2; final_pkt[4] = h3;
    final_pkt[5] = 0x21;
    final_pkt[6] = 0x12;
    final_pkt[7] = 0x00;
    final_pkt[8] = d0; final_pkt[9] = d1; final_pkt[10] = d2; final_pkt[11] = d3;
    final_pkt[12] = 0xFE;
    final_pkt[13] = 0x06;
    final_pkt[14] = 0x6E;
    final_pkt[15] = 0x01;
    final_pkt[16] = 0x00;
    final_pkt[17] = 0x07;
    final_pkt[18] = 0x00;
    final_pkt[19] = 0x02;
    final_pkt[20] = 0x00;
    final_pkt[21] = 0x00;
    final_pkt[22] = 0x00;
    final_pkt[23] = zone_id;  // ZONE ID - was hardcoded to 0x38!

    // Send in correct order: 8d, 93, 9f, b7, bd, c3
    // 8D, 93, 9F: 24 bytes data + 2 bytes CRC = 26 bytes total
    uint8_t first_types[] = {0x8D, 0x93, 0x9F};
    for (uint8_t type : first_types) {
      final_pkt[0] = type;
      uint16_t crc = this->encoder_.calc_crc(final_pkt, 24);
      final_pkt[24] = (crc >> 8) & 0xFF;
      final_pkt[25] = crc & 0xFF;
      this->transmit_packet(final_pkt, 26);
      delay(50);
    }

    // B7, BD: 25 bytes data (with 0xef suffix) + 2 bytes CRC = 27 bytes total
    final_pkt[24] = 0xEF;  // Extra byte for B7/BD
    uint8_t long_types[] = {0xB7, 0xBD};
    for (uint8_t type : long_types) {
      final_pkt[0] = type;
      uint16_t crc = this->encoder_.calc_crc(final_pkt, 25);
      final_pkt[25] = (crc >> 8) & 0xFF;
      final_pkt[26] = crc & 0xFF;
      this->transmit_packet(final_pkt, 27);
      delay(50);
    }

    // C3: 24 bytes data + 2 bytes CRC = 26 bytes total (back to short format)
    // Note: CRC is calculated on bytes 0-23, so final_pkt[24] (still 0xEF) doesn't affect it
    final_pkt[0] = 0xC3;
    uint16_t crc_c3 = this->encoder_.calc_crc(final_pkt, 24);
    final_pkt[24] = (crc_c3 >> 8) & 0xFF;
    final_pkt[25] = crc_c3 & 0xFF;
    this->transmit_packet(final_pkt, 26);
    delay(50);
  }

  ESP_LOGI(TAG, "Accept + config sequence complete for device 0x%08X", device_id);
}

void CC1101CCA::send_pair_assignment(uint16_t subnet, uint32_t factory_id, uint8_t zone_suffix) {
  ESP_LOGI(TAG, "=== SEND PAIR ASSIGNMENT (B1) ===");
  ESP_LOGI(TAG, "Subnet: 0x%04X, Factory ID: 0x%08X, Zone: 0x06%04X%02X",
           subnet, factory_id, subnet, zone_suffix);

  // Real bridge pattern analysis from real_bridge_repair_06fe43b1.cu8:
  // - Uses B1 packet type (NOT B0!)
  // - Starts at seq=0 with A0 prefix
  // - Pattern: 0,2,6,7,8,0C,0E,12,13,14,18,1A,1E,1F,20,24,26,2A,2B,2C,30,32,36,37,38,3C,3E,42,43,44
  // - Prefix: A0 for seq=0, A2 for seq=2,6, then AF for rest

  // Real bridge sequence pattern (extracted from successful pairing capture):
  static const uint8_t real_seqs[] = {
    0x00, 0x02, 0x06, 0x07, 0x08, 0x0C, 0x0E, 0x12, 0x13, 0x14,
    0x18, 0x1A, 0x1E, 0x1F, 0x20, 0x24, 0x26, 0x2A, 0x2B, 0x2C,
    0x30, 0x32, 0x36, 0x37, 0x38, 0x3C, 0x3E, 0x42, 0x43, 0x44
  };
  static const int num_seqs = sizeof(real_seqs) / sizeof(real_seqs[0]);

  uint8_t packet[48];

  for (int i = 0; i < num_seqs; i++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = 0xB1;  // B1 pairing assignment (real bridge uses B1, not B0!)
    packet[1] = real_seqs[i];

    // Zone prefix pattern from real bridge:
    // - A0 for seq=0x00
    // - A2 for seq=0x02, 0x06
    // - AF for all others
    uint8_t prefix;
    if (real_seqs[i] == 0x00) prefix = 0xA0;
    else if (real_seqs[i] == 0x02 || real_seqs[i] == 0x06) prefix = 0xA2;
    else prefix = 0xAF;
    packet[2] = prefix;
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

    // Real bridge timing: bursts of packets with seq+1 are sent rapidly (~12ms apart)
    // Larger gaps between bursts (~50ms)
    // Detect if next packet is part of burst (seq difference of 1)
    int delay_ms;
    if (i + 1 < num_seqs) {
      int seq_diff = real_seqs[i + 1] - real_seqs[i];
      if (seq_diff == 1) {
        delay_ms = 12;  // Fast burst timing
      } else {
        delay_ms = 50;  // Gap between bursts
      }
    } else {
      delay_ms = 50;
    }

    // CRITICAL: Process RX during delays to avoid FIFO overflow
    uint32_t delay_start = millis();
    while (millis() - delay_start < delay_ms) {
      this->radio_.check_rx();
      delay(1);
    }
  }

  ESP_LOGI(TAG, "Pair assignment packets sent (%d packets).", num_seqs);

  // CRITICAL: After B0 assignment, device takes ~1.5-2 seconds to process and respond with B3
  // We MUST stop all TX and listen during this time!
  ESP_LOGI(TAG, "=== LISTENING FOR B3 RESPONSE (5 seconds - NO TX) ===");
  ESP_LOGI(TAG, "Device should respond with B3 containing our assignment data");

  // Put radio in RX mode and listen
  this->radio_.start_rx();

  uint32_t listen_start = millis();
  int b3_count = 0;

  while (millis() - listen_start < 5000) {  // Listen for 5 seconds
    // Check for received packets
    this->radio_.check_rx();
    delay(5);

    // Log progress every second
    if ((millis() - listen_start) % 1000 < 10) {
      ESP_LOGI(TAG, "  Listening... %d seconds (B3 responses: %d)",
               (millis() - listen_start) / 1000, b3_count);
    }
  }

  ESP_LOGI(TAG, "=== LISTEN PERIOD COMPLETE ===");
}

void CC1101CCA::pair_device(uint16_t subnet, uint32_t factory_id, uint8_t zone_suffix) {
  ESP_LOGI(TAG, "=== COMPLETE BRIDGE PAIRING SEQUENCE ===");
  ESP_LOGI(TAG, "Subnet: 0x%04X, Factory: 0x%08X, Zone suffix: 0x%02X",
           subnet, factory_id, zone_suffix);

  // Step 1: Send active pairing beacons
  ESP_LOGI(TAG, "Step 1: Sending active pairing beacons...");
  this->start_bridge_pairing(subnet);

  // Step 2: Brief pause for device to respond - poll RX during this time
  ESP_LOGI(TAG, "Waiting for device response (polling RX)...");
  uint32_t pause_start = millis();
  while (millis() - pause_start < 500) {
    this->radio_.check_rx();
    delay(1);
  }

  // Step 3: Send B0 assignment packets
  ESP_LOGI(TAG, "Step 2: Sending B0 pairing assignment packets...");
  this->send_pair_assignment(subnet, factory_id, zone_suffix);

  // Step 4: Send stop beacons
  ESP_LOGI(TAG, "Step 3: Sending stop beacons...");
  this->stop_bridge_pairing(subnet);

  // Step 5: Extended RX listening period
  // RF analysis shows C responses (pairing ACKs) come 20+ seconds after B0 packets
  // Continue polling RX to catch delayed device responses
  ESP_LOGI(TAG, "Step 4: Extended RX listening for device response (30 seconds)...");
  uint32_t listen_start = millis();
  while (millis() - listen_start < 30000) {
    this->radio_.check_rx();
    delay(10);  // Poll every 10ms
    // Log progress every 5 seconds
    if ((millis() - listen_start) % 5000 < 15) {
      ESP_LOGI(TAG, "  Listening... %d seconds elapsed", (millis() - listen_start) / 1000);
    }
  }

  ESP_LOGI(TAG, "=== PAIRING SEQUENCE COMPLETE ===");
  ESP_LOGI(TAG, "Device 0x%08X should now respond to zone 0x06%04X%02X",
           factory_id, subnet, zone_suffix);
}

// ========== BRIDGE PAIRING PROTOCOL IMPLEMENTATIONS ==========

void CC1101CCA::send_config_packet(uint8_t type, uint32_t bridge_zone_id,
                                       uint32_t target_hw_id, uint32_t assigned_load_id) {
  ESP_LOGI(TAG, "=== CONFIG PACKET 0x%02X ===", type);
  ESP_LOGI(TAG, "Bridge zone: 0x%08X, Target: 0x%08X, Load ID: 0x%08X",
           bridge_zone_id, target_hw_id, assigned_load_id);

  // Validate type
  if (type != 0xA1 && type != 0xA2 && type != 0xA3) {
    ESP_LOGW(TAG, "Invalid config type 0x%02X, using 0xA1", type);
    type = 0xA1;
  }

  uint8_t packet[24];
  memset(packet, 0xCC, sizeof(packet));

  // Real bridge captures show different formats for A1 vs A2/A3:
  // A1: 0x70 format with device link
  // A2: 0x50 format with config params: 05 04 01 01 00 03
  // A3: 0x50 format with config params: 0C 04 3B 92 00 03
  packet[0] = type;
  packet[1] = this->pairing_seq_;

  // Bridge zone ID - little-endian
  packet[2] = bridge_zone_id & 0xFF;
  packet[3] = (bridge_zone_id >> 8) & 0xFF;
  packet[4] = (bridge_zone_id >> 16) & 0xFF;
  packet[5] = (bridge_zone_id >> 24) & 0xFF;

  packet[6] = 0x21;  // Protocol marker
  packet[7] = 0x0F;  // Config format
  packet[8] = 0x00;

  // Target device ID - big-endian
  packet[9] = (target_hw_id >> 24) & 0xFF;
  packet[10] = (target_hw_id >> 16) & 0xFF;
  packet[11] = (target_hw_id >> 8) & 0xFF;
  packet[12] = target_hw_id & 0xFF;

  packet[13] = 0xFE;
  packet[14] = 0x06;

  if (type == 0xA1) {
    // A1: Device link format (0x70)
    // From capture: A1 01 AD 90 2C 00 21 0F 00 06 FE 43 B1 FE 06 70 01 08 51 24 C9 00 00 CC
    packet[15] = 0x70;
    packet[16] = 0x01;
    // Link to assigned load ID (or bridge zone as controller)
    packet[17] = (assigned_load_id >> 24) & 0xFF;
    packet[18] = (assigned_load_id >> 16) & 0xFF;
    packet[19] = (assigned_load_id >> 8) & 0xFF;
    packet[20] = assigned_load_id & 0xFF;
    packet[21] = 0x00;
    packet[22] = 0x00;  // 0x70 format ends with 00 00 CC
    packet[23] = 0xCC;
  } else if (type == 0xA2) {
    // A2: Config parameters format (0x50)
    // From capture: A2 01 AD 90 2C 00 21 0F 00 06 FE 43 B1 FE 06 50 00 05 04 01 01 00 03 CC
    packet[15] = 0x50;
    packet[16] = 0x00;
    packet[17] = 0x05;
    packet[18] = 0x04;
    packet[19] = 0x01;
    packet[20] = 0x01;
    packet[21] = 0x00;
    packet[22] = 0x03;  // 0x50 format ends with 00 03 CC
    packet[23] = 0xCC;
  } else {  // A3
    // A3: Config parameters format (0x50)
    // From capture: A3 01 AD 90 2C 00 21 0F 00 06 FE 43 B1 FE 06 50 00 0C 04 3B 92 00 03 CC
    packet[15] = 0x50;
    packet[16] = 0x00;
    packet[17] = 0x0C;
    packet[18] = 0x04;
    packet[19] = 0x3B;
    packet[20] = 0x92;
    packet[21] = 0x00;
    packet[22] = 0x03;  // 0x50 format ends with 00 03 CC
    packet[23] = 0xCC;
  }

  // NOTE: Config packets don't use CRC - they use fixed endings
  // 0x70 format: 00 00 CC
  // 0x50 format: 00 03 CC

  this->transmit_packet(packet, 24);

  // Increment sequence by 6 (standard CCA pattern)
  this->pairing_seq_ = (this->pairing_seq_ + 6) % 0x48;
}

void CC1101CCA::send_device_link(uint8_t type, uint32_t bridge_zone_id,
                                     uint32_t target_hw_id, uint32_t linked_device_id,
                                     uint8_t slot) {
  ESP_LOGI(TAG, "=== DEVICE LINK 0x%02X (slot %d) ===", type, slot);
  ESP_LOGI(TAG, "Bridge zone: 0x%08X, Target: 0x%08X, Link to: 0x%08X",
           bridge_zone_id, target_hw_id, linked_device_id);

  // Validate type (only A1 and A3 can have device link format)
  if (type != 0xA1 && type != 0xA3) {
    ESP_LOGW(TAG, "Invalid device link type 0x%02X, must be A1 or A3", type);
    return;
  }

  uint8_t packet[24];
  memset(packet, 0xCC, sizeof(packet));

  // Device link format (0x70)
  // From capture: A3 01 AD 90 2C 00 21 0F 00 06 FE 43 B1 FE 06 70 00 04 D0 B5 91 00 00 CC
  packet[0] = type;
  packet[1] = this->pairing_seq_;

  // Bridge zone ID - little-endian
  packet[2] = bridge_zone_id & 0xFF;
  packet[3] = (bridge_zone_id >> 8) & 0xFF;
  packet[4] = (bridge_zone_id >> 16) & 0xFF;
  packet[5] = (bridge_zone_id >> 24) & 0xFF;

  packet[6] = 0x21;  // Protocol marker
  packet[7] = 0x0F;  // Config format
  packet[8] = 0x00;

  // Target device ID - big-endian
  packet[9] = (target_hw_id >> 24) & 0xFF;
  packet[10] = (target_hw_id >> 16) & 0xFF;
  packet[11] = (target_hw_id >> 8) & 0xFF;
  packet[12] = target_hw_id & 0xFF;

  packet[13] = 0xFE;
  packet[14] = 0x06;
  packet[15] = 0x70;  // Device link format
  packet[16] = slot;  // Link slot (0 or 1)

  // Linked device ID - big-endian
  packet[17] = (linked_device_id >> 24) & 0xFF;
  packet[18] = (linked_device_id >> 16) & 0xFF;
  packet[19] = (linked_device_id >> 8) & 0xFF;
  packet[20] = linked_device_id & 0xFF;

  packet[21] = 0x00;
  packet[22] = 0x00;  // 0x70 format ends with 00 00 CC
  packet[23] = 0xCC;

  this->transmit_packet(packet, 24);

  // Increment sequence by 6 (standard CCA pattern)
  this->pairing_seq_ = (this->pairing_seq_ + 6) % 0x48;
}

void CC1101CCA::send_targeted_beacon_93(uint32_t bridge_zone_id, uint32_t target_hw_id, uint16_t subnet) {
  ESP_LOGI(TAG, "=== TARGETED BEACON 0x93 (format 0x0D) ===");
  ESP_LOGI(TAG, "Zone: 0x%08X, Target: 0x%08X, Subnet: 0x%04X", bridge_zone_id, target_hw_id, subnet);

  uint8_t packet[24];
  memset(packet, 0xCC, sizeof(packet));

  // From REAL RadioRA3 capture: 93 01 AD 90 2C 00 21 0D 00 06 FE 43 B1 FE 08 06 90 2C 1A 04 06 CC
  // This targeted beacon acknowledges the discovered device
  packet[0] = 0x93;
  packet[1] = this->pairing_seq_;

  // Bridge zone ID - little-endian
  packet[2] = bridge_zone_id & 0xFF;
  packet[3] = (bridge_zone_id >> 8) & 0xFF;
  packet[4] = (bridge_zone_id >> 16) & 0xFF;
  packet[5] = (bridge_zone_id >> 24) & 0xFF;

  packet[6] = 0x21;  // Protocol marker
  packet[7] = 0x0D;  // TARGETED format (not 0x0C broadcast)
  packet[8] = 0x00;

  // Target device ID - big-endian
  packet[9] = (target_hw_id >> 24) & 0xFF;
  packet[10] = (target_hw_id >> 16) & 0xFF;
  packet[11] = (target_hw_id >> 8) & 0xFF;
  packet[12] = target_hw_id & 0xFF;

  packet[13] = 0xFE;
  packet[14] = 0x08;  // Different from broadcast 0x02
  packet[15] = 0x06;  // Device type (dimmer)

  // Subnet - big-endian
  packet[16] = (subnet >> 8) & 0xFF;
  packet[17] = subnet & 0xFF;

  packet[18] = 0x1A;
  packet[19] = 0x04;
  packet[20] = 0x06;  // Device type again
  packet[21] = 0xCC;

  // CRC
  uint16_t crc = this->encoder_.calc_crc(packet, 22);
  packet[22] = (crc >> 8) & 0xFF;
  packet[23] = crc & 0xFF;

  this->transmit_packet(packet, 24);

  // Increment sequence
  this->pairing_seq_ = (this->pairing_seq_ + 6) % 0x48;
}

void CC1101CCA::send_zone_assignment_82(uint32_t bridge_zone_id, uint32_t target_hw_id) {
  ESP_LOGI(TAG, "=== ZONE ASSIGNMENT 0x82 ===");
  ESP_LOGI(TAG, "Zone: 0x%08X, Target: 0x%08X", bridge_zone_id, target_hw_id);

  uint8_t packet[24];
  memset(packet, 0xCC, sizeof(packet));

  // From REAL RadioRA3 capture: 82 C3 AF 90 2C 00 21 09 00 06 FE 43 B1 FE 02 02 01 CC CC CC CC CC F2 47
  // This is the targeted zone assignment that makes the dimmer flash!
  packet[0] = 0x82;
  packet[1] = this->pairing_seq_;

  // Bridge zone ID - little-endian
  packet[2] = bridge_zone_id & 0xFF;
  packet[3] = (bridge_zone_id >> 8) & 0xFF;
  packet[4] = (bridge_zone_id >> 16) & 0xFF;
  packet[5] = (bridge_zone_id >> 24) & 0xFF;

  packet[6] = 0x21;  // Protocol marker
  packet[7] = 0x09;  // Targeted state format (NOT 0x0A broadcast)
  packet[8] = 0x00;

  // Target device ID - big-endian (the dimmer we're assigning)
  packet[9] = (target_hw_id >> 24) & 0xFF;
  packet[10] = (target_hw_id >> 16) & 0xFF;
  packet[11] = (target_hw_id >> 8) & 0xFF;
  packet[12] = target_hw_id & 0xFF;

  packet[13] = 0xFE;

  // State bytes from capture: 02 02 01
  packet[14] = 0x02;
  packet[15] = 0x02;
  packet[16] = 0x01;

  // Rest is CC padding, CRC at end
  uint16_t crc = this->encoder_.calc_crc(packet, 22);
  packet[22] = (crc >> 8) & 0xFF;
  packet[23] = crc & 0xFF;

  this->transmit_packet(packet, 24);

  // Increment sequence
  this->pairing_seq_ = (this->pairing_seq_ + 6) % 0x48;
}

void CC1101CCA::send_state_report_83(uint32_t bridge_zone_id, uint32_t target_hw_id) {
  ESP_LOGI(TAG, "=== STATE REPORT 0x83 ===");
  ESP_LOGI(TAG, "From zone: 0x%08X, To device: 0x%08X", bridge_zone_id, target_hw_id);

  uint8_t packet[24];
  memset(packet, 0xCC, sizeof(packet));

  // From REAL bridge capture: 83 01 AD 90 2C 00 21 0A 00 FF FF FF FF FF 09 06 00 00 CC CC CC CC 59 C4
  // Format 0x0A with BROADCAST target (FF FF FF FF FF)
  packet[0] = 0x83;
  packet[1] = this->pairing_seq_;

  // Bridge zone ID - little-endian
  packet[2] = bridge_zone_id & 0xFF;
  packet[3] = (bridge_zone_id >> 8) & 0xFF;
  packet[4] = (bridge_zone_id >> 16) & 0xFF;
  packet[5] = (bridge_zone_id >> 24) & 0xFF;

  packet[6] = 0x21;  // Protocol marker
  packet[7] = 0x0A;  // Broadcast state report format (NOT 0x09)
  packet[8] = 0x00;

  // BROADCAST target - FF FF FF FF FF (not specific device)
  packet[9] = 0xFF;
  packet[10] = 0xFF;
  packet[11] = 0xFF;
  packet[12] = 0xFF;
  packet[13] = 0xFF;

  // State bytes from capture
  packet[14] = 0x09;
  packet[15] = 0x06;
  packet[16] = 0x00;
  packet[17] = 0x00;

  // Calculate CRC
  uint16_t crc = this->encoder_.calc_crc(packet, 22);
  packet[22] = (crc >> 8) & 0xFF;
  packet[23] = crc & 0xFF;

  this->transmit_packet(packet, 24);

  // Increment sequence by 6
  this->pairing_seq_ = (this->pairing_seq_ + 6) % 0x48;
}

void CC1101CCA::send_handshake_response(uint8_t dimmer_type, uint16_t subnet) {
  // Validate dimmer sent odd type (C1, C7, CD, D3, D9, DF)
  if ((dimmer_type & 0x01) == 0) {
    ESP_LOGW(TAG, "Expected odd handshake type, got 0x%02X", dimmer_type);
    return;
  }

  // Bridge responds with dimmer_type + 1 (even type)
  uint8_t response_type = dimmer_type + 1;

  ESP_LOGI(TAG, "=== HANDSHAKE RESPONSE 0x%02X ===", response_type);
  ESP_LOGI(TAG, "Responding to dimmer 0x%02X with 0x%02X", dimmer_type, response_type);

  uint8_t packet[24];
  memset(packet, 0x00, sizeof(packet));

  // From capture: C2 26 90 2C 62 70 D0 FE 00 00 00 FE FE 00 00 00 00 00 FE 19 FE 00 XX XX
  packet[0] = response_type;
  packet[1] = this->pairing_seq_;

  // Subnet - little-endian in first two bytes of device ID field
  packet[2] = subnet & 0xFF;
  packet[3] = (subnet >> 8) & 0xFF;

  // Handshake payload pattern from captures
  packet[4] = 0x62;
  packet[5] = 0x70;
  packet[6] = 0xD0;
  packet[7] = 0xFE;
  packet[8] = 0x00;
  packet[9] = 0x00;
  packet[10] = 0x00;
  packet[11] = 0xFE;
  packet[12] = 0xFE;
  packet[13] = 0x00;
  packet[14] = 0x00;
  packet[15] = 0x00;
  packet[16] = 0x00;
  packet[17] = 0x00;
  packet[18] = 0xFE;
  packet[19] = 0x19;
  packet[20] = 0xFE;
  packet[21] = 0x00;

  // Calculate CRC
  uint16_t crc = this->encoder_.calc_crc(packet, 22);
  packet[22] = (crc >> 8) & 0xFF;
  packet[23] = crc & 0xFF;

  this->transmit_packet(packet, 24);

  // Increment sequence by 6
  this->pairing_seq_ = (this->pairing_seq_ + 6) % 0x48;
}

uint8_t CC1101CCA::send_bridge_beacon(uint8_t beacon_type, uint16_t subnet, uint8_t seq) {
  ESP_LOGD(TAG, "Beacon 0x%02X, subnet 0x%04X, seq 0x%02X", beacon_type, subnet, seq);

  // Validate beacon type
  if (beacon_type != 0x91 && beacon_type != 0x92 && beacon_type != 0x93) {
    ESP_LOGW(TAG, "Invalid beacon type 0x%02X, using 0x92", beacon_type);
    beacon_type = 0x92;
  }

  uint8_t packet[24];
  memset(packet, 0xCC, sizeof(packet));

  // From capture: 93 XX AF 90 2C 00 21 08 00 FF FF FF FF FF 08 01 CC CC CC CC CC CC XX XX
  packet[0] = beacon_type;
  packet[1] = seq;

  // Zone ID with alternating suffix (AF/AD)
  static bool zone_toggle = false;
  packet[2] = zone_toggle ? 0xAD : 0xAF;
  zone_toggle = !zone_toggle;

  // Subnet - little-endian
  packet[3] = subnet & 0xFF;
  packet[4] = (subnet >> 8) & 0xFF;
  packet[5] = 0x00;

  packet[6] = 0x21;  // Protocol marker

  // Format byte differs by beacon type
  if (beacon_type == 0x93) {
    packet[7] = 0x08;  // Initial beacon format
  } else {
    packet[7] = 0x0C;  // Active beacon format (0x91, 0x92)
  }
  packet[8] = 0x00;

  // Broadcast address
  packet[9] = 0xFF;
  packet[10] = 0xFF;
  packet[11] = 0xFF;
  packet[12] = 0xFF;
  packet[13] = 0xFF;

  packet[14] = 0x08;

  // Mode byte differs by beacon type
  if (beacon_type == 0x93) {
    packet[15] = 0x01;  // Initial
  } else if (beacon_type == 0x91) {
    packet[15] = 0x02;  // Active pairing
  } else {
    packet[15] = 0x02;  // 0x92 active or 0x04 for stop
  }

  // Additional zone info for 0x91/0x92
  if (beacon_type != 0x93) {
    packet[16] = subnet & 0xFF;
    packet[17] = (subnet >> 8) & 0xFF;
    packet[18] = 0x1A;
    packet[19] = 0x04;
  }

  // Calculate CRC
  uint16_t crc = this->encoder_.calc_crc(packet, 22);
  packet[22] = (crc >> 8) & 0xFF;
  packet[23] = crc & 0xFF;

  this->transmit_packet(packet, 24);

  // Return next sequence (increment by 6)
  return (seq + 6) % 0x48;
}

}  // namespace cc1101_cca
}  // namespace esphome
