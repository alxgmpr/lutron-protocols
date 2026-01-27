#pragma once

#include <atomic>
#include <cstring>
#include <cstdint>

namespace esphome {
namespace cc1101_cca {

/**
 * Lock-free single-producer single-consumer ring buffer for packet streaming.
 *
 * Producer: main loop() thread (check_rx callback)
 * Consumer: FreeRTOS UDP task
 *
 * This decouples the radio RX path from the potentially-blocking WiFi/UDP stack,
 * preventing FIFO overflows when the WiFi stack is busy.
 */

struct PacketEntry {
  uint8_t data[64];  // Max CC1101 FIFO size
  uint8_t len;
  int8_t rssi;
  bool is_tx;  // false = RX packet, true = TX packet
};

template<size_t SIZE>
class PacketRingBuffer {
  static_assert((SIZE & (SIZE - 1)) == 0, "SIZE must be a power of 2 for efficient modulo");

 public:
  PacketRingBuffer() : head_(0), tail_(0), dropped_(0), total_pushed_(0), total_popped_(0) {}

  /**
   * Push a packet into the buffer (producer side).
   * Non-blocking, O(1). Returns false if buffer is full.
   *
   * @param data Packet data
   * @param len Packet length (max 64)
   * @param rssi RSSI value
   * @param is_tx true if this is a TX packet, false for RX
   * @return true if packet was enqueued, false if buffer was full
   */
  bool push(const uint8_t* data, uint8_t len, int8_t rssi, bool is_tx = false) {
    size_t head = head_.load(std::memory_order_relaxed);
    size_t next = (head + 1) & (SIZE - 1);  // Fast modulo for power of 2

    // Check if buffer is full
    if (next == tail_.load(std::memory_order_acquire)) {
      dropped_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }

    // Copy packet data
    PacketEntry& entry = entries_[head];
    entry.len = (len > 64) ? 64 : len;
    entry.rssi = rssi;
    entry.is_tx = is_tx;
    memcpy(entry.data, data, entry.len);

    // Publish the write (release ensures data is visible before index update)
    head_.store(next, std::memory_order_release);
    total_pushed_.fetch_add(1, std::memory_order_relaxed);
    return true;
  }

  /**
   * Pop a packet from the buffer (consumer side).
   * Non-blocking, O(1). Returns false if buffer is empty.
   *
   * @param out Output packet entry
   * @return true if a packet was dequeued, false if buffer was empty
   */
  bool pop(PacketEntry& out) {
    size_t tail = tail_.load(std::memory_order_relaxed);

    // Check if buffer is empty
    if (tail == head_.load(std::memory_order_acquire)) {
      return false;
    }

    // Copy packet data
    out = entries_[tail];

    // Release the slot (release ensures read is complete before index update)
    tail_.store((tail + 1) & (SIZE - 1), std::memory_order_release);
    total_popped_.fetch_add(1, std::memory_order_relaxed);
    return true;
  }

  /**
   * Check if buffer is empty (approximate, for status only).
   */
  bool empty() const {
    return head_.load(std::memory_order_acquire) == tail_.load(std::memory_order_acquire);
  }

  /**
   * Get approximate number of packets in buffer.
   * Not exact due to concurrent access, but good for monitoring.
   */
  size_t size() const {
    size_t head = head_.load(std::memory_order_acquire);
    size_t tail = tail_.load(std::memory_order_acquire);
    return (head - tail + SIZE) & (SIZE - 1);
  }

  /**
   * Get number of dropped packets due to buffer full.
   */
  size_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

  /**
   * Get total packets pushed (for stats).
   */
  size_t total_pushed() const { return total_pushed_.load(std::memory_order_relaxed); }

  /**
   * Get total packets popped (for stats).
   */
  size_t total_popped() const { return total_popped_.load(std::memory_order_relaxed); }

  /**
   * Reset statistics (call only when buffer is known to be empty).
   */
  void reset_stats() {
    dropped_.store(0, std::memory_order_relaxed);
    total_pushed_.store(0, std::memory_order_relaxed);
    total_popped_.store(0, std::memory_order_relaxed);
  }

 private:
  PacketEntry entries_[SIZE];
  std::atomic<size_t> head_;      // Write position (producer)
  std::atomic<size_t> tail_;      // Read position (consumer)
  std::atomic<size_t> dropped_;   // Packets dropped due to full buffer
  std::atomic<size_t> total_pushed_;  // Total packets pushed
  std::atomic<size_t> total_popped_;  // Total packets popped
};

}  // namespace cc1101_cca
}  // namespace esphome
