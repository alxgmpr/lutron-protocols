#include "cc1101_radio.h"
#include "esphome/core/log.h"

namespace esphome {
namespace lutron_cc1101 {

static const char *const TAG = "cc1101_radio";

void CC1101Radio::init(CC1101SPI *spi, GPIOPin *gdo0_pin) {
  ESP_LOGI(TAG, "Initializing CC1101 radio...");

  this->spi_ = spi;
  this->gdo0_pin_ = gdo0_pin;

  if (this->gdo0_pin_ != nullptr) {
    this->gdo0_pin_->setup();
  }

  // Reset the radio
  this->reset();
  delay(10);

  // Verify CC1101 is responding
  uint8_t partnum = this->read_status_register(0x30);  // PARTNUM
  uint8_t version = this->read_status_register(0x31);  // VERSION
  ESP_LOGI(TAG, "CC1101 PARTNUM=0x%02X VERSION=0x%02X (expected 0x00, 0x14)", partnum, version);

  if (version != 0x14) {
    ESP_LOGE(TAG, "CC1101 not detected! Check wiring.");
    return;
  }

  // Configure for Lutron CCA
  this->strobe(CC1101_SIDLE);
  delay(1);

  // Frequency: 433.602844 MHz + 13 kHz calibration offset
  this->write_register(CC1101_FREQ2, 0x10);
  this->write_register(CC1101_FREQ1, 0xAD);
  this->write_register(CC1101_FREQ0, 0x73);

  // Data rate: 62.4847 kBaud
  this->write_register(CC1101_MDMCFG4, 0x0B);
  this->write_register(CC1101_MDMCFG3, 0x3B);

  // Modulation: 2-FSK, no sync word
  this->write_register(CC1101_MDMCFG2, 0x00);
  this->write_register(CC1101_MDMCFG1, 0x00);
  this->write_register(CC1101_MDMCFG0, 0x00);

  // Deviation: 41.2 kHz
  this->write_register(CC1101_DEVIATN, 0x45);

  // Packet config
  this->write_register(CC1101_PKTCTRL1, 0x00);
  this->write_register(CC1101_PKTCTRL0, 0x00);

  // No address filtering
  this->write_register(CC1101_ADDR, 0x00);
  this->write_register(CC1101_CHANNR, 0x00);

  // Frequency synthesizer
  this->write_register(CC1101_FSCTRL1, 0x06);
  this->write_register(CC1101_FSCTRL0, 0x00);

  // Auto-calibrate
  this->write_register(CC1101_MCSM0, 0x18);

  // AGC
  this->write_register(CC1101_AGCCTRL2, 0x43);
  this->write_register(CC1101_AGCCTRL1, 0x40);
  this->write_register(CC1101_AGCCTRL0, 0x91);

  // Front end config
  this->write_register(CC1101_FREND1, 0x56);
  this->write_register(CC1101_FREND0, 0x10);

  // Frequency calibration
  this->write_register(CC1101_FSCAL3, 0xE9);
  this->write_register(CC1101_FSCAL2, 0x2A);
  this->write_register(CC1101_FSCAL1, 0x00);
  this->write_register(CC1101_FSCAL0, 0x1F);

  // GDO pins
  this->write_register(CC1101_IOCFG2, 0x29);
  this->write_register(CC1101_IOCFG0, 0x06);

  // PA Table (+10 dBm)
  uint8_t pa_table[] = {0xC0};
  this->write_burst(CC1101_PATABLE, pa_table, 1);

  this->initialized_ = true;
  ESP_LOGI(TAG, "CC1101 initialized (433.6 MHz, 2-FSK, 62.5 kBaud)");
}

void CC1101Radio::reset() {
  this->spi_->spi_disable();
  delayMicroseconds(5);
  this->spi_->spi_enable();
  delayMicroseconds(10);
  this->spi_->spi_disable();
  delayMicroseconds(45);

  this->strobe(CC1101_SRES);
  delay(10);
}

void CC1101Radio::strobe(uint8_t cmd) {
  this->spi_->spi_enable();
  this->spi_->spi_transfer(cmd);
  this->spi_->spi_disable();
}

void CC1101Radio::write_register(uint8_t reg, uint8_t value) {
  this->spi_->spi_enable();
  this->spi_->spi_transfer(reg | CC1101_WRITE_SINGLE);
  this->spi_->spi_transfer(value);
  this->spi_->spi_disable();
}

uint8_t CC1101Radio::read_register(uint8_t reg) {
  this->spi_->spi_enable();
  this->spi_->spi_transfer(reg | CC1101_READ_SINGLE);
  uint8_t value = this->spi_->spi_transfer(0);
  this->spi_->spi_disable();
  return value;
}

uint8_t CC1101Radio::read_status_register(uint8_t reg) {
  this->spi_->spi_enable();
  this->spi_->spi_transfer(reg | CC1101_READ_BURST);
  uint8_t value = this->spi_->spi_transfer(0);
  this->spi_->spi_disable();
  return value;
}

void CC1101Radio::write_burst(uint8_t reg, const uint8_t *data, size_t len) {
  this->spi_->spi_enable();
  this->spi_->spi_transfer(reg | CC1101_WRITE_BURST);
  for (size_t i = 0; i < len; i++) {
    this->spi_->spi_transfer(data[i]);
  }
  this->spi_->spi_disable();
}

void CC1101Radio::set_idle() {
  this->strobe(CC1101_SIDLE);
}

void CC1101Radio::flush_tx() {
  this->strobe(CC1101_SFTX);
}

void CC1101Radio::flush_rx() {
  this->strobe(CC1101_SFRX);
}

uint8_t CC1101Radio::get_state() {
  return this->read_status_register(CC1101_MARCSTATE) & 0x1F;
}

uint8_t CC1101Radio::get_tx_bytes() {
  return this->read_status_register(CC1101_TXBYTES) & 0x7F;
}

uint8_t CC1101Radio::get_rx_bytes() {
  return this->read_status_register(CC1101_RXBYTES) & 0x7F;
}

void CC1101Radio::read_burst(uint8_t reg, uint8_t *data, size_t len) {
  this->spi_->spi_enable();
  this->spi_->spi_transfer(reg | CC1101_READ_BURST);
  for (size_t i = 0; i < len; i++) {
    data[i] = this->spi_->spi_transfer(0);
  }
  this->spi_->spi_disable();
}

void CC1101Radio::start_rx() {
  if (!this->initialized_) {
    ESP_LOGE(TAG, "Cannot start RX - radio not initialized");
    return;
  }

  ESP_LOGI(TAG, "Starting RX mode...");

  // Go to IDLE first
  this->set_idle();
  delay(1);

  // Flush any stale RX data
  this->flush_rx();
  delay(1);

  // Sync word: Use 0xAAAA to match the Lutron preamble
  // This will trigger on preamble, then we capture data after
  // The decoder will find the actual packet start in the captured data
  this->write_register(CC1101_SYNC1, 0xAA);
  this->write_register(CC1101_SYNC0, 0xAA);

  // MDMCFG2: 2-FSK, 15/16 sync word (allow 1 bit error)
  // Bits 6:4 = 000 = 2-FSK
  // Bit 3 = 0 = no Manchester
  // Bits 2:0 = 001 = 15/16 sync word bits (allows 1 bit error for robustness)
  this->write_register(CC1101_MDMCFG2, 0x01);

  // PKTCTRL0: FIFO packet mode, FIXED length
  this->write_register(CC1101_PKTCTRL0, 0x00);

  // PKTCTRL1: No address check, no append status
  this->write_register(CC1101_PKTCTRL1, 0x00);

  // Capture 48 bytes to ensure we get the full packet
  // Lutron packets are ~37 bytes encoded (24 payload * 10/8 + overhead)
  this->write_register(CC1101_PKTLEN, 48);

  // GDO0: Assert when sync word detected, deassert on end of packet
  this->write_register(CC1101_IOCFG0, 0x06);

  // FIFO threshold
  this->write_register(CC1101_FIFOTHR, 0x0F);

  // Carrier sense threshold: set to -10 dBm relative to MAGN_TARGET
  // This helps reject noise - only trigger on strong signals
  // AGCCTRL1 bits 3:0 = carrier sense threshold
  // 0x00 = relative threshold disabled (use absolute)
  // Let's use 0x40 which enables carrier sense at ~-7dB from RSSI
  uint8_t agcctrl1 = this->read_register(CC1101_AGCCTRL1);
  this->write_register(CC1101_AGCCTRL1, (agcctrl1 & 0xF0) | 0x00);  // Keep as is for now

  // Enter RX mode
  this->strobe(CC1101_SRX);

  this->rx_active_ = true;
  ESP_LOGI(TAG, "RX mode active (sync=0xAAAA, fixed 48 bytes, 15/16 sync)");
}

void CC1101Radio::stop_rx() {
  ESP_LOGI(TAG, "Stopping RX mode...");

  this->set_idle();
  delay(1);
  this->flush_rx();

  // Reset to fixed packet mode
  this->write_register(CC1101_PKTCTRL0, 0x00);

  // Reset GDO0 to default (TX mode signal)
  this->write_register(CC1101_IOCFG0, 0x06);

  this->rx_active_ = false;
  ESP_LOGI(TAG, "RX mode stopped");
}

bool CC1101Radio::check_rx() {
  if (!this->rx_active_) {
    return false;
  }

  // Skip GDO0 check for now - just poll RXBYTES directly
  // (GDO0 should assert when sync found, but let's verify FIFO state)

  // Read RXBYTES status register
  uint8_t rx_bytes_raw = this->read_status_register(CC1101_RXBYTES);
  bool overflow = (rx_bytes_raw & 0x80) != 0;
  uint8_t rx_bytes = rx_bytes_raw & 0x7F;

  if (overflow) {
    ESP_LOGW(TAG, "RX FIFO overflow, flushing");
    this->set_idle();
    this->flush_rx();
    this->strobe(CC1101_SRX);
    return false;
  }

  if (rx_bytes == 0) {
    return false;
  }

  // Fixed length mode: expect 48 bytes
  const uint8_t PACKET_LEN = 48;

  // Check if we have enough bytes
  if (rx_bytes < PACKET_LEN) {
    // Not enough data yet, wait for more
    return false;
  }

  // Read the payload
  uint8_t buffer[64];
  uint8_t payload_length = PACKET_LEN;
  this->read_burst(CC1101_RXFIFO, buffer, payload_length);

  // Read RSSI and LQI from registers
  uint8_t rssi_raw = this->read_status_register(CC1101_RSSI_REG);
  uint8_t lqi_raw = this->read_status_register(CC1101_LQI_REG);
  int8_t rssi = (rssi_raw >= 128) ? ((rssi_raw - 256) / 2 - 74) : (rssi_raw / 2 - 74);
  bool crc_ok = (lqi_raw & 0x80) != 0;

  // Don't log here - let callback handle logging for valid packets only

  // Call callback if set
  if (this->rx_callback_ != nullptr) {
    this->rx_callback_(buffer, payload_length, rssi);
  }

  // Return to RX mode
  this->set_idle();
  this->flush_rx();
  this->strobe(CC1101_SRX);

  return true;
}

bool CC1101Radio::transmit_raw(const uint8_t *data, size_t len) {
  if (!this->initialized_) {
    ESP_LOGE(TAG, "Radio not initialized!");
    return false;
  }

  this->set_idle();
  delay(2);
  this->flush_tx();
  delay(1);

  const size_t FIFO_SIZE = 64;

  // Debug: Log first 16 bytes being sent
  ESP_LOGD(TAG, "TX %d bytes: %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X",
           len,
           len > 0 ? data[0] : 0, len > 1 ? data[1] : 0, len > 2 ? data[2] : 0, len > 3 ? data[3] : 0,
           len > 4 ? data[4] : 0, len > 5 ? data[5] : 0, len > 6 ? data[6] : 0, len > 7 ? data[7] : 0,
           len > 8 ? data[8] : 0, len > 9 ? data[9] : 0, len > 10 ? data[10] : 0, len > 11 ? data[11] : 0,
           len > 12 ? data[12] : 0, len > 13 ? data[13] : 0, len > 14 ? data[14] : 0, len > 15 ? data[15] : 0);

  if (len <= FIFO_SIZE) {
    this->write_register(CC1101_PKTLEN, len);
    this->write_burst(CC1101_TXFIFO, data, len);
    this->strobe(CC1101_STX);
  } else {
    // Large packet - use INFINITE mode and time-based completion
    // This bypasses PKTLEN completely, which seems to not work correctly
    ESP_LOGI(TAG, "Large packet (%d bytes), using INFINITE mode with timing", len);

    // Set INFINITE packet mode (radio transmits until we stop it)
    this->write_register(CC1101_PKTCTRL0, 0x02);  // LENGTH_CONFIG = 10 (infinite)

    // Fill FIFO with first 64 bytes
    this->write_burst(CC1101_TXFIFO, data, FIFO_SIZE);
    size_t bytes_written = FIFO_SIZE;
    size_t remaining = len - bytes_written;

    ESP_LOGD(TAG, "Initial fill: %d bytes, remaining: %d", bytes_written, remaining);

    // Start TX
    this->strobe(CC1101_STX);

    uint32_t start_time = millis();
    int refill_count = 0;

    // Refill until all bytes are written
    while (remaining > 0) {
      uint8_t txbytes_raw = this->read_status_register(CC1101_TXBYTES);
      bool underflow = (txbytes_raw & 0x80) != 0;
      uint8_t txbytes = txbytes_raw & 0x7F;

      if (underflow) {
        ESP_LOGE(TAG, "TX FIFO underflow! Written %d/%d", bytes_written, len);
        this->strobe(CC1101_SIDLE);
        this->flush_tx();
        this->write_register(CC1101_PKTCTRL0, 0x00);  // Reset to fixed mode
        return false;
      }

      // Refill when FIFO has space
      if (txbytes < 48) {
        size_t fifo_free = FIFO_SIZE - txbytes;
        size_t to_write = (remaining < fifo_free) ? remaining : fifo_free;

        if (to_write > 0) {
          this->write_burst(CC1101_TXFIFO, data + bytes_written, to_write);
          bytes_written += to_write;
          remaining -= to_write;
          refill_count++;
          ESP_LOGD(TAG, "Refill #%d: +%d (total %d/%d, FIFO was %d)",
                   refill_count, to_write, bytes_written, len, txbytes);
        }
      }

      delayMicroseconds(10);

      if (millis() - start_time > 100) {
        ESP_LOGE(TAG, "Refill timeout! Written %d/%d", bytes_written, len);
        this->strobe(CC1101_SIDLE);
        this->flush_tx();
        this->write_register(CC1101_PKTCTRL0, 0x00);
        return false;
      }
    }

    ESP_LOGD(TAG, "All %d bytes written, waiting for FIFO to drain...", bytes_written);

    // Wait for FIFO to drain and last byte to finish transmitting
    // In INFINITE mode, when TXBYTES=0, the last byte may still be in the shift register
    // At 62.5 kbaud, one byte = 8 bits = 128us
    int drain_timeout = 50;  // 50ms max
    while (drain_timeout-- > 0) {
      uint8_t txbytes = this->get_tx_bytes();
      if (txbytes == 0) {
        // FIFO is empty - wait for shift register to finish (1 byte + margin)
        delayMicroseconds(200);
        break;
      }
      delay(1);
    }

    // Stop transmission
    this->strobe(CC1101_SIDLE);

    // Reset to fixed mode for next transmission
    this->write_register(CC1101_PKTCTRL0, 0x00);

    uint32_t elapsed = millis() - start_time;
    ESP_LOGI(TAG, "Transmitted %d bytes in %dms (%d refills, INFINITE mode)",
             bytes_written, elapsed, refill_count);
  }

  int timeout = 200;
  while (timeout-- > 0) {
    uint8_t state = this->get_state();
    if (state == 0x01) break;
    if (state == 0x16) {
      this->flush_tx();
      return false;
    }
    delay(1);
  }

  this->set_idle();
  return true;
}

}  // namespace lutron_cc1101
}  // namespace esphome
