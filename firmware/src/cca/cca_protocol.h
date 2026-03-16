#ifndef CCA_PROTOCOL_H
#define CCA_PROTOCOL_H

/**
 * QS Link / CCA protocol field constants.
 *
 * Proper names for packet byte values, established by reverse engineering
 * the ESN-QS (Energi Savr Node) firmware from 2009. QS Link is an RS-485
 * wired protocol for Lutron commercial systems; CCA reuses the same packet
 * structure over 433 MHz RF.
 *
 * See: docs/qslink-cca-mapping.md
 */

#include <cstdint>

/* ----------------------------------------------------------------------- *
 * Protocol byte — radio IC TX command, always present at byte 6           *
 * (except format 0x28 which omits it to reclaim space)                    *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_PROTO_RADIO_TX = 0x21;

/* ----------------------------------------------------------------------- *
 * Addressing modes (QS Link payload offset 5)                             *
 * Determines unicast / multicast / broadcast targeting                    *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_ADDR_COMPONENT = 0xFE;  /* Unicast to specific component/zone */
static const uint8_t QS_ADDR_GROUP     = 0xEF;  /* Multicast to all devices in a group */
static const uint8_t QS_ADDR_BROADCAST = 0xFF;  /* Broadcast to all devices on the link */

/* ----------------------------------------------------------------------- *
 * Command classes (QS Link payload offset 6)                              *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_CLASS_LEVEL    = 0x40;  /* Level control (GoToLevel) — unchanged since 2009 */
static const uint8_t QS_CLASS_DIM      = 0x42;  /* Dim control (raise/lower/stop) — modern CCA */
static const uint8_t QS_CLASS_LEGACY   = 0x06;  /* Original 2009 dim/config class — persists in pairing packets */
static const uint8_t QS_CLASS_DEVICE   = 0x01;  /* Device control (identify, mode changes) */
static const uint8_t QS_CLASS_SELECT   = 0x03;  /* Select / query component */
static const uint8_t QS_CLASS_BUTTON   = 0x05;  /* Button / programming master events */
static const uint8_t QS_CLASS_ASSIGN   = 0x08;  /* Address assignment / component binding */
static const uint8_t QS_CLASS_SCENE    = 0x09;  /* Scene activation */

/* ----------------------------------------------------------------------- *
 * Command types (QS Link payload offset 7)                                *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_TYPE_EXECUTE   = 0x02;  /* Set / execute */
static const uint8_t QS_TYPE_HOLD      = 0x00;  /* Hold / start */
static const uint8_t QS_TYPE_STEP      = 0x02;  /* Dim step (same value as execute, context-dependent) */
static const uint8_t QS_TYPE_IDENTIFY  = 0x22;  /* Flash LEDs / self-identify */
static const uint8_t QS_TYPE_CONFIG    = 0x33;  /* Configuration */
static const uint8_t QS_TYPE_ADDR_SET  = 0xA3;  /* Address assign */
static const uint8_t QS_TYPE_ADDR_QRY  = 0xA5;  /* Address query */

/* ----------------------------------------------------------------------- *
 * Component types                                                         *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_COMP_DIMMER    = 0x50;
static const uint8_t QS_COMP_RELAY     = 0x38;
static const uint8_t QS_COMP_SCENE     = 0x40;

/* ----------------------------------------------------------------------- *
 * Format byte values (= payload length in bytes)                          *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_FMT_TAP        = 0x04;  /* Button tap (4 bytes) */
static const uint8_t QS_FMT_STATE      = 0x08;  /* State report (8 bytes) */
static const uint8_t QS_FMT_CTRL       = 0x09;  /* Device control / hold-start (9 bytes) */
static const uint8_t QS_FMT_ADDR       = 0x0A;  /* Address assign (10 bytes) */
static const uint8_t QS_FMT_DIM_STEP   = 0x0B;  /* Dim step (11 bytes) */
static const uint8_t QS_FMT_BEACON     = 0x0C;  /* Beacon / unpair / dim-stop (12 bytes) */
static const uint8_t QS_FMT_LEVEL      = 0x0E;  /* GoToLevel / button extended (14 bytes) */
static const uint8_t QS_FMT_ACCEPT     = 0x10;  /* Pairing accept (16 bytes) */
static const uint8_t QS_FMT_LED        = 0x11;  /* LED config (17 bytes) */
static const uint8_t QS_FMT_FINAL      = 0x12;  /* Final config with zone (18 bytes) */
static const uint8_t QS_FMT_DIM_CAP    = 0x13;  /* Dimming capability (19 bytes) */
static const uint8_t QS_FMT_FUNC_MAP   = 0x14;  /* Function mapping (20 bytes) */
static const uint8_t QS_FMT_TRIM       = 0x15;  /* Trim / phase config (21 bytes) */
static const uint8_t QS_FMT_SCENE_CFG  = 0x1A;  /* Scene config (26 bytes) */
static const uint8_t QS_FMT_FADE       = 0x1C;  /* Fade config (28 bytes) */
static const uint8_t QS_FMT_ZONE       = 0x28;  /* Zone assignment (40 bytes, format at byte 6) */

/* ----------------------------------------------------------------------- *
 * Pico device framing                                                     *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_PICO_FRAME     = 0x03;

/* ----------------------------------------------------------------------- *
 * Level encoding                                                          *
 * ----------------------------------------------------------------------- */
static const uint16_t QS_LEVEL_MAX     = 0xFEFF;  /* 100% as 16-bit */
static const uint8_t  QS_LEVEL_MAX_8   = 0xFE;    /* 100% as 8-bit */

/* ----------------------------------------------------------------------- *
 * Property operation types (ESN-QS Case 0x51/0x13)                        *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_TYPE_PROP_SET_FIXED = 0x64;  /* Property set (fixed-size) */
static const uint8_t QS_TYPE_PROP_SET_VAR   = 0x65;  /* Property set (variable-size) */
static const uint8_t QS_TYPE_DIM_CONFIG     = 0x78;  /* Dimming config sub-type */

/* ----------------------------------------------------------------------- *
 * State report field values                                               *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_STATE_ENTITY_COMP = 0x1B;  /* Component entity marker (state rpt bytes 9/13) */
static const uint8_t QS_STATE_STATUS_FLAG = 0x92;  /* Status flag (state rpt byte 14) */

/* ----------------------------------------------------------------------- *
 * Preset base offset (button → preset mapping in pico long format)        *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_PRESET_BASE = 0x1E;

/* ----------------------------------------------------------------------- *
 * Padding                                                                 *
 * ----------------------------------------------------------------------- */
static const uint8_t QS_PADDING        = 0x00;

#endif /* CCA_PROTOCOL_H */
