/**
 * CCA TX command library — structured packet builders for Lutron CCA.
 *
 * Each command builds a burst of packets and transmits them synchronously
 * with inter-packet delays, matching the timing of real Lutron devices.
 * Must be called from the CCA task context (uses vTaskDelay + cc1101 API).
 *
 * Byte layouts verified against ESP32 lutron-tools source:
 *   esphome/custom_components/cc1101_cca/cc1101_cca.cpp
 */

#include "cca_commands.h"
#include "cca_pairing.h"
#include "cca_crc.h"
#include "cca_encoder.h"
#include "cca_types.h"
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
#define CCA_CMD_QUEUE_LEN  4

static QueueHandle_t cmd_queue = NULL;

void cca_cmd_queue_init(void)
{
    cmd_queue = xQueueCreate(CCA_CMD_QUEUE_LEN, sizeof(CcaCmdItem));
}

void *cca_cmd_queue_handle(void)
{
    return (void *)cmd_queue;
}

bool cca_cmd_enqueue(const CcaCmdItem *item)
{
    if (cmd_queue == NULL) return false;
    return xQueueSend(cmd_queue, item, pdMS_TO_TICKS(100)) == pdTRUE;
}

/* -----------------------------------------------------------------------
 * Shared state
 * ----------------------------------------------------------------------- */
static bool type_alternate_ = false;   /* toggles A/B on each button press */
static uint32_t cmd_tx_count = 0;      /* packets transmitted by commands */

/* -----------------------------------------------------------------------
 * Transmit one CCA packet (CRC + N81 encode + radio TX).
 * Also streams the raw (pre-CRC) packet to TCP client as TX echo.
 * ----------------------------------------------------------------------- */
static bool transmit_one(const uint8_t *packet, size_t len)
{
    /* Append CRC */
    uint8_t with_crc[64 + 2];
    cca_append_crc(packet, len, with_crc);

    /* N81 encode */
    uint8_t encoded[128];
    CcaEncoder encoder;
    size_t encoded_len = encoder.encode_packet(with_crc, len + 2,
                                                encoded, sizeof(encoded));
    if (encoded_len == 0) return false;

    bool ok = cc1101_transmit_raw(encoded, encoded_len);
    if (ok) {
        cmd_tx_count++;
        stream_send_cca_packet(packet, len, 0, true);
    }
    return ok;
}

/* -----------------------------------------------------------------------
 * Button press — 6 short + 10 long packets
 * ----------------------------------------------------------------------- */
static void exec_button(uint32_t device_id, uint8_t button)
{
    uint8_t packet[24];
    uint8_t type_base = type_alternate_ ? PKT_BUTTON_SHORT_B : PKT_BUTTON_SHORT_A;
    type_alternate_ = !type_alternate_;

    bool is_dimming = (button == BTN_RAISE || button == BTN_LOWER);
    uint8_t seq = 0x00;

    printf("[cca] CMD button dev=%08X btn=%s\r\n",
           (unsigned)device_id, cca_button_name(button));

    cc1101_stop_rx();

    /* --- Phase 1: SHORT format (6 packets) --- */
    for (int rep = 0; rep < 6; rep++) {
        memset(packet, 0xCC, sizeof(packet));

        packet[0] = type_base;
        packet[1] = seq;
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;
        packet[6] = 0x21;
        packet[8] = 0x03;
        packet[9] = 0x00;
        packet[10] = button;
        packet[11] = 0x00;  /* ACTION_PRESS */

        if (is_dimming) {
            packet[7] = 0x0C;
            packet[12] = (device_id >> 24) & 0xFF;
            packet[13] = (device_id >> 16) & 0xFF;
            packet[14] = (device_id >> 8) & 0xFF;
            packet[15] = device_id & 0xFF;
            packet[16] = 0x00;
            packet[17] = 0x42;
            packet[18] = 0x00;
            packet[19] = (button == BTN_RAISE) ? 0x03 : 0x02;
        } else {
            packet[7] = 0x04;
        }

        transmit_one(packet, 22);
        seq += 6;
        vTaskDelay(pdMS_TO_TICKS(70));
    }

    /* --- Phase 2: LONG format (10 packets) --- */
    seq = 0x00;

    for (int rep = 0; rep < 10; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = type_base | 0x01;  /* long format */
        packet[1] = seq;
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;
        packet[6] = 0x21;
        packet[7] = 0x0E;
        packet[8] = 0x03;
        packet[9] = 0x00;
        packet[10] = button;
        packet[11] = 0x01;  /* ACTION_RELEASE */

        /* Second device ID instance */
        packet[12] = (device_id >> 24) & 0xFF;
        packet[13] = (device_id >> 16) & 0xFF;
        packet[14] = (device_id >> 8) & 0xFF;
        packet[15] = device_id & 0xFF;
        packet[16] = 0x00;

        if (button == BTN_RAISE) {
            packet[17] = 0x42; packet[18] = 0x02; packet[19] = 0x01;
            packet[20] = 0x00; packet[21] = 0x16;
        } else if (button == BTN_LOWER) {
            packet[17] = 0x42; packet[18] = 0x02; packet[19] = 0x00;
            packet[20] = 0x00; packet[21] = 0x43;
        } else {
            packet[17] = 0x40; packet[18] = 0x00;
            packet[19] = 0x1E + button;
            packet[20] = 0x00; packet[21] = 0x00;
        }

        transmit_one(packet, 22);
        seq += 6;
        if (rep < 9) vTaskDelay(pdMS_TO_TICKS(70));
    }

    cc1101_start_rx();
    printf("[cca] CMD button complete (%lu pkts)\r\n", (unsigned long)cmd_tx_count);
}

/* -----------------------------------------------------------------------
 * Bridge level — 20 packets, type rotates 0x81/82/83
 * ----------------------------------------------------------------------- */
static void exec_bridge_level(uint32_t zone_id, uint32_t target_id,
                               uint8_t level_pct, uint8_t fade_qs)
{
    if (level_pct > 100) level_pct = 100;

    uint16_t level_value;
    if (level_pct == 100) {
        level_value = 0xFEFF;
    } else if (level_pct == 0) {
        level_value = 0x0000;
    } else {
        level_value = (uint16_t)((uint32_t)level_pct * 65279 / 100);
    }

    printf("[cca] CMD bridge_level zone=%08X target=%08X %u%% fade=%uqs\r\n",
           (unsigned)zone_id, (unsigned)target_id, level_pct, fade_qs);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x01;

    for (int rep = 0; rep < 20; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Zone ID in little-endian */
        packet[2] = zone_id & 0xFF;
        packet[3] = (zone_id >> 8) & 0xFF;
        packet[4] = (zone_id >> 16) & 0xFF;
        packet[5] = (zone_id >> 24) & 0xFF;

        packet[6] = 0x21;
        packet[7] = 0x0E;
        packet[8] = 0x00;

        /* Target device ID in big-endian */
        packet[9]  = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = 0xFE;
        packet[14] = 0x40;
        packet[15] = 0x02;

        /* Level value (big-endian) */
        packet[16] = (level_value >> 8) & 0xFF;
        packet[17] = level_value & 0xFF;

        packet[18] = 0x00;
        packet[19] = fade_qs;
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
 * Pico level — 8 packets, simpler format
 * ----------------------------------------------------------------------- */
static void exec_pico_level(uint32_t device_id, uint8_t level_pct)
{
    if (level_pct > 100) level_pct = 100;

    uint16_t level_value;
    if (level_pct == 100) {
        level_value = 0xFEFF;
    } else {
        level_value = (uint16_t)((uint32_t)level_pct * 65279 / 100);
    }

    printf("[cca] CMD pico_level dev=%08X %u%%\r\n",
           (unsigned)device_id, level_pct);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x00;

    for (int rep = 0; rep < 8; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Device ID in little-endian */
        packet[2] = device_id & 0xFF;
        packet[3] = (device_id >> 8) & 0xFF;
        packet[4] = (device_id >> 16) & 0xFF;
        packet[5] = (device_id >> 24) & 0xFF;

        packet[6] = 0x21;
        packet[7] = 0x0E;
        packet[8] = 0x00;
        packet[9] = 0x07;
        packet[10] = 0x03;
        packet[11] = 0xC3;
        packet[12] = 0xC6;
        packet[13] = 0xFE;
        packet[14] = 0x40;
        packet[15] = 0x02;

        /* Level value (big-endian) */
        packet[16] = (level_value >> 8) & 0xFF;
        packet[17] = level_value & 0xFF;

        packet[18] = 0x00;
        packet[19] = 0x01;
        packet[20] = 0x00;
        packet[21] = 0x00;

        transmit_one(packet, 22);
        seq += 6;
        if (rep < 7) vTaskDelay(pdMS_TO_TICKS(70));
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
        level_byte = 0xFE;
    } else {
        level_byte = (uint8_t)((uint32_t)level_pct * 254 / 100);
    }

    printf("[cca] CMD state_report dev=%08X %u%%\r\n",
           (unsigned)device_id, level_pct);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x00;

    for (int rep = 0; rep < 20; rep++) {
        memset(packet, 0xCC, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Device ID in little-endian */
        packet[2] = device_id & 0xFF;
        packet[3] = (device_id >> 8) & 0xFF;
        packet[4] = (device_id >> 16) & 0xFF;
        packet[5] = (device_id >> 24) & 0xFF;

        packet[6] = 0x00;
        packet[7] = 0x08;
        packet[8] = 0x00;
        packet[9] = 0x1B;
        packet[10] = 0x01;

        /* Level byte (first instance) */
        packet[11] = level_byte;

        packet[12] = 0x00;
        packet[13] = 0x1B;
        packet[14] = 0x92;

        /* Level byte (second instance) */
        packet[15] = level_byte;

        /* [16-21] remain 0xCC from memset */

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

    printf("[cca] CMD beacon dev=%08X dur=%us\r\n",
           (unsigned)device_id, duration_sec);

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

            packet[6] = 0x21;
            packet[7] = 0x0C;  /* format byte */
            packet[8] = 0x00;

            /* Broadcast address at [9-13] */
            packet[9]  = 0xFF;
            packet[10] = 0xFF;
            packet[11] = 0xFF;
            packet[12] = 0xFF;
            packet[13] = 0xFF;

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
    printf("[cca] CMD unpair zone=%08X target=%08X\r\n",
           (unsigned)zone_id, (unsigned)target_id);

    cc1101_stop_rx();

    uint8_t packet[24];
    uint8_t seq = 0x01;

    /* Phase 1: 4x "prepare" packets (format 0x09) */
    for (int rep = 0; rep < 4; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0x81 + (rep % 3);
        packet[1] = seq;

        /* Zone ID little-endian */
        packet[2] = zone_id & 0xFF;
        packet[3] = (zone_id >> 8) & 0xFF;
        packet[4] = (zone_id >> 16) & 0xFF;
        packet[5] = (zone_id >> 24) & 0xFF;

        packet[6] = 0x21;
        packet[7] = 0x09;  /* format: prepare */
        packet[8] = 0x00;

        /* Target ID big-endian */
        packet[9]  = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = 0xFE;

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

            /* Zone ID little-endian */
            packet[2] = zone_id & 0xFF;
            packet[3] = (zone_id >> 8) & 0xFF;
            packet[4] = (zone_id >> 16) & 0xFF;
            packet[5] = (zone_id >> 24) & 0xFF;

            packet[6] = 0x21;
            packet[7] = 0x0C;  /* format: unpair */
            packet[8] = 0x00;

            /* Target ID big-endian */
            packet[9]  = (target_id >> 24) & 0xFF;
            packet[10] = (target_id >> 16) & 0xFF;
            packet[11] = (target_id >> 8) & 0xFF;
            packet[12] = target_id & 0xFF;

            packet[13] = 0xFE;

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
        case 0: led_off_state = 0x00; led_on_state = 0x00; break;
        case 1: led_off_state = 0xFF; led_on_state = 0xFF; break;
        case 2: led_off_state = 0x00; led_on_state = 0xFF; break;
        case 3: led_off_state = 0xFF; led_on_state = 0x00; break;
        default: led_off_state = 0x00; led_on_state = 0x00; break;
    }

    printf("[cca] CMD led_config zone=%08X target=%08X mode=%u\r\n",
           (unsigned)zone_id, (unsigned)target_id, led_mode);

    cc1101_stop_rx();

    uint8_t packet[53];
    uint8_t seq = 0x01;
    uint32_t active_zone = zone_id;

    for (int rep = 0; rep < 20; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0xA1 + (rep % 3);
        packet[1] = seq;

        /* Zone ID little-endian */
        packet[2] = active_zone & 0xFF;
        packet[3] = (active_zone >> 8) & 0xFF;
        packet[4] = (active_zone >> 16) & 0xFF;
        packet[5] = (active_zone >> 24) & 0xFF;

        packet[6] = 0x21;
        packet[7] = 0x11;  /* format: LED config */
        packet[8] = 0x00;

        /* Target ID big-endian */
        packet[9]  = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = 0xFE;

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
static void exec_fade_config(uint32_t zone_id, uint32_t target_id,
                              uint16_t fade_on_qs, uint16_t fade_off_qs)
{
    printf("[cca] CMD fade_config zone=%08X target=%08X on=%uqs off=%uqs\r\n",
           (unsigned)zone_id, (unsigned)target_id, fade_on_qs, fade_off_qs);

    cc1101_stop_rx();

    uint8_t packet[53];
    uint8_t seq = 0x01;
    uint32_t active_zone = zone_id;

    for (int rep = 0; rep < 20; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0xA1 + (rep % 3);
        packet[1] = seq;

        /* Zone ID little-endian */
        packet[2] = active_zone & 0xFF;
        packet[3] = (active_zone >> 8) & 0xFF;
        packet[4] = (active_zone >> 16) & 0xFF;
        packet[5] = (active_zone >> 24) & 0xFF;

        packet[6] = 0x21;
        packet[7] = 0x1C;  /* format: fade config */
        packet[8] = 0x00;

        /* Target ID big-endian */
        packet[9]  = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = 0xFE;

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
static void exec_trim_config(uint32_t zone_id, uint32_t target_id,
                              uint8_t high_trim, uint8_t low_trim)
{
    /* Convert percentage (0-100) to 0x00-0xFE scale */
    uint8_t high_val = (high_trim >= 100) ? 0xFE :
                       (uint8_t)((uint32_t)high_trim * 254 / 100);
    uint8_t low_val  = (low_trim >= 100) ? 0xFE :
                       (uint8_t)((uint32_t)low_trim * 254 / 100);

    printf("[cca] CMD trim_config zone=%08X target=%08X high=%u%% low=%u%%\r\n",
           (unsigned)zone_id, (unsigned)target_id, high_trim, low_trim);

    cc1101_stop_rx();

    uint8_t packet[53];

    /* Only 2 packets: seq 0x01 on primary zone, seq 0x02 on alt zone */
    for (int rep = 0; rep < 2; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0xA3;
        packet[1] = (uint8_t)(rep + 1);  /* seq 0x01, 0x02 */

        uint32_t active_zone = (rep == 0) ? zone_id : (zone_id + 2);

        /* Zone ID little-endian */
        packet[2] = active_zone & 0xFF;
        packet[3] = (active_zone >> 8) & 0xFF;
        packet[4] = (active_zone >> 16) & 0xFF;
        packet[5] = (active_zone >> 24) & 0xFF;

        packet[6] = 0x21;
        packet[7] = 0x15;  /* format: trim config */
        packet[8] = 0x00;

        /* Target ID big-endian */
        packet[9]  = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = 0xFE;

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
static void exec_phase_config(uint32_t zone_id, uint32_t target_id,
                               uint8_t phase_byte)
{
    printf("[cca] CMD phase_config zone=%08X target=%08X phase=0x%02X\r\n",
           (unsigned)zone_id, (unsigned)target_id, phase_byte);

    cc1101_stop_rx();

    uint8_t packet[53];

    /* Same as trim: 2 packets, primary zone then alt zone */
    for (int rep = 0; rep < 2; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = 0xA3;
        packet[1] = (uint8_t)(rep + 1);

        uint32_t active_zone = (rep == 0) ? zone_id : (zone_id + 2);

        /* Zone ID little-endian */
        packet[2] = active_zone & 0xFF;
        packet[3] = (active_zone >> 8) & 0xFF;
        packet[4] = (active_zone >> 16) & 0xFF;
        packet[5] = (active_zone >> 24) & 0xFF;

        packet[6] = 0x21;
        packet[7] = 0x15;  /* format: trim/phase config */
        packet[8] = 0x00;

        /* Target ID big-endian */
        packet[9]  = (target_id >> 24) & 0xFF;
        packet[10] = (target_id >> 16) & 0xFF;
        packet[11] = (target_id >> 8) & 0xFF;
        packet[12] = target_id & 0xFF;

        packet[13] = 0xFE;

        /* Neutral trim values */
        packet[20] = 0xFE;  /* high trim = 100% */
        packet[21] = 0x03;  /* low trim ≈ 1% */

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

static void exec_vive_level(uint32_t hub_id, uint8_t zone_byte,
                             uint8_t level_pct, uint8_t fade_qs)
{
    if (level_pct > 100) level_pct = 100;

    uint16_t level_value;
    if (level_pct == 100) {
        level_value = 0xFEFF;
    } else if (level_pct == 0) {
        level_value = 0x0000;
    } else {
        level_value = (uint16_t)((uint32_t)level_pct * 65279 / 100);
    }

    printf("[cca] CMD vive_level hub=%08X zone=0x%02X %u%% fade=%uqs\r\n",
           (unsigned)hub_id, zone_byte, level_pct, fade_qs);

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

        packet[6] = 0x21;
        packet[7] = 0x0E;  /* format: set-level */
        /* [8-11] = 0x00 */

        packet[12] = zone_byte;
        packet[13] = 0xEF;
        packet[14] = 0x40;  /* command class: level */
        packet[15] = 0x02;

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
    printf("[cca] CMD vive_dim hub=%08X zone=0x%02X dir=%s\r\n",
           (unsigned)hub_id, zone_byte,
           direction == 0x03 ? "raise" : "lower");

    cc1101_stop_rx();

    uint8_t packet[24];

    /* Phase 1: 6 hold-start packets (format 0x09) */
    for (int rep = 0; rep < 6; rep++) {
        memset(packet, 0xCC, sizeof(packet));

        packet[0] = 0x89 + (rep % 3);
        packet[1] = vive_cmd_seq_;

        /* Hub ID big-endian */
        packet[2] = (hub_id >> 24) & 0xFF;
        packet[3] = (hub_id >> 16) & 0xFF;
        packet[4] = (hub_id >> 8) & 0xFF;
        packet[5] = hub_id & 0xFF;

        packet[6] = 0x21;
        packet[7] = 0x09;  /* format: hold-start */
        packet[8] = 0x00;
        packet[9] = 0x00;
        packet[10] = 0x00;
        packet[11] = 0x00;

        packet[12] = zone_byte;
        packet[13] = 0xEF;
        packet[14] = 0x42;  /* command class: dim */
        packet[15] = 0x00;  /* hold-start */
        packet[16] = direction;
        /* [17-21] = 0xCC from memset */

        transmit_one(packet, 22);
        if (rep < 5) vTaskDelay(pdMS_TO_TICKS(15));
    }

    vive_cmd_seq_ = (vive_cmd_seq_ + 6) % 0x43;
    if (vive_cmd_seq_ == 0) vive_cmd_seq_ = 0x01;

    vTaskDelay(pdMS_TO_TICKS(50));

    /* Phase 2: 12 dim step packets (format 0x0B) */
    for (int rep = 0; rep < 12; rep++) {
        memset(packet, 0xCC, sizeof(packet));

        packet[0] = 0x89 + (rep % 3);
        packet[1] = vive_cmd_seq_;

        /* Hub ID big-endian */
        packet[2] = (hub_id >> 24) & 0xFF;
        packet[3] = (hub_id >> 16) & 0xFF;
        packet[4] = (hub_id >> 8) & 0xFF;
        packet[5] = hub_id & 0xFF;

        packet[6] = 0x21;
        packet[7] = 0x0B;  /* format: dim step */
        packet[8] = 0x00;
        packet[9] = 0x00;
        packet[10] = 0x00;
        packet[11] = 0x00;

        packet[12] = zone_byte;
        packet[13] = 0xEF;
        packet[14] = 0x42;  /* command class: dim */
        packet[15] = 0x02;  /* step */
        packet[16] = direction;
        packet[17] = 0x00;
        packet[18] = 0x00;
        /* [19-21] = 0xCC from memset */

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
    uint8_t type_base = type_alternate_ ? PKT_BUTTON_SHORT_B : PKT_BUTTON_SHORT_A;
    type_alternate_ = !type_alternate_;

    uint8_t seq = 0x00;

    printf("[cca] CMD save_fav dev=%08X\r\n", (unsigned)device_id);

    cc1101_stop_rx();

    /* --- Phase 1: SHORT format (6 packets) --- */
    for (int rep = 0; rep < 6; rep++) {
        memset(packet, 0xCC, sizeof(packet));

        packet[0] = type_base;
        packet[1] = seq;
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;
        packet[6] = 0x21;
        packet[7] = 0x04;  /* short format */
        packet[8] = 0x03;
        packet[9] = 0x00;
        packet[10] = BTN_FAVORITE;
        packet[11] = 0x03;  /* ACTION_SAVE */

        transmit_one(packet, 22);
        seq += 6;
        vTaskDelay(pdMS_TO_TICKS(70));
    }

    /* --- Phase 2: LONG format (10 packets) --- */
    seq = 0x00;

    for (int rep = 0; rep < 10; rep++) {
        memset(packet, 0x00, sizeof(packet));

        packet[0] = type_base | 0x01;  /* long format */
        packet[1] = seq;
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;
        packet[6] = 0x21;
        packet[7] = 0x0E;
        packet[8] = 0x03;
        packet[9] = 0x00;
        packet[10] = BTN_FAVORITE;
        packet[11] = 0x03;  /* ACTION_SAVE */

        /* Second device ID instance */
        packet[12] = (device_id >> 24) & 0xFF;
        packet[13] = (device_id >> 16) & 0xFF;
        packet[14] = (device_id >> 8) & 0xFF;
        packet[15] = device_id & 0xFF;
        packet[16] = 0x00;
        packet[17] = 0x40; packet[18] = 0x00;
        packet[19] = 0x1E + BTN_FAVORITE;
        packet[20] = 0x00; packet[21] = 0x00;

        transmit_one(packet, 22);
        seq += 6;
        if (rep < 9) vTaskDelay(pdMS_TO_TICKS(70));
    }

    cc1101_start_rx();
    printf("[cca] CMD save_fav complete (%lu pkts)\r\n", (unsigned long)cmd_tx_count);
}

/* -----------------------------------------------------------------------
 * Command dispatcher — called from CCA task context
 * ----------------------------------------------------------------------- */
void cca_cmd_execute(const CcaCmdItem *item)
{
    switch (item->cmd) {
        case CCA_CMD_BUTTON:
            exec_button(item->device_id, item->button);
            break;
        case CCA_CMD_BRIDGE_LEVEL:
            exec_bridge_level(item->device_id, item->target_id,
                              item->level_pct, item->fade_qs);
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
            exec_fade_config(item->device_id, item->target_id,
                             item->fade_on_qs, item->fade_off_qs);
            break;
        case CCA_CMD_TRIM_CONFIG:
            exec_trim_config(item->device_id, item->target_id,
                             item->high_trim, item->low_trim);
            break;
        case CCA_CMD_PHASE_CONFIG:
            exec_phase_config(item->device_id, item->target_id,
                              item->phase_byte);
            break;
        case CCA_CMD_SAVE_FAV:
            exec_save_fav(item->device_id);
            break;
        case CCA_CMD_VIVE_LEVEL:
            exec_vive_level(item->device_id, item->zone_byte,
                            item->level_pct, item->fade_qs);
            break;
        case CCA_CMD_VIVE_DIM:
            exec_vive_dim(item->device_id, item->zone_byte,
                          item->direction);
            break;
        case CCA_CMD_PICO_PAIR:
        case CCA_CMD_BRIDGE_PAIR:
        case CCA_CMD_VIVE_PAIR:
            /* Handled by cca_pairing module */
            cca_pairing_execute(item);
            break;
        default:
            printf("[cca] Unknown command type: 0x%02X\r\n", item->cmd);
            break;
    }
}

uint32_t cca_cmd_tx_count(void) { return cmd_tx_count; }
