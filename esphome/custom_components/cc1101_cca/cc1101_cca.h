#pragma once

#include "esphome/core/component.h"
#include "esphome/core/automation.h"
#include "esphome/components/spi/spi.h"
#include "cc1101_radio.h"
#include "lutron_protocol.h"
#include "lutron_pairing.h"
#include "lutron_decoder.h"
#include <vector>
#include <functional>

namespace esphome {
namespace cc1101_cca {

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
class CC1101CCA : public Component,
                     public spi::SPIDevice<spi::BIT_ORDER_MSB_FIRST, spi::CLOCK_POLARITY_LOW,
                                           spi::CLOCK_PHASE_LEADING, spi::DATA_RATE_4MHZ>,
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
   * @brief Send continuous hold packets (for raise/lower dimming)
   * @param device_id OWT device ID
   * @param button Button code (0x05=RAISE, 0x06=LOWER for 5-btn)
   * @param duration_ms Hold duration in milliseconds
   */
  void send_button_hold(uint32_t device_id, uint8_t button, uint16_t duration_ms = 2000);

  /**
   * @brief Send double-tap sequence (two press/release cycles with A/B alternation)
   * @param device_id OWT device ID
   * @param button Button code
   */
  void send_button_double_tap(uint32_t device_id, uint8_t button);

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
  void send_bridge_level(uint32_t bridge_zone_id, uint32_t target_device_id, uint8_t level_percent, uint8_t fade_time_qs = 0x01);

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
   * @param beacon_type Beacon type (0x93=initial, 0x91=active, 0x92=continue)
   * @return Next sequence number to use
   */
  uint8_t send_beacon_single(uint32_t device_id, uint8_t seq, uint8_t beacon_type);

  /**
   * @brief Get pairing handler for advanced testing
   */
  LutronPairing *get_pairing() { return pairing_; }

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
   * @brief Send Reset/Unpair packet to remove a Pico from a device
   * Uses 0x81 packet type with byte[7]=0x0C format indicator
   * @param source_id Source/RF transmit ID (e.g., ESP32's fake Pico ID)
   * @param paired_id The paired device ID to unregister (the Pico being removed)
   */
  void send_reset(uint32_t source_id, uint32_t paired_id);

  // ========== DEVICE CONFIGURATION (from CCA Playground captures) ==========

  /**
   * @brief Send LED config command to change status LED behavior
   * Uses format 0x11 with A1/A2/A3 type bytes
   * @param bridge_zone_id Bridge zone ID (e.g., 0x002C90AD), sent little-endian
   * @param target_device_id Target dimmer ID (e.g., 0x06FE8006), sent big-endian
   * @param mode LED mode: 0=Both Off, 1=Both On, 2=On when load on, 3=On when load off
   */
  void send_led_config(uint32_t bridge_zone_id, uint32_t target_device_id, uint8_t mode);

  /**
   * @brief Send fade rate config command
   * Uses format 0x1C with A1/A2/A3 type bytes
   * @param bridge_zone_id Bridge zone ID, sent little-endian
   * @param target_device_id Target dimmer ID, sent big-endian
   * @param fade_on_qs Fade-on time in quarter-seconds (uint16)
   * @param fade_off_qs Fade-off time in quarter-seconds (uint16)
   */
  void send_fade_config(uint32_t bridge_zone_id, uint32_t target_device_id,
                        uint16_t fade_on_qs, uint16_t fade_off_qs);

  /**
   * @brief Send device state/config command (trim and phase settings)
   * Uses format 0x15 with A1/A2/A3 type bytes
   * @param bridge_zone_id Bridge zone ID, sent little-endian
   * @param target_device_id Target dimmer ID, sent big-endian
   * @param high_trim High-end trim 0-100% (encoded as % * 2.54)
   * @param low_trim Low-end trim 0-100% (encoded as % * 2.54)
   * @param phase_reverse true for reverse phase, false for forward
   */
  void send_device_state(uint32_t bridge_zone_id, uint32_t target_device_id,
                         uint8_t high_trim, uint8_t low_trim, bool phase_reverse);

  /**
   * @brief Send bridge-style unpair command to remove a device from the network
   * @param bridge_zone_id Bridge zone ID (e.g., 0x002C90AD), sent little-endian
   * @param target_device_id Device to unpair (e.g., 0x06F4587E), sent big-endian
   */
  void send_bridge_unpair(uint32_t bridge_zone_id, uint32_t target_device_id);

  // ========== BRIDGE PAIRING (based on real RadioRA3 captures) ==========

  /**
   * @brief Start bridge pairing mode - sends active beacons that make devices flash
   * Uses 0x92 packets with format=0x0C and mode=0x02 (active pairing)
   * When a device announces itself (B0/B2), auto-runs full config sequence.
   * Call stop_bridge_pairing() when done.
   * @param subnet 16-bit subnet (e.g., 0x2C90)
   * @param load_id Load address (0 = auto-generate from subnet)
   * @param counter Monotonic pairing counter (increments each pairing)
   */
  void start_bridge_pairing(uint16_t subnet, uint32_t load_id = 0, uint8_t counter = 0x06);

  /**
   * @brief Stop bridge pairing mode - sends stop beacon
   * Uses 0x92 packets with format=0x0C and mode=0x04 (stop)
   * @param subnet 16-bit subnet
   */
  void stop_bridge_pairing(uint16_t subnet);

  /**
   * @brief Run the full bridge config sequence after B0/B2 device discovery
   * Phases 3-8: targeted beacon, unpair, config, zone binding, LED, handshake
   * Called automatically from handle_rx_packet() when device announces.
   * @param hw_id Device hardware ID (from B0/B2 bytes 16-19)
   * @param subtype Device subtype (0x63=dimmer, 0x64=switch)
   */
  void send_bridge_pair_config(uint32_t hw_id, uint8_t subtype);

  /**
   * @brief Send zone binding packets (format 0x1A, subcmd 0x40)
   * Sends A3/A1/A2 in one round, called twice (byte 20 = 0x20, then 0x22)
   * @param bridge_zone_id Bridge zone ID (little-endian)
   * @param target_hw_id Device HW ID (big-endian)
   * @param round 0 for first round (byte20=0x20), 1 for second (byte20=0x22)
   */
  void send_zone_binding(uint32_t bridge_zone_id, uint32_t target_hw_id, uint8_t round);

  /**
   * @brief Check if pairing mode is active
   */
  bool is_pairing_active() const { return pairing_active_; }

  /**
   * @brief Send bridge-style unpair from TWO zone IDs (interleaved like real bridge)
   * Real bridge sends from both zones (e.g., 002C90AD and 002C90AF) to ensure
   * the device receives the unpair regardless of which zone it was paired to.
   *
   * @param zone_id_1 Primary zone ID (sent first in each burst)
   * @param zone_id_2 Secondary zone ID (0 to disable, use single-zone mode)
   * @param target_device_id Device to unpair
   */
  void send_bridge_unpair_dual(uint32_t zone_id_1, uint32_t zone_id_2, uint32_t target_device_id);

  // ========== BRIDGE PAIRING PROTOCOL (complete handshake) ==========

  /**
   * @brief Send A1/A2/A3 config packet during bridge pairing
   * Used in Phase 3 to assign load ID to a discovered dimmer
   * @param type Packet type (0xA1, 0xA2, or 0xA3)
   * @param bridge_zone_id Bridge zone ID (e.g., 0x002C90AD), sent little-endian
   * @param target_hw_id Target dimmer's hardware ID (e.g., 0x06FE43B1), sent big-endian
   * @param assigned_load_id Load ID to assign (e.g., 0x085124C9), sent big-endian
   */
  void send_config_packet(uint8_t type, uint32_t bridge_zone_id, uint32_t target_hw_id, uint32_t assigned_load_id);

  /**
   * @brief Send A1/A3 device link packet with 0x70 format
   * Used to link a dimmer to a controller device (pico, bridge zone, etc)
   * Real bridge sends A3 with slot 0 first, then A1 with slot 1
   * @param type Packet type (0xA1 or 0xA3)
   * @param bridge_zone_id Bridge zone ID (source, little-endian)
   * @param target_hw_id Target dimmer HW ID (bytes 9-12, big-endian)
   * @param linked_device_id Device to link (bytes 17-20, big-endian)
   * @param slot Link slot number (byte 16: 0x00 or 0x01)
   */
  void send_device_link(uint8_t type, uint32_t bridge_zone_id, uint32_t target_hw_id,
                        uint32_t linked_device_id, uint8_t slot);

  /**
   * @brief Send 0x93 targeted beacon to acknowledge discovered device
   * This is sent after B0 discovery, BEFORE the 0x82 zone assignment.
   * From capture: 93 01 AD 90 2C 00 21 0D 00 06 FE 43 B1 FE 08 06 90 2C 1A 04 06 CC
   * @param bridge_zone_id Bridge zone ID (little-endian in packet)
   * @param target_hw_id Target dimmer's hardware ID (big-endian in packet)
   * @param subnet 16-bit subnet ID
   */
  void send_targeted_beacon_93(uint32_t bridge_zone_id, uint32_t target_hw_id, uint16_t subnet);

  /**
   * @brief Send 0x82 zone assignment packet (makes dimmer flash!)
   * This targeted packet tells the dimmer it's being assigned to a zone.
   * From capture: 82 C3 AF 90 2C 00 21 09 00 06 FE 43 B1 FE 02 02 01
   * @param bridge_zone_id Bridge zone ID (little-endian in packet)
   * @param target_hw_id Target dimmer's hardware ID (big-endian in packet)
   */
  void send_zone_assignment_82(uint32_t bridge_zone_id, uint32_t target_hw_id);

  /**
   * @brief Send 0x83 state report during pairing finalization (Phase 4)
   * Sent from bridge zone to dimmer to confirm zone assignment
   * @param bridge_zone_id Bridge zone ID (e.g., 0x002C90AD or 0x002C90AF)
   * @param target_hw_id Target dimmer's hardware ID
   */
  void send_state_report_83(uint32_t bridge_zone_id, uint32_t target_hw_id);

  /**
   * @brief Store a handshake challenge from the device during Phase 8.
   * Device sends 4 payloads with seq 0x20/0x40/0x60/0x80.
   * Each payload arrives on rotating odd types (C1, C7, CD, D3, D9, DF).
   * We store unique payloads (keyed by seq) for later burst echo.
   */
  void store_handshake_challenge(const uint8_t *challenge_data, uint8_t challenge_len);

  /**
   * @brief Burst-send all collected handshake echoes.
   * For each stored payload, sends on ALL 6 even types (C2, C8, CE, D4, DA, E0).
   * 4 payloads x 6 types = 24 packets at ~75ms intervals.
   */
  void send_handshake_burst();

  /**
   * @brief Send beacon with specific type for pairing phases
   * Phase 1a: 0x93 (initial), Phase 1b: 0x91, Phase 1c: 0x92
   * @param beacon_type 0x93, 0x91, or 0x92
   * @param subnet 16-bit subnet
   * @param seq Sequence number (will be updated)
   * @return Next sequence number
   */
  uint8_t send_bridge_beacon(uint8_t beacon_type, uint16_t subnet, uint8_t seq);

  // ========== VIVE DEVICE COMMANDS (0x8A/0x8B format 0x0e) ==========

  /**
   * @brief Send ON/OFF command to a Vive zone
   * Vive addresses devices by ZONE ID, not device ID!
   * Zone IDs are assigned during pairing (byte 23 of 0x8D config packet)
   * @param hub_id Our hub ID (e.g., 0xYYYYYYYY)
   * @param zone_id Zone/room ID (e.g., 0x4B for room 3)
   * @param turn_on true=ON (0x8A), false=OFF (0x8B)
   */
  void send_vive_zone_command(uint32_t hub_id, uint8_t zone_id, bool turn_on, uint8_t fade_time_qs = 0x01);

  /**
   * @brief Turn ON a Vive zone
   * @param fade_time_qs Fade time in quarter-seconds (1=250ms, 4=1s, 40=10s)
   */
  void send_vive_on(uint32_t hub_id, uint8_t zone_id, uint8_t fade_time_qs = 0x01);

  /**
   * @brief Turn OFF a Vive zone
   * @param fade_time_qs Fade time in quarter-seconds (1=250ms, 4=1s, 40=10s)
   */
  void send_vive_off(uint32_t hub_id, uint8_t zone_id, uint8_t fade_time_qs = 0x01);

  /**
   * @brief Raise (dim up) a Vive zone
   */
  void send_vive_raise(uint32_t hub_id, uint8_t zone_id);

  /**
   * @brief Lower (dim down) a Vive zone
   */
  void send_vive_lower(uint32_t hub_id, uint8_t zone_id);

  /**
   * @brief Set a Vive zone to a specific level (0-100%)
   * @param fade_time_qs Fade time in quarter-seconds (1=250ms, 4=1s, 40=10s)
   */
  void send_vive_level(uint32_t hub_id, uint8_t zone_id, uint8_t level_percent, uint8_t fade_time_qs = 0x01);

  /**
   * @brief EXPERIMENTAL: Send SET_LEVEL using a Pico's device ID as source
   * Picos are one-way — the dimmer stores the pico's ID during pairing.
   * We broadcast with the pico's ID and a level payload; any dimmer paired
   * to that pico should obey (if it parses format 0x0E level commands).
   * @param pico_id Pico device ID (must be paired to the target dimmer)
   * @param level_percent Level 0-100
   * @param fade_time_qs Fade time in quarter-seconds (1=250ms, 4=1s, 40=10s)
   */
  void send_pico_level(uint32_t pico_id, uint8_t level_percent, uint8_t fade_time_qs = 0x01);
  void send_pico_level_raw(uint32_t pico_id, uint8_t b17, uint8_t b18, uint8_t b19, uint8_t b20, uint8_t b21);

  /**
   * @brief Send dim step command (shared by raise/lower)
   * @param direction 0x03 = raise, 0x02 = lower
   */
  void send_vive_dim_command(uint32_t hub_id, uint8_t zone_id, uint8_t direction);

  // Deprecated - use zone commands instead
  void send_vive_command(uint32_t hub_id, uint32_t device_id, uint8_t command, uint8_t subcommand);
  void send_vive_toggle(uint32_t hub_id, uint32_t device_id);

  // ========== VIVE PAIRING (0xBA/0xBB beacon protocol) ==========

  /**
   * @brief Start Vive-style pairing mode
   * Sends 0xBA beacon bursts (~9 packets) every ~30 seconds.
   * Devices in range will flash their LEDs to indicate pairing mode.
   * Call stop_vive_pairing() when done.
   * @param hub_id 32-bit hub ID (e.g., 0xYYYYYYYY)
   * @param zone_id Zone/room ID to assign to discovered devices (default 0x38 = Room 1)
   */
  void start_vive_pairing(uint32_t hub_id, uint8_t zone_id = 0x38);

  /**
   * @brief Stop Vive pairing mode
   * Sends 0xBB stop beacon burst (timer=0x00) to exit all devices from pairing mode.
   */
  void stop_vive_pairing();

  /**
   * @brief Check if Vive pairing mode is active
   */
  bool is_vive_pairing_active() const { return vive_pairing_active_; }

  /**
   * @brief Send a single Vive beacon burst (for manual control)
   * @param hub_id 32-bit hub ID
   * @param is_stop true for 0xBB stop burst, false for 0xBA enter burst
   * @param count Number of packets in burst (default 9)
   */
  void send_vive_beacon_burst(uint32_t hub_id, bool is_stop = false, int count = 9);

  /**
   * @brief Send targeted Vive accept packet to pair a specific device
   * Sends 0xBB with the device ID in the target field instead of broadcast.
   * Call this when a device sends 0xB8 pairing request.
   * @param hub_id Our hub ID
   * @param device_id The device ID that sent 0xB8 request
   * @param zone_id Zone/room ID to assign (0x38=Room1, 0x47=Room2, 0x4b=Room3, etc.)
   */
  void send_vive_accept(uint32_t hub_id, uint32_t device_id, uint8_t zone_id = 0x38);

  /**
   * @brief Transmit a raw packet (public for YAML lambda access)
   */
  void transmit_packet(const uint8_t *packet, size_t len);

  /**
   * @brief Register a callback for received packets
   * Callback receives: raw bytes, RSSI
   */
  void add_on_packet_callback(std::function<void(const std::vector<uint8_t> &, int8_t)> callback) {
    this->on_packet_callbacks_.push_back(std::move(callback));
  }

  /**
   * @brief Register a callback for transmitted packets
   * Callback receives: raw bytes (RSSI=0 for TX)
   */
  void add_on_tx_callback(std::function<void(const std::vector<uint8_t> &)> callback) {
    this->on_tx_callbacks_.push_back(std::move(callback));
  }

 protected:
  void handle_rx_packet(const uint8_t *data, size_t len, int8_t rssi);

  GPIOPin *gdo0_pin_{nullptr};
  CC1101Radio radio_;
  LutronEncoder encoder_;
  LutronDecoder decoder_;
  LutronPairing *pairing_{nullptr};

  bool type_alternate_{false};
  uint8_t config_type_idx_{0};  // Rotates 0→1→2 across config calls (A1/A2/A3)
  bool rx_enabled_{false};
  bool rx_auto_{true};  // Auto-resume RX after TX (default: on)
  bool pairing_active_{false};
  uint16_t pairing_subnet_{0};
  uint8_t pairing_seq_{0};
  uint8_t pairing_beacon_type_{0x93};  // Cycle through 0x93 -> 0x91 -> 0x92
  uint8_t pairing_beacon_count_{0};  // Counter for RX gap timing
  uint32_t last_rx_check_{0};
  uint32_t last_pairing_beacon_{0};  // For continuous beacon timing

  // Bridge auto-pairing state (set by start_bridge_pairing)
  uint32_t pairing_load_id_{0};         // Load address (e.g., 0x902C1A04)
  uint8_t pairing_counter_{0x06};       // Monotonic counter, increments each pairing
  uint32_t pairing_integ_ids_[4]{0};    // 4 integration IDs for this load
  bool pairing_is_dimmer_{false};       // Set from B0/B2 subtype
  uint32_t pairing_device_hw_id_{0};    // Filled from B0/B2 detection
  uint8_t pairing_instance_{0x01};      // Device instance counter

  // Handshake challenge collection (Phase 8)
  // Device sends 4 payloads with seq 0x20/0x40/0x60/0x80
  // We store bytes 0-21 of each unique challenge, keyed by slot = (seq / 0x20) - 1
  uint8_t hs_challenges_[4][22]{};      // 4 slots x 22 bytes each
  bool hs_challenge_received_[4]{};     // Which slots have been filled
  uint8_t hs_challenge_count_{0};       // How many unique payloads collected
  uint32_t hs_last_challenge_time_{0};  // Timestamp of last challenge received

  // Vive pairing state
  bool vive_pairing_active_{false};
  uint32_t vive_hub_id_{0};
  uint8_t vive_zone_id_{0x38};
  uint8_t vive_seq_{0};
  uint32_t vive_last_burst_{0};  // For ~30s burst interval

  // Callbacks for packet reception (used by UDP streaming)
  std::vector<std::function<void(const std::vector<uint8_t> &, int8_t)>> on_packet_callbacks_;

  // Callbacks for packet transmission (used by UDP streaming)
  std::vector<std::function<void(const std::vector<uint8_t> &)>> on_tx_callbacks_;
};

/**
 * @brief Automation trigger for received packets
 * Triggered when a valid CCA packet is received.
 * Template variables: data (vector<uint8_t>), rssi (int32_t)
 */
class CCAPacketTrigger : public Trigger<std::vector<uint8_t>, int32_t> {
 public:
  explicit CCAPacketTrigger(CC1101CCA *parent) {
    parent->add_on_packet_callback([this](const std::vector<uint8_t> &data, int8_t rssi) {
      this->trigger(data, static_cast<int32_t>(rssi));
    });
  }
};

/**
 * @brief Automation trigger for transmitted packets
 * Triggered when a packet is transmitted.
 * Template variables: data (vector<uint8_t>)
 */
class CCATxTrigger : public Trigger<std::vector<uint8_t>> {
 public:
  explicit CCATxTrigger(CC1101CCA *parent) {
    parent->add_on_tx_callback([this](const std::vector<uint8_t> &data) {
      this->trigger(data);
    });
  }
};

}  // namespace cc1101_cca
}  // namespace esphome
