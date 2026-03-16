#ifndef CCA_COMMANDS_H
#define CCA_COMMANDS_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

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
    CCA_CMD_IDENTIFY  = 0x12,  /* QS Link device identify (flash LED) */
    CCA_CMD_QUERY     = 0x13,  /* QS Link component query */
    CCA_CMD_RAW       = 0x14,  /* Universal raw packet builder */
    CCA_CMD_SCENE_EXEC = 0x15, /* Scene execute (format 0x0C) */
    CCA_CMD_DIM_CONFIG = 0x16, /* Dimming config (format 0x13) */
};

/* -----------------------------------------------------------------------
 * Command queue item — passed from shell/stream to CCA task
 * ----------------------------------------------------------------------- */
struct CcaCmdItem {
    uint8_t  cmd;          /* CcaCmdType */
    uint32_t device_id;    /* pico/dimmer ID or bridge zone ID */
    uint32_t target_id;    /* for bridge level: target dimmer ID */
    uint8_t  button;       /* for button press */
    uint8_t  level_pct;    /* 0-100 for level commands */
    uint8_t  fade_qs;      /* fade time in quarter-seconds */
    uint8_t  led_mode;     /* 0-3 for LED config */
    uint16_t fade_on_qs;   /* fade-on time in quarter-seconds */
    uint16_t fade_off_qs;  /* fade-off time in quarter-seconds */
    uint8_t  high_trim;    /* high trim % */
    uint8_t  low_trim;     /* low trim % */
    uint8_t  phase_byte;   /* phase config byte */
    uint8_t  pico_type;    /* 0=5btn, 1=2btn, 2=4btn-rl, 3=4btn-scene */
    uint8_t  duration_sec; /* pairing/beacon duration */
    uint8_t  zone_byte;    /* Vive single-byte zone ID */
    uint8_t  direction;    /* Vive dim direction: 0x03=raise, 0x02=lower */

    /* Raw command fields */
    uint8_t  raw_format;        /* format byte (determines 24 vs 53 byte packet) */
    uint8_t  raw_addr_mode;     /* QS_ADDR_COMPONENT/GROUP/BROADCAST */
    uint8_t  raw_payload[40];   /* payload bytes after format byte */
    uint8_t  raw_payload_len;   /* actual payload length */
    uint8_t  raw_repeat;        /* burst count (default 12) */
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

#ifdef __cplusplus
}
#endif

#endif /* CCA_COMMANDS_H */
