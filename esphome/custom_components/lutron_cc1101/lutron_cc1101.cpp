#include "lutron_cc1101.h"
#include "esphome/core/log.h"

namespace esphome {
namespace lutron_cc1101 {

static const char *const TAG = "lutron_cc1101";

void LutronCC1101::setup() {
  ESP_LOGI(TAG, "Setting up Lutron CC1101...");

  // Initialize SPI
  this->spi_setup();

  // Setup GDO0 pin
  if (this->gdo0_pin_ != nullptr) {
    this->gdo0_pin_->setup();
  }

  // Generate CRC table (polynomial 0xCA0F)
  for (int i = 0; i < 256; i++) {
    uint16_t crc = i << 8;
    for (int j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0xCA0F) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
    this->crc_table_[i] = crc;
  }

  // Initialize CC1101
  this->reset_();
  delay(10);

  // Verify CC1101 is responding by reading PARTNUM and VERSION
  uint8_t partnum = this->read_status_register_(0x30);  // PARTNUM
  uint8_t version = this->read_status_register_(0x31);  // VERSION
  ESP_LOGI(TAG, "CC1101 PARTNUM=0x%02X VERSION=0x%02X (expected 0x00, 0x14)", partnum, version);

  if (version != 0x14) {
    ESP_LOGE(TAG, "CC1101 not detected! Check wiring. Got version 0x%02X", version);
    return;
  }

  this->configure_lutron_();

  // Verify configuration was written
  uint8_t freq2 = this->read_register_(CC1101_FREQ2);
  uint8_t freq1 = this->read_register_(CC1101_FREQ1);
  uint8_t freq0 = this->read_register_(CC1101_FREQ0);
  ESP_LOGI(TAG, "Frequency regs: %02X %02X %02X (expected 10 AD 52)", freq2, freq1, freq0);

  ESP_LOGI(TAG, "CC1101 initialized for Lutron CCA (433.602844 MHz GFSK 62.5 kBaud)");
}

void LutronCC1101::dump_config() {
  ESP_LOGCONFIG(TAG, "Lutron CC1101:");
  LOG_PIN("  GDO0 Pin: ", this->gdo0_pin_);
}

void LutronCC1101::reset_() {
  // Manual reset sequence using CS toggling
  this->disable();  // CS high
  delayMicroseconds(5);
  this->enable();   // CS low
  delayMicroseconds(10);
  this->disable();  // CS high
  delayMicroseconds(45);

  this->strobe_(CC1101_SRES);
  delay(10);
}

void LutronCC1101::strobe_(uint8_t cmd) {
  this->enable();
  this->transfer_byte(cmd);
  this->disable();
}

void LutronCC1101::write_register_(uint8_t reg, uint8_t value) {
  this->enable();
  this->transfer_byte(reg | CC1101_WRITE_SINGLE);
  this->transfer_byte(value);
  this->disable();
}

uint8_t LutronCC1101::read_register_(uint8_t reg) {
  this->enable();
  this->transfer_byte(reg | CC1101_READ_SINGLE);
  uint8_t value = this->transfer_byte(0);
  this->disable();
  return value;
}

uint8_t LutronCC1101::read_status_register_(uint8_t reg) {
  this->enable();
  this->transfer_byte(reg | CC1101_READ_BURST);  // Status registers use burst read
  uint8_t value = this->transfer_byte(0);
  this->disable();
  return value;
}

void LutronCC1101::write_burst_(uint8_t reg, const uint8_t *data, size_t len) {
  this->enable();
  this->transfer_byte(reg | CC1101_WRITE_BURST);
  for (size_t i = 0; i < len; i++) {
    this->transfer_byte(data[i]);
  }
  this->disable();
}

void LutronCC1101::configure_lutron_() {
  this->strobe_(CC1101_SIDLE);
  delay(1);

  // Frequency: 433.602844 MHz
  // FREQ = 433602844 * 2^16 / 26000000 = 0x10AD52
  this->write_register_(CC1101_FREQ2, 0x10);
  this->write_register_(CC1101_FREQ1, 0xAD);
  this->write_register_(CC1101_FREQ0, 0x52);

  // Data rate: 62.4847 kBaud
  this->write_register_(CC1101_MDMCFG4, 0x0B);
  this->write_register_(CC1101_MDMCFG3, 0x3B);

  // Modulation: 2-FSK, no sync word (trying simpler modulation first)
  // GFSK (0x30) wasn't producing correct output, trying 2-FSK (0x00)
  this->write_register_(CC1101_MDMCFG2, 0x00);  // 2-FSK, no sync
  this->write_register_(CC1101_MDMCFG1, 0x00);
  this->write_register_(CC1101_MDMCFG0, 0x00);

  // Deviation: 41.2 kHz
  this->write_register_(CC1101_DEVIATN, 0x45);

  // Packet config - fixed length mode for easier TX
  this->write_register_(CC1101_PKTCTRL1, 0x00);
  this->write_register_(CC1101_PKTCTRL0, 0x00);  // Fixed length, no CRC by CC1101

  // No address filtering
  this->write_register_(CC1101_ADDR, 0x00);
  this->write_register_(CC1101_CHANNR, 0x00);

  // Frequency synthesizer
  this->write_register_(CC1101_FSCTRL1, 0x06);
  this->write_register_(CC1101_FSCTRL0, 0x00);

  // Calibration
  this->write_register_(CC1101_MCSM0, 0x18);  // Auto-calibrate on IDLE->RX/TX

  // AGC
  this->write_register_(CC1101_AGCCTRL2, 0x43);
  this->write_register_(CC1101_AGCCTRL1, 0x40);
  this->write_register_(CC1101_AGCCTRL0, 0x91);

  // Front end config
  this->write_register_(CC1101_FREND1, 0x56);
  this->write_register_(CC1101_FREND0, 0x10);

  // Frequency calibration
  this->write_register_(CC1101_FSCAL3, 0xE9);
  this->write_register_(CC1101_FSCAL2, 0x2A);
  this->write_register_(CC1101_FSCAL1, 0x00);
  this->write_register_(CC1101_FSCAL0, 0x1F);

  // GDO pins config
  this->write_register_(CC1101_IOCFG2, 0x29);  // CHIP_RDYn
  this->write_register_(CC1101_IOCFG0, 0x06);  // Sync word sent/received

  // PA Table - set TX power (+10 dBm for E07 module)
  uint8_t pa_table[] = {0xC0};
  this->write_burst_(CC1101_PATABLE, pa_table, 1);

  ESP_LOGD(TAG, "CC1101 configured");
}

uint16_t LutronCC1101::calc_crc_(const uint8_t *data, size_t len) {
  uint16_t crc_reg = 0;
  for (size_t i = 0; i < len; i++) {
    uint8_t crc_upper = crc_reg >> 8;
    crc_reg = (((crc_reg << 8) & 0xFF00) + data[i]) ^ this->crc_table_[crc_upper];
  }
  return crc_reg;
}

void LutronCC1101::transmit_packet_(const uint8_t *packet, size_t len) {
  // Build raw bit stream with Lutron encoding:
  // - Preamble: 32 bits of alternating 1010...
  // - Sync byte 0xFF with 10-bit encoding
  // - 0xFA 0xDE prefix with 10-bit encoding
  // - Data bytes with 10-bit encoding (LSB first + "10" suffix)

  // Calculate total bits needed
  // Preamble: 32 bits
  // Each byte: 10 bits (8 data + 2 framing)
  // Bytes: 1 (sync) + 2 (prefix) + len (data) + trailing
  size_t total_bits = 32 + (1 + 2 + len) * 10 + 16;
  size_t total_bytes = (total_bits + 7) / 8;

  uint8_t tx_buffer[128];
  memset(tx_buffer, 0, sizeof(tx_buffer));

  int bit_pos = 0;

  // Helper lambda to set a bit
  auto set_bit = [&tx_buffer, &bit_pos](int val) {
    if (val) {
      tx_buffer[bit_pos / 8] |= (1 << (7 - (bit_pos % 8)));
    }
    bit_pos++;
  };

  // Helper lambda to encode a byte using async serial N81 format
  // Start bit (0) + 8 data bits LSB first + Stop bit (1)
  auto encode_byte = [&set_bit](uint8_t byte) {
    set_bit(0);  // Start bit
    for (int i = 0; i < 8; i++) {
      set_bit((byte >> i) & 1);  // Data bits LSB first
    }
    set_bit(1);  // Stop bit
  };

  // Preamble: alternating bits starting with 1 (like real Pico)
  // Real captures show: 101010101010... pattern
  for (int i = 0; i < 32; i++) {
    set_bit((i + 1) % 2);  // Start with 1: 1,0,1,0,1,0...
  }

  // Sync byte 0xFF
  encode_byte(0xFF);

  // Prefix 0xFA 0xDE
  encode_byte(0xFA);
  encode_byte(0xDE);

  // Data bytes
  for (size_t i = 0; i < len; i++) {
    encode_byte(packet[i]);
  }

  // Trailing zeros
  for (int i = 0; i < 16; i++) {
    set_bit(0);
  }

  total_bytes = (bit_pos + 7) / 8;

  // Set packet length and transmit
  this->strobe_(CC1101_SIDLE);
  delay(2);

  uint8_t state_before = this->read_status_register_(0x35);  // MARCSTATE
  ESP_LOGD(TAG, "MARCSTATE before TX: 0x%02X", state_before);

  this->strobe_(CC1101_SFTX);  // Flush TX FIFO
  delay(1);

  this->write_register_(CC1101_PKTLEN, total_bytes);

  // Write data to TX FIFO
  this->write_burst_(CC1101_TXFIFO, tx_buffer, total_bytes);

  // Check FIFO status
  uint8_t txbytes = this->read_status_register_(0x3A);  // TXBYTES
  ESP_LOGD(TAG, "TXBYTES after fill: %d (expected %d)", txbytes & 0x7F, total_bytes);

  // Start transmission
  this->strobe_(CC1101_STX);

  // Wait for transmission to complete
  delay(5);
  uint8_t state_during = this->read_status_register_(0x35);
  ESP_LOGD(TAG, "MARCSTATE during TX: 0x%02X (0x13=TX)", state_during);

  // Wait for TX to complete - poll MARCSTATE until back to IDLE
  int timeout = 100;
  uint8_t last_state = 0;
  while (timeout-- > 0) {
    uint8_t state = this->read_status_register_(0x35);
    if (state != last_state) {
      ESP_LOGD(TAG, "State transition: 0x%02X -> 0x%02X", last_state, state);
      last_state = state;
    }
    if (state == 0x01) break;  // IDLE
    delay(1);
  }

  uint8_t state_after = this->read_status_register_(0x35);
  uint8_t txbytes_after = this->read_status_register_(0x3A);  // Check for underflow
  ESP_LOGD(TAG, "After TX: MARCSTATE=0x%02X TXBYTES=0x%02X timeout=%d", state_after, txbytes_after, timeout);

  this->strobe_(CC1101_SIDLE);
  delay(2);

  ESP_LOGD(TAG, "Transmitted %d bits (%d bytes)", bit_pos, total_bytes);
}

void LutronCC1101::send_button_press(uint32_t device_id, uint8_t button) {
  ESP_LOGI(TAG, "Sending button 0x%02X press for device %08X", button, device_id);

  uint8_t packet[24];

  // Type base alternates between button presses (0x88/89 vs 0x8A/8B)
  uint8_t type_base = this->type_alternate_ ? 0x8A : 0x88;
  this->type_alternate_ = !this->type_alternate_;

  // Button categories:
  // - ON (0x02), OFF (0x04), FAVORITE (0x03): Standard format
  // - RAISE (0x05), LOWER (0x06): Dimming format with byte 7 = 0x0C
  bool is_dimming = (button == 0x05 || button == 0x06);

  // --- PHASE 1: SHORT FORMAT PACKETS ---
  for (int rep = 0; rep < 5; rep++) {
    memset(packet, 0xCC, sizeof(packet));

    packet[0] = type_base;       // 0x88 or 0x8A (short format)
    packet[1] = this->tx_sequence_;
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
      // RAISE/LOWER use "medium" format with byte 7 = 0x0C
      packet[7] = 0x0C;
      // Device ID repeated in bytes 12-15
      packet[12] = (device_id >> 0) & 0xFF;
      packet[13] = (device_id >> 8) & 0xFF;
      packet[14] = (device_id >> 16) & 0xFF;
      packet[15] = (device_id >> 24) & 0xFF;
      packet[16] = 0x00;
      packet[17] = 0x42;
      packet[18] = 0x00;
      packet[19] = 0x02;
      // bytes 20-21 remain 0xCC from memset
    } else {
      // ON/OFF/FAVORITE use standard short format
      packet[7] = 0x04;
      // bytes 12-21 remain 0xCC from memset
    }

    uint16_t crc = this->calc_crc_(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    ESP_LOGD(TAG, "TX SHORT seq=%02X type=%02X byte7=%02X btn=%02X CRC=%04X",
             this->tx_sequence_, packet[0], packet[7], button, crc);

    this->transmit_packet_(packet, 24);
    this->tx_sequence_ += 2;
    delay(70);
  }

  // --- PHASE 2: LONG FORMAT PACKETS ---
  for (int rep = 0; rep < 5; rep++) {
    memset(packet, 0x00, sizeof(packet));

    packet[0] = type_base | 0x01;  // 0x89 or 0x8B (long format)
    packet[1] = this->tx_sequence_;
    packet[2] = (device_id >> 0) & 0xFF;
    packet[3] = (device_id >> 8) & 0xFF;
    packet[4] = (device_id >> 16) & 0xFF;
    packet[5] = (device_id >> 24) & 0xFF;
    packet[6] = 0x21;
    packet[7] = 0x0E;  // Long format indicator
    packet[8] = 0x03;
    packet[9] = 0x00;
    packet[10] = button;
    packet[11] = 0x01;  // Long format extended flag

    // Device ID repeated
    packet[12] = (device_id >> 0) & 0xFF;
    packet[13] = (device_id >> 8) & 0xFF;
    packet[14] = (device_id >> 16) & 0xFF;
    packet[15] = (device_id >> 24) & 0xFF;
    packet[16] = 0x00;

    // Button-specific extended data
    if (button == 0x05) {
      // RAISE: 42 02 01 00 16
      packet[17] = 0x42;
      packet[18] = 0x02;
      packet[19] = 0x01;
      packet[20] = 0x00;
      packet[21] = 0x16;
    } else if (button == 0x06) {
      // LOWER: 42 02 00 00 43
      packet[17] = 0x42;
      packet[18] = 0x02;
      packet[19] = 0x00;
      packet[20] = 0x00;
      packet[21] = 0x43;
    } else {
      // ON/OFF/FAVORITE: 40 00 XX 00 00 where XX = 0x1E + button
      packet[17] = 0x40;
      packet[18] = 0x00;
      packet[19] = 0x1E + button;  // ON=0x20, FAVORITE=0x21, OFF=0x22
      packet[20] = 0x00;
      packet[21] = 0x00;
    }

    uint16_t crc = this->calc_crc_(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    ESP_LOGD(TAG, "TX LONG seq=%02X type=%02X btn=%02X ext=%02X%02X%02X%02X%02X CRC=%04X",
             this->tx_sequence_, packet[0], button,
             packet[17], packet[18], packet[19], packet[20], packet[21], crc);

    this->transmit_packet_(packet, 24);
    this->tx_sequence_ += 6;

    if (rep < 4) {
      delay(70);
    }
  }

  ESP_LOGI(TAG, "Button press complete (sent 5 short + 5 long packets)");
}

void LutronCC1101::send_level(uint32_t device_id, uint8_t level_percent) {
  ESP_LOGI(TAG, "Sending level %d%% to device %08X", level_percent, device_id);

  // Clamp level to 0-100
  if (level_percent > 100) level_percent = 100;

  // Convert percentage to 16-bit value (0x0000 = 0%, 0xFEFF = 100%)
  // Note: 0xFFFF is reserved/invalid - bridge uses 0xFEFF for 100%
  uint16_t level_value;
  if (level_percent == 100) {
    level_value = 0xFEFF;  // Special case: 100% = 0xFEFF
  } else {
    level_value = (uint16_t)((uint32_t)level_percent * 65279 / 100);
  }

  uint8_t packet[24];

  // Bridge-style level command packet structure (based on capture analysis)
  // Send multiple packets like the bridge does
  for (int rep = 0; rep < 5; rep++) {
    memset(packet, 0x00, sizeof(packet));

    // Packet type increments: 0x81, 0x82, 0x83...
    packet[0] = 0x81 + (this->tx_sequence_ / 32) % 3;
    packet[1] = this->tx_sequence_;

    // Target device ID
    packet[2] = (device_id >> 0) & 0xFF;
    packet[3] = (device_id >> 8) & 0xFF;
    packet[4] = (device_id >> 16) & 0xFF;
    packet[5] = (device_id >> 24) & 0xFF;

    // Protocol constants from bridge capture
    packet[6] = 0x21;
    packet[7] = 0x0E;  // Long format
    packet[8] = 0x00;
    packet[9] = 0x07;  // Level command type
    packet[10] = 0x03;

    // Unknown constants from bridge capture (may be zone/group ID)
    packet[11] = 0xC3;
    packet[12] = 0xC6;
    packet[13] = 0xFE;
    packet[14] = 0x40;

    packet[15] = 0x02;

    // Level value (16-bit big-endian)
    packet[16] = (level_value >> 8) & 0xFF;
    packet[17] = level_value & 0xFF;

    packet[18] = 0x00;
    packet[19] = 0x01;
    packet[20] = 0x00;
    packet[21] = 0x00;

    // Calculate CRC
    uint16_t crc = this->calc_crc_(packet, 22);
    packet[22] = (crc >> 8) & 0xFF;
    packet[23] = crc & 0xFF;

    ESP_LOGD(TAG, "TX LEVEL seq=%02X type=%02X dev=%02X%02X%02X%02X level=%04X CRC=%04X",
             this->tx_sequence_, packet[0],
             packet[2], packet[3], packet[4], packet[5],
             level_value, crc);

    this->transmit_packet_(packet, 24);
    this->tx_sequence_ += 6;

    if (rep < 4) {
      delay(70);
    }
  }

  ESP_LOGI(TAG, "Level command complete");
}

void LutronCC1101::send_raw_packet(const uint8_t *packet, size_t len) {
  this->transmit_packet_(packet, len);
}

}  // namespace lutron_cc1101
}  // namespace esphome
