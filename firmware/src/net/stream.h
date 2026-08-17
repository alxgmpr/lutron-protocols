#ifndef STREAM_H
#define STREAM_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* Wire format + FLAGS bits live in stream_frame.h (pure, host-testable). */
#include "stream_frame.h"

#ifdef __cplusplus
extern "C" {
#endif

/** UDP stream port */
#define STREAM_UDP_PORT 9433

/** Heartbeat interval (ms) */
#define STREAM_HEARTBEAT_MS 5000

/** Datagrams the stream task will drain in one pass before getting on with the
 *  rest of its loop. High enough that a chunked upload keeps up, bounded so a
 *  flood cannot starve the heartbeat and client expiry. */
#define STREAM_RX_DRAIN_MAX 64

/**
 * Stream command opcodes (host → STM32):
 */
#define STREAM_CMD_KEEPALIVE 0x00
#define STREAM_CMD_TX_RAW_CCA 0x01
#define STREAM_CMD_TX_RAW_CCX 0x02
#define STREAM_CMD_NRF_DFU_START 0x03
#define STREAM_CMD_NRF_DFU_DATA 0x04
#define STREAM_CMD_CCA_BUTTON 0x05
#define STREAM_CMD_CCA_LEVEL 0x06
#define STREAM_CMD_CCA_PICO_LVL 0x07
#define STREAM_CMD_CCA_STATE 0x08
#define STREAM_CMD_CCA_BEACON 0x09
#define STREAM_CMD_CCA_UNPAIR 0x0A
#define STREAM_CMD_CCA_LED 0x0B
#define STREAM_CMD_CCA_FADE 0x0C
#define STREAM_CMD_CCA_TRIM 0x0D
#define STREAM_CMD_CCA_PHASE 0x0E
#define STREAM_CMD_CCA_PICO_PAIR 0x0F
#define STREAM_CMD_CCA_BRIDGE_PAIR 0x10
#define STREAM_CMD_STATUS_QUERY 0x11
#define STREAM_CMD_CCA_SAVE_FAV 0x12
#define STREAM_CMD_CCA_VIVE_LEVEL 0x13
#define STREAM_CMD_CCA_VIVE_DIM 0x14
#define STREAM_CMD_CCA_VIVE_PAIR 0x15
#define STREAM_CMD_TX_RAW_CCX_CBOR 0x16
#define STREAM_CMD_CCA_HYBRID_PAIR 0x17
/* OTA full-TX session upload (host → STM32). See cca_ota_session.h. */
#define STREAM_CMD_OTA_UPLOAD_START 0x18 /* [u32 body_len LE] */
#define STREAM_CMD_OTA_UPLOAD_CHUNK 0x19 /* [u16 chunk_idx BE][bytes...] (chunk = idx * 240) */
#define STREAM_CMD_OTA_UPLOAD_END 0x1A   /* [] — verify expected/body match, log */
/* STM32 self-update staging (GLAB-106). Distinct from the CCA OTA commands
 * above, which stage an LDF body for on-air TX and never touch our own flash.
 * Each is acked with STREAM_RESP_FW_OTA so the host can resume after loss. */
#define STREAM_CMD_FW_OTA_START 0x1B /* [len:4 LE][crc32:4 LE][version:4 LE] */
#define STREAM_CMD_FW_OTA_CHUNK 0x1C /* [offset:4 LE][bytes...] */
#define STREAM_CMD_FW_OTA_END 0x1D   /* [] — verify and commit header */
#define STREAM_CMD_FW_OTA_INFO 0x1E  /* [] — query without changing anything */
#define STREAM_CMD_TEXT 0x20

/**
 * Stream response opcodes (STM32 → host):
 */
#define STREAM_RESP_TEXT 0xFD
#define STREAM_RESP_STATUS 0xFE
/* [0xFC][len][status:1 int8][written:4 LE][capacity:4 LE]
 *              [staged_valid:1][staged_len:4 LE][staged_version:4 LE] */
#define STREAM_RESP_FW_OTA 0xFC
#define STREAM_RESP_FW_OTA_LEN 18

/** Maximum concurrent UDP stream clients */
#define MAX_STREAM_CLIENTS 4

/** Start the UDP stream FreeRTOS task */
void stream_task_start(void);

/** Send a CCA packet to all registered UDP clients.
 *  timestamp_ms  = HAL_GetTick() at start-of-frame (wall-clock aligned).
 *  timestamp_cyc = DWT->CYCCNT at the same instant (~1.82 ns @ 548 MHz,
 *                  wraps every ~7.8 s). Gives host sub-µs intra-radio ordering. */
void stream_send_cca_packet(const uint8_t* data, size_t len, int8_t rssi, bool is_tx, uint32_t timestamp_ms,
                            uint32_t timestamp_cyc);

/** Sentinel for stream_send_ccx_packet(): the frame has no meaningful sender
 *  because this node originated it.  Emits no source trailer — never a zero
 *  address — and marks the frame STREAM_FLAG_TX. */
#define CCX_SRC_LOCAL NULL

/** Send a CCX packet to all registered UDP clients.
 *  src_addr = 16-byte sender IPv6 in network byte order for received frames,
 *  or CCX_SRC_LOCAL for frames this node originated.
 *
 *  The two cases are distinguishable on the wire, which is what lets a host
 *  tell "locally originated" (TX set, SRC clear) from "firmware predates the
 *  source trailer" (TX clear, SRC clear) on a single frame. */
void stream_send_ccx_packet(const uint8_t* data, size_t len, const uint8_t* src_addr);

/** Send a raw 802.15.4 frame to all registered UDP clients (promiscuous mode) */
void stream_send_raw_frame(const uint8_t* data, size_t len);

/** Broadcast a text message to all UDP stream clients (async, any task).
 *  Appears as RESP_TEXT (0xFD) to the host — same as shell command output. */
void stream_broadcast_text(const char* text, size_t len);

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
