#pragma once

#include <functional>
#include "esphome/core/component.h"
#include "esphome/components/spi/spi.h"
#include "esphome/core/hal.h"

namespace esphome {
namespace cc1101_cca {

// CC1101 Strobe Commands
static const uint8_t CC1101_SRES = 0x30;
static const uint8_t CC1101_SFSTXON = 0x31;
static const uint8_t CC1101_SXOFF = 0x32;
static const uint8_t CC1101_SCAL = 0x33;
static const uint8_t CC1101_SRX = 0x34;
static const uint8_t CC1101_STX = 0x35;
static const uint8_t CC1101_SIDLE = 0x36;
static const uint8_t CC1101_SFTX = 0x3B;
static const uint8_t CC1101_SFRX = 0x3A;
static const uint8_t CC1101_SNOP = 0x3D;

// CC1101 Registers
static const uint8_t CC1101_IOCFG2 = 0x00;
static const uint8_t CC1101_IOCFG1 = 0x01;
static const uint8_t CC1101_IOCFG0 = 0x02;
static const uint8_t CC1101_FIFOTHR = 0x03;
static const uint8_t CC1101_SYNC1 = 0x04;
static const uint8_t CC1101_SYNC0 = 0x05;
static const uint8_t CC1101_PKTLEN = 0x06;
static const uint8_t CC1101_PKTCTRL1 = 0x07;
static const uint8_t CC1101_PKTCTRL0 = 0x08;
static const uint8_t CC1101_ADDR = 0x09;
static const uint8_t CC1101_CHANNR = 0x0A;
static const uint8_t CC1101_FSCTRL1 = 0x0B;
static const uint8_t CC1101_FSCTRL0 = 0x0C;
static const uint8_t CC1101_FREQ2 = 0x0D;
static const uint8_t CC1101_FREQ1 = 0x0E;
static const uint8_t CC1101_FREQ0 = 0x0F;
static const uint8_t CC1101_MDMCFG4 = 0x10;
static const uint8_t CC1101_MDMCFG3 = 0x11;
static const uint8_t CC1101_MDMCFG2 = 0x12;
static const uint8_t CC1101_MDMCFG1 = 0x13;
static const uint8_t CC1101_MDMCFG0 = 0x14;
static const uint8_t CC1101_DEVIATN = 0x15;
static const uint8_t CC1101_MCSM2 = 0x16;
static const uint8_t CC1101_MCSM1 = 0x17;
static const uint8_t CC1101_MCSM0 = 0x18;
static const uint8_t CC1101_FOCCFG = 0x19;
static const uint8_t CC1101_BSCFG = 0x1A;
static const uint8_t CC1101_AGCCTRL2 = 0x1B;
static const uint8_t CC1101_AGCCTRL1 = 0x1C;
static const uint8_t CC1101_AGCCTRL0 = 0x1D;
static const uint8_t CC1101_FREND1 = 0x21;
static const uint8_t CC1101_FREND0 = 0x22;
static const uint8_t CC1101_FSCAL3 = 0x23;
static const uint8_t CC1101_FSCAL2 = 0x24;
static const uint8_t CC1101_FSCAL1 = 0x25;
static const uint8_t CC1101_FSCAL0 = 0x26;
static const uint8_t CC1101_TEST2 = 0x2C;
static const uint8_t CC1101_TEST1 = 0x2D;
static const uint8_t CC1101_TEST0 = 0x2E;
static const uint8_t CC1101_PATABLE = 0x3E;
static const uint8_t CC1101_TXFIFO = 0x3F;
static const uint8_t CC1101_RXFIFO = 0x3F;
static const uint8_t CC1101_MARCSTATE = 0x35;
static const uint8_t CC1101_PKTSTATUS = 0x38;
static const uint8_t CC1101_TXBYTES = 0x3A;
static const uint8_t CC1101_RXBYTES = 0x3B;
static const uint8_t CC1101_RSSI_REG = 0x34;
static const uint8_t CC1101_LQI_REG = 0x33;

// SPI access modes
static const uint8_t CC1101_WRITE_SINGLE = 0x00;
static const uint8_t CC1101_WRITE_BURST = 0x40;
static const uint8_t CC1101_READ_SINGLE = 0x80;
static const uint8_t CC1101_READ_BURST = 0xC0;

// Forward declare the SPI interface
class CC1101SPI;

// RX callback type - called when a packet is received
using RxCallback = std::function<void(const uint8_t *data, size_t len, int8_t rssi)>;

/**
 * @brief Low-level CC1101 radio driver
 *
 * Handles register access and raw packet transmission/reception.
 * Uses a CC1101SPI interface for actual SPI communication.
 */
class CC1101Radio {
 public:
  void init(CC1101SPI *spi, GPIOPin *gdo0_pin);
  bool is_initialized() const { return initialized_; }

  // Low-level register access
  void strobe(uint8_t cmd);
  void write_register(uint8_t reg, uint8_t value);
  uint8_t read_register(uint8_t reg);
  uint8_t read_status_register(uint8_t reg);
  void write_burst(uint8_t reg, const uint8_t *data, size_t len);
  void read_burst(uint8_t reg, uint8_t *data, size_t len);

  // Radio control
  void reset();
  void set_idle();
  void flush_tx();
  void flush_rx();
  uint8_t get_state();
  uint8_t get_tx_bytes();
  uint8_t get_rx_bytes();

  /**
   * @brief Transmit raw bytes
   * @return true if transmission completed successfully
   */
  bool transmit_raw(const uint8_t *data, size_t len);

  /**
   * @brief Start RX mode (continuous reception)
   * Call check_rx() periodically or set up GDO0 interrupt
   */
  void start_rx();

  /**
   * @brief Stop RX mode and return to IDLE
   */
  void stop_rx();

  /**
   * @brief Check for received packet and call callback if available
   * @return true if a packet was received
   */
  bool check_rx();

  /**
   * @brief Set callback for received packets
   */
  void set_rx_callback(RxCallback callback) { rx_callback_ = callback; }

  /**
   * @brief Check if currently in RX mode
   */
  bool is_rx_active() const { return rx_active_; }

 protected:
  CC1101SPI *spi_{nullptr};
  GPIOPin *gdo0_pin_{nullptr};
  bool initialized_{false};
  bool rx_active_{false};
  RxCallback rx_callback_{nullptr};
  uint32_t overflow_count_{0};  // Track FIFO overflow events

  // RX accumulation buffer for packets exceeding 64-byte FIFO
  // Pairing packets are 53 decoded bytes = ~67 raw N81-encoded bytes
  static const size_t RX_ACCUM_SIZE = 128;
  uint8_t rx_accum_[RX_ACCUM_SIZE];
  size_t rx_accum_pos_{0};
};

/**
 * @brief SPI interface for CC1101
 *
 * Abstract interface that the main component implements.
 */
class CC1101SPI {
 public:
  virtual void spi_enable() = 0;
  virtual void spi_disable() = 0;
  virtual uint8_t spi_transfer(uint8_t data) = 0;
};

}  // namespace cc1101_cca
}  // namespace esphome
