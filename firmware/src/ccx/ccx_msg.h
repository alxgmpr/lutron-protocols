#ifndef CCX_MSG_H
#define CCX_MSG_H

/**
 * CCX message types + encode/decode wrappers.
 *
 * Matches the TypeScript reference: ccx/constants.ts, ccx/encoder.ts, ccx/decoder.ts.
 * All messages are CBOR arrays: [msg_type, body_map].
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* -----------------------------------------------------------------------
 * Message type IDs (from constants.ts)
 * ----------------------------------------------------------------------- */
#define CCX_MSG_LEVEL_CONTROL   0
#define CCX_MSG_BUTTON_PRESS    1
#define CCX_MSG_DIM_HOLD        2
#define CCX_MSG_DIM_STEP        3
#define CCX_MSG_ACK             7
#define CCX_MSG_DEVICE_REPORT   27   /* 0x1B */
#define CCX_MSG_SCENE_RECALL    36   /* 0x24 */
#define CCX_MSG_COMPONENT_CMD   40   /* 0x28 */
#define CCX_MSG_STATUS          41   /* 0x29 */
#define CCX_MSG_PRESENCE        0xFFFF

/* Body map keys */
#define CCX_KEY_COMMAND   0
#define CCX_KEY_ZONE      1
#define CCX_KEY_DEVICE    2
#define CCX_KEY_EXTRA     3
#define CCX_KEY_STATUS    4
#define CCX_KEY_SEQUENCE  5

/* Level constants */
#define CCX_LEVEL_FULL_ON  0xFEFF
#define CCX_LEVEL_OFF      0x0000

/* UDP port */
#define CCX_UDP_PORT  9190

/* Default zone type for dimmers */
#define CCX_ZONE_TYPE_DIMMER  16

/* -----------------------------------------------------------------------
 * Encoder — build CBOR into buffer, return length (0 on error)
 * ----------------------------------------------------------------------- */

/**
 * Encode a LEVEL_CONTROL message.
 * Structure: [0, { 0: {0: level, 3: fade}, 1: [zone_type, zone_id], 5: seq }]
 * fade: quarter-seconds (1=instant, 4=1s)
 */
size_t ccx_encode_level_control(uint8_t *buf, size_t buf_size,
                                 uint16_t zone_id, uint16_t level,
                                 uint8_t fade, uint8_t sequence);

/**
 * Encode a SCENE_RECALL message.
 * Structure: [36, { 0: {0: [4]}, 1: [0], 3: {0: scene_id}, 5: seq }]
 */
size_t ccx_encode_scene_recall(uint8_t *buf, size_t buf_size,
                                uint16_t scene_id, uint8_t sequence);

/** Convert percentage (0-100) to Lutron level (0x0000-0xFEFF) */
uint16_t ccx_percent_to_level(uint8_t percent);

/* -----------------------------------------------------------------------
 * Decoder — parse received CBOR into a struct
 * ----------------------------------------------------------------------- */

typedef struct {
    uint16_t msg_type;
    uint8_t  sequence;

    /* LEVEL_CONTROL (type 0) */
    uint16_t level;
    uint16_t zone_id;
    uint8_t  zone_type;
    uint8_t  fade;          /* quarter-seconds (1=instant, 4=1s) */
    uint8_t  delay;         /* quarter-seconds */

    /* BUTTON_PRESS / DIM_HOLD / DIM_STEP (types 1/2/3) */
    uint8_t  device_id[4];
    uint8_t  action;        /* DIM action (3=raise/lower) */
    uint16_t step_value;    /* DIM_STEP step size (180-250) */

    /* ACK (type 7) */
    uint8_t  response[4];   /* response bytes */
    uint8_t  response_len;  /* actual length (typically 1) */

    /* DEVICE_REPORT (type 27) */
    uint32_t device_serial;
    uint16_t group_id;      /* from EXTRA key 1 (shared w/ SCENE_RECALL) */

    /* SCENE_RECALL (type 36) / COMPONENT_CMD (type 40) */
    uint16_t scene_id;
    uint16_t component_type;  /* EXTRA key 2, element [0] */
    uint16_t component_value; /* EXTRA key 2, element [1] */

    /* PRESENCE (type 65535) */
    uint8_t  status_value;  /* body key 4 */
} ccx_decoded_msg_t;

/**
 * Decode a CBOR-encoded CCX message.
 * Returns true on success. Fills out with parsed fields.
 */
bool ccx_decode_message(const uint8_t *cbor, size_t len, ccx_decoded_msg_t *out);

/** Get human-readable name for a message type */
const char *ccx_msg_type_name(uint16_t msg_type);

#ifdef __cplusplus
}
#endif

#endif /* CCX_MSG_H */
