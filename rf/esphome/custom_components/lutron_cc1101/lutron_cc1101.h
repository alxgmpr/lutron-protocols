#pragma once

#include "esphome/core/component.h"
#include "esphome/components/spi/spi.h"
#include "cc1101_radio.h"
#include "lutron_protocol.h"
#include "lutron_pairing.h"
#include "lutron_decoder.h"

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
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }

  void set_gdo0_pin(GPIOPin *gdo0_pin) { this->gdo0_pin_ = gdo0_pin; }

  /**
   * @brief Start RX mode to receive packets
   * Logs all received data as hex
   */
  void start_rx();

  /**
   * @brief Stop RX mode
   */
  void stop_rx();

  /**
   * @brief Check if RX mode is active
   */
  bool is_rx_active() const { return rx_enabled_; }

  // CC1101SPI interface implementation
  void spi_enable() override { this->enable(); }
  void spi_disable() override { this->disable(); }
  uint8_t spi_transfer(uint8_t data) override { return this->transfer_byte(data); }

  /**
   * @brief Send a button press command (WORKING)
   */
  void send_button_press(uint32_t device_id, uint8_t button);

  /**
   * @brief Send "save favorite/scene" sequence
   * Holds button for specified duration then releases - triggers save mode on paired dimmers
   * @param device_id Pico device ID
   * @param button Button code (0x03=FAV for 5-btn, 0x08-0x0B for scene pico)
   * @param hold_seconds Duration to hold (default 6s, dimmer requires ~5s to enter save mode)
   */
  void send_save_favorite(uint32_t device_id, uint8_t button, int hold_seconds = 6);

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
   * @brief Experimental pairing with configurable parameters
   * @param device_id 32-bit device ID
   * @param ba_count Number of 0xBA packets
   * @param bb_count Number of 0xBB packets
   * @param protocol_variant 0=new, 1=old
   * @param pico_type 0=scene, 1=5-button
   * @param button_scheme Byte 10 - button codes: 0x04=5-btn, 0x0B=4-btn
   */
  void send_pairing_experimental(uint32_t device_id, int ba_count, int bb_count,
                                  int protocol_variant, int pico_type, int button_scheme);

  /**
   * @brief Direct-pair as 5-button Pico using B9 packets
   * Matches REAL 5-button Pico pairing exactly. Bytes 37-38 advertise button
   * range 0x02-0x06 so FAV (0x03) works as a real favorite button.
   * @param device_id 32-bit device ID
   * @param duration_seconds How long to transmit (default 10)
   */
  void send_pairing_5button(uint32_t device_id, int duration_seconds = 10);

  /**
   * @brief Advanced pairing with FULL control over ALL capability bytes
   * Replicate ANY Pico type exactly - 2-btn paddle, 5-btn, 4-btn R/L, scene
   *
   * Captured values:
   * - 2-btn paddle: A=B9, B=BB, b10=04, b30=03, b31=08, b37=01, b38=01
   * - 5-button:     A=B9, B=BB, b10=04, b30=03, b31=00, b37=02, b38=06
   * - 4-btn R/L:    A=B9, B=BB, b10=0B, b30=02, b31=00, b37=02, b38=21
   * - 4-btn scene:  A=B9, B=BB, b10=0B, b30=04, b31=00, b37=02, b38=28 (custom)
   * - 4-btn scene:  A=B8, B=BA, b10=0B, b30=04, b31=00, b37=02, b38=27 (std)
   */
  void send_pairing_advanced(uint32_t device_id, int duration_seconds,
                             uint8_t pkt_type_a, uint8_t pkt_type_b,
                             uint8_t byte10, uint8_t byte30, uint8_t byte31,
                             uint8_t byte37, uint8_t byte38);

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
   * @brief Complete bridge pairing sequence - beacons + assignment
   * Matches REAL bridge behavior from RF captures:
   * 1. Sends 0xB1/B2/B3 beacons (byte[7]=0x10) for duration
   * 2. After beacon phase, sends 0xA1/A2/A3 assignment packets
   *
   * Usage: Start this, then hold OFF on dimmer for 10 seconds
   *
   * @param bridge_id Our fake bridge zone ID (e.g., 0xAF902C01)
   * @param target_factory_id Dimmer's factory ID from label (e.g., 0x06FDEFF4)
   * @param beacon_seconds How long to send beacons (default 20s)
   */
  void send_bridge_pair_sequence(uint32_t bridge_id, uint32_t target_factory_id,
                                  int beacon_seconds = 20);

  /**
   * @brief Debug: Send raw alternating bytes (0xAA) to test CC1101
   * This bypasses the encoder to test if CC1101 is transmitting correctly
   */
  void send_debug_pattern();

  /**
   * @brief Send Reset/Unpair packet to remove a Pico from a device
   * Uses 0x81 packet type with byte[7]=0x0C format indicator
   * @param source_id Source/RF transmit ID (e.g., ESP32's fake Pico ID)
   * @param paired_id The paired device ID to unregister (the Pico being removed)
   */
  void send_reset(uint32_t source_id, uint32_t paired_id);

  /**
   * @brief Send bridge-style unpair command to remove a device from the network
   * Captured from Caseta bridge removing device 06F4587E:
   * 83 01 AD 90 2C 00 21 0C 00 FF FF FF FF FF 02 08 06 F4 58 7E CC CC [CRC]
   *
   * @param bridge_zone_id Bridge zone ID (e.g., 0x002C90AD), sent little-endian
   * @param target_device_id Device to unpair (e.g., 0x06F4587E), sent big-endian
   */
  void send_bridge_unpair(uint32_t bridge_zone_id, uint32_t target_device_id);

  /**
   * @brief Transmit a raw packet (public for YAML lambda access)
   */
  void transmit_packet(const uint8_t *packet, size_t len);

 protected:
  void handle_rx_packet(const uint8_t *data, size_t len, int8_t rssi);

  GPIOPin *gdo0_pin_{nullptr};
  CC1101Radio radio_;
  LutronEncoder encoder_;
  LutronDecoder decoder_;
  LutronPairing *pairing_{nullptr};

  bool type_alternate_{false};
  bool rx_enabled_{false};
  bool rx_auto_{true};  // Auto-resume RX after TX (default: on)
  uint32_t last_rx_check_{0};
};

}  // namespace lutron_cc1101
}  // namespace esphome
