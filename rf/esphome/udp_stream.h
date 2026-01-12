#pragma once

#include <WiFiUdp.h>
#include <vector>
#include <string>
#include "esphome/core/log.h"

/**
 * UDP streaming for CCA packets
 *
 * Sends raw CCA packets to a backend server via UDP.
 * Packet format:
 *   Byte 0: RSSI (signed int8)
 *   Byte 1: Packet length
 *   Bytes 2+: Raw packet data
 */

class CCAUdpStream {
 public:
  CCAUdpStream() : initialized_(false), port_(9433) {}

  void set_address(const char *host, uint16_t port) {
    host_ = host;
    port_ = port;
  }

  bool begin() {
    if (!initialized_) {
      initialized_ = udp_.begin(0);  // Use any available port for sending
    }
    return initialized_;
  }

  // Send RX packet with RSSI
  void send_packet(const std::vector<uint8_t> &data, int8_t rssi) {
    send_packet_internal(data, rssi, false);
  }

  // Send TX packet (uses RSSI=0 as TX indicator)
  void send_tx_packet(const std::vector<uint8_t> &data) {
    send_packet_internal(data, 0, true);
  }

 private:
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
      udp_.beginPacket(addr, port_);
      udp_.write(packet.data(), packet.size());
      udp_.endPacket();
    }
  }

 private:
  WiFiUDP udp_;
  bool initialized_;
  std::string host_;
  uint16_t port_;
};

// Global instance (inline ensures single instance across all translation units)
inline CCAUdpStream cca_udp_stream;
