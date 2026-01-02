#pragma once

#include "esphome/core/component.h"
#include "esphome/components/spi/spi.h"
#include "cc1101_radio.h"
#include "lutron_protocol.h"
#include "lutron_pairing.h"

namespace esphome {
namespace lutron_cc1101 {

/**
 * @brief Lutron Clear Connect Type A (CCA) RF Controller
 *
 * ESPHome component for transmitting Lutron Clear Connect Type A protocol
 * commands at 433.6 MHz using a CC1101 radio module.
 *
 * WORKING:
 * - Button press commands (ON, OFF, RAISE, LOWER, FAVORITE)
 * - Level commands (0-100% dimming)
 *
 * EXPERIMENTAL (not working):
 * - Pairing
 */
class LutronCC1101 : public Component,
                     public spi::SPIDevice<spi::BIT_ORDER_MSB_FIRST, spi::CLOCK_POLARITY_LOW,
                                           spi::CLOCK_PHASE_LEADING, spi::DATA_RATE_1MHZ>,
                     public CC1101SPI {
 public:
  void setup() override;
  void loop() override {}
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

  void set_gdo0_pin(GPIOPin *gdo0_pin) { this->gdo0_pin_ = gdo0_pin; }

  // CC1101SPI interface implementation
  void spi_enable() override { this->enable(); }
  void spi_disable() override { this->disable(); }
  uint8_t spi_transfer(uint8_t data) override { return this->transfer_byte(data); }

  /**
   * @brief Send a button press command (WORKING)
   */
  void send_button_press(uint32_t device_id, uint8_t button);

  /**
   * @brief Send a level/dimming command (WORKING - direct paired devices)
   */
  void send_level(uint32_t device_id, uint8_t level_percent);

  /**
   * @brief Send bridge-style level command with target device ID
   * Uses bridge zone ID as source, target dimmer ID in payload
   * @param bridge_zone_id Bridge zone ID (e.g., 0xAF902C00)
   * @param target_device_id Target dimmer's printed label ID (e.g., 0x06FDEFF4)
   * @param level_percent Level 0-100
   */
  void send_bridge_level(uint32_t bridge_zone_id, uint32_t target_device_id, uint8_t level_percent);

  /**
   * @brief Send pairing using 0xB9 format (EXPERIMENTAL)
   */
  void send_pairing_b9(uint32_t device_id);

  /**
   * @brief Send Pico-style pairing (0xBB packets)
   * Emulates a real Pico holding FAVORITE button for pairing
   * @param device_id Our device ID (ESP32's fake Pico ID)
   * @param duration_seconds How long to send (default 6s like real Pico)
   */
  void send_pairing_pico(uint32_t device_id, int duration_seconds = 6);

  /**
   * @brief Send a single test packet for RTL-SDR capture analysis
   * Sends 5 copies of a 0xB9 pairing packet with 200ms gaps
   */
  void send_test_packet(uint32_t device_id);

  /**
   * @brief Send pairing beacon packets like a bridge
   * This should make dimmers and picos flash as if bridge is in pairing mode
   * @param device_id ESP32's device ID (used as bridge zone ID)
   * @param beacon_type 0x91, 0x92, or 0x93 (0x92 = initial pairing mode)
   * @param duration_seconds How long to send beacons (default 10s)
   */
  void send_beacon(uint32_t device_id, uint8_t beacon_type = 0x92, int duration_seconds = 10);

  /**
   * @brief Send a single beacon packet (for use with ESPHome interval)
   * @param device_id Load ID to use (e.g., 0xAF902C01)
   * @param seq Sequence number
   * @return Next sequence number to use
   */
  uint8_t send_beacon_single(uint32_t device_id, uint8_t seq);

  /**
   * @brief Get pairing handler for advanced testing
   */
  LutronPairing *get_pairing() { return pairing_; }

  /**
   * @brief Send fake dimmer state report to bridge
   * Emulates what a dimmer sends when its level changes (via physical toggle)
   * This may trick the bridge into updating its state display
   * @param device_id Dimmer's RF transmit ID (e.g., 0x8F902C08 from captures)
   * @param level_percent Level 0-100
   */
  void send_state_report(uint32_t device_id, uint8_t level_percent);

  /**
   * @brief Send 0xB0 pairing assignment packet like a bridge
   * This assigns a dimmer to our ESP32 as if we're a bridge
   * @param load_id Our "bridge" load ID (e.g., 0xCC110100)
   * @param target_factory_id Factory ID of dimmer to pair (e.g., 0x06FDEFF4)
   */
  void send_pairing_b0(uint32_t load_id, uint32_t target_factory_id);

  /**
   * @brief Debug: Send raw alternating bytes (0xAA) to test CC1101
   * This bypasses the encoder to test if CC1101 is transmitting correctly
   */
  void send_debug_pattern();

  /**
   * @brief Transmit a raw packet (public for YAML lambda access)
   */
  void transmit_packet(const uint8_t *packet, size_t len);

 protected:

  GPIOPin *gdo0_pin_{nullptr};
  CC1101Radio radio_;
  LutronEncoder encoder_;
  LutronPairing *pairing_{nullptr};

  bool type_alternate_{false};
};

}  // namespace lutron_cc1101
}  // namespace esphome
