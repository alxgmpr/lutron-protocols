/**
 * CCX FreeRTOS task — Thread NCP via nRF52840 Dongle.
 *
 * Handles:
 *   1. Spinel/HDLC framing over USART2 (460800 baud)
 *   2. Thread network join (channel, PAN ID, master key, etc.)
 *   3. CCX message TX/RX over UDP port 9190 via PROP_STREAM_NET
 *   4. DFU: MCUboot SMP serial recovery to update nRF firmware
 *
 * TX path: ccx_send_level() → FreeRTOS queue → CBOR encode → IPv6+UDP →
 *          Spinel PROP_SET(STREAM_NET) → retransmit 7x
 *
 * RX path: hdlc_recv_frame() → PROP_INSERTED(STREAM_NET) → IPv6+UDP parse →
 *          CBOR decode → dedup → log + stream to TCP
 */

#include "ccx_task.h"
#include "ccx_msg.h"
#include "coap.h"
#include "ipv6_udp.h"
#include "spinel_props.h"
#include "smp_serial.h"
#include "stream.h"
#include "bsp.h"
#include "watchdog.h"

#include "FreeRTOS.h"
#include "task.h"
#include "semphr.h"
#include "queue.h"

#include <cstdio>
#include <cstring>

#define CCX_TASK_STACK_SIZE 2048
#define CCX_TASK_PRIORITY   2 /* Lower than CCA (3) — CCA is time-critical for CC1101 FIFO */

/* -----------------------------------------------------------------------
 * HDLC constants
 * ----------------------------------------------------------------------- */
#define HDLC_FLAG        0x7E
#define HDLC_ESCAPE      0x7D
#define HDLC_ESCAPE_XOR  0x20
#define HDLC_RX_BUF_SIZE 512

/* -----------------------------------------------------------------------
 * TX queue: other tasks enqueue requests, CCX task drains them
 * ----------------------------------------------------------------------- */
#define TX_QUEUE_SIZE 8

#define CCX_TX_TYPE_LEVEL 0
#define CCX_TX_TYPE_SCENE 1
#define CCX_TX_TYPE_COAP  2

#define CCX_COAP_MAX_PAYLOAD 128

struct ccx_tx_request_t {
    uint8_t  type;
    uint16_t id;       /* zone_id or scene_id (level/scene) */
    uint16_t level;    /* for level_control */
    uint8_t  fade;     /* for level_control (1=instant) */
    uint8_t  sequence;
    /* CoAP fields (type == CCX_TX_TYPE_COAP) */
    uint8_t  dst_addr[16];
    uint8_t  coap_code;
    char     uri_path[64];
    uint8_t  coap_payload[CCX_COAP_MAX_PAYLOAD];
    size_t   coap_payload_len;
};

static QueueHandle_t tx_queue = NULL;
/* High-rate CCX RX UART logging can interfere with shell usability.
 * Keep it disabled by default; raw packets still stream over TCP. */
static volatile bool ccx_rx_uart_log_enabled = false;
static volatile bool promiscuous_enabled = false;

/* -----------------------------------------------------------------------
 * MCUboot SMP serial DFU helpers
 * ----------------------------------------------------------------------- */
static uint8_t smp_seq = 0;

/**
 * Read a complete SMP serial response frame from USART2.
 * Scans for 0x06 0x09 header, reads until newline terminator.
 * Returns frame length including header/newline, or 0 on timeout.
 */
static size_t smp_recv_response(uint8_t* out, size_t out_size, uint32_t timeout_ms)
{
    uint32_t start = HAL_GetTick();
    size_t   pos = 0;
    bool     got_header = false;

    while ((HAL_GetTick() - start) < timeout_ms) {
        uint8_t byte;
        if (!bsp_uart2_rx_read(&byte)) {
            vTaskDelay(1);
            continue;
        }

        if (!got_header) {
            if (pos == 0 && byte == 0x06) {
                out[pos++] = byte;
            }
            else if (pos == 1 && byte == 0x09) {
                out[pos++] = byte;
                got_header = true;
            }
            else {
                pos = 0;
            }
            continue;
        }

        if (pos < out_size) {
            out[pos++] = byte;
        }

        if (byte == '\n') {
            return pos;
        }
    }

    return 0;
}

/* -----------------------------------------------------------------------
 * DFU state machine
 * ----------------------------------------------------------------------- */
static volatile ccx_dfu_state_t dfu_state = CCX_DFU_IDLE;
static uint32_t                 dfu_image_size = 0;
static uint32_t                 dfu_bytes_written = 0;

/* Chunk buffer: stream task writes here, ccx task drains it */
#define DFU_CHUNK_BUF_SIZE 256
static uint8_t           dfu_chunk_buf[DFU_CHUNK_BUF_SIZE];
static volatile size_t   dfu_chunk_len = 0;
static SemaphoreHandle_t dfu_chunk_sem = NULL;
static SemaphoreHandle_t dfu_chunk_ready = NULL;

/* -----------------------------------------------------------------------
 * Shell command passthrough — binary semaphore handshake
 * ----------------------------------------------------------------------- */
static ccx_spinel_request_t  shell_cmd_req;
static ccx_spinel_response_t shell_cmd_resp;
static SemaphoreHandle_t     shell_cmd_ready = NULL; /* shell gives, ccx takes */
static SemaphoreHandle_t     shell_cmd_done = NULL;  /* ccx gives, shell takes */

/* -----------------------------------------------------------------------
 * Private state
 * ----------------------------------------------------------------------- */
static bool              running = false;
static TaskHandle_t      ccx_task_handle = NULL;
static volatile bool     ncp_detected = false;
static volatile uint8_t  thread_role = SPINEL_NET_ROLE_DETACHED;
static volatile uint32_t rx_count = 0;
static volatile uint32_t tx_count = 0;
static volatile uint32_t raw_rx_count = 0;
static uint8_t           our_ipv6_addr[16]; /* mesh-local address for TX source */
static bool              have_ipv6_addr = false;
static uint8_t           ccx_sequence = 0; /* auto-increment if caller passes 0 */

/* -----------------------------------------------------------------------
 * RX deduplication ring buffer
 *
 * CCX commands are multicast 7-25 times. Keep (msg_type, seq, tick)
 * and suppress duplicates within a 2-second window.
 * ----------------------------------------------------------------------- */
#define DEDUP_RING_SIZE 16
#define DEDUP_WINDOW_MS 2000

struct dedup_entry_t {
    uint16_t msg_type;
    uint8_t  sequence;
    uint32_t tick;
};

static dedup_entry_t dedup_ring[DEDUP_RING_SIZE];
static size_t        dedup_idx = 0;

static bool dedup_is_duplicate(uint16_t msg_type, uint8_t sequence)
{
    uint32_t now = HAL_GetTick();
    for (size_t i = 0; i < DEDUP_RING_SIZE; i++) {
        if (dedup_ring[i].msg_type == msg_type && dedup_ring[i].sequence == sequence &&
            (now - dedup_ring[i].tick) < DEDUP_WINDOW_MS) {
            return true;
        }
    }
    /* Not a duplicate — record it */
    dedup_ring[dedup_idx].msg_type = msg_type;
    dedup_ring[dedup_idx].sequence = sequence;
    dedup_ring[dedup_idx].tick = now;
    dedup_idx = (dedup_idx + 1) % DEDUP_RING_SIZE;
    return false;
}

/* -----------------------------------------------------------------------
 * Peer table — track device RLOC from RX source addresses
 *
 * Every CCX multicast packet reveals its sender's RLOC in the IPv6 src.
 * We cache (rloc16 → serial/device_id) so CoAP commands can address
 * devices by serial number instead of needing full IPv6 addresses.
 * ----------------------------------------------------------------------- */
#define CCX_MAX_PEERS 32

struct ccx_peer_t {
    uint16_t rloc16;          /* RLOC16 from src addr (0 = unused) */
    uint32_t serial;          /* from DEVICE_REPORT/STATUS (0 = unknown) */
    uint8_t  device_id[4];   /* from BUTTON_PRESS (all 0 = unknown) */
    uint16_t last_msg_type;
    uint32_t last_seen_tick;
    uint8_t  prefix[8];      /* mesh-local prefix from src addr */
};

static ccx_peer_t peer_table[CCX_MAX_PEERS];
static size_t     peer_count = 0;

/** Extract RLOC16 from an IPv6 address, or 0 if it's not an RLOC address.
 *  RLOC format: fd..::00ff:fe00:XXXX (bytes 8-13 = 00:00:00:ff:fe:00) */
static uint16_t extract_rloc16(const uint8_t addr[16])
{
    if (addr[0] == 0xFD &&
        addr[8] == 0x00 && addr[9] == 0x00 &&
        addr[10] == 0x00 && addr[11] == 0xFF &&
        addr[12] == 0xFE && addr[13] == 0x00) {
        return (uint16_t)((addr[14] << 8) | addr[15]);
    }
    return 0;
}

/** Build an RLOC IPv6 address from RLOC16 using our mesh-local prefix. */
static void build_rloc_addr(uint16_t rloc16, uint8_t out[16])
{
    /* Use our own mesh-local prefix (first 8 bytes of our_ipv6_addr) */
    if (have_ipv6_addr) {
        memcpy(out, our_ipv6_addr, 8);
    } else {
        memset(out, 0, 8);
        out[0] = 0xFD;
    }
    out[8]  = 0x00;
    out[9]  = 0x00;
    out[10] = 0x00;
    out[11] = 0xFF;
    out[12] = 0xFE;
    out[13] = 0x00;
    out[14] = (uint8_t)(rloc16 >> 8);
    out[15] = (uint8_t)(rloc16 & 0xFF);
}

/** Update or insert a peer entry. Returns pointer to the entry. */
static ccx_peer_t* peer_update(uint16_t rloc16, const uint8_t src_addr[16])
{
    if (rloc16 == 0) return NULL;

    /* Find existing entry */
    for (size_t i = 0; i < peer_count; i++) {
        if (peer_table[i].rloc16 == rloc16) {
            peer_table[i].last_seen_tick = HAL_GetTick();
            memcpy(peer_table[i].prefix, src_addr, 8);
            return &peer_table[i];
        }
    }

    /* Add new entry */
    ccx_peer_t* p;
    if (peer_count < CCX_MAX_PEERS) {
        p = &peer_table[peer_count++];
    } else {
        /* Evict oldest */
        size_t oldest = 0;
        for (size_t i = 1; i < CCX_MAX_PEERS; i++) {
            if (peer_table[i].last_seen_tick < peer_table[oldest].last_seen_tick)
                oldest = i;
        }
        p = &peer_table[oldest];
    }
    memset(p, 0, sizeof(*p));
    p->rloc16 = rloc16;
    p->last_seen_tick = HAL_GetTick();
    memcpy(p->prefix, src_addr, 8);
    return p;
}

/* -----------------------------------------------------------------------
 * HDLC framing helpers (for Spinel over UART)
 * ----------------------------------------------------------------------- */

/* CRC-16/CCITT for HDLC-Lite */
static uint16_t hdlc_crc16(const uint8_t* data, size_t len)
{
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i];
        for (int j = 0; j < 8; j++) {
            if (crc & 1)
                crc = (crc >> 1) ^ 0x8408;
            else
                crc >>= 1;
        }
    }
    return crc ^ 0xFFFF;
}

/* Send a byte with HDLC escaping */
static void hdlc_send_byte(uint8_t b)
{
    if (b == HDLC_FLAG || b == HDLC_ESCAPE) {
        uint8_t esc[2] = {HDLC_ESCAPE, (uint8_t)(b ^ HDLC_ESCAPE_XOR)};
        HAL_UART_Transmit(&huart2, esc, 2, 10);
    }
    else {
        HAL_UART_Transmit(&huart2, &b, 1, 10);
    }
}

/* Send a complete HDLC frame (flag + escaped data + CRC + flag) */
static void hdlc_send_frame(const uint8_t* data, size_t len)
{
    uint8_t flag = HDLC_FLAG;
    HAL_UART_Transmit(&huart2, &flag, 1, 10);

    for (size_t i = 0; i < len; i++) {
        hdlc_send_byte(data[i]);
    }

    uint16_t crc = hdlc_crc16(data, len);
    hdlc_send_byte((uint8_t)(crc & 0xFF));
    hdlc_send_byte((uint8_t)(crc >> 8));

    HAL_UART_Transmit(&huart2, &flag, 1, 10);
}

/* Read one HDLC frame from USART2 using interrupt-driven ring buffer.
 * Yields via vTaskDelay(1) when no data available (non-blocking to other tasks).
 * Returns the unescaped payload length (excluding CRC), or 0 on timeout/error. */
static size_t hdlc_recv_frame(uint8_t* out, size_t out_size, uint32_t timeout_ms)
{
    uint32_t start = HAL_GetTick();
    size_t   pos = 0;
    bool     in_frame = false;
    bool     escaped = false;

    while ((HAL_GetTick() - start) < timeout_ms) {
        uint8_t byte;
        if (!bsp_uart2_rx_read(&byte)) {
            /* No data — yield CPU to let CCA and other tasks run */
            vTaskDelay(1);
            continue;
        }

        if (byte == HDLC_FLAG) {
            if (in_frame && pos > 0) {
                /* End of frame — verify CRC (last 2 bytes) */
                if (pos < 2) return 0;
                uint16_t rx_crc = (uint16_t)out[pos - 2] | ((uint16_t)out[pos - 1] << 8);
                uint16_t calc_crc = hdlc_crc16(out, pos - 2);
                if (rx_crc != calc_crc) {
                    return 0;
                }
                return pos - 2; /* payload length without CRC */
            }
            /* Start of new frame */
            in_frame = true;
            pos = 0;
            escaped = false;
            continue;
        }

        if (!in_frame) continue;

        if (byte == HDLC_ESCAPE) {
            escaped = true;
            continue;
        }

        if (escaped) {
            byte ^= HDLC_ESCAPE_XOR;
            escaped = false;
        }

        if (pos < out_size) {
            out[pos++] = byte;
        }
    }

    return 0; /* timeout */
}

/* -----------------------------------------------------------------------
 * Spinel TID management
 * ----------------------------------------------------------------------- */
static uint8_t spinel_tid = 1;
static uint8_t spinel_next_tid(void)
{
    uint8_t tid = spinel_tid;
    spinel_tid = (spinel_tid % 15) + 1;
    return tid;
}
static uint8_t spinel_header(void)
{
    return 0x80 | spinel_next_tid();
}

/* -----------------------------------------------------------------------
 * Spinel commands
 * ----------------------------------------------------------------------- */

/* Send Spinel RESET command */
static void spinel_send_reset(void)
{
    uint8_t frame[] = {0x80, SPINEL_CMD_RESET};
    hdlc_send_frame(frame, sizeof(frame));
}

/**
 * Wait for a Spinel response matching the expected command and property.
 * Skips unsolicited frames (TID=0) and logs mismatches for debugging.
 * Returns the payload length after the header+cmd+prop, or 0 on timeout.
 */
static size_t spinel_wait_response(uint8_t expect_cmd, uint8_t expect_prop, uint8_t* out, size_t out_size,
                                   uint32_t timeout_ms)
{
    uint32_t start = HAL_GetTick();

    while ((HAL_GetTick() - start) < timeout_ms) {
        uint8_t  rx_buf[HDLC_RX_BUF_SIZE];
        uint32_t remaining = timeout_ms - (HAL_GetTick() - start);
        if (remaining > timeout_ms) break; /* overflow guard */

        size_t rx_len = hdlc_recv_frame(rx_buf, sizeof(rx_buf), remaining);
        if (rx_len < 3) continue;

        uint8_t tid = rx_buf[0] & 0x0F;
        uint8_t cmd = rx_buf[1];
        uint8_t prop = rx_buf[2];

        /* Got our expected response */
        if (cmd == expect_cmd && prop == expect_prop) {
            size_t val_len = rx_len - 3;
            if (val_len > out_size) val_len = out_size;
            memcpy(out, rx_buf + 3, val_len);
            return val_len;
        }

        /* NCP error: PROP_IS for LAST_STATUS (prop 0x00) = Spinel error */
        if (cmd == SPINEL_CMD_PROP_IS && prop == 0x00 && rx_len >= 4) {
            printf("[ccx] NCP error: LAST_STATUS=%u for prop 0x%02X\r\n", rx_buf[3], expect_prop);
            return 0;
        }

        /* Silently skip STREAM_RAW/STREAM_NET unsolicited frames */
        if (prop == SPINEL_PROP_STREAM_RAW || prop == SPINEL_PROP_STREAM_NET) {
            continue;
        }

        /* Other unsolicited or mismatched frame — log it */
        printf("[ccx] Skipping frame: tid=%u cmd=0x%02X prop=0x%02X "
               "(waiting for cmd=0x%02X prop=0x%02X)\r\n",
               tid, cmd, prop, expect_cmd, expect_prop);
    }

    return 0;
}

/**
 * Send PROP_VALUE_GET and wait for PROP_VALUE_IS response.
 * Returns payload length after the property ID, or 0 on failure.
 */
static size_t spinel_prop_get(uint8_t prop_id, uint8_t* resp, size_t resp_size, uint32_t timeout_ms)
{
    uint8_t hdr = spinel_header();
    uint8_t frame[] = {hdr, SPINEL_CMD_PROP_GET, prop_id};
    hdlc_send_frame(frame, sizeof(frame));

    return spinel_wait_response(SPINEL_CMD_PROP_IS, prop_id, resp, resp_size, timeout_ms);
}

/**
 * Send PROP_VALUE_SET and wait for PROP_VALUE_IS confirmation.
 * Returns true if NCP acknowledged with matching property.
 */
static bool spinel_prop_set(uint8_t prop_id, const uint8_t* value, size_t value_len, uint32_t timeout_ms)
{
    uint8_t frame[HDLC_RX_BUF_SIZE];
    if (3 + value_len > sizeof(frame)) return false;

    frame[0] = spinel_header();
    frame[1] = SPINEL_CMD_PROP_SET;
    frame[2] = prop_id;
    memcpy(frame + 3, value, value_len);
    hdlc_send_frame(frame, 3 + value_len);

    uint8_t resp[64];
    size_t  len = spinel_wait_response(SPINEL_CMD_PROP_IS, prop_id, resp, sizeof(resp), timeout_ms);
    /* PROP_IS echoes back the value; len >= 1 for bool/int props.
     * A LAST_STATUS error returns 0 via the error path in spinel_wait_response. */
    return len > 0;
}

/**
 * Send PROP_VALUE_INSERT and wait for PROP_VALUE_INSERTED confirmation.
 * Used to add entries to list-type properties (e.g. multicast address table).
 */
static bool spinel_prop_insert(uint8_t prop_id, const uint8_t* value, size_t value_len, uint32_t timeout_ms)
{
    uint8_t frame[HDLC_RX_BUF_SIZE];
    if (3 + value_len > sizeof(frame)) return false;

    frame[0] = spinel_header();
    frame[1] = SPINEL_CMD_PROP_INSERT;
    frame[2] = prop_id;
    memcpy(frame + 3, value, value_len);
    hdlc_send_frame(frame, 3 + value_len);

    uint8_t resp[64];
    return spinel_wait_response(SPINEL_CMD_PROP_INSERTED, prop_id, resp, sizeof(resp), timeout_ms) > 0;
}

/* -----------------------------------------------------------------------
 * MCUboot SMP serial helpers (stub)
 * ----------------------------------------------------------------------- */


/* -----------------------------------------------------------------------
 * DFU state machine
 * ----------------------------------------------------------------------- */
static void dfu_enter_bootloader(void)
{
    printf("[ccx] DFU: sending Spinel RESET to enter bootloader...\r\n");
    dfu_state = CCX_DFU_ENTERING_BOOTLOADER;
    smp_seq = 0;

    /* Send Spinel reset — NCP firmware should set GPREGRET=0xB1
     * and reset into MCUboot serial recovery mode */
    spinel_send_reset();
    vTaskDelay(pdMS_TO_TICKS(500));

    /* Switch USART2 to 115200 baud for MCUboot serial recovery */
    printf("[ccx] DFU: switching USART2 to 115200 baud\r\n");
    bsp_uart2_set_baud(115200);
    vTaskDelay(pdMS_TO_TICKS(1000));

    /* Flush any boot garbage from ring buffer */
    uint8_t junk;
    while (bsp_uart2_rx_read(&junk)) {}

    /* Probe bootloader with SMP image-list request */
    printf("[ccx] DFU: probing MCUboot with SMP image-list...\r\n");
    uint8_t probe_buf[128];
    size_t  probe_len = smp_build_image_list(probe_buf, sizeof(probe_buf), smp_seq++);
    if (probe_len == 0) {
        printf("[ccx] DFU: failed to build SMP probe frame\r\n");
        dfu_state = CCX_DFU_ERROR;
        return;
    }

    HAL_UART_Transmit(&huart2, probe_buf, (uint16_t)probe_len, 100);

    /* Wait for SMP response */
    uint8_t resp_buf[512];
    size_t  resp_len = smp_recv_response(resp_buf, sizeof(resp_buf), 3000);
    if (resp_len == 0) {
        printf("[ccx] DFU: no SMP response — bootloader not running\r\n");
        dfu_state = CCX_DFU_ERROR;
        return;
    }

    /* Image-list response has no "rc" on success (it returns "images" array).
     * If parse finds rc > 0, that's an error. Otherwise bootloader is alive. */
    int      rc;
    uint32_t off;
    bool     parsed = smp_parse_response(resp_buf, resp_len, &rc, &off);
    if (parsed && rc != 0) {
        printf("[ccx] DFU: MCUboot returned error rc=%d\r\n", rc);
        dfu_state = CCX_DFU_ERROR;
        return;
    }

    printf("[ccx] DFU: MCUboot serial recovery mode confirmed (%u bytes)\r\n", (unsigned)resp_len);
    dfu_state = CCX_DFU_UPLOADING;
}

static void dfu_upload_loop(void)
{
    printf("[ccx] DFU: uploading %lu bytes...\r\n", (unsigned long)dfu_image_size);

    while (dfu_bytes_written < dfu_image_size && dfu_state == CCX_DFU_UPLOADING) {
        watchdog_feed();

        if (xSemaphoreTake(dfu_chunk_ready, pdMS_TO_TICKS(10000)) != pdTRUE) {
            printf("[ccx] DFU: timeout waiting for data chunk\r\n");
            dfu_state = CCX_DFU_ERROR;
            return;
        }

        /* Build SMP upload frame */
        uint8_t smp_buf[512];
        size_t  smp_len = smp_build_upload(smp_buf, sizeof(smp_buf), dfu_bytes_written, dfu_chunk_buf, dfu_chunk_len,
                                           dfu_image_size, smp_seq++);
        if (smp_len == 0) {
            printf("[ccx] DFU: SMP frame build failed\r\n");
            dfu_state = CCX_DFU_ERROR;
            xSemaphoreGive(dfu_chunk_sem);
            return;
        }

        /* Transmit SMP frame to bootloader */
        HAL_UART_Transmit(&huart2, smp_buf, (uint16_t)smp_len, 200);

        /* Wait for SMP response confirming the chunk */
        uint8_t resp_buf[256];
        size_t  resp_len = smp_recv_response(resp_buf, sizeof(resp_buf), 5000);
        if (resp_len == 0) {
            printf("[ccx] DFU: no response from bootloader\r\n");
            dfu_state = CCX_DFU_ERROR;
            xSemaphoreGive(dfu_chunk_sem);
            return;
        }

        int      rc;
        uint32_t ack_off;
        if (!smp_parse_response(resp_buf, resp_len, &rc, &ack_off)) {
            printf("[ccx] DFU: failed to parse SMP response\r\n");
            dfu_state = CCX_DFU_ERROR;
            xSemaphoreGive(dfu_chunk_sem);
            return;
        }

        if (rc != 0) {
            printf("[ccx] DFU: bootloader error rc=%d\r\n", rc);
            dfu_state = CCX_DFU_ERROR;
            xSemaphoreGive(dfu_chunk_sem);
            return;
        }

        dfu_bytes_written += dfu_chunk_len;
        printf("[ccx] DFU: %lu / %lu bytes (ack_off=%lu)\r\n", (unsigned long)dfu_bytes_written,
               (unsigned long)dfu_image_size, (unsigned long)ack_off);

        xSemaphoreGive(dfu_chunk_sem);
    }

    if (dfu_state == CCX_DFU_UPLOADING) {
        printf("[ccx] DFU: upload complete, waiting for MCUboot validation...\r\n");
        dfu_state = CCX_DFU_VALIDATING;
        /* MCUboot validates the image internally (CRC + signature).
         * After validation it auto-boots the new firmware. */
        vTaskDelay(pdMS_TO_TICKS(5000));
        printf("[ccx] DFU: complete. nRF should be running new firmware.\r\n");
        dfu_state = CCX_DFU_COMPLETE;
    }
}

/* -----------------------------------------------------------------------
 * NCP probe: verify the nRF is alive and speaking Spinel
 * ----------------------------------------------------------------------- */
static bool ncp_probe(void)
{
    printf("[ccx] Probing nRF52840 NCP at 460800 baud...\r\n");

    vTaskDelay(pdMS_TO_TICKS(1500));

    /* Flush any boot garbage from ring buffer */
    uint8_t junk;
    while (bsp_uart2_rx_read(&junk)) {}

    /* Read unsolicited boot frame */
    uint8_t boot_buf[HDLC_RX_BUF_SIZE];
    size_t  boot_len = hdlc_recv_frame(boot_buf, sizeof(boot_buf), 1000);
    if (boot_len > 0) {
        printf("[ccx] NCP boot frame: %u bytes, cmd=0x%02X\r\n", (unsigned)boot_len, boot_len >= 2 ? boot_buf[1] : 0);
    }

    /* Send reset and wait */
    spinel_send_reset();
    vTaskDelay(pdMS_TO_TICKS(500));

    size_t reset_len = hdlc_recv_frame(boot_buf, sizeof(boot_buf), 2000);
    if (reset_len > 0) {
        printf("[ccx] NCP reset response: %u bytes, cmd=0x%02X\r\n", (unsigned)reset_len,
               reset_len >= 2 ? boot_buf[1] : 0);
    }
    else {
        printf("[ccx] No HDLC frame received. Raw bytes: ");
        uint32_t n = 0;
        uint32_t tstart = HAL_GetTick();
        while ((HAL_GetTick() - tstart) < 1000 && n < 32) {
            uint8_t b;
            if (bsp_uart2_rx_read(&b)) {
                printf("%02X ", b);
                n++;
            }
            else {
                vTaskDelay(1);
            }
        }
        if (n == 0) printf("(none)");
        printf("\r\n");
    }

    /* Query protocol version */
    uint8_t ver_buf[16];
    size_t  ver_len = spinel_prop_get(SPINEL_PROP_PROTOCOL_VERSION, ver_buf, sizeof(ver_buf), 2000);
    if (ver_len >= 2) {
        printf("[ccx] NCP protocol version: %u.%u\r\n", ver_buf[0], ver_buf[1]);
    }
    else {
        printf("[ccx] NCP did not respond to protocol version query\r\n");
        return false;
    }

    /* Query NCP version string */
    uint8_t ncp_ver[128];
    size_t  ncp_len = spinel_prop_get(SPINEL_PROP_NCP_VERSION, ncp_ver, sizeof(ncp_ver) - 1, 2000);
    if (ncp_len > 0) {
        ncp_ver[ncp_len] = '\0';
        printf("[ccx] NCP firmware: %s\r\n", (char*)ncp_ver);
    }

    /* Query EUI-64 */
    uint8_t hwaddr[8];
    size_t  hw_len = spinel_prop_get(SPINEL_PROP_HWADDR, hwaddr, sizeof(hwaddr), 2000);
    if (hw_len == 8) {
        printf("[ccx] NCP EUI-64: %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X\r\n", hwaddr[0], hwaddr[1], hwaddr[2],
               hwaddr[3], hwaddr[4], hwaddr[5], hwaddr[6], hwaddr[7]);
    }

    return true;
}

/* -----------------------------------------------------------------------
 * Thread network join sequence
 * ----------------------------------------------------------------------- */
static bool thread_join(void)
{
    printf("[ccx] Joining Lutron Thread network (ch=%d, PAN=0x%04X)...\r\n", LUTRON_THREAD_CHANNEL,
           LUTRON_THREAD_PANID);

    /* 1. Set channel */
    uint8_t chan = LUTRON_THREAD_CHANNEL;
    if (!spinel_prop_set(SPINEL_PROP_PHY_CHAN, &chan, 1, 2000)) {
        printf("[ccx] Failed to set channel\r\n");
        return false;
    }
    printf("[ccx] Channel: %d\r\n", chan);

    /* 2. Set PAN ID (little-endian uint16) */
    uint8_t panid[2] = {(uint8_t)(LUTRON_THREAD_PANID & 0xFF), (uint8_t)(LUTRON_THREAD_PANID >> 8)};
    if (!spinel_prop_set(SPINEL_PROP_MAC_15_4_PANID, panid, 2, 2000)) {
        printf("[ccx] Failed to set PAN ID\r\n");
        return false;
    }
    printf("[ccx] PAN ID: 0x%04X\r\n", LUTRON_THREAD_PANID);

    /* 3. Set Extended PAN ID */
    if (!spinel_prop_set(SPINEL_PROP_NET_XPANID, LUTRON_THREAD_XPANID, 8, 2000)) {
        printf("[ccx] Failed to set Extended PAN ID\r\n");
        return false;
    }
    printf("[ccx] Extended PAN ID set\r\n");

    /* 4. Set Network Master Key */
    if (!spinel_prop_set(SPINEL_PROP_NET_NETWORK_KEY, LUTRON_THREAD_MASTER_KEY, 16, 2000)) {
        printf("[ccx] Failed to set master key\r\n");
        return false;
    }
    printf("[ccx] Master key set\r\n");

    /* 5. Set CCA threshold BEFORE bringing up interface.
     *    Default is ~-75 dBm which is too sensitive — 2.4 GHz WiFi noise
     *    at -67 dBm triggers CCA on every TX attempt, causing 100% TX failure.
     *    Must be set before ifconfig up / thread start. */
    uint8_t cca_thresh = (uint8_t)(int8_t)-45; /* 0xD3 = -45 dBm */
    if (!spinel_prop_set(SPINEL_PROP_PHY_CCA_THRESHOLD, &cca_thresh, 1, 2000)) {
        printf("[ccx] WARNING: failed to set CCA threshold\r\n");
    }
    else {
        printf("[ccx] CCA threshold: -45 dBm\r\n");
    }

    /* 6. Bring up network interface */
    uint8_t flag_true = 1;
    if (!spinel_prop_set(SPINEL_PROP_NET_IF_UP, &flag_true, 1, 2000)) {
        printf("[ccx] Failed to bring interface up\r\n");
        return false;
    }
    printf("[ccx] Interface UP\r\n");

    /* 7. Start Thread stack */
    if (!spinel_prop_set(SPINEL_PROP_NET_STACK_UP, &flag_true, 1, 2000)) {
        printf("[ccx] Failed to start Thread stack\r\n");
        return false;
    }
    printf("[ccx] Thread stack started\r\n");

    /* 8. Poll NET_ROLE until != DETACHED (up to 30 seconds) */
    printf("[ccx] Waiting for Thread attachment...\r\n");
    for (int attempt = 0; attempt < 60; attempt++) {
        vTaskDelay(pdMS_TO_TICKS(500));

        uint8_t role_buf[4];
        size_t  role_len = spinel_prop_get(SPINEL_PROP_NET_ROLE, role_buf, sizeof(role_buf), 1000);
        if (role_len >= 1) {
            thread_role = role_buf[0];
            if (thread_role != SPINEL_NET_ROLE_DETACHED) {
                printf("[ccx] Thread attached! Role: %s (%u)\r\n", ccx_thread_role_str(), thread_role);
                break;
            }
        }

        if (attempt > 0 && attempt % 10 == 0) {
            printf("[ccx] Still waiting... (%d s)\r\n", attempt / 2);
        }
    }

    if (thread_role == SPINEL_NET_ROLE_DETACHED) {
        printf("[ccx] Thread attachment FAILED (still detached after 30s)\r\n");
        return false;
    }

    /* 9. Promote to ROUTER for direct multicast participation.
     *    A CHILD depends on its parent to forward multicast; a ROUTER
     *    receives ff03::1 directly and participates in mesh routing. */
    if (thread_role == SPINEL_NET_ROLE_CHILD) {
        uint8_t router_role = SPINEL_NET_ROLE_ROUTER;
        if (spinel_prop_set(SPINEL_PROP_NET_ROLE, &router_role, 1, 5000)) {
            thread_role = SPINEL_NET_ROLE_ROUTER;
            printf("[ccx] Promoted to ROUTER\r\n");
        }
        else {
            printf("[ccx] WARNING: router promotion failed, staying as CHILD\r\n");
        }
    }

    /* 10. Subscribe to ff03::1 multicast (CCX traffic is all multicast).
     *    Without this, the NCP silently drops inbound multicast packets
     *    instead of forwarding them to the host via STREAM_NET. */
    if (!spinel_prop_insert(SPINEL_PROP_IPV6_MULTICAST_ADDRESS_TABLE, CCX_MULTICAST_ADDR, 16, 2000)) {
        printf("[ccx] WARNING: failed to subscribe to ff03::1 multicast\r\n");
        /* Non-fatal: TX will still work, but RX of CCX traffic will fail */
    }
    else {
        printf("[ccx] Subscribed to ff03::1 multicast\r\n");
    }

    /* 11. Parse IPv6 address table to get our mesh-local address for TX.
     *    Format: A(t(6CLLC)) — array of structs, each prefixed with 2-byte LE length.
     *    Each struct: [IPv6 addr (16)] [prefix_len (1)] [valid_lt (4)] [pref_lt (4)] ...
     *    We want the first fd00::/8 address (mesh-local). */
    uint8_t addr_buf[256];
    size_t  addr_len = spinel_prop_get(SPINEL_PROP_IPV6_ADDRESS_TABLE, addr_buf, sizeof(addr_buf), 2000);
    if (addr_len > 0) {
        size_t pos = 0;
        while (pos + 2 < addr_len) {
            uint16_t entry_len = (uint16_t)addr_buf[pos] | ((uint16_t)addr_buf[pos + 1] << 8);
            pos += 2;
            if (entry_len < 16 || pos + entry_len > addr_len) break;
            const uint8_t* addr = addr_buf + pos;
            if (addr[0] == 0xFD && !have_ipv6_addr) {
                memcpy(our_ipv6_addr, addr, 16);
                have_ipv6_addr = true;
                printf("[ccx] Our mesh-local addr: %02x%02x:%02x%02x:%02x%02x:%02x%02x:"
                       "%02x%02x:%02x%02x:%02x%02x:%02x%02x\r\n",
                       addr[0], addr[1], addr[2], addr[3], addr[4], addr[5], addr[6], addr[7],
                       addr[8], addr[9], addr[10], addr[11], addr[12], addr[13], addr[14], addr[15]);
            }
            pos += entry_len;
        }
        if (!have_ipv6_addr) {
            printf("[ccx] WARNING: no mesh-local address found, TX checksum will be 0\r\n");
        }
    }

    return true;
}

/* -----------------------------------------------------------------------
 * TX: encode and send a CCX message via Spinel PROP_STREAM_NET
 * ----------------------------------------------------------------------- */

/* Retransmit count matching Lutron multicast pattern */
#define CCX_TX_RETRANSMITS   7
#define CCX_TX_RETRANSMIT_MS 80
#define COAP_UDP_PORT        5683

static bool ccx_transmit_ipv6(const uint8_t* ipv6_pkt, size_t pkt_len)
{
    /* STREAM_NET uses Spinel 'dD' format:
     *   d = [len_lo][len_hi][IPv6 packet]
     *   D = [len_lo][len_hi][metadata]   (we send empty metadata)
     */
    uint8_t frame[HDLC_RX_BUF_SIZE];
    size_t  frame_len = 3 + 2 + pkt_len + 2; /* hdr+cmd+prop + d_prefix + pkt + empty_D */
    if (frame_len > sizeof(frame)) return false;

    uint8_t hdr = spinel_header();
    frame[0] = hdr;
    frame[1] = SPINEL_CMD_PROP_SET;
    frame[2] = SPINEL_PROP_STREAM_NET;
    /* 'd' field: 2-byte LE length + IPv6 packet */
    frame[3] = (uint8_t)(pkt_len & 0xFF);
    frame[4] = (uint8_t)(pkt_len >> 8);
    memcpy(frame + 5, ipv6_pkt, pkt_len);
    /* 'D' field: empty metadata (2-byte LE length = 0) */
    frame[5 + pkt_len] = 0x00;
    frame[6 + pkt_len] = 0x00;
    hdlc_send_frame(frame, frame_len);

    /* Wait for NCP response to verify it accepted the packet */
    uint8_t resp[HDLC_RX_BUF_SIZE];
    size_t  resp_len = hdlc_recv_frame(resp, sizeof(resp), 500);
    if (resp_len < 3) {
        printf("[ccx] TX: no NCP response (len=%u)\r\n", (unsigned)resp_len);
        return false;
    }

    uint8_t resp_cmd = resp[1];
    uint8_t resp_prop = resp[2];

    /* NCP returns PROP_IS(LAST_STATUS) with status=0 on STREAM_NET success,
     * or PROP_IS(STREAM_NET) echoing the property back. Both are OK. */
    if (resp_cmd == SPINEL_CMD_PROP_IS) {
        if (resp_prop == SPINEL_PROP_STREAM_NET) {
            return true;
        }
        if (resp_prop == 0x00 /* LAST_STATUS */) {
            uint8_t status = (resp_len > 3) ? resp[3] : 0xFF;
            if (status == 0) return true; /* STATUS_OK */
            printf("[ccx] TX: NCP LAST_STATUS error=%u\r\n", status);
            return false;
        }
    }

    printf("[ccx] TX: NCP unexpected response (cmd=0x%02X prop=0x%02X len=%u)\r\n",
           resp_cmd, resp_prop, (unsigned)resp_len);
    return false;
}

static void coap_send_empty_ack(const uint8_t* dst_addr, uint16_t src_port, uint16_t dst_port, uint16_t mid)
{
    uint8_t ack[4];
    coap_build_ack(ack, sizeof(ack), mid);
    uint8_t pkt[128];
    size_t  pkt_len = ipv6_udp_build(pkt, sizeof(pkt), have_ipv6_addr ? our_ipv6_addr : NULL,
                                     dst_addr, src_port, dst_port, ack, sizeof(ack));
    if (pkt_len == 0) return;
    ccx_transmit_ipv6(pkt, pkt_len);
}

static uint16_t coap_msg_id_counter = 0x1000;
static uint8_t  coap_token_counter = 0x01;

static void ccx_process_tx(const ccx_tx_request_t* req)
{
    if (req->type == CCX_TX_TYPE_COAP) {
        /* --- CoAP unicast TX --- */
        uint8_t coap_buf[256];
        uint16_t mid = coap_msg_id_counter++;
        uint8_t  tok = coap_token_counter++;

        size_t coap_len = coap_build_request(coap_buf, sizeof(coap_buf),
                                             mid, tok, req->coap_code,
                                             req->uri_path,
                                             req->coap_payload, req->coap_payload_len);
        if (coap_len == 0) {
            printf("[ccx] CoAP TX: build failed\r\n");
            return;
        }

        /* Wrap in IPv6+UDP → unicast to device on port 5683 */
        uint8_t pkt[384];
        size_t  pkt_len = ipv6_udp_build(pkt, sizeof(pkt),
                                         have_ipv6_addr ? our_ipv6_addr : NULL,
                                         req->dst_addr, COAP_PORT, COAP_PORT,
                                         coap_buf, coap_len);
        if (pkt_len == 0) {
            printf("[ccx] CoAP TX: IPv6+UDP build failed\r\n");
            return;
        }

        /* Single transmit (CoAP has its own retransmit via CON/ACK) */
        ccx_transmit_ipv6(pkt, pkt_len);
        tx_count++;

        printf("[ccx] CoAP %s %s → ",
               req->coap_code == COAP_CODE_GET ? "GET" :
               req->coap_code == COAP_CODE_POST ? "POST" :
               req->coap_code == COAP_CODE_PUT ? "PUT" : "???",
               req->uri_path);
        /* Print dst addr */
        for (int i = 0; i < 16; i += 2) {
            if (i > 0) printf(":");
            printf("%02x%02x", req->dst_addr[i], req->dst_addr[i + 1]);
        }
        printf(" mid=0x%04X payload=%u\r\n", mid, (unsigned)req->coap_payload_len);
        if (req->coap_payload_len > 0) {
            printf("[ccx] CoAP payload:");
            for (size_t i = 0; i < req->coap_payload_len; i++) printf(" %02X", req->coap_payload[i]);
            printf("\r\n");
        }

        stream_send_ccx_packet(coap_buf, coap_len);
        return;
    }

    /* --- Multicast CCX command TX --- */
    uint8_t cbor_buf[64];
    size_t  cbor_len = 0;

    if (req->type == CCX_TX_TYPE_LEVEL) {
        cbor_len = ccx_encode_level_control(cbor_buf, sizeof(cbor_buf), req->id, req->level, req->fade, req->sequence);
    }
    else if (req->type == CCX_TX_TYPE_SCENE) {
        cbor_len = ccx_encode_scene_recall(cbor_buf, sizeof(cbor_buf), req->id, req->sequence);
    }

    if (cbor_len == 0) {
        printf("[ccx] TX: CBOR encode failed\r\n");
        return;
    }

    /* Wrap in IPv6+UDP */
    uint8_t pkt[256];
    size_t  pkt_len =
        ipv6_udp_build(pkt, sizeof(pkt), have_ipv6_addr ? our_ipv6_addr : NULL,
                       CCX_MULTICAST_ADDR, CCX_UDP_PORT, CCX_UDP_PORT, cbor_buf, cbor_len);
    if (pkt_len == 0) {
        printf("[ccx] TX: IPv6+UDP build failed\r\n");
        return;
    }

    /* Transmit with retransmits */
    for (int i = 0; i < CCX_TX_RETRANSMITS; i++) {
        ccx_transmit_ipv6(pkt, pkt_len);
        if (i < CCX_TX_RETRANSMITS - 1) {
            vTaskDelay(pdMS_TO_TICKS(CCX_TX_RETRANSMIT_MS));
        }
    }

    tx_count++;

    /* Log with CBOR hex dump for diagnostics */
    if (req->type == CCX_TX_TYPE_LEVEL) {
        printf("[ccx] TX LEVEL_CONTROL zone=%u level=0x%04X fade=%u seq=%u\r\n",
               req->id, req->level, req->fade, req->sequence);
    }
    else {
        printf("[ccx] TX SCENE_RECALL scene=%u seq=%u\r\n", req->id, req->sequence);
    }
    printf("[ccx] TX CBOR (%u):", (unsigned)cbor_len);
    for (size_t i = 0; i < cbor_len; i++) printf(" %02X", cbor_buf[i]);
    printf("\r\n");

    /* Stream CBOR to TCP client */
    stream_send_ccx_packet(cbor_buf, cbor_len);
}

/* -----------------------------------------------------------------------
 * RX: process incoming PROP_STREAM_NET frames
 * ----------------------------------------------------------------------- */
static void ccx_process_rx(const uint8_t* spinel_payload, size_t payload_len)
{
    /* The Spinel payload for PROP_STREAM_NET is the raw IPv6 packet.
     * (For PROP_INSERTED frames: [header][cmd][prop][ipv6_packet...])
     * The caller already stripped the Spinel header. */

    uint8_t  src_addr[16];
    uint16_t src_port, dst_port;
    size_t   udp_payload_len;

    const uint8_t* udp_data =
        ipv6_udp_parse(spinel_payload, payload_len, src_addr, &src_port, &dst_port, &udp_payload_len);
    if (!udp_data) return;

    /* Forward CoAP traffic to host tools and auto-ACK CON responses so
     * programming database write transactions can complete end-to-end. */
    if (src_port == COAP_UDP_PORT || dst_port == COAP_UDP_PORT) {
        stream_send_ccx_packet(udp_data, udp_payload_len);

        uint8_t  coap_type = 0;
        uint8_t  coap_code = 0;
        uint16_t coap_mid = 0;
        if (coap_parse_response(udp_data, udp_payload_len, &coap_type, &coap_code, &coap_mid)) {
            /* CoAP CON response (class 2..5): reply with empty ACK.
             * Do not ACK requests (class 0), otherwise TX loopback frames
             * would self-trigger synthetic ACKs. */
            uint8_t coap_class = (uint8_t)(coap_code >> 5);
            if (coap_type == 0 && coap_class >= 2) {
                coap_send_empty_ack(src_addr, dst_port, src_port, coap_mid);
                if (ccx_rx_uart_log_enabled) {
                    printf("[ccx] CoAP ACK mid=0x%04X src_port=%u dst_port=%u\r\n", coap_mid, src_port, dst_port);
                }
            }
            /* Log all CoAP responses to UART */
            if (ccx_rx_uart_log_enabled) {
                printf("[ccx] CoAP RX type=%u code=%u.%02u mid=0x%04X\r\n",
                       coap_type, coap_code >> 5, coap_code & 0x1F, coap_mid);
            }
        }
        return;
    }

    /* Filter for CCX port */
    if (dst_port != CCX_UDP_PORT) return;

    /* Decode CBOR */
    ccx_decoded_msg_t msg;
    if (!ccx_decode_message(udp_data, udp_payload_len, &msg)) return;

    /* Deduplicate */
    if (dedup_is_duplicate(msg.msg_type, msg.sequence)) return;

    rx_count++;

    /* Track peer RLOC from source address */
    uint16_t src_rloc16 = extract_rloc16(src_addr);
    if (src_rloc16 != 0) {
        ccx_peer_t* peer = peer_update(src_rloc16, src_addr);
        if (peer) {
            peer->last_msg_type = msg.msg_type;
            /* Store serial from DEVICE_REPORT / STATUS */
            if ((msg.msg_type == CCX_MSG_DEVICE_REPORT || msg.msg_type == CCX_MSG_STATUS) &&
                msg.device_serial != 0) {
                peer->serial = msg.device_serial;
            }
            /* Store device_id from BUTTON_PRESS / DIM_HOLD / DIM_STEP */
            if (msg.msg_type == CCX_MSG_BUTTON_PRESS || msg.msg_type == CCX_MSG_DIM_HOLD ||
                msg.msg_type == CCX_MSG_DIM_STEP) {
                memcpy(peer->device_id, msg.device_id, 4);
            }
        }
    }

    if (ccx_rx_uart_log_enabled) {
        const char* type_name = ccx_msg_type_name(msg.msg_type);
        switch (msg.msg_type) {
        case CCX_MSG_LEVEL_CONTROL:
            printf("[ccx] RX %s zone=%u level=0x%04X fade=%u delay=%u seq=%u rloc=0x%04X\r\n", type_name, msg.zone_id, msg.level,
                   msg.fade, msg.delay, msg.sequence, src_rloc16);
            break;
        case CCX_MSG_BUTTON_PRESS:
            printf("[ccx] RX %s dev=%02X%02X%02X%02X seq=%u rloc=0x%04X\r\n", type_name, msg.device_id[0], msg.device_id[1],
                   msg.device_id[2], msg.device_id[3], msg.sequence, src_rloc16);
            break;
        case CCX_MSG_DIM_HOLD:
            printf("[ccx] RX %s dev=%02X%02X%02X%02X action=%u seq=%u rloc=0x%04X\r\n", type_name, msg.device_id[0],
                   msg.device_id[1], msg.device_id[2], msg.device_id[3], msg.action, msg.sequence, src_rloc16);
            break;
        case CCX_MSG_DIM_STEP:
            printf("[ccx] RX %s dev=%02X%02X%02X%02X action=%u step=%u seq=%u rloc=0x%04X\r\n", type_name, msg.device_id[0],
                   msg.device_id[1], msg.device_id[2], msg.device_id[3], msg.action, msg.step_value, msg.sequence, src_rloc16);
            break;
        case CCX_MSG_ACK:
            printf("[ccx] RX %s response=%02X seq=%u rloc=0x%04X\r\n", type_name, msg.response_len > 0 ? msg.response[0] : 0,
                   msg.sequence, src_rloc16);
            break;
        case CCX_MSG_DEVICE_REPORT:
            printf("[ccx] RX %s serial=%lu group=%u rloc=0x%04X\r\n", type_name, (unsigned long)msg.device_serial, msg.group_id, src_rloc16);
            break;
        case CCX_MSG_SCENE_RECALL:
            printf("[ccx] RX %s scene=%u group=%u seq=%u rloc=0x%04X\r\n", type_name, msg.scene_id, msg.group_id, msg.sequence, src_rloc16);
            break;
        case CCX_MSG_COMPONENT_CMD:
            printf("[ccx] RX %s group=%u type=%u val=%u seq=%u rloc=0x%04X\r\n", type_name, msg.scene_id, msg.component_type,
                   msg.component_value, msg.sequence, src_rloc16);
            break;
        case CCX_MSG_STATUS:
            printf("[ccx] RX %s serial=%lu seq=%u rloc=0x%04X\r\n", type_name,
                   (unsigned long)msg.device_serial, msg.sequence, src_rloc16);
            break;
        case CCX_MSG_PRESENCE:
            printf("[ccx] RX %s status=%u seq=%u rloc=0x%04X\r\n", type_name, msg.status_value, msg.sequence, src_rloc16);
            break;
        default:
            printf("[ccx] RX %s type=%u seq=%u rloc=0x%04X\r\n", type_name, msg.msg_type, msg.sequence, src_rloc16);
            break;
        }
    }

    /* Forward raw CBOR to TCP stream */
    stream_send_ccx_packet(udp_data, udp_payload_len);
}

void ccx_set_rx_log_enabled(bool enabled)
{
    ccx_rx_uart_log_enabled = enabled;
}

bool ccx_rx_log_enabled(void)
{
    return ccx_rx_uart_log_enabled;
}

bool ccx_set_promiscuous(bool enabled)
{
    /* Route through ccx_spinel_command so the CCX task handles UART
     * access — calling spinel_prop_set directly from the shell task
     * races with the CCX task's main loop UART reads. */
    ccx_spinel_request_t req;
    ccx_spinel_response_t resp;

    req.cmd_type = CCX_SPINEL_PROP_SET;
    req.prop_id = SPINEL_PROP_MAC_PROMISCUOUS_MODE;
    req.value[0] = enabled ? SPINEL_MAC_PROMISCUOUS_MODE_NETWORK : SPINEL_MAC_PROMISCUOUS_MODE_OFF;
    req.value_len = 1;
    if (!ccx_spinel_command(&req, &resp, 3000) || !resp.success) {
        printf("[ccx] Failed to set promiscuous mode\r\n");
        return false;
    }

    req.prop_id = SPINEL_PROP_MAC_RAW_STREAM_ENABLED;
    req.value[0] = enabled ? 1 : 0;
    req.value_len = 1;
    if (!ccx_spinel_command(&req, &resp, 3000) || !resp.success) {
        printf("[ccx] Failed to set raw stream\r\n");
        return false;
    }

    promiscuous_enabled = enabled;
    printf("[ccx] Promiscuous mode: %s\r\n", enabled ? "ON" : "OFF");
    return true;
}

bool ccx_promiscuous_enabled(void)
{
    return promiscuous_enabled;
}

/* -----------------------------------------------------------------------
 * Shell command passthrough — process a pending request from the shell task
 * ----------------------------------------------------------------------- */
static void shell_cmd_process(void)
{
    shell_cmd_resp.success = false;
    shell_cmd_resp.data_len = 0;

    switch (shell_cmd_req.cmd_type) {
    case CCX_SPINEL_PROP_GET: {
        size_t len = spinel_prop_get(shell_cmd_req.prop_id, shell_cmd_resp.data, sizeof(shell_cmd_resp.data), 3000);
        if (len > 0) {
            shell_cmd_resp.success = true;
            shell_cmd_resp.data_len = len;
        }
        break;
    }
    case CCX_SPINEL_PROP_SET: {
        bool ok = spinel_prop_set(shell_cmd_req.prop_id, shell_cmd_req.value, shell_cmd_req.value_len, 3000);
        shell_cmd_resp.success = ok;
        break;
    }
    case CCX_SPINEL_PROP_INSERT: {
        bool ok = spinel_prop_insert(shell_cmd_req.prop_id, shell_cmd_req.value, shell_cmd_req.value_len, 3000);
        shell_cmd_resp.success = ok;
        break;
    }
    case CCX_SPINEL_RESET:
        spinel_send_reset();
        shell_cmd_resp.success = true;
        break;
    case CCX_SPINEL_RAW: {
        /* Send raw frame and try to read back a response */
        hdlc_send_frame(shell_cmd_req.value, shell_cmd_req.value_len);
        size_t len = hdlc_recv_frame(shell_cmd_resp.data, sizeof(shell_cmd_resp.data), 3000);
        if (len > 0) {
            shell_cmd_resp.success = true;
            shell_cmd_resp.data_len = len;
        }
        break;
    }
    }
}

/* -----------------------------------------------------------------------
 * Main task
 * ----------------------------------------------------------------------- */
static void ccx_task_func(void* param)
{
    (void)param;

    printf("[ccx] Task started (nRF52840 Dongle -- Spinel/HDLC NCP)\r\n");
    printf("[ccx] USART2: 460800 baud, P0.20 TX -> PD6, P0.24 RX <- PD5\r\n");

    running = true;

    /* Probe the NCP on startup */
    ncp_detected = ncp_probe();

    /* Join Thread network if NCP is alive */
    if (ncp_detected) {
        if (!thread_join()) {
            printf("[ccx] Thread join failed — will retry on reboot\r\n");
        }
    }

    for (;;) {
        watchdog_feed();

        /* Check if shell task has a pending Spinel command */
        if (xSemaphoreTake(shell_cmd_ready, 0) == pdTRUE) {
            shell_cmd_process();
            xSemaphoreGive(shell_cmd_done);
        }

        /* Check if DFU was requested */
        if (dfu_state == CCX_DFU_ENTERING_BOOTLOADER) {
            dfu_enter_bootloader();
            if (dfu_state == CCX_DFU_UPLOADING) {
                dfu_upload_loop();
            }
            dfu_bytes_written = 0;
            dfu_image_size = 0;

            /* Restore USART2 to 460800 baud for Spinel/HDLC */
            printf("[ccx] DFU: restoring USART2 to 460800 baud\r\n");
            bsp_uart2_set_baud(460800);

            if (dfu_state == CCX_DFU_COMPLETE || dfu_state == CCX_DFU_ERROR) {
                if (dfu_state == CCX_DFU_ERROR) {
                    printf("[ccx] DFU: failed, restoring normal operation\r\n");
                }
                dfu_state = CCX_DFU_IDLE;
                vTaskDelay(pdMS_TO_TICKS(2000));
                ncp_detected = ncp_probe();
                if (ncp_detected) thread_join();
            }
            continue;
        }

        /* --- TX: drain queue --- */
        if (ncp_detected && thread_role != SPINEL_NET_ROLE_DETACHED) {
            ccx_tx_request_t req;
            while (xQueueReceive(tx_queue, &req, 0) == pdTRUE) {
                ccx_process_tx(&req);
            }
        }

        /* --- RX: poll for HDLC frames --- */
        if (ncp_detected) {
            uint8_t rx_buf[HDLC_RX_BUF_SIZE];
            size_t  rx_len = hdlc_recv_frame(rx_buf, sizeof(rx_buf), 50);

            if (rx_len >= 3) {
                uint8_t cmd = rx_buf[1];
                uint8_t prop = rx_buf[2];

                if ((cmd == SPINEL_CMD_PROP_INSERTED || cmd == SPINEL_CMD_PROP_IS) && prop == SPINEL_PROP_STREAM_NET) {
                    /* STREAM_NET uses Spinel 'd' format: [len_lo][len_hi][IPv6 packet...]
                     * Skip the 2-byte length prefix to get the raw IPv6 packet. */
                    const uint8_t* payload = rx_buf + 3;
                    size_t         payload_len = rx_len - 3;
                    if (payload_len >= 2) {
                        uint16_t ipv6_len = (uint16_t)payload[0] | ((uint16_t)payload[1] << 8);
                        if (ipv6_len <= payload_len - 2) {
                            ccx_process_rx(payload + 2, ipv6_len);
                        }
                    }
                }
                else if ((cmd == SPINEL_CMD_PROP_INSERTED || cmd == SPINEL_CMD_PROP_IS) && prop == SPINEL_PROP_STREAM_RAW) {
                    /* STREAM_RAW: raw 802.15.4 frame from promiscuous mode.
                     * Format: [len_lo][len_hi][raw_frame...][rssi][...metadata]
                     * Filter: only forward encrypted data frames (short/short addressing
                     * with security enabled). Skips beacons, ACKs, MLE, etc. */
                    if (promiscuous_enabled) {
                        const uint8_t* payload = rx_buf + 3;
                        size_t         payload_len = rx_len - 3;
                        if (payload_len >= 2) {
                            uint16_t frame_len = (uint16_t)payload[0] | ((uint16_t)payload[1] << 8);
                            const uint8_t* frame = payload + 2;
                            if (frame_len >= 15 && frame_len <= payload_len - 2) {
                                uint16_t fc = (uint16_t)frame[0] | ((uint16_t)frame[1] << 8);
                                bool has_security = (fc & 0x08) != 0;
                                uint8_t dst_mode = (fc >> 10) & 0x03;
                                uint8_t src_mode = (fc >> 14) & 0x03;

                                /* Short/short with security = encrypted Thread data */
                                if (has_security && dst_mode == 2 && src_mode == 2) {
                                    raw_rx_count++;
                                    stream_send_raw_frame(frame, frame_len);
                                }
                            }
                        }
                    }
                }
            }
        }
        else {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
}

/* -----------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */
void ccx_task_start(void)
{
    dfu_chunk_sem = xSemaphoreCreateBinary();
    dfu_chunk_ready = xSemaphoreCreateBinary();
    xSemaphoreGive(dfu_chunk_sem);

    shell_cmd_ready = xSemaphoreCreateBinary();
    shell_cmd_done = xSemaphoreCreateBinary();

    tx_queue = xQueueCreate(TX_QUEUE_SIZE, sizeof(ccx_tx_request_t));

    xTaskCreate(ccx_task_func, "CCX", CCX_TASK_STACK_SIZE, NULL, CCX_TASK_PRIORITY, &ccx_task_handle);
}

bool ccx_spinel_command(const ccx_spinel_request_t* req, ccx_spinel_response_t* resp, uint32_t timeout_ms)
{
    if (!running || !shell_cmd_ready || !shell_cmd_done) return false;

    /* Copy request into shared buffer */
    memcpy(&shell_cmd_req, req, sizeof(shell_cmd_req));

    /* Signal the CCX task */
    xSemaphoreGive(shell_cmd_ready);

    /* Wait for the CCX task to process and respond */
    if (xSemaphoreTake(shell_cmd_done, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        return false;
    }

    /* Copy response out */
    memcpy(resp, &shell_cmd_resp, sizeof(shell_cmd_resp));
    return true;
}

bool ccx_is_running(void)
{
    return running;
}

bool ccx_thread_joined(void)
{
    return ncp_detected && thread_role != SPINEL_NET_ROLE_DETACHED;
}

const char* ccx_thread_role_str(void)
{
    switch (thread_role) {
    case SPINEL_NET_ROLE_CHILD:
        return "CHILD";
    case SPINEL_NET_ROLE_ROUTER:
        return "ROUTER";
    case SPINEL_NET_ROLE_LEADER:
        return "LEADER";
    default:
        return "DETACHED";
    }
}

static uint8_t next_sequence(void)
{
    return ++ccx_sequence;
}

bool ccx_send_level(uint16_t zone_id, uint16_t level, uint8_t fade, uint8_t sequence)
{
    if (!ccx_thread_joined() || tx_queue == NULL) return false;

    ccx_tx_request_t req;
    memset(&req, 0, sizeof(req));
    req.type = CCX_TX_TYPE_LEVEL;
    req.id = zone_id;
    req.level = level;
    req.fade = fade ? fade : 1;
    req.sequence = sequence ? sequence : next_sequence();

    return xQueueSend(tx_queue, &req, pdMS_TO_TICKS(100)) == pdTRUE;
}

bool ccx_send_on(uint16_t zone_id, uint8_t sequence)
{
    return ccx_send_level(zone_id, CCX_LEVEL_FULL_ON, 1, sequence);
}

bool ccx_send_off(uint16_t zone_id, uint8_t sequence)
{
    return ccx_send_level(zone_id, CCX_LEVEL_OFF, 1, sequence);
}

bool ccx_send_scene(uint16_t scene_id, uint8_t sequence)
{
    if (!ccx_thread_joined() || tx_queue == NULL) return false;

    ccx_tx_request_t req;
    req.type = CCX_TX_TYPE_SCENE;
    req.id = scene_id;
    req.level = 0;
    req.sequence = sequence ? sequence : next_sequence();

    return xQueueSend(tx_queue, &req, pdMS_TO_TICKS(100)) == pdTRUE;
}

bool ccx_send_coap(const uint8_t* dst_addr, uint8_t code,
                   const char* uri_path,
                   const uint8_t* payload, size_t payload_len)
{
    if (!ccx_thread_joined() || tx_queue == NULL) return false;
    if (payload_len > CCX_COAP_MAX_PAYLOAD) return false;

    ccx_tx_request_t req;
    memset(&req, 0, sizeof(req));
    req.type = CCX_TX_TYPE_COAP;
    req.coap_code = code;
    memcpy(req.dst_addr, dst_addr, 16);
    strncpy(req.uri_path, uri_path, sizeof(req.uri_path) - 1);
    if (payload && payload_len > 0) {
        memcpy(req.coap_payload, payload, payload_len);
        req.coap_payload_len = payload_len;
    }

    return xQueueSend(tx_queue, &req, pdMS_TO_TICKS(100)) == pdTRUE;
}

uint32_t ccx_rx_count(void)
{
    return rx_count;
}
uint32_t ccx_raw_rx_count(void)
{
    return raw_rx_count;
}
uint32_t ccx_tx_count(void)
{
    return tx_count;
}
uint8_t ccx_thread_role_id(void)
{
    return thread_role;
}

bool ccx_dfu_start(uint32_t image_size)
{
    if (dfu_state != CCX_DFU_IDLE) {
        printf("[ccx] DFU: already in progress (state=%d)\r\n", dfu_state);
        return false;
    }

    printf("[ccx] DFU: starting, image_size=%lu\r\n", (unsigned long)image_size);
    dfu_image_size = image_size;
    dfu_bytes_written = 0;
    dfu_state = CCX_DFU_ENTERING_BOOTLOADER;

    return true;
}

bool ccx_dfu_write_chunk(const uint8_t* data, size_t len)
{
    if (dfu_state != CCX_DFU_UPLOADING) return false;
    if (len > DFU_CHUNK_BUF_SIZE) return false;

    if (xSemaphoreTake(dfu_chunk_sem, pdMS_TO_TICKS(5000)) != pdTRUE) {
        return false;
    }

    memcpy(dfu_chunk_buf, data, len);
    dfu_chunk_len = len;

    xSemaphoreGive(dfu_chunk_ready);

    return true;
}

ccx_dfu_state_t ccx_dfu_get_state(void)
{
    return dfu_state;
}

/* -----------------------------------------------------------------------
 * Peer table public API
 * ----------------------------------------------------------------------- */

size_t ccx_peer_count(void)
{
    return peer_count;
}

bool ccx_peer_get(size_t index, uint16_t* rloc16, uint32_t* serial,
                  uint8_t device_id[4], uint16_t* last_msg_type, uint32_t* age_ms)
{
    if (index >= peer_count) return false;
    const ccx_peer_t* p = &peer_table[index];
    if (rloc16) *rloc16 = p->rloc16;
    if (serial) *serial = p->serial;
    if (device_id) memcpy(device_id, p->device_id, 4);
    if (last_msg_type) *last_msg_type = p->last_msg_type;
    if (age_ms) *age_ms = HAL_GetTick() - p->last_seen_tick;
    return true;
}

bool ccx_peer_find_by_serial(uint32_t serial, uint16_t* rloc16)
{
    if (serial == 0) return false;
    for (size_t i = 0; i < peer_count; i++) {
        if (peer_table[i].serial == serial) {
            if (rloc16) *rloc16 = peer_table[i].rloc16;
            return true;
        }
    }
    return false;
}

bool ccx_build_rloc_addr(uint16_t rloc16, uint8_t out[16])
{
    if (!have_ipv6_addr) return false;
    build_rloc_addr(rloc16, out);
    return true;
}
