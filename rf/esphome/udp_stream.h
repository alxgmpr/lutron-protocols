#pragma once

#include <WiFiUdp.h>
#include <vector>
#include <string>
#include <functional>
#include "esphome/core/log.h"

/**
 * Bidirectional UDP streaming for CCA packets
 *
 * TX (ESP32 -> Backend):
 *   Port: configurable (default 9433)
 *   Format: [FLAGS:1][LEN:1][DATA:N]
 *   FLAGS: bit 7 = direction (0=RX, 1=TX), bits 0-6 = |RSSI| for RX
 *
 * RX (Backend -> ESP32):
 *   Port: configurable (default 9434)
 *   Format: [CMD:1][LEN:1][DATA:N]
 *   CMD 0x01 = TX_RAW_PACKET (transmit immediately)
 */

// Command bytes for RX packets
#define CCA_UDP_CMD_TX_RAW 0x01

class CCAUdpStream {
 public:
  // TX callback type: called when RX packet requests TX
  using TxCallback = std::function<void(const std::vector<uint8_t>&)>;

  CCAUdpStream() : initialized_(false), rx_initialized_(false),
                   tx_port_(9433), rx_port_(9434) {}

  void set_address(const char *host, uint16_t port) {
    host_ = host;
    tx_port_ = port;
  }

  void set_rx_port(uint16_t port) {
    rx_port_ = port;
  }

  void set_tx_callback(TxCallback callback) {
    tx_callback_ = callback;
  }

  bool begin() {
    if (!initialized_) {
      initialized_ = tx_udp_.begin(0);  // Use any available port for sending
    }
    return initialized_;
  }

  bool begin_rx() {
    if (!rx_initialized_) {
      rx_initialized_ = rx_udp_.begin(rx_port_);
      if (rx_initialized_) {
        ESP_LOGI("udp_stream", "RX listening on port %d", rx_port_);
      } else {
        ESP_LOGE("udp_stream", "Failed to bind RX port %d", rx_port_);
      }
    }
    return rx_initialized_;
  }

  // Poll for incoming TX commands - call from loop()
  void poll() {
    if (!rx_initialized_) {
      return;
    }

    int packet_size = rx_udp_.parsePacket();
    if (packet_size > 0) {
      handle_rx_packet(packet_size);
    }
  }

  // Send RX packet with RSSI
  void send_packet(const std::vector<uint8_t> &data, int8_t rssi) {
    send_packet_internal(data, rssi, false);
  }

  // Send TX packet (uses RSSI=0 as TX indicator)
  void send_tx_packet(const std::vector<uint8_t> &data) {
    send_packet_internal(data, 0, true);
  }

  // Stats
  uint32_t rx_commands_received() const { return rx_commands_; }
  uint32_t tx_packets_sent() const { return tx_packets_; }

 private:
  void handle_rx_packet(int packet_size) {
    if (packet_size < 2) {
      return;  // Too short
    }

    uint8_t buffer[64];  // Max expected command size
    int len = rx_udp_.read(buffer, std::min(packet_size, (int)sizeof(buffer)));
    if (len < 2) {
      return;
    }

    uint8_t cmd = buffer[0];
    uint8_t data_len = buffer[1];

    if (len < 2 + data_len) {
      ESP_LOGW("udp_stream", "Truncated RX command: expected %d data bytes, got %d",
               data_len, len - 2);
      return;
    }

    rx_commands_++;

    switch (cmd) {
      case CCA_UDP_CMD_TX_RAW:
        if (tx_callback_) {
          std::vector<uint8_t> tx_data(buffer + 2, buffer + 2 + data_len);
          ESP_LOGD("udp_stream", "TX_RAW command: %d bytes", data_len);
          tx_callback_(tx_data);
        } else {
          ESP_LOGW("udp_stream", "TX_RAW command but no TX callback set");
        }
        break;

      default:
        ESP_LOGW("udp_stream", "Unknown RX command: 0x%02X", cmd);
        break;
    }
  }

  void send_packet_internal(const std::vector<uint8_t> &data, int8_t rssi, bool is_tx) {
    if (!initialized_ || host_.empty()) {
      return;
    }

    // Build packet: [FLAGS:1][LEN:1][DATA:N]
    // FLAGS: bit 7 = direction (0=RX, 1=TX), bits 0-6 = |RSSI| for RX
    std::vector<uint8_t> packet;
    packet.reserve(2 + data.size());

    uint8_t flags = is_tx ? 0x80 : (static_cast<uint8_t>(-rssi) & 0x7F);
    packet.push_back(flags);
    packet.push_back(static_cast<uint8_t>(data.size()));
    packet.insert(packet.end(), data.begin(), data.end());

    // Send to backend
    IPAddress addr;
    if (addr.fromString(host_.c_str())) {
      tx_udp_.beginPacket(addr, tx_port_);
      tx_udp_.write(packet.data(), packet.size());
      tx_udp_.endPacket();
      tx_packets_++;
    }
  }

 private:
  WiFiUDP tx_udp_;      // For sending to backend
  WiFiUDP rx_udp_;      // For receiving from backend
  bool initialized_;
  bool rx_initialized_;
  std::string host_;
  uint16_t tx_port_;    // Port to send TO (backend RX)
  uint16_t rx_port_;    // Port to listen ON (ESP32 RX)
  TxCallback tx_callback_;

  // Stats
  uint32_t rx_commands_ = 0;
  uint32_t tx_packets_ = 0;
};

// Global instance (inline ensures single instance across all translation units)
inline CCAUdpStream cca_udp_stream;
