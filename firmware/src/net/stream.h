#ifndef STREAM_H
#define STREAM_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** UDP stream port */
#define STREAM_UDP_PORT 9433

/** Heartbeat interval (ms) */
#define STREAM_HEARTBEAT_MS 5000

/**
 * Stream packet FLAGS byte:
 *   Bit 7:   Direction (0=RX from radio, 1=TX echo)
 *   Bit 6:   Protocol  (0=CCA, 1=CCX)
 *   Bits 0-5: |RSSI| for RX packets
 */
#define STREAM_FLAG_TX        0x80
#define STREAM_FLAG_CCX       0x40
#define STREAM_FLAG_RAW       0x20 /* Raw 802.15.4 frame (promiscuous sniff) */
#define STREAM_FLAG_RSSI_MASK 0x1F

/**
 * Stream command opcodes (host → STM32):
 */
#define STREAM_CMD_KEEPALIVE       0x00
#define STREAM_CMD_TX_RAW_CCA      0x01
#define STREAM_CMD_TX_RAW_CCX      0x02
#define STREAM_CMD_NRF_DFU_START   0x03
#define STREAM_CMD_NRF_DFU_DATA    0x04
#define STREAM_CMD_CCA_BUTTON      0x05
#define STREAM_CMD_CCA_LEVEL       0x06
#define STREAM_CMD_CCA_PICO_LVL    0x07
#define STREAM_CMD_CCA_STATE       0x08
#define STREAM_CMD_CCA_BEACON      0x09
#define STREAM_CMD_CCA_UNPAIR      0x0A
#define STREAM_CMD_CCA_LED         0x0B
#define STREAM_CMD_CCA_FADE        0x0C
#define STREAM_CMD_CCA_TRIM        0x0D
#define STREAM_CMD_CCA_PHASE       0x0E
#define STREAM_CMD_CCA_PICO_PAIR   0x0F
#define STREAM_CMD_CCA_BRIDGE_PAIR 0x10
#define STREAM_CMD_STATUS_QUERY    0x11
#define STREAM_CMD_CCA_SAVE_FAV    0x12
#define STREAM_CMD_CCA_VIVE_LEVEL  0x13
#define STREAM_CMD_CCA_VIVE_DIM    0x14
#define STREAM_CMD_CCA_VIVE_PAIR   0x15
#define STREAM_CMD_TX_RAW_CCX_CBOR 0x16
#define STREAM_CMD_TEXT            0x20

/**
 * Stream response opcodes (STM32 → host):
 */
#define STREAM_RESP_TEXT   0xFD
#define STREAM_RESP_STATUS 0xFE

/** Maximum concurrent UDP stream clients */
#define MAX_STREAM_CLIENTS 4

/** Start the UDP stream FreeRTOS task */
void stream_task_start(void);

/** Send a CCA packet to all registered UDP clients.
 *  timestamp_ms is the radio-side HAL_GetTick() when the packet was first heard. */
void stream_send_cca_packet(const uint8_t* data, size_t len, int8_t rssi, bool is_tx, uint32_t timestamp_ms);

/** Send a CCX packet to all registered UDP clients */
void stream_send_ccx_packet(const uint8_t* data, size_t len);

/** Send a raw 802.15.4 frame to all registered UDP clients (promiscuous mode) */
void stream_send_raw_frame(const uint8_t* data, size_t len);

/** Check if any UDP client is registered */
bool stream_client_connected(void);

/** Get number of registered UDP clients */
int stream_num_clients(void);

/** Telemetry counters for stream path health. */
uint32_t stream_tx_drop_count(void);
uint32_t stream_udp_sent_count(void);
uint32_t stream_udp_fail_count(void);

#ifdef __cplusplus
}
#endif

#endif /* STREAM_H */
