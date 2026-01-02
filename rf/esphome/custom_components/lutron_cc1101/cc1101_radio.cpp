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

uint8_t CC1101Radio::get_state() {
  return this->read_status_register(CC1101_MARCSTATE) & 0x1F;
}

uint8_t CC1101Radio::get_tx_bytes() {
  return this->read_status_register(CC1101_TXBYTES) & 0x7F;
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

  if (len <= FIFO_SIZE) {
    this->write_register(CC1101_PKTLEN, len);
    this->write_burst(CC1101_TXFIFO, data, len);
    this->strobe(CC1101_STX);
  } else {
    ESP_LOGD(TAG, "Large packet (%d bytes), streaming", len);

    this->write_register(CC1101_PKTLEN, len);

    size_t initial_fill = FIFO_SIZE - 4;
    this->write_burst(CC1101_TXFIFO, data, initial_fill);
    size_t bytes_written = initial_fill;

    this->strobe(CC1101_STX);

    while (bytes_written < len) {
      uint8_t txbytes = this->get_tx_bytes();

      if (txbytes < 32) {
        size_t fifo_free = FIFO_SIZE - txbytes;
        size_t remaining = len - bytes_written;
        size_t to_write = (remaining < fifo_free) ? remaining : fifo_free;

        if (to_write > 0) {
          this->write_burst(CC1101_TXFIFO, data + bytes_written, to_write);
          bytes_written += to_write;
        }
      }

      uint8_t state = this->get_state();
      if (state == 0x01) break;
      if (state == 0x16) {
        ESP_LOGW(TAG, "TX underflow at %d/%d", bytes_written, len);
        this->flush_tx();
        return false;
      }

      delayMicroseconds(50);
    }
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
