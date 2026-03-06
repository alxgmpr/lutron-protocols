/**
 * UDP stream server — bridges CCA/CCX packets over Ethernet.
 *
 * Single UDP socket on port 9433.  Clients auto-register by sending
 * any datagram; firmware mirrors all RX packets to registered clients.
 * Client registrations expire after 30s of silence.
 *
 * Binary framing (one datagram = one frame):
 *   STM32 → host:  [FLAGS:1][LEN:1][TS_MS:4 LE][DATA:N]
 *   host → STM32:  [CMD:1][LEN:1][DATA:N]
 *   Heartbeat:      [0xFF][0x00]
 *   Status resp:    [0xFE][len][blob]
 *
 * FLAGS byte:
 *   Bit 7:   Direction (0=RX, 1=TX echo)
 *   Bit 6:   Protocol  (0=CCA, 1=CCX)
 *   Bits 0-5: |RSSI| for RX packets
 */

#include "stream.h"
#include "shell.h"
#include "cca_task.h"
#include "cca_commands.h"
#include "cc1101.h"
#include "ccx_task.h"
#include "eth.h"
#include "bsp.h"
#include "watchdog.h"

#include "lwip/api.h"
#include "lwip/ip_addr.h"

#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"

#include <cstdio>
#include <cstring>

/* -----------------------------------------------------------------------
 * Constants
 * ----------------------------------------------------------------------- */
#define STREAM_TASK_STACK_SIZE 2048
#define STREAM_TASK_PRIORITY   2
#define TX_RING_SIZE           64
#define TX_ITEM_MAX_DATA       140 /* 127 max 802.15.4 frame + margin for raw mode */
#define CLIENT_TIMEOUT_MS      30000

/* Status blob v2:
 *   bytes 0..47   = legacy fields
 *   bytes 48..111 = extended CCA radio reliability telemetry
 */
#define STATUS_BLOB_SIZE 112

/* -----------------------------------------------------------------------
 * TX queue item
 * ----------------------------------------------------------------------- */
struct StreamTxItem {
    uint8_t  flags;
    uint8_t  data[TX_ITEM_MAX_DATA];
    uint8_t  len;
    uint32_t timestamp_ms;
};

/* -----------------------------------------------------------------------
 * UDP client slot (auto-registered on first datagram)
 * ----------------------------------------------------------------------- */
struct UdpClient {
    ip_addr_t addr;
    uint16_t  port;
    uint32_t  last_heard;
    bool      active;
};

/* -----------------------------------------------------------------------
 * Private state
 * ----------------------------------------------------------------------- */
static QueueHandle_t   tx_queue = NULL;
static struct netconn* udp_conn = NULL;
static UdpClient       clients[MAX_STREAM_CLIENTS];
static int             num_clients = 0;

static volatile uint32_t tx_drop_count = 0;
static volatile uint32_t udp_sent_count = 0;
static volatile uint32_t udp_fail_count = 0;

/* -----------------------------------------------------------------------
 * Public API: enqueue packets for streaming
 * ----------------------------------------------------------------------- */
void stream_send_cca_packet(const uint8_t* data, size_t len, int8_t rssi, bool is_tx, uint32_t timestamp_ms)
{
    if (tx_queue == NULL || len > TX_ITEM_MAX_DATA) return;

    StreamTxItem item;
    item.flags = is_tx ? STREAM_FLAG_TX : (static_cast<uint8_t>(-rssi) & STREAM_FLAG_RSSI_MASK);
    memcpy(item.data, data, len);
    item.len = static_cast<uint8_t>(len);
    item.timestamp_ms = timestamp_ms;

    if (xQueueSend(tx_queue, &item, 0) != pdTRUE) tx_drop_count++;
}

void stream_send_ccx_packet(const uint8_t* data, size_t len)
{
    if (tx_queue == NULL || len > TX_ITEM_MAX_DATA) return;

    StreamTxItem item;
    item.flags = STREAM_FLAG_CCX;
    memcpy(item.data, data, len);
    item.len = static_cast<uint8_t>(len);
    item.timestamp_ms = HAL_GetTick();

    if (xQueueSend(tx_queue, &item, 0) != pdTRUE) tx_drop_count++;
}

void stream_send_raw_frame(const uint8_t* data, size_t len)
{
    if (tx_queue == NULL || len > TX_ITEM_MAX_DATA) return;

    StreamTxItem item;
    item.flags = STREAM_FLAG_CCX | STREAM_FLAG_RAW;
    memcpy(item.data, data, len);
    item.len = static_cast<uint8_t>(len);
    item.timestamp_ms = HAL_GetTick();

    if (xQueueSend(tx_queue, &item, 0) != pdTRUE) tx_drop_count++;
}

bool stream_client_connected(void)
{
    return num_clients > 0;
}
int stream_num_clients(void)
{
    return num_clients;
}

uint32_t stream_tx_drop_count(void)
{
    return tx_drop_count;
}
uint32_t stream_udp_sent_count(void)
{
    return udp_sent_count;
}
uint32_t stream_udp_fail_count(void)
{
    return udp_fail_count;
}

/* -----------------------------------------------------------------------
 * Little-endian uint32 helper
 * ----------------------------------------------------------------------- */
static void put_le32(uint8_t* dst, uint32_t val)
{
    dst[0] = (uint8_t)(val);
    dst[1] = (uint8_t)(val >> 8);
    dst[2] = (uint8_t)(val >> 16);
    dst[3] = (uint8_t)(val >> 24);
}

/* -----------------------------------------------------------------------
 * UDP client management
 * ----------------------------------------------------------------------- */

/** Register or refresh a UDP client by source address. */
static void register_client(const ip_addr_t* addr, uint16_t port)
{
    uint32_t now = HAL_GetTick();

    /* Already known? Just refresh. */
    for (int i = 0; i < MAX_STREAM_CLIENTS; i++) {
        if (clients[i].active && ip_addr_cmp(&clients[i].addr, addr) && clients[i].port == port) {
            clients[i].last_heard = now;
            return;
        }
    }

    /* Find empty slot */
    for (int i = 0; i < MAX_STREAM_CLIENTS; i++) {
        if (!clients[i].active) {
            clients[i].addr = *addr;
            clients[i].port = port;
            clients[i].last_heard = now;
            clients[i].active = true;
            num_clients++;
            printf("[stream] Client %s:%u registered (%d/%d)\r\n", ipaddr_ntoa(addr), port, num_clients,
                   MAX_STREAM_CLIENTS);
            if (num_clients == 1) LED_YELLOW_ON();
            return;
        }
    }

    /* Full — evict oldest */
    int      oldest = 0;
    uint32_t oldest_age = 0;
    for (int i = 0; i < MAX_STREAM_CLIENTS; i++) {
        uint32_t age = now - clients[i].last_heard;
        if (age > oldest_age) {
            oldest_age = age;
            oldest = i;
        }
    }
    printf("[stream] Evicting %s:%u for %s:%u\r\n", ipaddr_ntoa(&clients[oldest].addr), clients[oldest].port,
           ipaddr_ntoa(addr), port);
    clients[oldest].addr = *addr;
    clients[oldest].port = port;
    clients[oldest].last_heard = now;
}

/** Expire clients that haven't sent anything in CLIENT_TIMEOUT_MS. */
static void expire_clients(void)
{
    uint32_t now = HAL_GetTick();
    for (int i = 0; i < MAX_STREAM_CLIENTS; i++) {
        if (clients[i].active && (now - clients[i].last_heard) > CLIENT_TIMEOUT_MS) {
            printf("[stream] Client %s:%u expired\r\n", ipaddr_ntoa(&clients[i].addr), clients[i].port);
            clients[i].active = false;
            num_clients--;
            if (num_clients == 0) LED_YELLOW_OFF();
        }
    }
}

/* -----------------------------------------------------------------------
 * UDP send helpers
 * ----------------------------------------------------------------------- */

/** Send a frame to all registered UDP clients. */
static void broadcast_frame(const uint8_t* frame, uint16_t frame_len)
{
    if (udp_conn == NULL || num_clients == 0) return;

    struct netbuf* nb = netbuf_new();
    if (nb == NULL) {
        udp_fail_count++;
        return;
    }
    void* p = netbuf_alloc(nb, frame_len);
    if (p == NULL) {
        netbuf_delete(nb);
        udp_fail_count++;
        return;
    }
    memcpy(p, frame, frame_len);

    for (int i = 0; i < MAX_STREAM_CLIENTS; i++) {
        if (!clients[i].active) continue;
        err_t err = netconn_sendto(udp_conn, nb, &clients[i].addr, clients[i].port);
        if (err == ERR_OK)
            udp_sent_count++;
        else
            udp_fail_count++;
    }

    netbuf_delete(nb);
}

/** Send a frame to one specific client (for directed responses). */
static void send_to_client(const uint8_t* frame, uint16_t frame_len, const ip_addr_t* addr, uint16_t port)
{
    if (udp_conn == NULL) return;
    struct netbuf* nb = netbuf_new();
    if (nb == NULL) return;
    void* p = netbuf_alloc(nb, frame_len);
    if (p == NULL) {
        netbuf_delete(nb);
        return;
    }
    memcpy(p, frame, frame_len);
    netconn_sendto(udp_conn, nb, addr, port);
    netbuf_delete(nb);
}

/* -----------------------------------------------------------------------
 * Build and send status response to a specific client
 * ----------------------------------------------------------------------- */
static void send_status_response(const ip_addr_t* addr, uint16_t port)
{
    uint8_t resp[2 + STATUS_BLOB_SIZE];
    resp[0] = STREAM_RESP_STATUS; /* 0xFE */
    resp[1] = STATUS_BLOB_SIZE;

    uint8_t* blob = resp + 2;
    memset(blob, 0, STATUS_BLOB_SIZE);

    put_le32(blob + 0, HAL_GetTick());                     /* uptime_ms */
    put_le32(blob + 4, cca_rx_count());                    /* cca_rx_count */
    put_le32(blob + 8, cca_tx_count());                    /* cca_tx_count */
    put_le32(blob + 12, cca_drop_count());                 /* cca_drop_count */
    put_le32(blob + 16, cca_crc_fail_count());             /* cca_crc_fail_count */
    put_le32(blob + 20, cca_n81_err_count());              /* cca_n81_err_count */
    put_le32(blob + 24, cc1101_overflow_count());          /* cc1101_overflow_count */
    put_le32(blob + 28, cc1101_runt_count());              /* cc1101_runt_count */
    put_le32(blob + 32, ccx_rx_count());                   /* ccx_rx_count */
    put_le32(blob + 36, ccx_tx_count());                   /* ccx_tx_count */
    blob[40] = ccx_thread_joined() ? 1 : 0;                /* ccx_thread_joined */
    blob[41] = ccx_thread_role_id();                       /* ccx_thread_role */
    blob[42] = eth_link_is_up() ? 1 : 0;                   /* eth_link_up */
    blob[43] = (uint8_t)num_clients;                       /* num_clients */
    put_le32(blob + 44, (uint32_t)xPortGetFreeHeapSize()); /* heap_free */

    /* Extended telemetry (v2 status blob) */
    put_le32(blob + 48, cc1101_rx_restart_timeout_count());
    put_le32(blob + 52, cc1101_rx_restart_overflow_count());
    put_le32(blob + 56, cc1101_rx_restart_manual_count());
    put_le32(blob + 60, cc1101_rx_restart_packet_count());
    put_le32(blob + 64, cc1101_sync_peek_hit_count());
    put_le32(blob + 68, cc1101_sync_peek_miss_count());
    put_le32(blob + 72, cc1101_ring_max_occupancy());
    put_le32(blob + 76, cc1101_ring_bytes_in_count());
    put_le32(blob + 80, cc1101_ring_bytes_dropped_count());
    put_le32(blob + 84, cca_ack_count());
    put_le32(blob + 88, cca_crc_optional_count());
    put_le32(blob + 92, cca_irq_count());
    put_le32(blob + 96, cca_isr_latency_min_us());
    put_le32(blob + 100, cca_isr_latency_p95_us());
    put_le32(blob + 104, cca_isr_latency_max_us());
    put_le32(blob + 108, cca_isr_latency_samples());

    send_to_client(resp, sizeof(resp), addr, port);
}

/* -----------------------------------------------------------------------
 * Handle incoming command from a UDP client
 * ----------------------------------------------------------------------- */
static void handle_rx_data(const uint8_t* buf, size_t len, const ip_addr_t* src_addr, uint16_t src_port)
{
    if (len < 2) return;

    /* Check for JSON command (starts with '{') */
    if (buf[0] == '{') {
        printf("[stream] JSON command received (%u bytes) — not handled\r\n", (unsigned)len);
        return;
    }

    /* Binary command: [CMD:1][LEN:1][DATA:N] */
    uint8_t cmd = buf[0];
    uint8_t data_len = buf[1];

    if (len < (size_t)(2 + data_len)) {
        printf("[stream] Truncated command\r\n");
        return;
    }

    switch (cmd) {
    case STREAM_CMD_KEEPALIVE:
        /* No-op — register_client() already ran */
        break;

    case STREAM_CMD_TX_RAW_CCA:
        printf("[stream] CCA TX command: %u bytes\r\n", data_len);
        cca_tx_enqueue(buf + 2, data_len);
        break;

    case STREAM_CMD_TX_RAW_CCX: {
        if (data_len >= 5) {
            uint16_t zone_id = ((uint16_t)buf[2] << 8) | buf[3];
            uint16_t level = ((uint16_t)buf[4] << 8) | buf[5];
            uint8_t  seq = (data_len >= 6) ? buf[6] : 0;
            printf("[stream] CCX TX: zone=%u level=0x%04X seq=%u\r\n", zone_id, level, seq);
            ccx_send_level(zone_id, level, 1, seq);
        }
        else {
            printf("[stream] CCX TX: need >= 5 data bytes, got %u\r\n", data_len);
        }
        break;
    }

    case STREAM_CMD_NRF_DFU_START: {
        if (data_len >= 4) {
            uint32_t img_size =
                (uint32_t)buf[2] | ((uint32_t)buf[3] << 8) | ((uint32_t)buf[4] << 16) | ((uint32_t)buf[5] << 24);
            printf("[stream] nRF DFU start: %lu bytes\r\n", (unsigned long)img_size);
            ccx_dfu_start(img_size);
        }
        break;
    }

    case STREAM_CMD_NRF_DFU_DATA:
        ccx_dfu_write_chunk(buf + 2, data_len);
        break;

    case STREAM_CMD_CCA_BUTTON: {
        if (data_len >= 5) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_BUTTON;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.button = buf[6];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA button: dev=%08X btn=0x%02X\r\n", (unsigned)item.device_id, item.button);
        }
        break;
    }

    case STREAM_CMD_CCA_LEVEL: {
        if (data_len >= 10) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_BRIDGE_LEVEL;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.target_id = ((uint32_t)buf[6] << 24) | ((uint32_t)buf[7] << 16) | ((uint32_t)buf[8] << 8) | buf[9];
            item.level_pct = buf[10];
            item.fade_qs = buf[11];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA bridge level: zone=%08X target=%08X %u%%\r\n", (unsigned)item.device_id,
                   (unsigned)item.target_id, item.level_pct);
        }
        break;
    }

    case STREAM_CMD_CCA_PICO_LVL: {
        if (data_len >= 5) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_PICO_LEVEL;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.level_pct = buf[6];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA pico level: dev=%08X %u%%\r\n", (unsigned)item.device_id, item.level_pct);
        }
        break;
    }

    case STREAM_CMD_CCA_STATE: {
        if (data_len >= 5) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_STATE_REPORT;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.level_pct = buf[6];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA state report: dev=%08X %u%%\r\n", (unsigned)item.device_id, item.level_pct);
        }
        break;
    }

    case STREAM_CMD_CCA_BEACON: {
        if (data_len >= 5) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_BEACON;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.duration_sec = buf[6];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA beacon: dev=%08X dur=%u\r\n", (unsigned)item.device_id, item.duration_sec);
        }
        break;
    }

    case STREAM_CMD_CCA_UNPAIR: {
        if (data_len >= 8) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_UNPAIR;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.target_id = ((uint32_t)buf[6] << 24) | ((uint32_t)buf[7] << 16) | ((uint32_t)buf[8] << 8) | buf[9];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA unpair: zone=%08X target=%08X\r\n", (unsigned)item.device_id,
                   (unsigned)item.target_id);
        }
        break;
    }

    case STREAM_CMD_CCA_LED: {
        if (data_len >= 9) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_LED_CONFIG;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.target_id = ((uint32_t)buf[6] << 24) | ((uint32_t)buf[7] << 16) | ((uint32_t)buf[8] << 8) | buf[9];
            item.led_mode = buf[10];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA LED config: zone=%08X target=%08X mode=%u\r\n", (unsigned)item.device_id,
                   (unsigned)item.target_id, item.led_mode);
        }
        break;
    }

    case STREAM_CMD_CCA_FADE: {
        if (data_len >= 12) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_FADE_CONFIG;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.target_id = ((uint32_t)buf[6] << 24) | ((uint32_t)buf[7] << 16) | ((uint32_t)buf[8] << 8) | buf[9];
            item.fade_on_qs = (uint16_t)buf[10] | ((uint16_t)buf[11] << 8);
            item.fade_off_qs = (uint16_t)buf[12] | ((uint16_t)buf[13] << 8);
            cca_cmd_enqueue(&item);
            printf("[stream] CCA fade config: zone=%08X target=%08X on=%u off=%u\r\n", (unsigned)item.device_id,
                   (unsigned)item.target_id, item.fade_on_qs, item.fade_off_qs);
        }
        break;
    }

    case STREAM_CMD_CCA_TRIM: {
        if (data_len >= 10) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_TRIM_CONFIG;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.target_id = ((uint32_t)buf[6] << 24) | ((uint32_t)buf[7] << 16) | ((uint32_t)buf[8] << 8) | buf[9];
            item.high_trim = buf[10];
            item.low_trim = buf[11];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA trim config: zone=%08X target=%08X high=%u low=%u\r\n", (unsigned)item.device_id,
                   (unsigned)item.target_id, item.high_trim, item.low_trim);
        }
        break;
    }

    case STREAM_CMD_CCA_PHASE: {
        if (data_len >= 9) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_PHASE_CONFIG;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.target_id = ((uint32_t)buf[6] << 24) | ((uint32_t)buf[7] << 16) | ((uint32_t)buf[8] << 8) | buf[9];
            item.phase_byte = buf[10];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA phase config: zone=%08X target=%08X phase=0x%02X\r\n", (unsigned)item.device_id,
                   (unsigned)item.target_id, item.phase_byte);
        }
        break;
    }

    case STREAM_CMD_CCA_PICO_PAIR: {
        if (data_len >= 6) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_PICO_PAIR;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.pico_type = buf[6];
            item.duration_sec = buf[7];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA pico pair: dev=%08X type=%u dur=%u\r\n", (unsigned)item.device_id, item.pico_type,
                   item.duration_sec);
        }
        break;
    }

    case STREAM_CMD_CCA_BRIDGE_PAIR: {
        if (data_len >= 9) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_BRIDGE_PAIR;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.target_id = ((uint32_t)buf[6] << 24) | ((uint32_t)buf[7] << 16) | ((uint32_t)buf[8] << 8) | buf[9];
            item.duration_sec = buf[10];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA bridge pair: bridge=%08X target=%08X beacon=%u\r\n", (unsigned)item.device_id,
                   (unsigned)item.target_id, item.duration_sec);
        }
        break;
    }

    case STREAM_CMD_CCA_SAVE_FAV: {
        if (data_len >= 4) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_SAVE_FAV;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA save-fav: dev=%08X\r\n", (unsigned)item.device_id);
        }
        break;
    }

    case STREAM_CMD_CCA_VIVE_LEVEL: {
        if (data_len >= 7) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_VIVE_LEVEL;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.zone_byte = buf[6];
            item.level_pct = buf[7];
            item.fade_qs = buf[8];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA vive level: hub=%08X zone=0x%02X %u%% fade=%u\r\n", (unsigned)item.device_id,
                   item.zone_byte, item.level_pct, item.fade_qs);
        }
        break;
    }

    case STREAM_CMD_CCA_VIVE_DIM: {
        if (data_len >= 6) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_VIVE_DIM;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.zone_byte = buf[6];
            item.direction = buf[7];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA vive dim: hub=%08X zone=0x%02X dir=%s\r\n", (unsigned)item.device_id, item.zone_byte,
                   item.direction == 0x03 ? "raise" : "lower");
        }
        break;
    }

    case STREAM_CMD_CCA_VIVE_PAIR: {
        if (data_len >= 6) {
            CcaCmdItem item = {};
            item.cmd = CCA_CMD_VIVE_PAIR;
            item.device_id = ((uint32_t)buf[2] << 24) | ((uint32_t)buf[3] << 16) | ((uint32_t)buf[4] << 8) | buf[5];
            item.zone_byte = buf[6];
            item.duration_sec = buf[7];
            cca_cmd_enqueue(&item);
            printf("[stream] CCA vive pair: hub=%08X zone=0x%02X dur=%u\r\n", (unsigned)item.device_id, item.zone_byte,
                   item.duration_sec);
        }
        break;
    }

    case STREAM_CMD_STATUS_QUERY:
        printf("[stream] Status query\r\n");
        send_status_response(src_addr, src_port);
        break;

    case STREAM_CMD_TEXT: {
        if (data_len == 0) break;
        char   cmd_line[256];
        size_t cmd_len = data_len < sizeof(cmd_line) - 1 ? data_len : sizeof(cmd_line) - 1;
        memcpy(cmd_line, buf + 2, cmd_len);
        cmd_line[cmd_len] = '\0';
        /* Strip trailing \r\n */
        while (cmd_len > 0 && (cmd_line[cmd_len - 1] == '\r' || cmd_line[cmd_len - 1] == '\n'))
            cmd_line[--cmd_len] = '\0';
        if (cmd_len == 0) break;

        static uint8_t text_resp[1500];
        text_resp[0] = STREAM_RESP_TEXT;
        printf_capture_start(text_resp + 1, sizeof(text_resp) - 1);
        shell_execute(cmd_line);
        size_t captured = printf_capture_stop();

        send_to_client(text_resp, (uint16_t)(1 + captured), src_addr, src_port);
        break;
    }

    default:
        printf("[stream] Unknown command: 0x%02X\r\n", cmd);
        break;
    }
}

/* -----------------------------------------------------------------------
 * UDP stream task
 * ----------------------------------------------------------------------- */
static void stream_task_func(void* param)
{
    (void)param;

    printf("[stream] Task started, waiting for Ethernet link...\r\n");

    while (!eth_link_is_up()) {
        watchdog_feed();
        eth_poll_link();
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    printf("[stream] Ethernet up, IP=%s\r\n", eth_get_ip_str());

    /* Create UDP socket */
    udp_conn = netconn_new(NETCONN_UDP);
    if (udp_conn == NULL) {
        printf("[stream] Failed to create UDP socket!\r\n");
        vTaskDelete(NULL);
        return;
    }

    netconn_bind(udp_conn, IP_ADDR_ANY, STREAM_UDP_PORT);
    netconn_set_recvtimeout(udp_conn, 1); /* 1ms timeout — lwIP 0 = block forever */
    printf("[stream] Listening on UDP port %d\r\n", STREAM_UDP_PORT);

    memset(clients, 0, sizeof(clients));
    num_clients = 0;

    uint32_t     last_heartbeat = HAL_GetTick();
    uint32_t     last_expire = HAL_GetTick();
    StreamTxItem tx_item;

    for (;;) {
        watchdog_feed();

        /* --- 1. Drain tx_queue → broadcast to all UDP clients ---
         * First receive blocks 1ms (idle sleep); subsequent drains
         * are non-blocking to flush the entire burst immediately. */
        if (xQueueReceive(tx_queue, &tx_item, pdMS_TO_TICKS(1)) == pdTRUE) {
            do {
                uint8_t frame[TX_ITEM_MAX_DATA + 6]; /* FLAGS + LEN + TS(4) + DATA */
                frame[0] = tx_item.flags;
                frame[1] = tx_item.len;
                put_le32(frame + 2, tx_item.timestamp_ms);
                memcpy(frame + 6, tx_item.data, tx_item.len);
                broadcast_frame(frame, (uint16_t)(6 + tx_item.len));
            } while (xQueueReceive(tx_queue, &tx_item, 0) == pdTRUE);
        }

        /* --- 2. Receive incoming UDP commands (non-blocking) --- */
        struct netbuf* inbuf = NULL;
        err_t          err = netconn_recv(udp_conn, &inbuf);
        if (err == ERR_OK && inbuf != NULL) {
            ip_addr_t* src_addr = netbuf_fromaddr(inbuf);
            uint16_t   src_port = netbuf_fromport(inbuf);

            /* Auto-register the sender as a client */
            register_client(src_addr, src_port);

            uint8_t* data;
            uint16_t data_len;
            netbuf_data(inbuf, (void**)&data, &data_len);
            handle_rx_data(data, data_len, src_addr, src_port);
            netbuf_delete(inbuf);
        }

        /* --- 3. Heartbeat to all clients every 5s --- */
        if (num_clients > 0 && HAL_GetTick() - last_heartbeat >= STREAM_HEARTBEAT_MS) {
            uint8_t heartbeat[2] = {0xFF, 0x00};
            broadcast_frame(heartbeat, 2);
            last_heartbeat = HAL_GetTick();
        }

        /* --- 4. Expire stale clients every 5s --- */
        if (HAL_GetTick() - last_expire >= 5000) {
            expire_clients();
            last_expire = HAL_GetTick();
        }
    }
}

void stream_task_start(void)
{
    tx_queue = xQueueCreate(TX_RING_SIZE, sizeof(StreamTxItem));

    xTaskCreate(stream_task_func, "Stream", STREAM_TASK_STACK_SIZE, NULL, STREAM_TASK_PRIORITY, NULL);
}
