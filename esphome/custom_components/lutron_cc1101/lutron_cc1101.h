#pragma once

#include "esphome/core/component.h"
#include "esphome/components/spi/spi.h"
#include "esphome/core/hal.h"

namespace esphome {
namespace lutron_cc1101 {

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

// SPI access modes
static const uint8_t CC1101_WRITE_SINGLE = 0x00;
static const uint8_t CC1101_WRITE_BURST = 0x40;
static const uint8_t CC1101_READ_SINGLE = 0x80;
static const uint8_t CC1101_READ_BURST = 0xC0;

class LutronCC1101 : public Component, public spi::SPIDevice<spi::BIT_ORDER_MSB_FIRST, spi::CLOCK_POLARITY_LOW,
                                                              spi::CLOCK_PHASE_LEADING, spi::DATA_RATE_1MHZ> {
 public:
  void setup() override;
  void loop() override {}
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

  void set_gdo0_pin(GPIOPin *gdo0_pin) { this->gdo0_pin_ = gdo0_pin; }

  void send_button_press(uint32_t device_id, uint8_t button);
  void send_level(uint32_t device_id, uint8_t level_percent);
  void send_pairing(uint32_t device_id, uint8_t button);
  void send_pairing_exp(uint32_t device_id, uint8_t button, uint8_t pkt_type, uint8_t dev_type, bool short_format);
  void send_pairing_exact_05851117();  // Exact replay of real Pico 05851117
  void send_raw_packet(const uint8_t *packet, size_t len);

 protected:
  void reset_();
  void configure_lutron_();
  void write_register_(uint8_t reg, uint8_t value);
  uint8_t read_register_(uint8_t reg);
  uint8_t read_status_register_(uint8_t reg);
  void strobe_(uint8_t cmd);
  void write_burst_(uint8_t reg, const uint8_t *data, size_t len);
  uint16_t calc_crc_(const uint8_t *data, size_t len);
  void transmit_packet_(const uint8_t *packet, size_t len);
  void transmit_packet_2x_(const uint8_t *packet, size_t len);  // 2x slower for pairing

  GPIOPin *gdo0_pin_{nullptr};
  uint16_t crc_table_[256];
  uint8_t tx_sequence_{0};
  bool type_alternate_{false};  // Alternates between 0x88/89 and 0x8A/8B per button press
};

}  // namespace lutron_cc1101
}  // namespace esphome
