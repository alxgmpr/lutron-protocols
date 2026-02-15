#ifndef CCX_TASK_H
#define CCX_TASK_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Start the CCX FreeRTOS task (Thread NCP via nRF52840) */
void ccx_task_start(void);

/** Check if CCX task is running */
bool ccx_is_running(void);

/** Check if Thread network is joined (role != DETACHED) */
bool ccx_thread_joined(void);

/** Get Thread role string ("DETACHED", "CHILD", "ROUTER", "LEADER") */
const char *ccx_thread_role_str(void);

/** Get Thread role as numeric ID (0=detached, 1=child, 2=router, 3=leader) */
uint8_t ccx_thread_role_id(void);

/** Send a LEVEL_CONTROL command to a zone. fade: quarter-seconds (1=instant). */
bool ccx_send_level(uint16_t zone_id, uint16_t level, uint8_t fade, uint8_t sequence);

/** Send ON command (level=0xFEFF) */
bool ccx_send_on(uint16_t zone_id, uint8_t sequence);

/** Send OFF command (level=0x0000) */
bool ccx_send_off(uint16_t zone_id, uint8_t sequence);

/** Send a SCENE_RECALL command */
bool ccx_send_scene(uint16_t scene_id, uint8_t sequence);

/** Get RX/TX packet counters */
uint32_t ccx_rx_count(void);
uint32_t ccx_tx_count(void);

/** Control high-volume CCX RX UART logging (shell/VCP). */
void ccx_set_rx_log_enabled(bool enabled);
bool ccx_rx_log_enabled(void);

/**
 * Request nRF52840 DFU: sends Spinel RESET with GPREGRET magic,
 * then streams firmware image over UART using MCUboot SMP protocol.
 *
 * This is non-blocking — kicks off the DFU state machine.
 * Progress is reported via stream_send_ccx_packet().
 *
 * @param image_size  Total firmware image size in bytes
 * @return true if DFU started, false if already in progress or NCP not ready
 */
bool ccx_dfu_start(uint32_t image_size);

/** Feed the next chunk of firmware data (called from stream task as TCP data arrives) */
bool ccx_dfu_write_chunk(const uint8_t *data, size_t len);

/* -----------------------------------------------------------------------
 * Shell → CCX Spinel command passthrough
 * ----------------------------------------------------------------------- */
typedef enum {
    CCX_SPINEL_PROP_GET,
    CCX_SPINEL_PROP_SET,
    CCX_SPINEL_PROP_INSERT,
    CCX_SPINEL_RESET,
    CCX_SPINEL_RAW,
} ccx_spinel_cmd_type_t;

typedef struct {
    ccx_spinel_cmd_type_t cmd_type;
    uint8_t  prop_id;
    uint8_t  value[128];
    size_t   value_len;
} ccx_spinel_request_t;

typedef struct {
    bool     success;
    uint8_t  data[256];
    size_t   data_len;
} ccx_spinel_response_t;

/**
 * Send a Spinel command via the CCX task and wait for the response.
 * Called from the shell task; blocks until the CCX task processes it.
 * @return true if response received within timeout
 */
bool ccx_spinel_command(const ccx_spinel_request_t *req,
                        ccx_spinel_response_t *resp,
                        uint32_t timeout_ms);

/** Check DFU state */
typedef enum {
    CCX_DFU_IDLE = 0,
    CCX_DFU_ENTERING_BOOTLOADER,
    CCX_DFU_UPLOADING,
    CCX_DFU_VALIDATING,
    CCX_DFU_COMPLETE,
    CCX_DFU_ERROR
} ccx_dfu_state_t;

ccx_dfu_state_t ccx_dfu_get_state(void);

#ifdef __cplusplus
}
#endif

#endif /* CCX_TASK_H */
