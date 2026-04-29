#ifndef CCA_COMMANDS_H
#define CCA_COMMANDS_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "cca_tdma.h"

#ifdef __cplusplus
extern "C" {
#endif

/* -----------------------------------------------------------------------
 * Command types for the CCA command queue
 * ----------------------------------------------------------------------- */
enum CcaCmdType : uint8_t {
    CCA_CMD_BUTTON = 0x01,
    CCA_CMD_BRIDGE_LEVEL = 0x02,
    CCA_CMD_PICO_LEVEL = 0x03,
    CCA_CMD_STATE_REPORT = 0x04,
    CCA_CMD_BEACON = 0x05,
    CCA_CMD_UNPAIR = 0x06,
    CCA_CMD_LED_CONFIG = 0x07,
    CCA_CMD_FADE_CONFIG = 0x08,
    CCA_CMD_TRIM_CONFIG = 0x09,
    CCA_CMD_PHASE_CONFIG = 0x0A,
    CCA_CMD_PICO_PAIR = 0x0B,
    CCA_CMD_BRIDGE_PAIR = 0x0C,
    CCA_CMD_SAVE_FAV = 0x0D,
    CCA_CMD_VIVE_LEVEL = 0x0E,
    CCA_CMD_VIVE_DIM = 0x0F,
    CCA_CMD_VIVE_PAIR = 0x10,
    CCA_CMD_BROADCAST_LEVEL = 0x11, /* Broadcast SET_LEVEL to all devices */
    CCA_CMD_IDENTIFY = 0x12,        /* QS Link device identify (flash LED) */
    CCA_CMD_QUERY = 0x13,           /* QS Link component query */
    CCA_CMD_RAW = 0x14,             /* Universal raw packet builder */
    CCA_CMD_SCENE_EXEC = 0x15,      /* Scene execute (format 0x0C) */
    CCA_CMD_DIM_CONFIG = 0x16,      /* Dimming config (format 0x13) */
    CCA_CMD_ANNOUNCE = 0x17,        /* Spoofed B0 device announce */
    CCA_CMD_HYBRID_PAIR = 0x18,     /* Hybrid Vive→RA3 pairing (B9 beacon + bridge ID config) */
    CCA_CMD_AUTO_PAIR = 0x19,       /* Non-blocking auto-pair (B9 beacon + B0 announce via TDMA) */
    CCA_CMD_AUTO_PAIR_STOP = 0x1A,  /* Stop auto-pair engine */
    CCA_CMD_SUBNET_PAIR = 0x1B,     /* Hybrid Vive beacon + RA3 subnet config */
    CCA_CMD_OTA_BEGIN_TX = 0x1C,    /* Synth-OTA BeginTransfer burst (Phase 2a subnet recon) */
    CCA_CMD_OTA_POLL_TX = 0x1D,     /* Synth-OTA Device-poll burst (safe pre-flight, no flash side effects) */
};

/* -----------------------------------------------------------------------
 * Command queue item — passed from shell/stream to CCA task
 * ----------------------------------------------------------------------- */
struct CcaCmdItem {
    uint8_t cmd;           /* CcaCmdType */
    uint32_t device_id;    /* pico/dimmer ID or bridge zone ID */
    uint32_t target_id;    /* for bridge level: target dimmer ID */
    uint8_t button;        /* for button press */
    uint8_t level_pct;     /* 0-100 for level commands */
    uint8_t fade_qs;       /* fade time in quarter-seconds */
    uint8_t led_mode;      /* 0-3 for LED config */
    uint16_t fade_on_qs;   /* fade-on time in quarter-seconds */
    uint16_t fade_off_qs;  /* fade-off time in quarter-seconds */
    uint8_t high_trim;     /* high trim % */
    uint8_t low_trim;      /* low trim % */
    uint8_t phase_byte;    /* phase config byte */
    uint8_t pico_type;     /* 0=5btn, 1=2btn, 2=4btn-rl, 3=4btn-scene */
    uint16_t duration_sec; /* pairing/beacon duration (up to 65535s) */
    uint8_t zone_byte;     /* Vive single-byte zone ID */
    uint8_t direction;     /* Vive dim direction: 0x03=raise, 0x02=lower */

    /* Raw command fields */
    uint8_t raw_format;      /* format byte (determines 24 vs 53 byte packet) */
    uint8_t raw_addr_mode;   /* QS_ADDR_COMPONENT/GROUP/BROADCAST */
    uint8_t raw_payload[40]; /* payload bytes after format byte */
    uint8_t raw_payload_len; /* actual payload length */
    uint8_t raw_repeat;      /* burst count (default 12) */
};

/* -----------------------------------------------------------------------
 * Enqueue a high-level CCA command for execution by the CCA task.
 * Thread-safe (uses FreeRTOS queue).
 * ----------------------------------------------------------------------- */
bool cca_cmd_enqueue(const CcaCmdItem* item);

/* -----------------------------------------------------------------------
 * Execute a CCA command synchronously (called from CCA task context).
 * Stops RX, builds + transmits the full packet burst with delays,
 * then restarts RX.
 * ----------------------------------------------------------------------- */
void cca_cmd_execute(const CcaCmdItem* item);

/** Initialize the command queue (called from cca_task_start) */
void cca_cmd_queue_init(void);

/** Get command queue handle for CCA task to poll */
void* cca_cmd_queue_handle(void);

/** Get total packets transmitted by command functions */
uint32_t cca_cmd_tx_count(void);

/* -----------------------------------------------------------------------
 * Job group builders — decompose commands into TDMA-scheduled phases.
 * Each returns a TdmaJobGroup ready for cca_tdma_submit_group().
 * ----------------------------------------------------------------------- */
TdmaJobGroup cca_jobs_button(uint32_t device_id, uint8_t button);
TdmaJobGroup cca_jobs_bridge_level(uint32_t zone_id, uint32_t target_id, uint8_t level_pct, uint8_t fade_qs);
TdmaJobGroup cca_jobs_beacon(uint32_t zone_id, uint8_t type_byte);
TdmaJobGroup cca_jobs_raw(const uint8_t* payload, uint8_t len, uint8_t retransmits);
TdmaJobGroup cca_jobs_pico_level(uint32_t device_id, uint8_t level_pct);
TdmaJobGroup cca_jobs_broadcast_level(uint32_t zone_id, uint8_t level_pct, uint8_t fade_qs);
TdmaJobGroup cca_jobs_scene_exec(uint32_t zone_id, uint32_t target_id, uint8_t level_pct, uint8_t fade_qs);
TdmaJobGroup cca_jobs_state_report(uint32_t device_id, uint8_t level_pct);
TdmaJobGroup cca_jobs_unpair(uint32_t zone_id, uint32_t target_id);
TdmaJobGroup cca_jobs_save_fav(uint32_t device_id);
TdmaJobGroup cca_jobs_led_config(uint32_t zone_id, uint32_t target_id, uint8_t led_mode);
TdmaJobGroup cca_jobs_fade_config(uint32_t zone_id, uint32_t target_id, uint16_t fade_on_qs, uint16_t fade_off_qs);
TdmaJobGroup cca_jobs_trim_config(uint32_t zone_id, uint32_t target_id, uint8_t high_trim, uint8_t low_trim);
TdmaJobGroup cca_jobs_phase_config(uint32_t zone_id, uint32_t target_id, uint8_t phase_byte);
TdmaJobGroup cca_jobs_dim_config(uint32_t zone_id, uint32_t target_id, const uint8_t* config_bytes, uint8_t config_len);
TdmaJobGroup cca_jobs_identify(uint32_t target_id);
TdmaJobGroup cca_jobs_query(uint32_t target_id);
TdmaJobGroup cca_jobs_vive_level(uint32_t hub_id, uint8_t zone_byte, uint8_t level_pct, uint8_t fade_qs);
TdmaJobGroup cca_jobs_vive_dim(uint32_t hub_id, uint8_t zone_byte, uint8_t direction);

/** Convert a CcaCmdItem to a TdmaJobGroup. Returns group with phase_count=0 on error. */
TdmaJobGroup cca_cmd_to_jobs(const CcaCmdItem* item);

#ifdef __cplusplus
}
#endif

#endif /* CCA_COMMANDS_H */
