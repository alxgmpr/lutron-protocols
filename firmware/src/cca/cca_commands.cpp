/**
 * CCA TX command library — non-blocking job builders for Lutron CCA.
 *
 * Each cca_jobs_*() builder returns a TdmaJobGroup (1-2 phases) that the
 * TDMA scheduler transmits in correct timing slots. cca_cmd_to_jobs()
 * routes all 19 operational commands to their builders.
 *
 * cca_cmd_execute() handles only pairing commands which still require
 * blocking TX (multi-step handshakes with variable-length responses).
 *
 * Byte layouts verified against ESP32 lutron-tools source and ESN-QS
 * firmware (QS Link protocol, 2009). Field names from cca_protocol.h.
 */

#include "cca_commands.h"
#include "cca_pairing.h"
#include "cca_auto_pair.h"
#include "cca_protocol.h"
#include "cca_types.h"
#include "cca_tdma.h"
#include "cca_tx_builder.h"

#include "FreeRTOS.h"
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
static uint32_t cmd_tx_count = 0; /* packets transmitted by commands */

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
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
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
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 0;
    g.phases[0].tx_count = CCA_TX_COUNT_BURST;
    g.phases[0].post_delay_ms = 0;

    /* Phase 1: RELEASE (long format) */
    cca_build_button_long(g.phases[1].packet.data, device_id, button, release_type);
    g.phases[1].packet.len = 22;
    g.phases[1].packet.type_base = 0x81;
    g.phases[1].packet.type_rotate = 0;
    g.phases[1].tx_count = CCA_TX_COUNT_NORMAL;
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
    g.phases[0].tx_count = CCA_TX_COUNT_BEACON;
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
    g.phases[0].tx_count = retransmits > 0 ? retransmits : CCA_TX_COUNT_NORMAL;
    g.phases[0].post_delay_ms = 0;

    return g;
}

TdmaJobGroup cca_jobs_pico_level(uint32_t device_id, uint8_t level_pct)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_pico_level(g.phases[0].packet.data, device_id, level16);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB pico_level dev=%08X %u%%\r\n", (unsigned)device_id, level_pct);
    return g;
}

TdmaJobGroup cca_jobs_broadcast_level(uint32_t zone_id, uint8_t level_pct, uint8_t fade_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_set_level(g.phases[0].packet.data, zone_id, 0xFFFFFFFF, QS_ADDR_BROADCAST, level16, fade_qs, 0x81);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB broadcast_level zone=%08X %u%% fade=%uqs\r\n", (unsigned)zone_id, level_pct, fade_qs);
    return g;
}

TdmaJobGroup cca_jobs_scene_exec(uint32_t zone_id, uint32_t target_id, uint8_t level_pct, uint8_t fade_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_scene_exec(g.phases[0].packet.data, zone_id, target_id, level16, fade_qs);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB scene zone=%08X target=%08X %u%% fade=%uqs\r\n", (unsigned)zone_id, (unsigned)target_id,
           level_pct, fade_qs);
    return g;
}

TdmaJobGroup cca_jobs_state_report(uint32_t device_id, uint8_t level_pct)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    uint8_t level_byte;
    if (level_pct >= 100)
        level_byte = QS_LEVEL_MAX_8;
    else
        level_byte = (uint8_t)((uint32_t)level_pct * 254 / 100);
    cca_build_state_report(g.phases[0].packet.data, device_id, level_byte);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB state_report dev=%08X %u%%\r\n", (unsigned)device_id, level_pct);
    return g;
}

TdmaJobGroup cca_jobs_unpair(uint32_t zone_id, uint32_t target_id)
{
    TdmaJobGroup g = {};

    /* Phase 0: prepare (format 0x09) */
    cca_build_unpair_prepare(g.phases[0].packet.data, zone_id, target_id);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_BURST;
    g.phases[0].post_delay_ms = 800;

    /* Phase 1: unpair beacon (format 0x0C) */
    cca_build_unpair_beacon(g.phases[1].packet.data, zone_id, target_id);
    g.phases[1].packet.len = 22;
    g.phases[1].packet.type_base = 0x81;
    g.phases[1].packet.type_rotate = 1;
    g.phases[1].tx_count = CCA_TX_COUNT_NORMAL;
    g.phases[1].post_delay_ms = 0;

    g.phase_count = 2;
    printf("[cca] JOB unpair zone=%08X target=%08X\r\n", (unsigned)zone_id, (unsigned)target_id);
    return g;
}

TdmaJobGroup cca_jobs_save_fav(uint32_t device_id)
{
    TdmaJobGroup g = {};

    /* A/B alternation (shared with button) */
    static bool alt = false;
    uint8_t short_type = alt ? PKT_BTN_SHORT_B : PKT_BTN_SHORT_A;
    uint8_t long_type = alt ? PKT_BTN_LONG_B : PKT_BTN_LONG_A;
    alt = !alt;

    /* Phase 0: SHORT format save press */
    cca_build_button_short(g.phases[0].packet.data, device_id, BTN_FAVORITE, ACTION_SAVE, QS_FMT_TAP, short_type);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_rotate = 0;
    g.phases[0].tx_count = CCA_TX_COUNT_BURST;
    g.phases[0].post_delay_ms = 0;

    /* Phase 1: LONG format save release */
    cca_build_button_long(g.phases[1].packet.data, device_id, BTN_FAVORITE, long_type);
    g.phases[1].packet.data[11] = ACTION_SAVE; /* override RELEASE→SAVE */
    g.phases[1].packet.len = 22;
    g.phases[1].packet.type_rotate = 0;
    g.phases[1].tx_count = CCA_TX_COUNT_NORMAL;
    g.phases[1].post_delay_ms = 0;

    g.phase_count = 2;
    printf("[cca] JOB save_fav dev=%08X\r\n", (unsigned)device_id);
    return g;
}

TdmaJobGroup cca_jobs_led_config(uint32_t zone_id, uint32_t target_id, uint8_t led_mode)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    cca_build_led_config(g.phases[0].packet.data, zone_id, target_id, led_mode);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB led_config zone=%08X target=%08X mode=%u\r\n", (unsigned)zone_id, (unsigned)target_id, led_mode);
    return g;
}

TdmaJobGroup cca_jobs_fade_config(uint32_t zone_id, uint32_t target_id, uint16_t fade_on_qs, uint16_t fade_off_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    cca_build_fade_config(g.phases[0].packet.data, zone_id, target_id, fade_on_qs, fade_off_qs);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB fade_config zone=%08X target=%08X on=%uqs off=%uqs\r\n", (unsigned)zone_id, (unsigned)target_id,
           fade_on_qs, fade_off_qs);
    return g;
}

TdmaJobGroup cca_jobs_trim_config(uint32_t zone_id, uint32_t target_id, uint8_t high_trim, uint8_t low_trim)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    cca_build_trim_config(g.phases[0].packet.data, zone_id, target_id, high_trim, low_trim);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB trim_config zone=%08X target=%08X high=%u%% low=%u%%\r\n", (unsigned)zone_id, (unsigned)target_id,
           high_trim, low_trim);
    return g;
}

TdmaJobGroup cca_jobs_phase_config(uint32_t zone_id, uint32_t target_id, uint8_t phase_byte)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    cca_build_phase_config(g.phases[0].packet.data, zone_id, target_id, phase_byte);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB phase_config zone=%08X target=%08X phase=0x%02X\r\n", (unsigned)zone_id, (unsigned)target_id,
           phase_byte);
    return g;
}

TdmaJobGroup cca_jobs_dim_config(uint32_t zone_id, uint32_t target_id, const uint8_t* config_bytes, uint8_t config_len)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    cca_build_dim_config(g.phases[0].packet.data, zone_id, target_id, config_bytes, config_len);
    g.phases[0].packet.len = 51;
    g.phases[0].packet.type_base = 0xA1;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB dim_config zone=%08X target=%08X\r\n", (unsigned)zone_id, (unsigned)target_id);
    return g;
}

TdmaJobGroup cca_jobs_identify(uint32_t target_id)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    cca_build_identify(g.phases[0].packet.data, target_id);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB identify target=%08X\r\n", (unsigned)target_id);
    return g;
}

TdmaJobGroup cca_jobs_query(uint32_t target_id)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    cca_build_query(g.phases[0].packet.data, target_id);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x81;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB query target=%08X\r\n", (unsigned)target_id);
    return g;
}

TdmaJobGroup cca_jobs_vive_level(uint32_t hub_id, uint8_t zone_byte, uint8_t level_pct, uint8_t fade_qs)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    uint16_t level16 = cca_percent_to_level16(level_pct);
    cca_build_vive_level(g.phases[0].packet.data, hub_id, zone_byte, level16, fade_qs);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x89;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_NORMAL;
    printf("[cca] JOB vive_level hub=%08X zone=0x%02X %u%% fade=%uqs\r\n", (unsigned)hub_id, zone_byte, level_pct,
           fade_qs);
    return g;
}

TdmaJobGroup cca_jobs_vive_dim(uint32_t hub_id, uint8_t zone_byte, uint8_t direction)
{
    TdmaJobGroup g = {};

    /* Phase 0: hold-start (short burst) */
    cca_build_vive_dim_start(g.phases[0].packet.data, hub_id, zone_byte, direction);
    g.phases[0].packet.len = 22;
    g.phases[0].packet.type_base = 0x89;
    g.phases[0].packet.type_rotate = 1;
    g.phases[0].tx_count = CCA_TX_COUNT_BURST;
    g.phases[0].post_delay_ms = 50;

    /* Phase 1: dim-step (full burst) */
    cca_build_vive_dim_stop(g.phases[1].packet.data, hub_id, zone_byte, direction);
    g.phases[1].packet.len = 22;
    g.phases[1].packet.type_base = 0x89;
    g.phases[1].packet.type_rotate = 1;
    g.phases[1].tx_count = CCA_TX_COUNT_NORMAL;
    g.phases[1].post_delay_ms = 0;

    g.phase_count = 2;
    printf("[cca] JOB vive_dim hub=%08X zone=0x%02X dir=%s\r\n", (unsigned)hub_id, zone_byte,
           direction == 0x03 ? "raise" : "lower");
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
    case CCA_CMD_PICO_LEVEL:
        return cca_jobs_pico_level(item->device_id, item->level_pct);
    case CCA_CMD_STATE_REPORT:
        return cca_jobs_state_report(item->device_id, item->level_pct);
    case CCA_CMD_BEACON:
        return cca_jobs_beacon(item->device_id, 0x91);
    case CCA_CMD_UNPAIR:
        return cca_jobs_unpair(item->device_id, item->target_id);
    case CCA_CMD_LED_CONFIG:
        return cca_jobs_led_config(item->device_id, item->target_id, item->led_mode);
    case CCA_CMD_FADE_CONFIG:
        return cca_jobs_fade_config(item->device_id, item->target_id, item->fade_on_qs, item->fade_off_qs);
    case CCA_CMD_TRIM_CONFIG:
        return cca_jobs_trim_config(item->device_id, item->target_id, item->high_trim, item->low_trim);
    case CCA_CMD_PHASE_CONFIG:
        return cca_jobs_phase_config(item->device_id, item->target_id, item->phase_byte);
    case CCA_CMD_SAVE_FAV:
        return cca_jobs_save_fav(item->device_id);
    case CCA_CMD_VIVE_LEVEL:
        return cca_jobs_vive_level(item->device_id, item->zone_byte, item->level_pct, item->fade_qs);
    case CCA_CMD_VIVE_DIM:
        return cca_jobs_vive_dim(item->device_id, item->zone_byte, item->direction);
    case CCA_CMD_BROADCAST_LEVEL:
        return cca_jobs_broadcast_level(item->device_id, item->level_pct, item->fade_qs);
    case CCA_CMD_IDENTIFY:
        return cca_jobs_identify(item->target_id);
    case CCA_CMD_QUERY:
        return cca_jobs_query(item->target_id);
    case CCA_CMD_SCENE_EXEC:
        return cca_jobs_scene_exec(item->device_id, item->target_id, item->level_pct, item->fade_qs);
    case CCA_CMD_DIM_CONFIG:
        return cca_jobs_dim_config(item->device_id, item->target_id, item->raw_payload, item->raw_payload_len);
    case CCA_CMD_RAW:
        return cca_jobs_raw(item->raw_payload, item->raw_payload_len, item->raw_repeat);
    default:
        printf("[cca] JOB: unsupported cmd 0x%02X, falling back to blocking\r\n", item->cmd);
        return empty;
    }
}

/* -----------------------------------------------------------------------
 * Command dispatcher — called from CCA task context (pairing only)
 * ----------------------------------------------------------------------- */
void cca_cmd_execute(const CcaCmdItem* item)
{
    switch (item->cmd) {
    case CCA_CMD_PICO_PAIR:
    case CCA_CMD_BRIDGE_PAIR:
    case CCA_CMD_VIVE_PAIR:
    case CCA_CMD_ANNOUNCE:
    case CCA_CMD_HYBRID_PAIR:
    case CCA_CMD_SUBNET_PAIR:
    case CCA_CMD_OTA_BEGIN_TX:
    case CCA_CMD_OTA_POLL_TX:
    case CCA_CMD_OTA_FULL_TX:
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
