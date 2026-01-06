/**
 * Auto-generated from protocol/cca.yaml
 * DO NOT EDIT - regenerate with: cca codegen
 *
 * Lutron Clear Connect Type A v1.0.0
 */

#ifndef CCA_PROTOCOL_H
#define CCA_PROTOCOL_H

#include <stdint.h>
#include <stdbool.h>

/* RF physical layer constants */
#define CCA_FREQUENCY_HZ      433602844
#define CCA_DEVIATION_HZ      41200
#define CCA_BAUD_RATE         62484.7f

/* CRC configuration */
#define CCA_CRC_POLYNOMIAL    0xCA0F
#define CCA_CRC_WIDTH         16
#define CCA_CRC_INITIAL       0x0000

/* Packet framing */
#define CCA_PREAMBLE_BITS     32
#define CCA_PREAMBLE_PATTERN  0xAAAAAAAA
#define CCA_SYNC_BYTE         0xFF
#define CCA_TRAILING_BITS     16
#define CCA_PREFIX_LEN        2
static const uint8_t CCA_PREFIX[] = {0xFA, 0xDE};

/* Timing constants (milliseconds) */
#define CCA_BUTTON_REPEAT_MS     70
#define CCA_BEACON_INTERVAL_MS   65
#define CCA_PAIRING_INTERVAL_MS  75
#define CCA_LEVEL_REPORT_MS      60
#define CCA_UNPAIR_INTERVAL_MS   60
#define CCA_LED_CONFIG_INTERVAL_MS 75

/* Sequence number behavior */
#define CCA_SEQUENCE_INCREMENT   6
#define CCA_SEQUENCE_WRAP        0x48

/* Packet lengths */
#define CCA_LENGTH_STANDARD      24
#define CCA_LENGTH_PAIRING       53

/* Button action codes */
#define CCA_ACTION_HOLD         0x02  /* Continuous hold for dimming */
#define CCA_ACTION_PRESS        0x00
#define CCA_ACTION_RELEASE      0x01
#define CCA_ACTION_SAVE         0x03  /* Save favorite/scene */

/* Button code values */
#define CCA_BUTTON_FAVORITE     0x03  /* 5-button FAV / middle */
#define CCA_BUTTON_LOWER        0x06  /* 5-button LOWER */
#define CCA_BUTTON_OFF          0x04  /* 5-button OFF / bottom */
#define CCA_BUTTON_ON           0x02  /* 5-button ON / top */
#define CCA_BUTTON_RAISE        0x05  /* 5-button RAISE */
#define CCA_BUTTON_RESET        0xFF  /* Reset/unpair */
#define CCA_BUTTON_SCENE1       0x0B  /* 4-button top */
#define CCA_BUTTON_SCENE2       0x0A  /* 4-button second */
#define CCA_BUTTON_SCENE3       0x09  /* 4-button third */
#define CCA_BUTTON_SCENE4       0x08  /* 4-button bottom */

/* Packet categories for filtering */

/* Device class codes (byte 28 in pairing) */
#define CCA_DEVICE_CLASS_DIMMER       0x04
#define CCA_DEVICE_CLASS_FAN          0x06
#define CCA_DEVICE_CLASS_KEYPAD       0x0B
#define CCA_DEVICE_CLASS_SHADE        0x0A
#define CCA_DEVICE_CLASS_SWITCH       0x05

/* Packet type codes */
#define CCA_PKT_BEACON               0x91  /* Pairing beacon */
#define CCA_PKT_BEACON_92            0x92  /* Beacon stop */
#define CCA_PKT_BEACON_93            0x93  /* Beacon variant */
#define CCA_PKT_BTN_LONG_A           0x89  /* Button press, long format, group A */
#define CCA_PKT_BTN_LONG_B           0x8B  /* Button press, long format, group B */
#define CCA_PKT_BTN_SHORT_A          0x88  /* Button press, short format, group A */
#define CCA_PKT_BTN_SHORT_B          0x8A  /* Button press, short format, group B */
#define CCA_PKT_LED_CONFIG           0xF2  /* LED configuration (derived from STATE_RPT format 0x0A) */
#define CCA_PKT_PAIR_B0              0xB0  /* Device announcement */
#define CCA_PKT_PAIR_B8              0xB8  /* Scene Pico pairing (bridge-only) */
#define CCA_PKT_PAIR_B9              0xB9  /* Direct-pair Pico pairing */
#define CCA_PKT_PAIR_BA              0xBA  /* Scene Pico pairing variant */
#define CCA_PKT_PAIR_BB              0xBB  /* Direct-pair Pico pairing variant */
#define CCA_PKT_PAIR_RESP_C0         0xC0  /* Pairing response */
#define CCA_PKT_PAIR_RESP_C1         0xC1  /* Pairing response phase 1 */
#define CCA_PKT_PAIR_RESP_C2         0xC2  /* Pairing response phase 2 */
#define CCA_PKT_PAIR_RESP_C8         0xC8  /* Pairing acknowledgment */
#define CCA_PKT_SET_LEVEL            0xA2  /* Set level command */
#define CCA_PKT_STATE_RPT_81         0x81  /* State report (type 81) */
#define CCA_PKT_STATE_RPT_82         0x82  /* State report (type 82) */
#define CCA_PKT_STATE_RPT_83         0x83  /* State report (type 83) */
#define CCA_PKT_UNPAIR               0xF0  /* Unpair command (derived from STATE_RPT format 0x0C) */
#define CCA_PKT_UNPAIR_PREP          0xF1  /* Unpair preparation (derived from STATE_RPT format 0x09) */

/* Packet type lengths */
#define CCA_PKT_BEACON_LEN           24
#define CCA_PKT_BEACON_92_LEN        24
#define CCA_PKT_BEACON_93_LEN        24
#define CCA_PKT_BTN_LONG_A_LEN       24
#define CCA_PKT_BTN_LONG_B_LEN       24
#define CCA_PKT_BTN_SHORT_A_LEN      24
#define CCA_PKT_BTN_SHORT_B_LEN      24
#define CCA_PKT_LED_CONFIG_LEN       24
#define CCA_PKT_PAIR_B0_LEN          53
#define CCA_PKT_PAIR_B8_LEN          53
#define CCA_PKT_PAIR_B9_LEN          53
#define CCA_PKT_PAIR_BA_LEN          53
#define CCA_PKT_PAIR_BB_LEN          53
#define CCA_PKT_PAIR_RESP_C0_LEN     24
#define CCA_PKT_PAIR_RESP_C1_LEN     24
#define CCA_PKT_PAIR_RESP_C2_LEN     24
#define CCA_PKT_PAIR_RESP_C8_LEN     24
#define CCA_PKT_SET_LEVEL_LEN        24
#define CCA_PKT_STATE_RPT_81_LEN     24
#define CCA_PKT_STATE_RPT_82_LEN     24
#define CCA_PKT_STATE_RPT_83_LEN     24
#define CCA_PKT_UNPAIR_LEN           24
#define CCA_PKT_UNPAIR_PREP_LEN      24

/* Helper macros */
#define CCA_IS_BEACON_PKT(t) ( \
    (t) == CCA_PKT_BEACON || \
    (t) == CCA_PKT_BEACON_92 || \
    (t) == CCA_PKT_BEACON_93 \
)

#define CCA_IS_BUTTON_PKT(t) ( \
    (t) == CCA_PKT_BTN_LONG_A || \
    (t) == CCA_PKT_BTN_LONG_B || \
    (t) == CCA_PKT_BTN_SHORT_A || \
    (t) == CCA_PKT_BTN_SHORT_B \
)

#define CCA_IS_CONFIG_PKT(t) ( \
    (t) == CCA_PKT_LED_CONFIG || \
    (t) == CCA_PKT_SET_LEVEL || \
    (t) == CCA_PKT_UNPAIR || \
    (t) == CCA_PKT_UNPAIR_PREP \
)

#define CCA_IS_HANDSHAKE_PKT(t) ( \
    (t) == CCA_PKT_PAIR_RESP_C0 || \
    (t) == CCA_PKT_PAIR_RESP_C1 || \
    (t) == CCA_PKT_PAIR_RESP_C2 || \
    (t) == CCA_PKT_PAIR_RESP_C8 \
)

#define CCA_IS_PAIRING_PKT(t) ( \
    (t) == CCA_PKT_PAIR_B0 || \
    (t) == CCA_PKT_PAIR_B8 || \
    (t) == CCA_PKT_PAIR_B9 || \
    (t) == CCA_PKT_PAIR_BA || \
    (t) == CCA_PKT_PAIR_BB \
)

#define CCA_IS_STATE_PKT(t) ( \
    (t) == CCA_PKT_STATE_RPT_81 || \
    (t) == CCA_PKT_STATE_RPT_82 || \
    (t) == CCA_PKT_STATE_RPT_83 \
)

#define CCA_PKT_USES_BE_DEVICE_ID(t) ( \
    (t) == CCA_PKT_BEACON || \
    (t) == CCA_PKT_BEACON_92 || \
    (t) == CCA_PKT_BEACON_93 || \
    (t) == CCA_PKT_BTN_LONG_A || \
    (t) == CCA_PKT_BTN_LONG_B || \
    (t) == CCA_PKT_BTN_SHORT_A || \
    (t) == CCA_PKT_BTN_SHORT_B || \
    (t) == CCA_PKT_PAIR_B0 || \
    (t) == CCA_PKT_PAIR_B8 || \
    (t) == CCA_PKT_PAIR_B9 || \
    (t) == CCA_PKT_PAIR_BA || \
    (t) == CCA_PKT_PAIR_BB || \
    (t) == CCA_PKT_PAIR_RESP_C0 || \
    (t) == CCA_PKT_PAIR_RESP_C1 || \
    (t) == CCA_PKT_PAIR_RESP_C2 || \
    (t) == CCA_PKT_PAIR_RESP_C8 \
)

static inline uint8_t cca_packet_length(uint8_t type) {
    switch (type) {
        case CCA_PKT_BEACON: return 24;
        case CCA_PKT_BEACON_92: return 24;
        case CCA_PKT_BEACON_93: return 24;
        case CCA_PKT_BTN_LONG_A: return 24;
        case CCA_PKT_BTN_LONG_B: return 24;
        case CCA_PKT_BTN_SHORT_A: return 24;
        case CCA_PKT_BTN_SHORT_B: return 24;
        case CCA_PKT_LED_CONFIG: return 24;
        case CCA_PKT_PAIR_B0: return 53;
        case CCA_PKT_PAIR_B8: return 53;
        case CCA_PKT_PAIR_B9: return 53;
        case CCA_PKT_PAIR_BA: return 53;
        case CCA_PKT_PAIR_BB: return 53;
        case CCA_PKT_PAIR_RESP_C0: return 24;
        case CCA_PKT_PAIR_RESP_C1: return 24;
        case CCA_PKT_PAIR_RESP_C2: return 24;
        case CCA_PKT_PAIR_RESP_C8: return 24;
        case CCA_PKT_SET_LEVEL: return 24;
        case CCA_PKT_STATE_RPT_81: return 24;
        case CCA_PKT_STATE_RPT_82: return 24;
        case CCA_PKT_STATE_RPT_83: return 24;
        case CCA_PKT_UNPAIR: return 24;
        case CCA_PKT_UNPAIR_PREP: return 24;
        default: return 0;
    }
}

static inline const char* cca_packet_name(uint8_t type) {
    switch (type) {
        case CCA_PKT_BEACON: return "BEACON";
        case CCA_PKT_BEACON_92: return "BEACON_92";
        case CCA_PKT_BEACON_93: return "BEACON_93";
        case CCA_PKT_BTN_LONG_A: return "BTN_LONG_A";
        case CCA_PKT_BTN_LONG_B: return "BTN_LONG_B";
        case CCA_PKT_BTN_SHORT_A: return "BTN_SHORT_A";
        case CCA_PKT_BTN_SHORT_B: return "BTN_SHORT_B";
        case CCA_PKT_LED_CONFIG: return "LED_CONFIG";
        case CCA_PKT_PAIR_B0: return "PAIR_B0";
        case CCA_PKT_PAIR_B8: return "PAIR_B8";
        case CCA_PKT_PAIR_B9: return "PAIR_B9";
        case CCA_PKT_PAIR_BA: return "PAIR_BA";
        case CCA_PKT_PAIR_BB: return "PAIR_BB";
        case CCA_PKT_PAIR_RESP_C0: return "PAIR_RESP_C0";
        case CCA_PKT_PAIR_RESP_C1: return "PAIR_RESP_C1";
        case CCA_PKT_PAIR_RESP_C2: return "PAIR_RESP_C2";
        case CCA_PKT_PAIR_RESP_C8: return "PAIR_RESP_C8";
        case CCA_PKT_SET_LEVEL: return "SET_LEVEL";
        case CCA_PKT_STATE_RPT_81: return "STATE_RPT_81";
        case CCA_PKT_STATE_RPT_82: return "STATE_RPT_82";
        case CCA_PKT_STATE_RPT_83: return "STATE_RPT_83";
        case CCA_PKT_UNPAIR: return "UNPAIR";
        case CCA_PKT_UNPAIR_PREP: return "UNPAIR_PREP";
        default: return "UNKNOWN";
    }
}

/* Field offsets for packet parsing */
/* BEACON fields */
#define CCA_BEACON_OFF_TYPE    0
#define CCA_BEACON_SIZE_TYPE   1
#define CCA_BEACON_OFF_SEQUENCE    1
#define CCA_BEACON_SIZE_SEQUENCE   1
#define CCA_BEACON_OFF_LOAD_ID    2
#define CCA_BEACON_SIZE_LOAD_ID   4
#define CCA_BEACON_OFF_PROTOCOL    6
#define CCA_BEACON_SIZE_PROTOCOL   1
#define CCA_BEACON_OFF_FORMAT    7
#define CCA_BEACON_SIZE_FORMAT   1
#define CCA_BEACON_OFF_FIXED    8
#define CCA_BEACON_SIZE_FIXED   5
#define CCA_BEACON_OFF_BROADCAST    13
#define CCA_BEACON_SIZE_BROADCAST   9
#define CCA_BEACON_OFF_CRC    22
#define CCA_BEACON_SIZE_CRC   2

/* BTN_LONG_A fields */
#define CCA_BTN_LONG_A_OFF_TYPE    0
#define CCA_BTN_LONG_A_SIZE_TYPE   1
#define CCA_BTN_LONG_A_OFF_SEQUENCE    1
#define CCA_BTN_LONG_A_SIZE_SEQUENCE   1
#define CCA_BTN_LONG_A_OFF_DEVICE_ID    2
#define CCA_BTN_LONG_A_SIZE_DEVICE_ID   4
#define CCA_BTN_LONG_A_OFF_PROTOCOL    6
#define CCA_BTN_LONG_A_SIZE_PROTOCOL   1
#define CCA_BTN_LONG_A_OFF_FORMAT    7
#define CCA_BTN_LONG_A_SIZE_FORMAT   1
#define CCA_BTN_LONG_A_OFF_FIXED    8
#define CCA_BTN_LONG_A_SIZE_FIXED   2
#define CCA_BTN_LONG_A_OFF_BUTTON    10
#define CCA_BTN_LONG_A_SIZE_BUTTON   1
#define CCA_BTN_LONG_A_OFF_ACTION    11
#define CCA_BTN_LONG_A_SIZE_ACTION   1
#define CCA_BTN_LONG_A_OFF_DEVICE_REPEAT    12
#define CCA_BTN_LONG_A_SIZE_DEVICE_REPEAT   4
#define CCA_BTN_LONG_A_OFF_BUTTON_DATA    16
#define CCA_BTN_LONG_A_SIZE_BUTTON_DATA   6
#define CCA_BTN_LONG_A_OFF_CRC    22
#define CCA_BTN_LONG_A_SIZE_CRC   2

/* BTN_SHORT_A fields */
#define CCA_BTN_SHORT_A_OFF_TYPE    0
#define CCA_BTN_SHORT_A_SIZE_TYPE   1
#define CCA_BTN_SHORT_A_OFF_SEQUENCE    1
#define CCA_BTN_SHORT_A_SIZE_SEQUENCE   1
#define CCA_BTN_SHORT_A_OFF_DEVICE_ID    2
#define CCA_BTN_SHORT_A_SIZE_DEVICE_ID   4
#define CCA_BTN_SHORT_A_OFF_PROTOCOL    6
#define CCA_BTN_SHORT_A_SIZE_PROTOCOL   1
#define CCA_BTN_SHORT_A_OFF_FORMAT    7
#define CCA_BTN_SHORT_A_SIZE_FORMAT   1
#define CCA_BTN_SHORT_A_OFF_FIXED    8
#define CCA_BTN_SHORT_A_SIZE_FIXED   2
#define CCA_BTN_SHORT_A_OFF_BUTTON    10
#define CCA_BTN_SHORT_A_SIZE_BUTTON   1
#define CCA_BTN_SHORT_A_OFF_ACTION    11
#define CCA_BTN_SHORT_A_SIZE_ACTION   1
#define CCA_BTN_SHORT_A_OFF_PADDING    12
#define CCA_BTN_SHORT_A_SIZE_PADDING   10
#define CCA_BTN_SHORT_A_OFF_CRC    22
#define CCA_BTN_SHORT_A_SIZE_CRC   2

/* PAIR_B0 fields */
#define CCA_PAIR_B0_OFF_TYPE    0
#define CCA_PAIR_B0_SIZE_TYPE   1
#define CCA_PAIR_B0_OFF_SEQUENCE    1
#define CCA_PAIR_B0_SIZE_SEQUENCE   1
#define CCA_PAIR_B0_OFF_DEVICE_ID    2
#define CCA_PAIR_B0_SIZE_DEVICE_ID   4
#define CCA_PAIR_B0_OFF_PROTOCOL    6
#define CCA_PAIR_B0_SIZE_PROTOCOL   1
#define CCA_PAIR_B0_OFF_FORMAT    7
#define CCA_PAIR_B0_SIZE_FORMAT   1
#define CCA_PAIR_B0_OFF_DATA    8
#define CCA_PAIR_B0_SIZE_DATA   43
#define CCA_PAIR_B0_OFF_CRC    51
#define CCA_PAIR_B0_SIZE_CRC   2

/* PAIR_B8 fields */
#define CCA_PAIR_B8_OFF_TYPE    0
#define CCA_PAIR_B8_SIZE_TYPE   1
#define CCA_PAIR_B8_OFF_SEQUENCE    1
#define CCA_PAIR_B8_SIZE_SEQUENCE   1
#define CCA_PAIR_B8_OFF_DEVICE_ID    2
#define CCA_PAIR_B8_SIZE_DEVICE_ID   4
#define CCA_PAIR_B8_OFF_PROTOCOL    6
#define CCA_PAIR_B8_SIZE_PROTOCOL   1
#define CCA_PAIR_B8_OFF_FORMAT    7
#define CCA_PAIR_B8_SIZE_FORMAT   1
#define CCA_PAIR_B8_OFF_FIXED    8
#define CCA_PAIR_B8_SIZE_FIXED   2
#define CCA_PAIR_B8_OFF_BTN_SCHEME    10
#define CCA_PAIR_B8_SIZE_BTN_SCHEME   1
#define CCA_PAIR_B8_OFF_FIXED2    11
#define CCA_PAIR_B8_SIZE_FIXED2   2
#define CCA_PAIR_B8_OFF_BROADCAST    13
#define CCA_PAIR_B8_SIZE_BROADCAST   5
#define CCA_PAIR_B8_OFF_FIXED3    18
#define CCA_PAIR_B8_SIZE_FIXED3   2
#define CCA_PAIR_B8_OFF_DEVICE_ID2    20
#define CCA_PAIR_B8_SIZE_DEVICE_ID2   4
#define CCA_PAIR_B8_OFF_DEVICE_ID3    24
#define CCA_PAIR_B8_SIZE_DEVICE_ID3   4
#define CCA_PAIR_B8_OFF_DEVICE_CLASS    28
#define CCA_PAIR_B8_SIZE_DEVICE_CLASS   1
#define CCA_PAIR_B8_OFF_DEVICE_SUB    29
#define CCA_PAIR_B8_SIZE_DEVICE_SUB   1
#define CCA_PAIR_B8_OFF_CAPS    30
#define CCA_PAIR_B8_SIZE_CAPS   11
#define CCA_PAIR_B8_OFF_BROADCAST2    41
#define CCA_PAIR_B8_SIZE_BROADCAST2   4
#define CCA_PAIR_B8_OFF_PADDING    45
#define CCA_PAIR_B8_SIZE_PADDING   6
#define CCA_PAIR_B8_OFF_CRC    51
#define CCA_PAIR_B8_SIZE_CRC   2

/* PAIR_RESP_C0 fields */
#define CCA_PAIR_RESP_C0_OFF_TYPE    0
#define CCA_PAIR_RESP_C0_SIZE_TYPE   1
#define CCA_PAIR_RESP_C0_OFF_SEQUENCE    1
#define CCA_PAIR_RESP_C0_SIZE_SEQUENCE   1
#define CCA_PAIR_RESP_C0_OFF_DEVICE_ID    2
#define CCA_PAIR_RESP_C0_SIZE_DEVICE_ID   4
#define CCA_PAIR_RESP_C0_OFF_PROTOCOL    6
#define CCA_PAIR_RESP_C0_SIZE_PROTOCOL   1
#define CCA_PAIR_RESP_C0_OFF_FORMAT    7
#define CCA_PAIR_RESP_C0_SIZE_FORMAT   1
#define CCA_PAIR_RESP_C0_OFF_DATA    8
#define CCA_PAIR_RESP_C0_SIZE_DATA   14
#define CCA_PAIR_RESP_C0_OFF_CRC    22
#define CCA_PAIR_RESP_C0_SIZE_CRC   2

/* SET_LEVEL fields */
#define CCA_SET_LEVEL_OFF_TYPE    0
#define CCA_SET_LEVEL_SIZE_TYPE   1
#define CCA_SET_LEVEL_OFF_SEQUENCE    1
#define CCA_SET_LEVEL_SIZE_SEQUENCE   1
#define CCA_SET_LEVEL_OFF_SOURCE_ID    2
#define CCA_SET_LEVEL_SIZE_SOURCE_ID   4
#define CCA_SET_LEVEL_OFF_PROTOCOL    6
#define CCA_SET_LEVEL_SIZE_PROTOCOL   1
#define CCA_SET_LEVEL_OFF_FORMAT    7
#define CCA_SET_LEVEL_SIZE_FORMAT   1
#define CCA_SET_LEVEL_OFF_FIXED    8
#define CCA_SET_LEVEL_SIZE_FIXED   1
#define CCA_SET_LEVEL_OFF_TARGET_ID    9
#define CCA_SET_LEVEL_SIZE_TARGET_ID   4
#define CCA_SET_LEVEL_OFF_FIXED2    13
#define CCA_SET_LEVEL_SIZE_FIXED2   3
#define CCA_SET_LEVEL_OFF_LEVEL    16
#define CCA_SET_LEVEL_SIZE_LEVEL   2
#define CCA_SET_LEVEL_OFF_PADDING    18
#define CCA_SET_LEVEL_SIZE_PADDING   4
#define CCA_SET_LEVEL_OFF_CRC    22
#define CCA_SET_LEVEL_SIZE_CRC   2

/* STATE_RPT_81 fields */
#define CCA_STATE_RPT_81_OFF_TYPE    0
#define CCA_STATE_RPT_81_SIZE_TYPE   1
#define CCA_STATE_RPT_81_OFF_SEQUENCE    1
#define CCA_STATE_RPT_81_SIZE_SEQUENCE   1
#define CCA_STATE_RPT_81_OFF_DEVICE_ID    2
#define CCA_STATE_RPT_81_SIZE_DEVICE_ID   4
#define CCA_STATE_RPT_81_OFF_PROTOCOL    6
#define CCA_STATE_RPT_81_SIZE_PROTOCOL   1
#define CCA_STATE_RPT_81_OFF_FORMAT    7
#define CCA_STATE_RPT_81_SIZE_FORMAT   1
#define CCA_STATE_RPT_81_OFF_FIXED    8
#define CCA_STATE_RPT_81_SIZE_FIXED   3
#define CCA_STATE_RPT_81_OFF_LEVEL    11
#define CCA_STATE_RPT_81_SIZE_LEVEL   1
#define CCA_STATE_RPT_81_OFF_PADDING    12
#define CCA_STATE_RPT_81_SIZE_PADDING   10
#define CCA_STATE_RPT_81_OFF_CRC    22
#define CCA_STATE_RPT_81_SIZE_CRC   2

/* UNPAIR fields */
#define CCA_UNPAIR_OFF_TYPE    0
#define CCA_UNPAIR_SIZE_TYPE   1
#define CCA_UNPAIR_OFF_SEQUENCE    1
#define CCA_UNPAIR_SIZE_SEQUENCE   1
#define CCA_UNPAIR_OFF_SOURCE_ID    2
#define CCA_UNPAIR_SIZE_SOURCE_ID   4
#define CCA_UNPAIR_OFF_PROTOCOL    6
#define CCA_UNPAIR_SIZE_PROTOCOL   1
#define CCA_UNPAIR_OFF_FORMAT    7
#define CCA_UNPAIR_SIZE_FORMAT   1
#define CCA_UNPAIR_OFF_FIXED    8
#define CCA_UNPAIR_SIZE_FIXED   3
#define CCA_UNPAIR_OFF_COMMAND    11
#define CCA_UNPAIR_SIZE_COMMAND   5
#define CCA_UNPAIR_OFF_TARGET_ID    16
#define CCA_UNPAIR_SIZE_TARGET_ID   4
#define CCA_UNPAIR_OFF_PADDING    20
#define CCA_UNPAIR_SIZE_PADDING   2
#define CCA_UNPAIR_OFF_CRC    22
#define CCA_UNPAIR_SIZE_CRC   2

/* Transmission sequence definitions */

typedef struct {
    uint8_t packet_type;
    int32_t count;       /* -1 = repeat until stopped */
    uint32_t interval_ms;
} cca_sequence_step_t;

typedef struct {
    const char* name;
    const char* description;
    const cca_sequence_step_t* steps;
    uint8_t step_count;
} cca_sequence_t;

/* Dimming hold (raise/lower) */
static const cca_sequence_step_t CCA_SEQ_BUTTON_HOLD_STEPS[] = {
    { CCA_PKT_BTN_SHORT_A, -1, 65 },
};

static const cca_sequence_t CCA_SEQ_BUTTON_HOLD = {
    .name = "button_hold",
    .description = "Dimming hold (raise/lower)",
    .steps = CCA_SEQ_BUTTON_HOLD_STEPS,
    .step_count = sizeof(CCA_SEQ_BUTTON_HOLD_STEPS) / sizeof(cca_sequence_step_t),
};

/* Standard 5-button Pico press */
static const cca_sequence_step_t CCA_SEQ_BUTTON_PRESS_STEPS[] = {
    { CCA_PKT_BTN_SHORT_A, 3, 70 },
    { CCA_PKT_BTN_LONG_A, 1, 70 },
};

static const cca_sequence_t CCA_SEQ_BUTTON_PRESS = {
    .name = "button_press",
    .description = "Standard 5-button Pico press",
    .steps = CCA_SEQ_BUTTON_PRESS_STEPS,
    .step_count = sizeof(CCA_SEQ_BUTTON_PRESS_STEPS) / sizeof(cca_sequence_step_t),
};

/* Button release (sent after press) */
static const cca_sequence_step_t CCA_SEQ_BUTTON_RELEASE_STEPS[] = {
    { CCA_PKT_BTN_SHORT_B, 3, 70 },
    { CCA_PKT_BTN_LONG_B, 1, 70 },
};

static const cca_sequence_t CCA_SEQ_BUTTON_RELEASE = {
    .name = "button_release",
    .description = "Button release (sent after press)",
    .steps = CCA_SEQ_BUTTON_RELEASE_STEPS,
    .step_count = sizeof(CCA_SEQ_BUTTON_RELEASE_STEPS) / sizeof(cca_sequence_step_t),
};

/* Pairing beacon broadcast */
static const cca_sequence_step_t CCA_SEQ_PAIRING_BEACON_STEPS[] = {
    { CCA_PKT_BEACON, -1, 65 },
};

static const cca_sequence_t CCA_SEQ_PAIRING_BEACON = {
    .name = "pairing_beacon",
    .description = "Pairing beacon broadcast",
    .steps = CCA_SEQ_PAIRING_BEACON_STEPS,
    .step_count = sizeof(CCA_SEQ_PAIRING_BEACON_STEPS) / sizeof(cca_sequence_step_t),
};

/* Pico pairing announcement */
static const cca_sequence_step_t CCA_SEQ_PICO_PAIRING_STEPS[] = {
    { CCA_PKT_PAIR_B9, 15, 75 },
};

static const cca_sequence_t CCA_SEQ_PICO_PAIRING = {
    .name = "pico_pairing",
    .description = "Pico pairing announcement",
    .steps = CCA_SEQ_PICO_PAIRING_STEPS,
    .step_count = sizeof(CCA_SEQ_PICO_PAIRING_STEPS) / sizeof(cca_sequence_step_t),
};

/* Set dimmer level */
static const cca_sequence_step_t CCA_SEQ_SET_LEVEL_STEPS[] = {
    { CCA_PKT_SET_LEVEL, 20, 60 },
};

static const cca_sequence_t CCA_SEQ_SET_LEVEL = {
    .name = "set_level",
    .description = "Set dimmer level",
    .steps = CCA_SEQ_SET_LEVEL_STEPS,
    .step_count = sizeof(CCA_SEQ_SET_LEVEL_STEPS) / sizeof(cca_sequence_step_t),
};

/* Unpair device from bridge */
static const cca_sequence_step_t CCA_SEQ_UNPAIR_STEPS[] = {
    { CCA_PKT_UNPAIR, 20, 60 },
};

static const cca_sequence_t CCA_SEQ_UNPAIR = {
    .name = "unpair",
    .description = "Unpair device from bridge",
    .steps = CCA_SEQ_UNPAIR_STEPS,
    .step_count = sizeof(CCA_SEQ_UNPAIR_STEPS) / sizeof(cca_sequence_step_t),
};

#endif /* CCA_PROTOCOL_H */
