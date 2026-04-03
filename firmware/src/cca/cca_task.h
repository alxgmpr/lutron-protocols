#ifndef CCA_TASK_H
#define CCA_TASK_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Start the CCA FreeRTOS task (CC1101 RX/TX loop) */
void cca_task_start(void);

/** Enqueue a raw CCA packet for TDMA-scheduled transmission. Thread-safe.
 *  The TDMA engine manages slot timing, sequence numbers, and retransmission. */
bool cca_tx_enqueue(const uint8_t* packet, size_t len);

/** Get RX packet count */
uint32_t cca_rx_count(void);

/** Get TX packet count */
uint32_t cca_tx_count(void);

/** Get count of dropped packets (decode failures with RSSI > -85) */
uint32_t cca_drop_count(void);

/** Get count of packets decoded but with CRC failure */
uint32_t cca_crc_fail_count(void);

/** Get count of packets decoded with N81 framing errors */
uint32_t cca_n81_err_count(void);

/** Count of decoded dimmer ACK packets (type 0x0B) */
uint32_t cca_ack_count(void);

/** Count of packets accepted via CRC-optional decode fallback */
uint32_t cca_crc_optional_count(void);

/** Number of GDO0 IRQ edges observed */
uint32_t cca_irq_count(void);

/** ISR-to-check_rx latency stats (microseconds) */
uint32_t cca_isr_latency_min_us(void);
uint32_t cca_isr_latency_p95_us(void);
uint32_t cca_isr_latency_max_us(void);
uint32_t cca_isr_latency_samples(void);

/** Reset CCA task-side RX/TX telemetry counters */
void cca_reset_stats(void);

/** Enable/disable verbose CCA RX UART logging (shell/VCP). */
void cca_set_uart_log_enabled(bool enabled);
bool cca_uart_log_enabled(void);

/** Get total packets transmitted by command functions */
uint32_t cca_cmd_tx_count(void);

/** RX hook callback type — set during bridge pairing handshake */
typedef void (*cca_rx_hook_t)(const struct DecodedPacket* pkt);

/** Set/clear the RX hook. Called from pairing engine (CCA task context). */
void cca_set_rx_hook(cca_rx_hook_t hook);

/** Flush pending RX packets — processes hooks, sends to stream.
 *  Must be called from CCA task context. Blocking pairing code needs
 *  this since the main task loop isn't running during blocking commands. */
void cca_flush_rx(void);

#ifdef __cplusplus
}
#endif

#endif /* CCA_TASK_H */
