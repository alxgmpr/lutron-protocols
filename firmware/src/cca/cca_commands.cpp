/**
 * CCA TX command library — structured packet builders for Lutron CCA.
 *
 * Each command builds a burst of packets and transmits them synchronously
 * with inter-packet delays, matching the timing of real Lutron devices.
 * Must be called from the CCA task context (uses vTaskDelay + cc1101 API).
 *
 * Byte layouts verified against ESP32 lutron-tools source and ESN-QS
 * firmware (QS Link protocol, 2009). Field names from cca_protocol.h.
 */

#include "cca_commands.h"
#include "cca_pairing.h"
#include "cca_auto_pair.h"
#include "cca_protocol.h"
#include "cca_crc.h"
#include "cca_encoder.h"
#include "cca_timer.h"
#include "cca_types.h"
#include "cca_tdma.h"
#include "cca_tx_builder.h"
#include "cc1101.h"
#include "stream.h"
#include "bsp.h"

#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"

#include <cstdio>
#include <cstring>

/* -----------------------------------------------------------------------
 * Command queue (created by cca_task, extern'd here)
 * ----------------------------------------------------------------------- */
#define CCA_CMD_QUEUE_LEN 4

static QueueHandle_t cmd_queue = NULL;

void cca_cmd_queue_init(void)
{
    cmd_queue = xQueueCreate(CCA_CMD_QUEUE_LEN, sizeof(CcaCmdItem));
}

void* cca_cmd_queue_handle(void)
{
    return (void*)cmd_queue;
}

bool cca_cmd_enqueue(const CcaCmdItem* item)
{
    if (cmd_queue == NULL) return false;
    return xQueueSend(cmd_queue, item, pdMS_TO_TICKS(100)) == pdTRUE;
}

/* -----------------------------------------------------------------------
 * Shared state
 * ----------------------------------------------------------------------- */
static bool type_alternate_ = false; /* toggles A/B on each button press */
static uint32_t cmd_tx_count = 0;    /* packets transmitted by commands */

/* -----------------------------------------------------------------------
 * Job group builders — non-blocking command decomposition
 * ----------------------------------------------------------------------- */

TdmaJobGroup cca_jobs_bridge_level(uint32_t zone_id, uint32_t target_id, uint8_t level_pct, uint8_t fade_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_set_level(g.phases[0].packet.data, zone_id, target_id, QS_ADDR_COMPONENT, level16, fade_qs, 0x81);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].retransmits = CCA_TDMA_RETRIES_LEVEL;
    g.phases[0].post_delay_ms = 0;

    printf("[cca] JOB bridge_level zone=%08X target=%08X %u%% fade=%uqs\r\n", (unsigned)zone_id, (unsigned)target_id,
           level_pct, fade_qs);
    return g;
}

TdmaJobGroup cca_jobs_button(uint32_t device_id, uint8_t button)
{
    TdmaJobGroup g = {};

    /* A/B alternation */
    static bool alt = false;
    uint8_t press_type = alt ? PKT_BTN_LONG_B : PKT_BTN_LONG_A;
    uint8_t release_type = alt ? PKT_BTN_SHORT_A : PKT_BTN_SHORT_B;
    alt = !alt;

    /* Map 5-btn raise/lower to 4-btn codes */
    bool is_dimming = (button == BTN_RAISE || button == BTN_LOWER);
    if (button == BTN_RAISE) button = 0x09;
    if (button == BTN_LOWER) button = 0x0A;

    uint8_t press_fmt = is_dimming ? QS_FMT_BEACON : QS_FMT_TAP;

    /* Phase 0: PRESS (short format) */
    cca_build_button_short(g.phases[0].packet.data, device_id, button, ACTION_PRESS, press_fmt, press_type);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_rotate = 0;
    g.phases[0].retransmits = 2;
    g.phases[0].post_delay_ms = 0;

    /* Phase 1: RELEASE (long format) */
    cca_build_button_long(g.phases[1].packet.data, device_id, button, release_type);
    g.phases[1].packet.len = 22;
    g.phases[1].packet.type_rotate = 0;
    g.phases[1].retransmits = 12;
    g.phases[1].post_delay_ms = 0;

    g.phase_count = 2;

    printf("[cca] JOB button dev=%08X btn=%s\r\n", (unsigned)device_id, cca_button_name(button));
    return g;
}

TdmaJobGroup cca_jobs_beacon(uint32_t zone_id, uint8_t type_byte)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    cca_build_beacon(g.phases[0].packet.data, zone_id, type_byte);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_rotate = 0;
    g.phases[0].retransmits = CCA_TDMA_RETRIES_NORMAL;
    g.phases[0].post_delay_ms = 0;

    printf("[cca] JOB beacon zone=%08X type=0x%02X\r\n", (unsigned)zone_id, type_byte);
    return g;
}

TdmaJobGroup cca_jobs_raw(const uint8_t* payload, uint8_t len, uint8_t retransmits)
{
    TdmaJobGroup g = {};
    if (len == 0 || len > 53) return g;

    g.phase_count = 1;
    memcpy(g.phases[0].packet.data, payload, len);
    g.phases[0].packet.len = len;
    g.phases[0].packet.type_rotate = 0;
    g.phases[0].retransmits = retransmits > 0 ? retransmits : CCA_TDMA_RETRIES_NORMAL;
    g.phases[0].post_delay_ms = 0;

    return g;
}

TdmaJobGroup cca_cmd_to_jobs(const CcaCmdItem* item)
{
    TdmaJobGroup empty = {};
    if (!item) return empty;

    switch (item->cmd) {
    case CCA_CMD_BUTTON:
        return cca_jobs_button(item->device_id, item->button);
    case CCA_CMD_BRIDGE_LEVEL:
        return cca_jobs_bridge_level(item->device_id, item->target_id, item->level_pct, item->fade_qs);
    case CCA_CMD_BEACON:
        return cca_jobs_beacon(item->device_id, 0x91);
    case CCA_CMD_RAW:
        return cca_jobs_raw(item->raw_payload, item->raw_payload_len, item->raw_repeat);
    default:
        printf("[cca] JOB: unsupported cmd 0x%02X, falling back to blocking\r\n", item->cmd);
        return empty;
    }
}

/* -----------------------------------------------------------------------
 * Transmit one CCA packet (CRC + N81 encode + radio TX).
 * Also streams the raw (pre-CRC) packet to TCP client as TX echo.
 * ----------------------------------------------------------------------- */
static bool transmit_one(const uint8_t* packet, size_t len)
{
    /* Append CRC */
    uint8_t with_crc[64 + 2];
    cca_append_crc(packet, len, with_crc);

    /* N81 encode */
    uint8_t encoded[128];
    CcaEncoder encoder;
    size_t encoded_len = encoder.encode_packet(with_crc, len + 2, encoded, sizeof(encoded));
    if (encoded_len == 0) return false;

    bool ok = cc1101_transmit_raw(encoded, encoded_len);
    if (ok) {
        cmd_tx_count++;
        stream_send_cca_packet(packet, len, 0, true, HAL_GetTick());
    }
    return ok;
}

/* -----------------------------------------------------------------------
 * Button press — matched to real Pico capture (08692D70 PJ2-4B-XXX-L01).
 *
 * Real Pico pattern:
 *   Phase 1 (PRESS):   type=LONG  fmt=0x04 act=PRESS    3 pairs (6 pkts)
 *   Phase 2 (RELEASE): type=SHORT fmt=0x0E act=RELEASE   ~12 pkts
 *
 * PRESS packets come in PAIRS (seq N, N+1) per slot.
 * A/B group alternates between button presses (LONG_A/SHORT_B, then LONG_B/SHORT_A).
 * ----------------------------------------------------------------------- */
static void exec_button(uint32_t device_id, uint8_t button)
{
    uint8_t packet[24];
    /* Within a press: PRESS=LONG, RELEASE=SHORT. A/B alternates between presses. */
    uint8_t press_type = type_alternate_ ? PKT_BTN_LONG_B : PKT_BTN_LONG_A;
    uint8_t release_type = type_alternate_ ? PKT_BTN_SHORT_A : PKT_BTN_SHORT_B;
    type_alternate_ = !type_alternate_;

    /* Dimming commands: map 5-btn codes to 4-btn codes for the actual packet.
     * 'raise' (BTN_RAISE=0x05) → packet byte 0x09, 'lower' (BTN_LOWER=0x06) → 0x0A.
     * From real 4-btn RL Pico capture: raise sends 0x09, lower sends 0x0A. */
    bool is_dimming = (button == BTN_RAISE || button == BTN_LOWER);
    if (button == BTN_RAISE) button = 0x09; /* 4-btn raise */
    if (button == BTN_LOWER) button = 0x0A; /* 4-btn lower */
    uint8_t seq = 0x00;
    uint32_t next_fire = 0;

    printf("[cca] CMD button dev=%08X btn=%s press=0x%02X release=0x%02X\r\n", (unsigned)device_id,
           cca_button_name(button), press_type, release_type);

    cc1101_stop_rx();

    /* --- Phase 1: PRESS — LONG type, format 0x04, 2 packets, stride 6 ---
     * Real Pico sends exactly 2 PRESS packets (seq 0x00, 0x06) then
     * switches to RELEASE. The processor echoes each at seq+1. */
    for (int rep = 0; rep < 2; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = press_type;
        packet[1] = seq;
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;
        packet[6] = QS_PROTO_RADIO_TX;
        packet[8] = QS_PICO_FRAME;
        packet[9] = 0x00;
        packet[10] = button;
        packet[11] = ACTION_PRESS;

        if (is_dimming) {
            packet[7] = QS_FMT_BEACON;
            packet[12] = (device_id >> 24) & 0xFF;
            packet[13] = (device_id >> 16) & 0xFF;
            packet[14] = (device_id >> 8) & 0xFF;
            packet[15] = device_id & 0xFF;
            packet[16] = 0x00;
            packet[17] = QS_CLASS_DIM;
            packet[18] = QS_TYPE_HOLD;
            /* Direction: 0x03=raise, 0x02=lower (from real Pico capture) */
            packet[19] = (button == BTN_RAISE || button == BTN_SCENE3) ? 0x03 : 0x02;
        }
        else {
            packet[7] = QS_FMT_TAP;
        }

        if (rep == 0) {
            /* Capture timer tick BEFORE first TX for precise scheduling */
            next_fire = cca_timer_ticks();
        }
        transmit_one(packet, 22);
        seq += 6;
        if (rep < 1) {
            next_fire += CCA_FRAME_TICKS; /* +75ms exactly */
            cca_timer_wait_until(next_fire);
        }
    }

    /* Gap between PRESS and RELEASE — exactly one frame (75ms from last PRESS) */
    next_fire += CCA_FRAME_TICKS;
    cca_timer_wait_until(next_fire);

    /* --- Phase 2: RELEASE — SHORT type, format 0x0E, ~12 packets --- */
    seq = 0x00;

    for (int rep = 0; rep < 12; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = release_type;
        packet[1] = seq;
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;
        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_LEVEL;
        packet[8] = QS_PICO_FRAME;
        packet[9] = 0x00;
        packet[10] = button;
        packet[11] = ACTION_RELEASE;

        /* Second device ID instance */
        packet[12] = (device_id >> 24) & 0xFF;
        packet[13] = (device_id >> 16) & 0xFF;
        packet[14] = (device_id >> 8) & 0xFF;
        packet[15] = device_id & 0xFF;
        packet[16] = 0x00;

        if (button == BTN_RAISE || button == BTN_SCENE3) {
            /* From real Pico capture: 42 02 01 00 D9 */
            packet[17] = QS_CLASS_DIM;
            packet[18] = QS_TYPE_EXECUTE;
            packet[19] = 0x01; /* direction: raise */
            packet[20] = 0x00;
            packet[21] = 0xD9;
        }
        else if (button == BTN_LOWER || button == BTN_SCENE2) {
            /* From real Pico capture: 42 02 00 00 CA */
            packet[17] = QS_CLASS_DIM;
            packet[18] = QS_TYPE_EXECUTE;
            packet[19] = 0x00; /* direction: lower */
            packet[20] = 0x00;
            packet[21] = 0xCA;
        }
        else {
            packet[17] = QS_CLASS_LEVEL;
            packet[18] = QS_TYPE_HOLD;
            /* Preset byte from real Pico capture:
             * ON(0x08)→0x20, OFF(0x0B)→0x21, mapped as 0x20 + button_index.
             * For 4-btn RL: SCENE4(0x08)=idx0, SCENE3(0x09)=idx1, SCENE2(0x0A)=idx2, SCENE1(0x0B)=idx3
             * For 5-btn:    ON(0x02)=idx0, FAV(0x03)=idx1, OFF(0x04)=idx2 */
            if (button >= 0x08 && button <= 0x0B) {
                packet[19] = 0x20 + (button - 0x08); /* 4-btn: 0x20-0x23 */
            }
            else {
                packet[19] = 0x20 + (button - 0x02); /* 5-btn: 0x20-0x22 */
            }
            packet[20] = 0x00;
            packet[21] = 0x00;
        }

        if (rep == 0) {
            next_fire = cca_timer_ticks();
        }
        transmit_one(packet, 22);
        seq += 6;
        if (rep < 11) {
            next_fire += CCA_FRAME_TICKS; /* +75ms exactly */
            cca_timer_wait_until(next_fire);
        }
    }

    cc1101_start_rx();
    printf("[cca] CMD button complete (%lu pkts)\r\n", (unsigned long)cmd_tx_count);
}

/* -----------------------------------------------------------------------
 * Bridge level — 20 packets, type rotates 0x81/82/83
 * ----------------------------------------------------------------------- */
static void exec_bridge_level(uint32_t zone_id, uint32_t target_id, uint8_t level_pct, uint8_t fade_qs)
{
    if (level_pct > 100) level_pct = 100;

    uint16_t level_value;
    if (level_pct == 100) {
        level_value = 0xFEFF;
    }
    else if (level_pct == 0) {
        level_value = 0x0000;
    }
    else {
        level_value = (uint16_t)((uint32_t)level_pct * 65279 / 100);
    }

    printf("[cca] CMD bridge_level zone=%08X target=%08X %u%% fade=%uqs\r\n", (unsigned)zone_id, (unsigned)target_id,
           level_pct, fade_qs);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x01;

    for (int rep = 0; rep < 20; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (zone_id >> 24) & 0xFF;
        packet[3] = (zone_id >> 16) & 0xFF;
        packet[4] = (zone_id >> 8) & 0xFF;
        packet[5] = zone_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_LEVEL;
        packet[8] = 0x00; /* flags: normal */

        /* Target device ID (object_id) in big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;
        packet[14] = QS_CLASS_LEVEL;
        packet[15] = QS_TYPE_EXECUTE;

        /* Level value (big-endian) */
        packet[16] = (level_value >> 8) & 0xFF;
        packet[17] = level_value & 0xFF;

        packet[18] = 0x00;
        packet[19] = fade_qs; /* fade time in quarter-seconds */
        packet[20] = 0x00;
        packet[21] = 0x00;

        transmit_one(packet, 22);

        /* Sequence increments by 5-6 like real bridge */
        seq = (seq + 5 + (rep % 2)) & 0xFF;

        if (rep < 19) vTaskDelay(pdMS_TO_TICKS(60));
    }

    cc1101_start_rx();
    printf("[cca] CMD bridge_level complete\r\n");
}

/* -----------------------------------------------------------------------
 * Broadcast level — format 0x0E with addr_mode=0xFF (broadcast)
 * Tests QS Link hypothesis: does broadcast addressing control all devices?
 * Same as bridge_level but target=0xFFFFFFFF, addr_mode=BROADCAST.
 * ----------------------------------------------------------------------- */
static void exec_broadcast_level(uint32_t zone_id, uint8_t level_pct, uint8_t fade_qs)
{
    if (level_pct > 100) level_pct = 100;

    uint16_t level_value;
    if (level_pct == 100)
        level_value = QS_LEVEL_MAX;
    else if (level_pct == 0)
        level_value = 0x0000;
    else
        level_value = (uint16_t)((uint32_t)level_pct * 65279 / 100);

    printf("[cca] CMD broadcast_level zone=%08X %u%% fade=%uqs\r\n", (unsigned)zone_id, level_pct, fade_qs);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x01;

    for (int rep = 0; rep < 20; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (zone_id >> 24) & 0xFF;
        packet[3] = (zone_id >> 16) & 0xFF;
        packet[4] = (zone_id >> 8) & 0xFF;
        packet[5] = zone_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_LEVEL;
        packet[8] = 0x00; /* flags: normal */

        /* Broadcast target: all 0xFF */
        packet[9] = 0xFF;
        packet[10] = 0xFF;
        packet[11] = 0xFF;
        packet[12] = 0xFF;

        packet[13] = QS_ADDR_BROADCAST; /* 0xFF = broadcast */
        packet[14] = QS_CLASS_LEVEL;
        packet[15] = QS_TYPE_EXECUTE;

        /* Level value (big-endian) */
        packet[16] = (level_value >> 8) & 0xFF;
        packet[17] = level_value & 0xFF;

        packet[18] = 0x00;
        packet[19] = fade_qs;
        packet[20] = 0x00;
        packet[21] = 0x00;

        transmit_one(packet, 22);
        seq = (seq + 5 + (rep % 2)) & 0xFF;
        if (rep < 19) vTaskDelay(pdMS_TO_TICKS(60));
    }

    cc1101_start_rx();
    printf("[cca] CMD broadcast_level complete\r\n");
}

/* -----------------------------------------------------------------------
 * Pico level — 8 packets, simpler format
 * ----------------------------------------------------------------------- */
static void exec_pico_level(uint32_t device_id, uint8_t level_pct)
{
    if (level_pct > 100) level_pct = 100;

    uint16_t level_value;
    if (level_pct == 100) {
        level_value = 0xFEFF;
    }
    else {
        level_value = (uint16_t)((uint32_t)level_pct * 65279 / 100);
    }

    printf("[cca] CMD pico_level dev=%08X %u%%\r\n", (unsigned)device_id, level_pct);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x00;

    for (int rep = 0; rep < 8; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Device ID (source) in big-endian */
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_LEVEL;
        packet[8] = 0x00; /* flags */
        packet[9] = 0x07; /* pico-specific field */
        packet[10] = 0x03;
        packet[11] = 0xC3;
        packet[12] = 0xC6;
        packet[13] = QS_ADDR_COMPONENT;
        packet[14] = QS_CLASS_LEVEL;
        packet[15] = QS_TYPE_EXECUTE;

        /* Level value (big-endian) */
        packet[16] = (level_value >> 8) & 0xFF;
        packet[17] = level_value & 0xFF;

        packet[18] = 0x00;
        packet[19] = 0x01; /* fade: 0.25s (minimum) */
        packet[20] = 0x00;
        packet[21] = 0x00;

        transmit_one(packet, 22);
        seq += 6;
        if (rep < 7) vTaskDelay(pdMS_TO_TICKS(65));
    }

    cc1101_start_rx();
    printf("[cca] CMD pico_level complete\r\n");
}

/* -----------------------------------------------------------------------
 * State report — 20 packets, type rotates 0x81/82/83, seq += 2
 * ----------------------------------------------------------------------- */
static void exec_state_report(uint32_t device_id, uint8_t level_pct)
{
    if (level_pct > 100) level_pct = 100;

    uint8_t level_byte;
    if (level_pct == 100) {
        level_byte = QS_LEVEL_MAX_8;
    }
    else {
        level_byte = (uint8_t)((uint32_t)level_pct * 254 / 100);
    }

    printf("[cca] CMD state_report dev=%08X %u%%\r\n", (unsigned)device_id, level_pct);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x00;

    for (int rep = 0; rep < 20; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Device ID (source) in big-endian */
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;

        packet[6] = 0x00;
        packet[7] = QS_FMT_STATE;
        packet[8] = 0x00;
        packet[9] = QS_STATE_ENTITY_COMP;
        packet[10] = 0x01;

        /* Level byte (first instance) */
        packet[11] = level_byte;

        packet[12] = 0x00;
        packet[13] = QS_STATE_ENTITY_COMP;
        packet[14] = QS_STATE_STATUS_FLAG;

        /* Level byte (second instance) */
        packet[15] = level_byte;

        /* [16-21] remain 0x00 from memset */

        transmit_one(packet, 22);
        seq = (seq + 2) & 0xFF;
        if (rep < 19) vTaskDelay(pdMS_TO_TICKS(50));
    }

    cc1101_start_rx();
    printf("[cca] CMD state_report complete\r\n");
}

/* -----------------------------------------------------------------------
 * Beacon — alternating 0x91/0x92/0x93 pairs, ~65ms spacing
 * Source: ESP32 send_beacon() lines 921-1011
 * ----------------------------------------------------------------------- */
static void exec_beacon(uint32_t device_id, uint8_t duration_sec)
{
    if (duration_sec == 0) duration_sec = 5;

    printf("[cca] CMD beacon dev=%08X dur=%us\r\n", (unsigned)device_id, duration_sec);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x01;
    uint32_t start = HAL_GetTick();

    while ((HAL_GetTick() - start) < (uint32_t)duration_sec * 1000) {
        for (int sub = 0; sub < 3; sub++) {
            memset(packet, 0x00, sizeof(packet));

            packet[0] = 0x91 + sub;
            packet[1] = seq;

            /* Device ID big-endian at [2-5] */
            packet[2] = (device_id >> 24) & 0xFF;
            packet[3] = (device_id >> 16) & 0xFF;
            packet[4] = (device_id >> 8) & 0xFF;
            packet[5] = device_id & 0xFF;

            packet[6] = QS_PROTO_RADIO_TX;
            packet[7] = QS_FMT_BEACON;
            packet[8] = 0x00; /* flags */

            /* Broadcast address: object_id=0xFFFFFFFF, addr_mode=BROADCAST */
            packet[9] = QS_ADDR_BROADCAST;
            packet[10] = QS_ADDR_BROADCAST;
            packet[11] = QS_ADDR_BROADCAST;
            packet[12] = QS_ADDR_BROADCAST;
            packet[13] = QS_ADDR_BROADCAST;

            transmit_one(packet, 22);
            vTaskDelay(pdMS_TO_TICKS(65));
        }

        seq = (seq + 5 + (seq & 1)) & 0xFF;
    }

    cc1101_start_rx();
    printf("[cca] CMD beacon complete\r\n");
}

/* -----------------------------------------------------------------------
 * Unpair — Phase 1: 4x format 0x09 prepare, Phase 2: 3x11 format 0x0C
 * Source: ESP32 send_bridge_unpair_dual() lines 1977-2105
 * ----------------------------------------------------------------------- */
static void exec_unpair(uint32_t zone_id, uint32_t target_id)
{
    printf("[cca] CMD unpair zone=%08X target=%08X\r\n", (unsigned)zone_id, (unsigned)target_id);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x01;

    /* Phase 1: 4x "prepare" packets (format 0x09) */
    for (int rep = 0; rep < 4; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (zone_id >> 24) & 0xFF;
        packet[3] = (zone_id >> 16) & 0xFF;
        packet[4] = (zone_id >> 8) & 0xFF;
        packet[5] = zone_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_CTRL; /* format 0x09: device control / prepare */
        packet[8] = 0x00;        /* flags */

        /* Target object_id big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;

        transmit_one(packet, 22);
        seq = (seq + 5 + (rep & 1)) & 0xFF;
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    /* Gap between phases */
    vTaskDelay(pdMS_TO_TICKS(800));

    /* Phase 2: 3 bursts of 11 "unpair" packets (format 0x0C) */
    for (int burst = 0; burst < 3; burst++) {
        for (int rep = 0; rep < 11; rep++) {
            memset(packet, 0x00, sizeof(packet));

            packet[0] = 0x81 + (rep % 3);
            packet[1] = seq;

            /* Source ID (zone/subnet) in big-endian */
            packet[2] = (zone_id >> 24) & 0xFF;
            packet[3] = (zone_id >> 16) & 0xFF;
            packet[4] = (zone_id >> 8) & 0xFF;
            packet[5] = zone_id & 0xFF;

            packet[6] = QS_PROTO_RADIO_TX;
            packet[7] = QS_FMT_BEACON; /* format 0x0C: unpair */
            packet[8] = 0x00;          /* flags */

            /* Target object_id big-endian */
            packet[9] = (target_id >> 24) & 0xFF;
            packet[10] = (target_id >> 16) & 0xFF;
            packet[11] = (target_id >> 8) & 0xFF;
            packet[12] = target_id & 0xFF;

            packet[13] = QS_ADDR_COMPONENT;

            transmit_one(packet, 22);
            seq = (seq + 5 + (rep & 1)) & 0xFF;
            vTaskDelay(pdMS_TO_TICKS(60));
        }

        if (burst < 2) vTaskDelay(pdMS_TO_TICKS(200));
    }

    cc1101_start_rx();
    printf("[cca] CMD unpair complete\r\n");
}

/* -----------------------------------------------------------------------
 * LED config — 53-byte A1/A2/A3 packets, format 0x11
 * Source: ESP32 send_led_config() lines 1463-1573
 * ----------------------------------------------------------------------- */
static void exec_led_config(uint32_t zone_id, uint32_t target_id, uint8_t led_mode)
{
    /* Mode encoding: 0=both off, 1=both on, 2=on-when-on, 3=on-when-off */
    uint8_t led_off_state, led_on_state;
    switch (led_mode) {
    case 0:
        led_off_state = 0x00;
        led_on_state = 0x00;
        break;
    case 1:
        led_off_state = 0xFF;
        led_on_state = 0xFF;
        break;
    case 2:
        led_off_state = 0x00;
        led_on_state = 0xFF;
        break;
    case 3:
        led_off_state = 0xFF;
        led_on_state = 0x00;
        break;
    default:
        led_off_state = 0x00;
        led_on_state = 0x00;
        break;
    }

    printf("[cca] CMD led_config zone=%08X target=%08X mode=%u\r\n", (unsigned)zone_id, (unsigned)target_id, led_mode);

    cc1101_stop_rx();

    uint8_t packet[53];
    uint8_t seq = 0x01;
    uint32_t active_zone = zone_id;

    for (int rep = 0; rep < 20; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0xA1 + (rep % 3);
        packet[1] = seq;

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (active_zone >> 24) & 0xFF;
        packet[3] = (active_zone >> 16) & 0xFF;
        packet[4] = (active_zone >> 8) & 0xFF;
        packet[5] = active_zone & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_LED;
        packet[8] = 0x00; /* flags */

        /* Target object_id big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;

        /* LED state bytes at [23-24] */
        packet[23] = led_off_state;
        packet[24] = led_on_state;

        transmit_one(packet, 51);

        /* After first packet, switch to alt zone (zone+2) */
        if (rep == 0) {
            active_zone = zone_id + 2;
        }
        seq = (seq + 1) & 0xFF;
        vTaskDelay(pdMS_TO_TICKS(75));
    }

    cc1101_start_rx();
    printf("[cca] CMD led_config complete\r\n");
}

/* -----------------------------------------------------------------------
 * Fade config — 53-byte packets, format 0x1C
 * Source: ESP32 send_fade_config() lines 1575-1669
 * ----------------------------------------------------------------------- */
static void exec_fade_config(uint32_t zone_id, uint32_t target_id, uint16_t fade_on_qs, uint16_t fade_off_qs)
{
    printf("[cca] CMD fade_config zone=%08X target=%08X on=%uqs off=%uqs\r\n", (unsigned)zone_id, (unsigned)target_id,
           fade_on_qs, fade_off_qs);

    cc1101_stop_rx();

    uint8_t packet[53];
    uint8_t seq = 0x01;
    uint32_t active_zone = zone_id;

    for (int rep = 0; rep < 20; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0xA1 + (rep % 3);
        packet[1] = seq;

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (active_zone >> 24) & 0xFF;
        packet[3] = (active_zone >> 16) & 0xFF;
        packet[4] = (active_zone >> 8) & 0xFF;
        packet[5] = active_zone & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_FADE;
        packet[8] = 0x00; /* flags */

        /* Target object_id big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;

        /* Fade values LE16 at [23-26] */
        packet[23] = fade_on_qs & 0xFF;
        packet[24] = (fade_on_qs >> 8) & 0xFF;
        packet[25] = fade_off_qs & 0xFF;
        packet[26] = (fade_off_qs >> 8) & 0xFF;

        transmit_one(packet, 51);

        /* After first packet, switch to alt zone (zone+2) */
        if (rep == 0) {
            active_zone = zone_id + 2;
        }
        seq = (seq + 1) & 0xFF;
        vTaskDelay(pdMS_TO_TICKS(75));
    }

    cc1101_start_rx();
    printf("[cca] CMD fade_config complete\r\n");
}

/* -----------------------------------------------------------------------
 * Trim config — 53-byte A3 packets, format 0x15
 * Source: ESP32 send_trim_config_only() lines 1815-1909
 * ----------------------------------------------------------------------- */
static void exec_trim_config(uint32_t zone_id, uint32_t target_id, uint8_t high_trim, uint8_t low_trim)
{
    /* Convert percentage (0-100) to 0x00-0xFE scale */
    uint8_t high_val = (high_trim >= 100) ? 0xFE : (uint8_t)((uint32_t)high_trim * 254 / 100);
    uint8_t low_val = (low_trim >= 100) ? 0xFE : (uint8_t)((uint32_t)low_trim * 254 / 100);

    printf("[cca] CMD trim_config zone=%08X target=%08X high=%u%% low=%u%%\r\n", (unsigned)zone_id, (unsigned)target_id,
           high_trim, low_trim);

    cc1101_stop_rx();

    uint8_t packet[53];

    /* Only 2 packets: seq 0x01 on primary zone, seq 0x02 on alt zone */
    for (int rep = 0; rep < 2; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0xA3;
        packet[1] = (uint8_t)(rep + 1); /* seq 0x01, 0x02 */

        uint32_t active_zone = (rep == 0) ? zone_id : (zone_id + 2);

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (active_zone >> 24) & 0xFF;
        packet[3] = (active_zone >> 16) & 0xFF;
        packet[4] = (active_zone >> 8) & 0xFF;
        packet[5] = active_zone & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_TRIM;
        packet[8] = 0x00; /* flags */

        /* Target object_id big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;

        /* Trim at [20-21] */
        packet[20] = high_val;
        packet[21] = low_val;

        transmit_one(packet, 51);
        if (rep == 0) vTaskDelay(pdMS_TO_TICKS(75));
    }

    cc1101_start_rx();
    printf("[cca] CMD trim_config complete\r\n");
}

/* -----------------------------------------------------------------------
 * Phase config — format 0x15 with neutral trim, phase byte at [22]
 * Source: ESP32 send_phase_config() lines 1911-1970
 * ----------------------------------------------------------------------- */
static void exec_phase_config(uint32_t zone_id, uint32_t target_id, uint8_t phase_byte)
{
    printf("[cca] CMD phase_config zone=%08X target=%08X phase=0x%02X\r\n", (unsigned)zone_id, (unsigned)target_id,
           phase_byte);

    cc1101_stop_rx();

    uint8_t packet[53];

    /* Same as trim: 2 packets, primary zone then alt zone */
    for (int rep = 0; rep < 2; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0xA3;
        packet[1] = (uint8_t)(rep + 1);

        uint32_t active_zone = (rep == 0) ? zone_id : (zone_id + 2);

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (active_zone >> 24) & 0xFF;
        packet[3] = (active_zone >> 16) & 0xFF;
        packet[4] = (active_zone >> 8) & 0xFF;
        packet[5] = active_zone & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_TRIM; /* trim/phase share same format */
        packet[8] = 0x00;        /* flags */

        /* Target object_id big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;

        /* Neutral trim values */
        packet[20] = QS_LEVEL_MAX_8; /* high trim = 100% */
        packet[21] = 0x03;           /* low trim ≈ 1% */

        /* Phase byte at [22] */
        packet[22] = phase_byte;

        transmit_one(packet, 51);
        if (rep == 0) vTaskDelay(pdMS_TO_TICKS(75));
    }

    cc1101_start_rx();
    printf("[cca] CMD phase_config complete\r\n");
}

/* -----------------------------------------------------------------------
 * Vive level — 12 packets, type rotates 0x89/0x8A/0x8B, format 0x0E
 * Source: ESP32 send_vive_level() line 2318
 * ----------------------------------------------------------------------- */
static uint8_t vive_cmd_seq_ = 0x01;

static void exec_vive_level(uint32_t hub_id, uint8_t zone_byte, uint8_t level_pct, uint8_t fade_qs)
{
    if (level_pct > 100) level_pct = 100;

    uint16_t level_value;
    if (level_pct == 100) {
        level_value = 0xFEFF;
    }
    else if (level_pct == 0) {
        level_value = 0x0000;
    }
    else {
        level_value = (uint16_t)((uint32_t)level_pct * 65279 / 100);
    }

    printf("[cca] CMD vive_level hub=%08X zone=0x%02X %u%% fade=%uqs\r\n", (unsigned)hub_id, zone_byte, level_pct,
           fade_qs);

    cc1101_stop_rx();

    uint8_t packet[24];

    for (int rep = 0; rep < 12; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x89 + (rep % 3);
        packet[1] = vive_cmd_seq_;

        /* Hub ID big-endian at [2-5] */
        packet[2] = (hub_id >> 24) & 0xFF;
        packet[3] = (hub_id >> 16) & 0xFF;
        packet[4] = (hub_id >> 8) & 0xFF;
        packet[5] = hub_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_LEVEL;
        /* [8-11] = 0x00 */

        packet[12] = zone_byte;
        packet[13] = QS_ADDR_GROUP;
        packet[14] = QS_CLASS_LEVEL;
        packet[15] = QS_TYPE_EXECUTE;

        /* Level value big-endian */
        packet[16] = (level_value >> 8) & 0xFF;
        packet[17] = level_value & 0xFF;

        packet[18] = 0x00;
        packet[19] = fade_qs;
        packet[20] = 0x00;
        packet[21] = 0x00;

        transmit_one(packet, 22);
        if (rep < 11) vTaskDelay(pdMS_TO_TICKS(15));
    }

    vive_cmd_seq_ = (vive_cmd_seq_ + 6) % 0x43;
    if (vive_cmd_seq_ == 0) vive_cmd_seq_ = 0x01;

    cc1101_start_rx();
    printf("[cca] CMD vive_level complete\r\n");
}

/* -----------------------------------------------------------------------
 * Vive dim (raise/lower) — 6 hold-start + 12 dim step packets
 * Source: ESP32 send_vive_dim_command() line 2481
 * ----------------------------------------------------------------------- */
static void exec_vive_dim(uint32_t hub_id, uint8_t zone_byte, uint8_t direction)
{
    printf("[cca] CMD vive_dim hub=%08X zone=0x%02X dir=%s\r\n", (unsigned)hub_id, zone_byte,
           direction == 0x03 ? "raise" : "lower");

    cc1101_stop_rx();

    uint8_t packet[24];

    /* Phase 1: 6 hold-start packets (format 0x09) */
    for (int rep = 0; rep < 6; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x89 + (rep % 3);
        packet[1] = vive_cmd_seq_;

        /* Hub ID big-endian */
        packet[2] = (hub_id >> 24) & 0xFF;
        packet[3] = (hub_id >> 16) & 0xFF;
        packet[4] = (hub_id >> 8) & 0xFF;
        packet[5] = hub_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_CTRL; /* format 0x09: hold-start */
        packet[8] = 0x00;
        packet[9] = 0x00;
        packet[10] = 0x00;
        packet[11] = 0x00;

        packet[12] = zone_byte;
        packet[13] = QS_ADDR_GROUP;
        packet[14] = QS_CLASS_DIM;
        packet[15] = QS_TYPE_HOLD;
        packet[16] = direction;
        /* [17-21] = 0x00 from memset */

        transmit_one(packet, 22);
        if (rep < 5) vTaskDelay(pdMS_TO_TICKS(15));
    }

    vive_cmd_seq_ = (vive_cmd_seq_ + 6) % 0x43;
    if (vive_cmd_seq_ == 0) vive_cmd_seq_ = 0x01;

    vTaskDelay(pdMS_TO_TICKS(50));

    /* Phase 2: 12 dim step packets (format 0x0B) */
    for (int rep = 0; rep < 12; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x89 + (rep % 3);
        packet[1] = vive_cmd_seq_;

        /* Hub ID big-endian */
        packet[2] = (hub_id >> 24) & 0xFF;
        packet[3] = (hub_id >> 16) & 0xFF;
        packet[4] = (hub_id >> 8) & 0xFF;
        packet[5] = hub_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_DIM_STEP;
        packet[8] = 0x00;
        packet[9] = 0x00;
        packet[10] = 0x00;
        packet[11] = 0x00;

        packet[12] = zone_byte;
        packet[13] = QS_ADDR_GROUP;
        packet[14] = QS_CLASS_DIM;
        packet[15] = QS_TYPE_EXECUTE; /* 0x02 = step/execute */
        packet[16] = direction;
        packet[17] = 0x00;
        packet[18] = 0x00;
        /* [19-21] = 0x00 from memset */

        transmit_one(packet, 22);
        if (rep < 11) vTaskDelay(pdMS_TO_TICKS(15));
    }

    vive_cmd_seq_ = (vive_cmd_seq_ + 6) % 0x43;
    if (vive_cmd_seq_ == 0) vive_cmd_seq_ = 0x01;

    cc1101_start_rx();
    printf("[cca] CMD vive_dim complete\r\n");
}

/* -----------------------------------------------------------------------
 * Save favorite — sends FAV button with SAVE action (0x03)
 * Same structure as button press but action=SAVE in both phases.
 * ----------------------------------------------------------------------- */
static void exec_save_fav(uint32_t device_id)
{
    uint8_t packet[24];
    uint8_t type_base = type_alternate_ ? PKT_BTN_SHORT_B : PKT_BTN_SHORT_A;
    type_alternate_ = !type_alternate_;

    uint8_t seq = 0x00;

    printf("[cca] CMD save_fav dev=%08X\r\n", (unsigned)device_id);

    cc1101_stop_rx();

    /* --- Phase 1: SHORT format (6 packets) --- */
    for (int rep = 0; rep < 6; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = type_base;
        packet[1] = seq;
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;
        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_TAP;
        packet[8] = QS_PICO_FRAME;
        packet[9] = 0x00;
        packet[10] = BTN_FAVORITE;
        packet[11] = ACTION_SAVE;

        transmit_one(packet, 22);
        seq += 6;
        vTaskDelay(pdMS_TO_TICKS(65));
    }

    /* --- Phase 2: LONG format (10 packets) --- */
    seq = 0x00;

    for (int rep = 0; rep < 10; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = type_base | 0x01; /* long format */
        packet[1] = seq;
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;
        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_LEVEL;
        packet[8] = QS_PICO_FRAME;
        packet[9] = 0x00;
        packet[10] = BTN_FAVORITE;
        packet[11] = ACTION_SAVE;

        /* Second device ID instance (pico embeds object_id twice) */
        packet[12] = (device_id >> 24) & 0xFF;
        packet[13] = (device_id >> 16) & 0xFF;
        packet[14] = (device_id >> 8) & 0xFF;
        packet[15] = device_id & 0xFF;
        packet[16] = 0x00;
        packet[17] = QS_CLASS_LEVEL;
        packet[18] = QS_TYPE_HOLD;
        packet[19] = QS_PRESET_BASE + BTN_FAVORITE;
        packet[20] = 0x00;
        packet[21] = 0x00;

        transmit_one(packet, 22);
        seq += 6;
        if (rep < 9) vTaskDelay(pdMS_TO_TICKS(65));
    }

    cc1101_start_rx();
    printf("[cca] CMD save_fav complete (%lu pkts)\r\n", (unsigned long)cmd_tx_count);
}

/* -----------------------------------------------------------------------
 * Identify — send QS_CLASS_DEVICE + QS_TYPE_IDENTIFY to flash a device's LED.
 * Hypothesis #6: This should work without pairing, since identify is a
 * fundamental device function in QS Link (telnet cmd DEVICECOMPONENTIDENTIFY).
 * Format 0x09 (9-byte payload): flags, object_id, addr_mode, cmd_class, cmd_type, param
 * ----------------------------------------------------------------------- */
static void exec_identify(uint32_t target_id)
{
    printf("[cca] CMD identify target=%08X\r\n", (unsigned)target_id);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x01;

    for (int rep = 0; rep < 12; rep++) {
        memset(packet, QS_PADDING, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Source ID placeholder (use target as source — we're pretending to be a processor) */
        packet[2] = (target_id >> 24) & 0xFF;
        packet[3] = (target_id >> 16) & 0xFF;
        packet[4] = (target_id >> 8) & 0xFF;
        packet[5] = target_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_CTRL; /* format 0x09 = 9-byte payload */
        packet[8] = 0x00;        /* flags */

        /* Target object_id big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;
        packet[14] = QS_CLASS_DEVICE;  /* 0x01 = device control */
        packet[15] = QS_TYPE_IDENTIFY; /* 0x22 = identify / flash LED */
        packet[16] = 0x01;             /* identify mode (from ESN firmware) */

        transmit_one(packet, 22);
        seq = (seq + 6) & 0xFF;
        if (rep < 11) vTaskDelay(pdMS_TO_TICKS(60));
    }

    cc1101_start_rx();
    printf("[cca] CMD identify complete\r\n");
}

/* -----------------------------------------------------------------------
 * Query — send QS_CLASS_SELECT + QS_TYPE_EXECUTE to query a device.
 * Hypothesis #4: This should trigger the device to report its component
 * info, similar to DEVICEREQUESTCOMPONENTPRESENT in the ESN telnet protocol.
 * ----------------------------------------------------------------------- */
static void exec_query(uint32_t target_id)
{
    printf("[cca] CMD query target=%08X\r\n", (unsigned)target_id);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x01;

    for (int rep = 0; rep < 12; rep++) {
        memset(packet, QS_PADDING, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Source ID placeholder */
        packet[2] = (target_id >> 24) & 0xFF;
        packet[3] = (target_id >> 16) & 0xFF;
        packet[4] = (target_id >> 8) & 0xFF;
        packet[5] = target_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_CTRL; /* format 0x09 */
        packet[8] = 0x00;

        /* Target object_id */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;
        packet[14] = QS_CLASS_SELECT; /* 0x03 = select/query */
        packet[15] = QS_TYPE_EXECUTE; /* 0x02 = execute */
        packet[16] = 0x0D;            /* parameter from ESN firmware */

        transmit_one(packet, 22);
        seq = (seq + 6) & 0xFF;
        if (rep < 11) vTaskDelay(pdMS_TO_TICKS(60));
    }

    cc1101_start_rx();
    printf("[cca] CMD query complete\r\n");
}

/* -----------------------------------------------------------------------
 * Raw command — universal packet builder
 * Builds a valid CCA packet from format byte + payload, handles type
 * cycling, sequence, device_id, CRC, and packet length selection.
 * ----------------------------------------------------------------------- */
static void exec_raw_cmd(uint32_t zone_id, uint32_t target_id, uint8_t format, const uint8_t* payload,
                         uint8_t payload_len, uint8_t repeat)
{
    if (repeat == 0) repeat = 12;

    /* Packet length: format < 0x20 → 24 bytes (22 data), format >= 0x20 → 53 bytes (51 data) */
    bool is_long = (format >= 0x20);
    size_t data_len = is_long ? 51 : 22;
    uint8_t type_base = is_long ? 0xA1 : 0x81;

    printf("[cca] CMD raw zone=%08X target=%08X fmt=0x%02X len=%u repeat=%u\r\n", (unsigned)zone_id,
           (unsigned)target_id, format, payload_len, repeat);

    cc1101_stop_rx();

    uint8_t packet[53];
    uint8_t seq = 0x01;

    for (int rep = 0; rep < repeat; rep++) {
        memset(packet, QS_PADDING, sizeof(packet));

        packet[0] = type_base + (rep % 3);
        packet[1] = seq;

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (zone_id >> 24) & 0xFF;
        packet[3] = (zone_id >> 16) & 0xFF;
        packet[4] = (zone_id >> 8) & 0xFF;
        packet[5] = zone_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = format;
        packet[8] = 0x00; /* flags */

        /* Target object_id big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        /* Copy payload bytes starting at [13] (includes addr_mode) */
        size_t max_payload = data_len - 13;
        size_t copy_len = payload_len < max_payload ? payload_len : max_payload;
        if (copy_len > 0) {
            memcpy(packet + 13, payload, copy_len);
        }

        transmit_one(packet, data_len);
        seq = (seq + 5 + (rep % 2)) & 0xFF;
        if (rep < repeat - 1) vTaskDelay(pdMS_TO_TICKS(65));
    }

    cc1101_start_rx();
    printf("[cca] CMD raw complete\r\n");
}

/* -----------------------------------------------------------------------
 * Scene execute — format 0x0C with QS_CLASS_SCENE
 * Activates a scene on a target device with level and fade.
 * Packet structure from ESN-QS Case 0x53.
 * ----------------------------------------------------------------------- */
static void exec_scene_execute(uint32_t zone_id, uint32_t target_id, uint8_t level_pct, uint8_t fade_qs)
{
    if (level_pct > 100) level_pct = 100;

    uint16_t level_value;
    if (level_pct == 100)
        level_value = QS_LEVEL_MAX;
    else if (level_pct == 0)
        level_value = 0x0000;
    else
        level_value = (uint16_t)((uint32_t)level_pct * 65279 / 100);

    printf("[cca] CMD scene zone=%08X target=%08X %u%% fade=%uqs\r\n", (unsigned)zone_id, (unsigned)target_id,
           level_pct, fade_qs);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x01;

    /* Same format as bridge_level (0x0E) but with CLASS_SCENE instead of CLASS_LEVEL */
    for (int rep = 0; rep < 20; rep++) {
        memset(packet, QS_PADDING, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (zone_id >> 24) & 0xFF;
        packet[3] = (zone_id >> 16) & 0xFF;
        packet[4] = (zone_id >> 8) & 0xFF;
        packet[5] = zone_id & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_LEVEL; /* 0x0E — same as bridge level */
        packet[8] = 0x00;         /* flags */

        /* Target object_id big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;
        packet[14] = QS_CLASS_SCENE;  /* 0x09 — scene instead of level */
        packet[15] = QS_TYPE_EXECUTE; /* 0x02 */

        /* Level16 big-endian */
        packet[16] = (level_value >> 8) & 0xFF;
        packet[17] = level_value & 0xFF;

        packet[18] = 0x00;
        packet[19] = fade_qs;
        packet[20] = 0x00;
        packet[21] = 0x00;

        transmit_one(packet, 22);
        seq = (seq + 5 + (rep % 2)) & 0xFF;
        if (rep < 19) vTaskDelay(pdMS_TO_TICKS(60));
    }

    cc1101_start_rx();
    printf("[cca] CMD scene complete\r\n");
}

/* -----------------------------------------------------------------------
 * Dimming config — format 0x13, 53-byte packet
 * Sends dimming capability / config bytes from ESN-QS Case 0x51.
 * Payload bytes are passed through from shell.
 * ----------------------------------------------------------------------- */
static void exec_dim_config(uint32_t zone_id, uint32_t target_id, const uint8_t* config_bytes, uint8_t config_len)
{
    printf("[cca] CMD dim_config zone=%08X target=%08X config_len=%u\r\n", (unsigned)zone_id, (unsigned)target_id,
           config_len);

    cc1101_stop_rx();

    uint8_t packet[53];
    uint8_t seq = 0x01;

    for (int rep = 0; rep < 5; rep++) {
        memset(packet, QS_PADDING, sizeof(packet));

        packet[0] = 0xA3; /* config type byte — always 0xA3 for trim-style */
        packet[1] = seq;

        uint32_t active_zone = (rep == 0) ? zone_id : (zone_id + 2);

        /* Source ID (zone/subnet) in big-endian */
        packet[2] = (active_zone >> 24) & 0xFF;
        packet[3] = (active_zone >> 16) & 0xFF;
        packet[4] = (active_zone >> 8) & 0xFF;
        packet[5] = active_zone & 0xFF;

        packet[6] = QS_PROTO_RADIO_TX;
        packet[7] = QS_FMT_DIM_CAP; /* 0x13 — dimming capability format */
        packet[8] = 0x00;           /* flags */

        /* Target object_id big-endian */
        packet[9] = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = QS_ADDR_COMPONENT;
        packet[14] = QS_CLASS_LEGACY;    /* 0x06 */
        packet[15] = QS_TYPE_DIM_CONFIG; /* 0x78 */

        /* Config payload starting at [16] */
        size_t max_payload = 51 - 16;
        size_t copy_len = config_len < max_payload ? config_len : max_payload;
        if (copy_len > 0) {
            memcpy(packet + 16, config_bytes, copy_len);
        }

        transmit_one(packet, 51);
        seq = (seq + 1) & 0xFF;
        if (rep < 4) vTaskDelay(pdMS_TO_TICKS(65));
    }

    cc1101_start_rx();
    printf("[cca] CMD dim_config complete\r\n");
}

/* -----------------------------------------------------------------------
 * Command dispatcher — called from CCA task context
 * ----------------------------------------------------------------------- */
void cca_cmd_execute(const CcaCmdItem* item)
{
    switch (item->cmd) {
    case CCA_CMD_BUTTON:
        exec_button(item->device_id, item->button);
        break;
    case CCA_CMD_BRIDGE_LEVEL:
        exec_bridge_level(item->device_id, item->target_id, item->level_pct, item->fade_qs);
        break;
    case CCA_CMD_PICO_LEVEL:
        exec_pico_level(item->device_id, item->level_pct);
        break;
    case CCA_CMD_STATE_REPORT:
        exec_state_report(item->device_id, item->level_pct);
        break;
    case CCA_CMD_BEACON:
        exec_beacon(item->device_id, item->duration_sec);
        break;
    case CCA_CMD_UNPAIR:
        exec_unpair(item->device_id, item->target_id);
        break;
    case CCA_CMD_LED_CONFIG:
        exec_led_config(item->device_id, item->target_id, item->led_mode);
        break;
    case CCA_CMD_FADE_CONFIG:
        exec_fade_config(item->device_id, item->target_id, item->fade_on_qs, item->fade_off_qs);
        break;
    case CCA_CMD_TRIM_CONFIG:
        exec_trim_config(item->device_id, item->target_id, item->high_trim, item->low_trim);
        break;
    case CCA_CMD_PHASE_CONFIG:
        exec_phase_config(item->device_id, item->target_id, item->phase_byte);
        break;
    case CCA_CMD_SAVE_FAV:
        exec_save_fav(item->device_id);
        break;
    case CCA_CMD_VIVE_LEVEL:
        exec_vive_level(item->device_id, item->zone_byte, item->level_pct, item->fade_qs);
        break;
    case CCA_CMD_VIVE_DIM:
        exec_vive_dim(item->device_id, item->zone_byte, item->direction);
        break;
    case CCA_CMD_BROADCAST_LEVEL:
        exec_broadcast_level(item->device_id, item->level_pct, item->fade_qs);
        break;
    case CCA_CMD_IDENTIFY:
        exec_identify(item->target_id);
        break;
    case CCA_CMD_QUERY:
        exec_query(item->target_id);
        break;
    case CCA_CMD_RAW:
        exec_raw_cmd(item->device_id, item->target_id, item->raw_format, item->raw_payload, item->raw_payload_len,
                     item->raw_repeat);
        break;
    case CCA_CMD_SCENE_EXEC:
        exec_scene_execute(item->device_id, item->target_id, item->level_pct, item->fade_qs);
        break;
    case CCA_CMD_DIM_CONFIG:
        exec_dim_config(item->device_id, item->target_id, item->raw_payload, item->raw_payload_len);
        break;
    case CCA_CMD_PICO_PAIR:
    case CCA_CMD_BRIDGE_PAIR:
    case CCA_CMD_VIVE_PAIR:
    case CCA_CMD_ANNOUNCE:
    case CCA_CMD_HYBRID_PAIR:
    case CCA_CMD_SUBNET_PAIR:
        /* Handled by cca_pairing module */
        cca_pairing_execute(item);
        break;
    case CCA_CMD_AUTO_PAIR:
        cca_auto_pair_start(item->device_id, item->target_id,
                            (uint16_t)((item->raw_payload[0] << 8) | item->raw_payload[1]), item->zone_byte,
                            item->duration_sec);
        break;
    case CCA_CMD_AUTO_PAIR_STOP:
        cca_auto_pair_stop();
        break;
    default:
        printf("[cca] Unknown command type: 0x%02X\r\n", item->cmd);
        break;
    }
}

uint32_t cca_cmd_tx_count(void)
{
    return cmd_tx_count;
}
