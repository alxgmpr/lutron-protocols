#pragma once

#include <WiFiUdp.h>
#include <vector>
#include <string>
#include <functional>
#include <ArduinoJson.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esphome/core/log.h"
#include "esphome/components/cc1101_cca/packet_buffer.h"

/**
 * Bidirectional UDP streaming for CCA packets with async send pipeline.
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
 *
 * Architecture:
 *   Radio RX -> callback -> ring buffer (O(1) non-blocking push)
 *                              |
 *                              v
 *                       FreeRTOS task -> UDP send (may block)
 *
 * This decouples the radio from WiFi stack, preventing FIFO overflows.
 */

// Command bytes for RX packets
#define CCA_UDP_CMD_TX_RAW 0x01

class CCAUdpStream {
 public:
  // TX callback type: called when RX packet requests TX (binary)
  using TxCallback = std::function<void(const std::vector<uint8_t>&)>;

  // JSON command callback: called when JSON command is received
  using JsonCommandCallback = std::function<void(const char* cmd, JsonObject& params)>;

  // Log interval in milliseconds
  static constexpr uint32_t LOG_INTERVAL_MS = 5000;

  // Heartbeat interval in milliseconds
  static constexpr uint32_t HEARTBEAT_INTERVAL_MS = 5000;

  // Ring buffer size (must be power of 2)
  static constexpr size_t BUFFER_SIZE = 256;

  CCAUdpStream() : initialized_(false), rx_initialized_(false),
                   tx_port_(9433), rx_port_(9434), udp_task_handle_(nullptr) {}

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

  void set_json_command_callback(JsonCommandCallback callback) {
    json_command_callback_ = callback;
  }

  bool begin() {
    if (!initialized_) {
      initialized_ = tx_udp_.begin(0);  // Use any available port for sending

      if (initialized_) {
        // Start the UDP send task
        start_udp_task();
      }
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

  // Enqueue RX packet for async send (non-blocking)
  void send_packet(const std::vector<uint8_t> &data, int8_t rssi) {
    enqueue_packet(data.data(), data.size(), rssi, false);
  }

  // Enqueue TX packet for async send (non-blocking)
  void send_tx_packet(const std::vector<uint8_t> &data) {
    enqueue_packet(data.data(), data.size(), 0, true);
  }

  // Stats
  uint32_t rx_commands_received() const { return rx_commands_; }
  uint32_t tx_packets_sent() const { return tx_packets_sent_; }
  uint32_t rx_packets_streamed() const { return rx_packets_queued_; }
  uint32_t tx_packets_streamed() const { return tx_packets_queued_; }

  // New diagnostic stats
  uint32_t buffer_drops() const { return packet_buffer_.dropped(); }
  uint32_t slow_sends() const { return slow_sends_; }
  uint32_t failed_sends() const { return failed_sends_; }
  uint32_t max_send_time_us() const { return max_send_time_us_; }

 private:
  void handle_rx_packet(int packet_size) {
    if (packet_size < 2) {
      return;  // Too short
    }

    uint8_t buffer[256];  // Larger buffer for JSON commands
    int len = rx_udp_.read(buffer, std::min(packet_size, (int)sizeof(buffer) - 1));
    if (len < 2) {
      return;
    }

    rx_commands_++;

    // Check if this looks like JSON (starts with '{')
    if (buffer[0] == '{') {
      buffer[len] = '\0';  // Null-terminate for JSON parsing
      handle_json_command((const char*)buffer);
      return;
    }

    // Binary command format: [CMD:1][LEN:1][DATA:N]
    uint8_t cmd = buffer[0];
    uint8_t data_len = buffer[1];

    if (len < 2 + data_len) {
      ESP_LOGW("udp_stream", "Truncated RX command: expected %d data bytes, got %d",
               data_len, len - 2);
      return;
    }

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

  void handle_json_command(const char* json_str) {
    StaticJsonDocument<512> doc;
    DeserializationError err = deserializeJson(doc, json_str);

    if (err) {
      ESP_LOGW("udp_stream", "JSON parse error: %s", err.c_str());
      return;
    }

    const char* cmd = doc["cmd"];
    if (!cmd) {
      ESP_LOGW("udp_stream", "JSON missing 'cmd' field");
      return;
    }

    ESP_LOGD("udp_stream", "JSON command: %s", cmd);

    if (json_command_callback_) {
      JsonObject params = doc.as<JsonObject>();
      json_command_callback_(cmd, params);
    } else {
      ESP_LOGW("udp_stream", "JSON command received but no callback set");
    }
  }

  // Enqueue packet to ring buffer (called from main loop - non-blocking)
  void enqueue_packet(const uint8_t* data, size_t len, int8_t rssi, bool is_tx) {
    // Track queue attempts
    if (is_tx) {
      tx_packets_queued_++;
    } else {
      rx_packets_queued_++;
    }

    // Push to ring buffer (O(1), never blocks)
    if (!packet_buffer_.push(data, len, rssi, is_tx)) {
      // Buffer full - already counted by ring buffer's dropped counter
      ESP_LOGW("udp_stream", "Ring buffer full, packet dropped (total dropped: %u)",
               (uint32_t)packet_buffer_.dropped());
    }

    // Periodic logging
    uint32_t now = millis();
    if (now - last_log_time_ >= LOG_INTERVAL_MS) {
      last_log_time_ = now;
      ESP_LOGI("udp_stream", "[ESP32->UDP] queued=%u sent=%u dropped=%u slow=%u failed=%u max_us=%u host=%s",
               (uint32_t)packet_buffer_.total_pushed(),
               tx_packets_sent_,
               (uint32_t)packet_buffer_.dropped(),
               slow_sends_,
               failed_sends_,
               max_send_time_us_,
               host_.empty() ? "(empty)" : host_.c_str());
    }
  }

  // Actual UDP send (called from FreeRTOS task - may block)
  void send_packet_now(const uint8_t* data, uint8_t len, int8_t rssi, bool is_tx) {
    if (!initialized_ || host_.empty()) {
      return;
    }

    // Build packet: [FLAGS:1][LEN:1][DATA:N]
    // FLAGS: bit 7 = direction (0=RX, 1=TX), bits 0-6 = |RSSI| for RX
    uint8_t packet[66];  // Max 64 data + 2 header
    uint8_t flags = is_tx ? 0x80 : (static_cast<uint8_t>(-rssi) & 0x7F);
    packet[0] = flags;
    packet[1] = len;
    memcpy(packet + 2, data, len);
    size_t total_len = 2 + len;

    // Send to backend with timing
    IPAddress addr;
    if (addr.fromString(host_.c_str())) {
      uint32_t send_start = micros();

      tx_udp_.beginPacket(addr, tx_port_);
      tx_udp_.write(packet, total_len);
      bool ok = tx_udp_.endPacket();

      uint32_t send_time = micros() - send_start;

      // Track diagnostics
      if (send_time > max_send_time_us_) {
        max_send_time_us_ = send_time;
      }

      if (send_time > 1000) {  // > 1ms is slow
        slow_sends_++;
        if (send_time > 5000) {  // > 5ms is very slow, log it
          ESP_LOGW("udp_stream", "Slow UDP send: %u us", send_time);
        }
      }

      if (!ok) {
        failed_sends_++;
        ESP_LOGW("udp_stream", "UDP send failed");
      } else {
        tx_packets_sent_++;
      }
    }
  }

  // Send a 2-byte heartbeat packet [0xFF, 0x00] to the backend
  void send_heartbeat_now() {
    if (!initialized_ || host_.empty()) {
      return;
    }

    uint8_t heartbeat[2] = {0xFF, 0x00};
    IPAddress addr;
    if (addr.fromString(host_.c_str())) {
      tx_udp_.beginPacket(addr, tx_port_);
      tx_udp_.write(heartbeat, 2);
      tx_udp_.endPacket();
      last_heartbeat_ms_ = millis();
    }
  }

  // Start the FreeRTOS task for async UDP sending
  void start_udp_task() {
    if (udp_task_handle_ != nullptr) {
      return;  // Already started
    }

    xTaskCreatePinnedToCore(
        udp_task_func,      // Task function
        "udp_send",         // Name
        4096,               // Stack size (bytes)
        this,               // Parameter (this pointer)
        1,                  // Priority (1 = low, below WiFi's default of 5)
        &udp_task_handle_,  // Task handle output
        0                   // Core 0 (same as WiFi for better cache locality)
    );

    ESP_LOGI("udp_stream", "Started UDP send task on core 0");
  }

  // FreeRTOS task function (runs on separate task)
  static void udp_task_func(void* param) {
    auto* self = static_cast<CCAUdpStream*>(param);
    esphome::cc1101_cca::PacketEntry pkt;

    while (true) {
      // Try to pop a packet from the buffer
      if (self->packet_buffer_.pop(pkt)) {
        // Send it (this may block on WiFi stack)
        self->send_packet_now(pkt.data, pkt.len, pkt.rssi, pkt.is_tx);
      } else {
        // Buffer empty - yield to other tasks
        // Use 1 tick delay (~1ms) to avoid busy-spinning
        vTaskDelay(1);
      }

      // Send heartbeat if interval has elapsed
      if (millis() - self->last_heartbeat_ms_ >= HEARTBEAT_INTERVAL_MS) {
        self->send_heartbeat_now();
      }
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
  JsonCommandCallback json_command_callback_;

  // Ring buffer for async packet sending
  esphome::cc1101_cca::PacketRingBuffer<BUFFER_SIZE> packet_buffer_;
  TaskHandle_t udp_task_handle_;

  // Stats
  uint32_t rx_commands_ = 0;
  uint32_t tx_packets_sent_ = 0;        // Actually sent over UDP
  uint32_t rx_packets_queued_ = 0;      // RX packets queued to buffer
  uint32_t tx_packets_queued_ = 0;      // TX packets queued to buffer
  uint32_t last_log_time_ = 0;

  // Diagnostic stats
  uint32_t slow_sends_ = 0;             // Sends taking > 1ms
  uint32_t failed_sends_ = 0;           // Failed UDP sends
  uint32_t max_send_time_us_ = 0;       // Max send time in microseconds

  // Heartbeat tracking
  uint32_t last_heartbeat_ms_ = 0;
};

// Global instance (inline ensures single instance across all translation units)
inline CCAUdpStream cca_udp_stream;
