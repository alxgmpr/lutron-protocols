#include "cc1101_radio.h"
#include "esphome/core/log.h"

namespace esphome {
namespace cc1101_cca {

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

  // Frequency: 433.602844 MHz — matches CC1150 TX (FREQ=0x10AD52)
  // Previously had +13 kHz "calibration offset" (FREQ0=0x73) which was wrong
  this->write_register(CC1101_FREQ2, 0x10);
  this->write_register(CC1101_FREQ1, 0xAD);
  this->write_register(CC1101_FREQ0, 0x52);

  // Channel filter BW + data rate exponent
  // CHANBW_E=1, CHANBW_M=1 → BW = 26MHz/(8*5*2) = 325 kHz
  // Bridge commands decode reliably at this BW.
  // Dimmer responses fail with strict=5 at ALL BW settings (270/325/406/812 kHz)
  // — this is NOT an RF issue, it's a protocol/encoding difference.
  this->write_register(CC1101_MDMCFG4, 0x5B);
  // Data rate mantissa: 62.4847 kBaud
  this->write_register(CC1101_MDMCFG3, 0x3B);

  // Modulation: 2-FSK, no sync word
  // CC1150 from Hackaday uses GFSK (0x10) but some Lutron devices (dimmers)
  // may use plain 2-FSK. 2-FSK demod works for both signal types.
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

  // Main Radio Control State Machine
  // MCSM1: Auto-RX after TX for fast turnaround
  //   Bits 5:4 = CCA_MODE: 00 (Always clear)
  //   Bits 3:2 = RXOFF_MODE: 00 (IDLE after RX)
  //   Bits 1:0 = TXOFF_MODE: 11 (RX after TX)
  this->write_register(CC1101_MCSM1, 0x03);
  // MCSM0: Auto-calibrate when going from IDLE to RX/TX
  this->write_register(CC1101_MCSM0, 0x18);

  // AGC
  this->write_register(CC1101_AGCCTRL2, 0x43);
  this->write_register(CC1101_AGCCTRL1, 0x40);
  this->write_register(CC1101_AGCCTRL0, 0x91);

  // Frequency Offset Compensation
  // FOC_BS_CS_GATE=0 (AFC always active, not gated on carrier sense)
  // FOC_PRE_K=10 (2K pre-sync loop gain)
  // FOC_POST_K=1 (K/2 post-sync)
  // FOC_LIMIT=10 (±BW_chan/4 = ±101 kHz compensation range)
  // Different Lutron devices have different crystal offsets — AFC tracks per-packet.
  this->write_register(CC1101_FOCCFG, 0x16);

  // Bit Synchronization Configuration
  // BS_PRE_KI=01 (KI), BS_PRE_KP=10 (2Kp), BS_POST_KI=1 (KI/2), BS_POST_KP=0 (Kp)
  // BS_LIMIT=00 (no data rate offset compensation)
  // SmartRF Studio default for 2-FSK at 62.5 kBaud.
  this->write_register(CC1101_BSCFG, 0x6C);

  // Front end config
  this->write_register(CC1101_FREND1, 0x56);
  this->write_register(CC1101_FREND0, 0x10);

  // Frequency calibration (matches CC1150 TX: FSCAL3=0xEA)
  this->write_register(CC1101_FSCAL3, 0xEA);
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

  // Write in chunks with small delays to avoid overwhelming the FIFO
  // This helps prevent corruption at the tail of longer packets
  const size_t CHUNK_SIZE = 16;
  for (size_t i = 0; i < len; i++) {
    this->spi_->spi_transfer(data[i]);
    // Add small delay every CHUNK_SIZE bytes
    if ((i + 1) % CHUNK_SIZE == 0 && i + 1 < len) {
      delayMicroseconds(10);  // Brief pause to let FIFO settle
    }
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

  ESP_LOGV(TAG, "Starting RX mode...");

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
  // Bits 6:4 = 000 = 2-FSK (works for both 2-FSK and GFSK transmitters)
  // Bit 3 = 0 = no Manchester
  // Bits 2:0 = 001 = 15/16 sync word bits (allows 1 bit error for robustness)
  this->write_register(CC1101_MDMCFG2, 0x01);

  // PKTCTRL0: FIFO packet mode, FIXED length
  this->write_register(CC1101_PKTCTRL0, 0x00);

  // PKTCTRL1: No address check, no append status
  this->write_register(CC1101_PKTCTRL1, 0x00);

  // Set packet length for RX - 110 bytes to capture overlapping transmissions.
  // When two CCA devices transmit back-to-back (e.g. hub config + dimmer response),
  // the CC1101 captures both in one FIFO fill. A 53-byte config packet as the second
  // transmission needs ~75 raw bytes after the first packet's sync. With PKTLEN=80,
  // the second packet is truncated at ~44 N81 bytes (need 53). PKTLEN=110 gives
  // enough room for both a 24-byte and 53-byte packet with their preambles.
  this->write_register(CC1101_PKTLEN, 110);

  // Reset accumulation buffer
  this->rx_accum_pos_ = 0;

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
}

void CC1101Radio::stop_rx() {
  this->set_idle();
  delay(1);
  this->flush_rx();

  // Reset to fixed packet mode
  this->write_register(CC1101_PKTCTRL0, 0x00);

  // Reset GDO0 to default (TX mode signal)
  this->write_register(CC1101_IOCFG0, 0x06);

  this->rx_accum_pos_ = 0;
  this->rx_active_ = false;
}

bool CC1101Radio::check_rx() {
  if (!this->rx_active_) {
    return false;
  }

  // Read RXBYTES status register
  uint8_t rx_bytes_raw = this->read_status_register(CC1101_RXBYTES);
  bool overflow = (rx_bytes_raw & 0x80) != 0;
  uint8_t rx_bytes = rx_bytes_raw & 0x7F;

  if (overflow) {
    this->overflow_count_++;
    ESP_LOGW(TAG, "FIFO OVERFLOW #%u (accum=%u) - delivering partial data",
             this->overflow_count_, this->rx_accum_pos_);
    // Deliver whatever we accumulated before the overflow
    bool had_data = this->rx_accum_pos_ > 0;
    if (had_data && this->rx_callback_ != nullptr) {
      uint8_t rssi_raw = this->read_status_register(CC1101_RSSI_REG);
      int8_t rssi = (rssi_raw >= 128) ? ((rssi_raw - 256) / 2 - 74) : (rssi_raw / 2 - 74);
      this->rx_callback_(this->rx_accum_, this->rx_accum_pos_, rssi);
    }
    this->rx_accum_pos_ = 0;
    this->set_idle();
    this->flush_rx();
    this->strobe(CC1101_SRX);
    return had_data;
  }

  if (rx_bytes == 0 && this->rx_accum_pos_ == 0) {
    return false;
  }

  // PKTLEN is 110. At 62.5 kbaud (7812.5 bytes/s), 110 bytes takes ~14ms.
  // The 64-byte FIFO fills in ~8.2ms, so we must drain mid-packet.
  // Strategy: once we see bytes, enter a tight loop accumulating into rx_accum_
  // until we have 110 bytes, the FIFO goes idle for >2ms, or 20ms timeout.
  const size_t PKTLEN = 110;
  const uint32_t IDLE_TIMEOUT_US = 2000;   // 2ms with no new bytes = end of packet
  const uint32_t TOTAL_TIMEOUT_MS = 20;    // 20ms safety timeout

  uint32_t loop_start = millis();
  uint32_t last_byte_time = micros();

  while (this->rx_accum_pos_ < PKTLEN) {
    rx_bytes_raw = this->read_status_register(CC1101_RXBYTES);
    overflow = (rx_bytes_raw & 0x80) != 0;
    rx_bytes = rx_bytes_raw & 0x7F;

    if (overflow) {
      this->overflow_count_++;
      ESP_LOGW(TAG, "FIFO OVERFLOW mid-accumulation #%u (accum=%u)",
               this->overflow_count_, this->rx_accum_pos_);
      break;  // Deliver what we have
    }

    if (rx_bytes > 0) {
      // Read available bytes into accumulation buffer
      size_t space = RX_ACCUM_SIZE - this->rx_accum_pos_;
      size_t to_read = (rx_bytes < space) ? rx_bytes : space;
      if (to_read > 0) {
        this->read_burst(CC1101_RXFIFO, this->rx_accum_ + this->rx_accum_pos_, to_read);
        this->rx_accum_pos_ += to_read;
      }
      last_byte_time = micros();

      if (space == 0) {
        break;  // Accumulation buffer full
      }
    } else {
      // No bytes available - check if transmission ended
      if (this->rx_accum_pos_ > 0 && (micros() - last_byte_time) > IDLE_TIMEOUT_US) {
        break;  // No new bytes for 2ms, packet is done
      }
    }

    // Safety timeout
    if ((millis() - loop_start) > TOTAL_TIMEOUT_MS) {
      ESP_LOGW(TAG, "RX accumulation timeout (accum=%u)", this->rx_accum_pos_);
      break;
    }

    delayMicroseconds(50);  // Brief yield between FIFO polls
  }

  // Minimum viable packet: 35 raw bytes = 280 bits (decoder needs bit_pos + 270 < total)
  const size_t MIN_PACKET_LEN = 35;
  if (this->rx_accum_pos_ < MIN_PACKET_LEN) {
    // Not enough data for a valid packet - reset and continue
    this->rx_accum_pos_ = 0;
    this->set_idle();
    this->flush_rx();
    this->strobe(CC1101_SRX);
    return false;
  }

  // Read RSSI from status register
  uint8_t rssi_raw = this->read_status_register(CC1101_RSSI_REG);
  int8_t rssi = (rssi_raw >= 128) ? ((rssi_raw - 256) / 2 - 74) : (rssi_raw / 2 - 74);

  ESP_LOGV(TAG, "RX accumulated %u bytes (RSSI=%d)", this->rx_accum_pos_, rssi);

  // Deliver accumulated packet
  if (this->rx_callback_ != nullptr) {
    this->rx_callback_(this->rx_accum_, this->rx_accum_pos_, rssi);
  }

  // Reset accumulator and re-enter RX
  this->rx_accum_pos_ = 0;
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

  // Full state reset before TX to handle RX->TX transition properly
  this->set_idle();

  // Wait for radio to actually be in IDLE state
  uint32_t start = millis();
  while ((this->read_status_register(CC1101_MARCSTATE) & 0x1F) != 0x01) {
    if (millis() - start > 10) {
      ESP_LOGW(TAG, "Timeout waiting for IDLE state");
      break;
    }
    delayMicroseconds(100);
  }

  // Flush BOTH FIFOs - RX FIFO can have garbage that affects state machine
  this->flush_rx();
  this->flush_tx();
  delay(1);

  const size_t FIFO_SIZE = 64;

  if (len <= FIFO_SIZE) {
    // Set fixed length mode and packet length
    this->write_register(CC1101_PKTCTRL0, 0x00);  // Fixed length mode
    this->write_register(CC1101_PKTLEN, len);

    // Small delay for register writes to take effect
    delayMicroseconds(500);

    this->write_burst(CC1101_TXFIFO, data, len);

    // Verify FIFO was written correctly
    uint8_t txbytes = this->read_status_register(CC1101_TXBYTES) & 0x7F;
    if (txbytes != len) {
      ESP_LOGW(TAG, "FIFO mismatch: wrote %d, FIFO has %d", len, txbytes);
    }

    this->strobe(CC1101_STX);
  } else {
    // Large packet - use INFINITE mode and time-based completion
    // This bypasses PKTLEN completely, which seems to not work correctly
    ESP_LOGV(TAG, "Large packet (%d bytes), using INFINITE mode", len);

    // Set INFINITE packet mode (radio transmits until we stop it)
    this->write_register(CC1101_PKTCTRL0, 0x02);  // LENGTH_CONFIG = 10 (infinite)

    // Fill FIFO with first 64 bytes
    this->write_burst(CC1101_TXFIFO, data, FIFO_SIZE);
    size_t bytes_written = FIFO_SIZE;
    size_t remaining = len - bytes_written;

    ESP_LOGVV(TAG, "Initial fill: %d bytes, remaining: %d", bytes_written, remaining);

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
          ESP_LOGVV(TAG, "Refill #%d: +%d (total %d/%d, FIFO was %d)",
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

    ESP_LOGVV(TAG, "All %d bytes written, waiting for FIFO to drain...", bytes_written);

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
    ESP_LOGV(TAG, "Transmitted %d bytes in %dms (%d refills)", bytes_written, elapsed, refill_count);
  }

  // Wait for TX to complete
  // With MCSM1 TXOFF_MODE=11, radio auto-transitions to RX (0x0D) after TX
  // Also accept IDLE (0x01) for backwards compatibility
  int timeout = 200;
  while (timeout-- > 0) {
    uint8_t state = this->get_state();
    if (state == 0x01 || state == 0x0D || state == 0x0E) break;  // IDLE, RX, or FSTXON
    if (state == 0x16) {  // TX_UNDERFLOW
      this->flush_tx();
      return false;
    }
    delay(1);
  }

  // Don't force IDLE - let auto-RX take effect if configured
  // The caller (lutron_cc1101.cpp) will call start_rx() if needed
  return true;
}

}  // namespace cc1101_cca
}  // namespace esphome
