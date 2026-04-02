/**
 * CCA FreeRTOS task — CC1101 RX/TX loop.
 *
 * RX path:
 *   GDO0 EXTI interrupt (sync word detect) → FreeRTOS task notification
 *   → cc1101_check_rx() → CcaDecoder → stream_send_cca_packet()
 *
 * TX path:
 *   FreeRTOS queue ← cca_tx_enqueue()
 *   → n81_encode_packet() + cca_append_crc() → cc1101_transmit_raw()
 *   → auto-return to RX (MCSM1 TXOFF=11)
 */

#include "cca_task.h"
#include "cca_commands.h"
#include "cca_tdma.h"
#include "cca_timer.h"
#include "cc1101.h"
#include "cca_decoder.h"
#include "cca_encoder.h"
#include "cca_types.h"
#include "stream.h"
#include "bsp.h"
#include "watchdog.h"

#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"

#include <cstdio>
#include <cstring>

/* -----------------------------------------------------------------------
 * Constants
 * ----------------------------------------------------------------------- */
#define CCA_TASK_STACK_SIZE 2048
#define CCA_TASK_PRIORITY 5 /* Must be above lwIP tcpip_thread (4) — CC1101 FIFO overflows in ~27ms */
#define CCA_TX_QUEUE_LEN 8
#define CCA_TX_MAX_LEN 64
#define CCA_RX_PEND_MAX 24      /* enough for a full retransmission train */
#define CCA_DRAIN_SILENCE_MS 18 /* absorb short retrans+ACK bursts before flush */
#define CCA_ISR_LAT_BINS 12
#define CCA_MAIN_POLL_MS 2
#define CCA_HOT_POLL_MS 1

/* TDMA slot observation and TX scheduling in cca_tdma.h/cpp */

/* -----------------------------------------------------------------------
 * TX queue item
 * ----------------------------------------------------------------------- */
struct CcaTxItem {
    uint8_t data[CCA_TX_MAX_LEN];
    size_t len;
};

/* -----------------------------------------------------------------------
 * Private state
 * ----------------------------------------------------------------------- */
static TaskHandle_t cca_task_handle = NULL;
static QueueHandle_t cca_tx_queue = NULL;           /* TDMA-scheduled TX */
static QueueHandle_t cca_tx_immediate_queue = NULL; /* bypass TDMA (pairing) */
static CcaDecoder decoder;
static uint32_t rx_count = 0;
static uint32_t tx_count = 0;
static uint32_t drop_count = 0;         /* decode failures with strong signal */
static uint32_t crc_fail_count = 0;     /* decoded but CRC invalid */
static uint32_t n81_err_count = 0;      /* decoded with N81 framing errors */
static uint32_t ack_count = 0;          /* decoded dimmer ACK packets (0x0B) */
static uint32_t crc_optional_count = 0; /* accepted with crc_valid=false */
/* High-rate UART packet logs can disrupt shell interactivity. Keep off by default. */
static volatile bool cca_uart_log_enabled_ = false;

/* GDO0/latency telemetry */
static volatile uint32_t gdo0_irq_count = 0;
static volatile uint32_t gdo0_last_cycle = 0;
static volatile uint8_t gdo0_stamp_valid = 0;
static uint32_t isr_latency_min_us = 0xFFFFFFFFu;
static uint32_t isr_latency_max_us = 0;
static uint32_t isr_latency_samples = 0;
static uint32_t isr_latency_hist[CCA_ISR_LAT_BINS] = {0};
static const uint32_t isr_latency_hist_max_us[CCA_ISR_LAT_BINS] = {10,  20,   40,   80,   160,   320,
                                                                   640, 1000, 2000, 5000, 10000, 0xFFFFFFFFu};

static void reset_isr_latency_stats(void)
{
    gdo0_irq_count = 0;
    gdo0_last_cycle = 0;
    gdo0_stamp_valid = 0;
    isr_latency_min_us = 0xFFFFFFFFu;
    isr_latency_max_us = 0;
    isr_latency_samples = 0;
    memset(isr_latency_hist, 0, sizeof(isr_latency_hist));
}

/* -----------------------------------------------------------------------
 * Pending RX queue — defers printf/streaming out of the RX hot path.
 * Callback only decodes + enqueues; logging happens after all pending
 * FIFO data is drained, so the radio isn't starved by UART blocking.
 * ----------------------------------------------------------------------- */
struct CcaRxPending {
    DecodedPacket pkt;
    int8_t rssi;
    uint32_t timestamp_ms;
    bool valid; /* true = decoded packet, false = drop */
    uint8_t drop_hex[16];
    size_t drop_hex_len;
    size_t drop_raw_len;
};
static CcaRxPending rx_pending[CCA_RX_PEND_MAX];
static size_t rx_pend_count = 0;

/* RX hook — set by pairing engine to intercept handshake challenges */
static cca_rx_hook_t rx_hook = NULL;

/* -----------------------------------------------------------------------
 * GDO0 ISR callback — called from EXTI9_5_IRQHandler (stm32h7xx_it.c)
 * ----------------------------------------------------------------------- */
extern "C" void cca_gdo0_isr_callback(void)
{
    gdo0_irq_count++;
    gdo0_last_cycle = DWT->CYCCNT;
    gdo0_stamp_valid = 1;

    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    if (cca_task_handle != NULL) {
        vTaskNotifyGiveFromISR(cca_task_handle, &xHigherPriorityTaskWoken);
        portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
    }
}

static size_t isr_latency_bin_for_us(uint32_t latency_us)
{
    for (size_t i = 0; i < CCA_ISR_LAT_BINS; i++) {
        if (latency_us <= isr_latency_hist_max_us[i]) return i;
    }
    return CCA_ISR_LAT_BINS - 1;
}

static void record_isr_latency_sample(uint32_t latency_us)
{
    if (latency_us < isr_latency_min_us) isr_latency_min_us = latency_us;
    if (latency_us > isr_latency_max_us) isr_latency_max_us = latency_us;
    isr_latency_samples++;
    size_t bin = isr_latency_bin_for_us(latency_us);
    isr_latency_hist[bin]++;
}

static uint32_t isr_latency_p95_us_internal(void)
{
    if (isr_latency_samples == 0) return 0;

    uint64_t threshold = ((uint64_t)isr_latency_samples * 95u + 99u) / 100u;
    uint64_t seen = 0;
    for (size_t i = 0; i < CCA_ISR_LAT_BINS; i++) {
        seen += isr_latency_hist[i];
        if (seen >= threshold) return isr_latency_hist_max_us[i];
    }
    return isr_latency_max_us;
}

/* -----------------------------------------------------------------------
 * CC1101 RX callback — called from cc1101_check_rx()
 * FAST PATH: decode + enqueue only, NO printf or stream I/O.
 * Logging and streaming happen later in the task loop after all
 * pending FIFO data has been drained.
 * ----------------------------------------------------------------------- */
static void on_rx_packet(const uint8_t* data, size_t len, int8_t rssi, uint32_t timestamp_ms)
{
    DecodedPacket pkt;
    pkt.clear();

    if (decoder.decode(data, len, pkt) && pkt.valid) {
        rx_count++;
        if (!pkt.crc_valid) {
            crc_fail_count++;
            crc_optional_count++;
        }
        if (pkt.n81_errors > 0) n81_err_count++;
        if (pkt.type_byte == 0x0B) ack_count++;
        cca_tdma_on_rx(&pkt, timestamp_ms);

        if (rx_pend_count < CCA_RX_PEND_MAX) {
            CcaRxPending& p = rx_pending[rx_pend_count++];
            p.pkt = pkt;
            p.rssi = rssi;
            p.timestamp_ms = timestamp_ms;
            p.valid = true;
        }
    }
    else if (rssi > -85) {
        drop_count++;

        if (rx_pend_count < CCA_RX_PEND_MAX) {
            CcaRxPending& p = rx_pending[rx_pend_count++];
            p.valid = false;
            p.rssi = rssi;
            p.timestamp_ms = timestamp_ms;
            p.drop_raw_len = len;
            size_t dump_len = len < 16 ? len : 16;
            memcpy(p.drop_hex, data, dump_len);
            p.drop_hex_len = dump_len;
        }
    }
}

/* -----------------------------------------------------------------------
 * Flush pending RX queue — printf + stream AFTER FIFO is fully drained
 *
 * All log lines are built into a single buffer and written with one
 * _write() call.  This is critical for timing: each separate printf()
 * releases the UART mutex, allowing other tasks (CCX, shell) to
 * interleave their own DMA writes.  Each interleaved write adds up to
 * ~8ms of DMA wait, starving the CC1101 FIFO.  A single batched write
 * holds the mutex for one DMA start and returns, with no interleaving
 * opportunity.
 * ----------------------------------------------------------------------- */
static void flush_rx_pending(void)
{
    if (rx_pend_count == 0) return;

    bool enable_uart_log = cca_uart_log_enabled_;

    if (enable_uart_log) {
        /* Build all log lines into one buffer — one _write call */
        char log_buf[CCA_RX_PEND_MAX * 128];
        int n = 0;

        for (size_t i = 0; i < rx_pend_count; i++) {
            CcaRxPending& p = rx_pending[i];

            if (p.valid) {
                if (rx_hook) rx_hook(&p.pkt);

                char dev_id[9];
                cca_format_device_id(p.pkt.device_id, dev_id, sizeof(dev_id));

                n += snprintf(log_buf + n, sizeof(log_buf) - n, "[cca] RX %-12s dev=%s seq=%02X rssi=%d",
                              cca_packet_type_name(p.pkt.type_byte), dev_id, p.pkt.sequence, p.rssi);

                if (cca_is_button_type(p.pkt.type_byte)) {
                    n += snprintf(log_buf + n, sizeof(log_buf) - n, " btn=%s act=%s", cca_button_name(p.pkt.button),
                                  p.pkt.action == ACTION_PRESS ? "PRESS" : "REL");
                }
                if (p.pkt.type == PKT_LEVEL) {
                    n += snprintf(log_buf + n, sizeof(log_buf) - n, " level=%u%%", p.pkt.level);
                }
                if (p.pkt.n81_errors > 0) {
                    n += snprintf(log_buf + n, sizeof(log_buf) - n, " n81err=%u", p.pkt.n81_errors);
                }
                const char* crc_str = p.pkt.crc_valid ? (p.pkt.n81_errors > 0 ? "RCVR" : "OK") : "FAIL";
                n += snprintf(log_buf + n, sizeof(log_buf) - n, " crc=%s\r\n", crc_str);
            }
            else {
                n += snprintf(log_buf + n, sizeof(log_buf) - n, "[cca] RX DROP rssi=%d len=%u hex=", p.rssi,
                              (unsigned)p.drop_raw_len);
                for (size_t j = 0; j < p.drop_hex_len && n < (int)sizeof(log_buf) - 4; j++) {
                    n += snprintf(log_buf + n, sizeof(log_buf) - n, "%02X", p.drop_hex[j]);
                }
                if (p.drop_raw_len > 16) {
                    n += snprintf(log_buf + n, sizeof(log_buf) - n, "...");
                }
                n += snprintf(log_buf + n, sizeof(log_buf) - n, "\r\n");
            }
        }

        /* Single write — prevents other tasks from interleaving DMA writes */
        if (n > 0) {
            fwrite(log_buf, 1, (size_t)n, stdout);
        }
    }
    else {
        /* Still feed pairing hook when UART log is suppressed. */
        if (rx_hook) {
            for (size_t i = 0; i < rx_pend_count; i++) {
                if (rx_pending[i].valid) rx_hook(&rx_pending[i].pkt);
            }
        }
    }

    /* Stream decoded packets to UDP */
    for (size_t i = 0; i < rx_pend_count; i++) {
        if (rx_pending[i].valid) {
            stream_send_cca_packet(rx_pending[i].pkt.raw, rx_pending[i].pkt.raw_len, rx_pending[i].rssi, false,
                                   rx_pending[i].timestamp_ms);
        }
    }

    rx_pend_count = 0;
}

/* -----------------------------------------------------------------------
 * CCA task main loop
 * ----------------------------------------------------------------------- */
static void cca_task_func(void* param)
{
    (void)param;

    printf("[cca] Task started, initializing CC1101...\r\n");

    cc1101_init();
    if (!cc1101_is_initialized()) {
        printf("[cca] CC1101 init failed! Task halting.\r\n");
        LED_RED_ON();
        vTaskDelete(NULL);
        return;
    }

    cca_timer_init();
    cc1101_set_rx_callback(on_rx_packet);
    cc1101_start_rx();
    reset_isr_latency_stats();
    cca_tdma_init();

    LED_GREEN_ON();
    printf("[cca] RX mode active\r\n");

    CcaTxItem tx_item;

    for (;;) {
        watchdog_feed();

        /* Poll RX frequently; CCA bursts can overflow CC1101 FIFO in a few ms.
         * TDMA engine determines poll interval (1ms near slot edges, 2ms otherwise). */
        uint32_t tdma_poll_ms = cca_tdma_poll(HAL_GetTick());
        TickType_t wait_ticks = pdMS_TO_TICKS(tdma_poll_ms > 0 ? tdma_poll_ms : CCA_MAIN_POLL_MS);
        if (wait_ticks == 0) wait_ticks = 1;
        uint32_t notified = ulTaskNotifyTake(pdTRUE, wait_ticks);
        if (notified > 0 && gdo0_stamp_valid) {
            uint32_t irq_cycle = gdo0_last_cycle;
            gdo0_stamp_valid = 0;

            uint32_t now_cycle = DWT->CYCCNT;
            uint32_t delta_cycles = now_cycle - irq_cycle;
            uint32_t cycles_per_us = SystemCoreClock / 1000000U;
            uint32_t latency_us = (cycles_per_us > 0) ? (delta_cycles / cycles_per_us) : 0;
            record_isr_latency_sample(latency_us);
        }

        /* Extended drain on IRQ — absorb full retrans burst before flush.
         * New driver handles FIFO reads + packet framing internally. */
        if (notified > 0) {
            TickType_t last_rx = xTaskGetTickCount();
            for (;;) {
                if (cc1101_check_rx()) {
                    last_rx = xTaskGetTickCount();
                }
                else {
                    TickType_t elapsed = xTaskGetTickCount() - last_rx;
                    if (elapsed >= pdMS_TO_TICKS(CCA_DRAIN_SILENCE_MS)) break;
                    /* Yield briefly — GDO0 notification wakes us early */
                    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1));
                }
                if (rx_pend_count >= CCA_RX_PEND_MAX) break;
            }
            flush_rx_pending();
        }
        else {
            /* Lightweight fallback poll in case one IRQ edge is missed. */
            bool got_packet = cc1101_check_rx();
            if (!got_packet && tdma_poll_ms <= 1) {
                /* In hot windows (TDMA near slot edge), probe extra to catch arrivals. */
                got_packet = cc1101_check_rx();
                if (!got_packet) got_packet = cc1101_check_rx();
            }
            if (got_packet) {
                flush_rx_pending();
            }
        }

        /* Process TDMA-scheduled TX queue — submit to TDMA engine */
        while (xQueueReceive(cca_tx_queue, &tx_item, 0) == pdTRUE) {
            CcaTdmaTxRequest req = {};
            memcpy(req.packet, tx_item.data, tx_item.len);
            req.packet_len = (uint8_t)tx_item.len;
            req.retries = CCA_TDMA_RETRIES_NORMAL;
            /* State reports (0x81-0x83) rotate type byte across retransmits */
            req.type_rotate = (tx_item.data[0] >= 0x81 && tx_item.data[0] <= 0x83) ? 1 : 0;
            req.priority = 0;
            const CcaTdmaJob* job = cca_tdma_submit(&req);
            if (job) {
                tx_count++;
            }
            else {
                printf("[cca] TDMA queue full, TX dropped\r\n");
            }
        }

        /* Process immediate TX queue — bypasses TDMA (used by pairing) */
        while (xQueueReceive(cca_tx_immediate_queue, &tx_item, 0) == pdTRUE) {
            cc1101_stop_rx();

            uint8_t with_crc[CCA_TX_MAX_LEN + 2];
            cca_append_crc(tx_item.data, tx_item.len, with_crc);

            uint8_t encoded[128];
            CcaEncoder encoder;
            size_t encoded_len = encoder.encode_packet(with_crc, tx_item.len + 2, encoded, sizeof(encoded));

            if (encoded_len > 0) {
                bool ok = cc1101_transmit_raw(encoded, encoded_len);
                if (ok) {
                    tx_count++;
                    stream_send_cca_packet(tx_item.data, tx_item.len, 0, true, HAL_GetTick());
                }
            }

            cc1101_start_rx();
        }

        /* Process command queue (non-blocking).
         * Commands execute synchronously with delays (blocking this task),
         * which is fine since they handle stop_rx/start_rx internally. */
        {
            QueueHandle_t cmdq = (QueueHandle_t)cca_cmd_queue_handle();
            CcaCmdItem cmd_item;
            while (cmdq && xQueueReceive(cmdq, &cmd_item, 0) == pdTRUE) {
                cca_cmd_execute(&cmd_item);
            }
        }
    }
}

/* -----------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */
void cca_task_start(void)
{
    cca_tx_queue = xQueueCreate(CCA_TX_QUEUE_LEN, sizeof(CcaTxItem));
    cca_tx_immediate_queue = xQueueCreate(CCA_TX_QUEUE_LEN, sizeof(CcaTxItem));
    cca_cmd_queue_init();

    xTaskCreate(cca_task_func, "CCA", CCA_TASK_STACK_SIZE, NULL, CCA_TASK_PRIORITY, &cca_task_handle);
}

bool cca_tx_enqueue(const uint8_t* packet, size_t len)
{
    if (cca_tx_queue == NULL || len == 0 || len > CCA_TX_MAX_LEN) return false;

    CcaTxItem item;
    memcpy(item.data, packet, len);
    item.len = len;

    return xQueueSend(cca_tx_queue, &item, pdMS_TO_TICKS(100)) == pdTRUE;
}

bool cca_tx_enqueue_immediate(const uint8_t* packet, size_t len)
{
    if (cca_tx_immediate_queue == NULL || len == 0 || len > CCA_TX_MAX_LEN) return false;

    CcaTxItem item;
    memcpy(item.data, packet, len);
    item.len = len;

    return xQueueSend(cca_tx_immediate_queue, &item, pdMS_TO_TICKS(100)) == pdTRUE;
}

uint32_t cca_rx_count(void)
{
    return rx_count;
}
uint32_t cca_tx_count(void)
{
    return tx_count + cca_cmd_tx_count();
}
uint32_t cca_drop_count(void)
{
    return drop_count;
}
uint32_t cca_crc_fail_count(void)
{
    return crc_fail_count;
}
uint32_t cca_n81_err_count(void)
{
    return n81_err_count;
}
uint32_t cca_ack_count(void)
{
    return ack_count;
}
uint32_t cca_crc_optional_count(void)
{
    return crc_optional_count;
}
uint32_t cca_irq_count(void)
{
    return gdo0_irq_count;
}
uint32_t cca_isr_latency_min_us(void)
{
    return (isr_latency_samples > 0) ? isr_latency_min_us : 0;
}
uint32_t cca_isr_latency_p95_us(void)
{
    return isr_latency_p95_us_internal();
}
uint32_t cca_isr_latency_max_us(void)
{
    return isr_latency_max_us;
}
uint32_t cca_isr_latency_samples(void)
{
    return isr_latency_samples;
}
void cca_set_uart_log_enabled(bool enabled)
{
    cca_uart_log_enabled_ = enabled;
}
bool cca_uart_log_enabled(void)
{
    return cca_uart_log_enabled_;
}

void cca_reset_stats(void)
{
    rx_count = 0;
    tx_count = 0;
    drop_count = 0;
    crc_fail_count = 0;
    n81_err_count = 0;
    ack_count = 0;
    crc_optional_count = 0;
    reset_isr_latency_stats();
    cca_tdma_reset();
}

void cca_set_rx_hook(cca_rx_hook_t hook)
{
    rx_hook = hook;
}
