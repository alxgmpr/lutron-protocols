#pragma once

/**
 * CCA TX Packet Builder — constructs CCA packets matching Lutron firmware.
 *
 * Each builder fills a raw packet buffer (pre-CRC, pre-N81).  The caller
 * then submits the packet to the TDMA engine via cca_tdma_submit().
 *
 * Byte layouts match QSM firmware func_0x0283 and observed Lutron traffic.
 * All builders return the packet length (22 for standard, 51 for pairing),
 * or 0 on error.
 */

#include "cca_types.h"

#include <cstdint>
#include <cstddef>
#include <cstring>

/* -----------------------------------------------------------------------
 * Helper: encode level percent to 16-bit Lutron encoding
 * ----------------------------------------------------------------------- */
inline uint16_t cca_percent_to_level16(uint8_t pct)
{
    if (pct >= 100) return QS_LEVEL_MAX;
    if (pct == 0) return 0x0000;
    return (uint16_t)((uint32_t)pct * 65279 / 100);
}

/* -----------------------------------------------------------------------
 * Helper: write 4-byte device ID in big-endian
 * ----------------------------------------------------------------------- */
inline void cca_write_id_be(uint8_t* dst, uint32_t id)
{
    dst[0] = (id >> 24) & 0xFF;
    dst[1] = (id >> 16) & 0xFF;
    dst[2] = (id >> 8) & 0xFF;
    dst[3] = id & 0xFF;
}

/* -----------------------------------------------------------------------
 * Helper: write 4-byte device ID in little-endian
 * ----------------------------------------------------------------------- */
inline void cca_write_id_le(uint8_t* dst, uint32_t id)
{
    dst[0] = id & 0xFF;
    dst[1] = (id >> 8) & 0xFF;
    dst[2] = (id >> 16) & 0xFF;
    dst[3] = (id >> 24) & 0xFF;
}

/* -----------------------------------------------------------------------
 * Build SET_LEVEL packet (format 0x0E, 22 bytes)
 *
 * Matches exec_bridge_level layout from cca_commands.cpp.
 * Source ID in little-endian (bytes 2-5), target in big-endian (bytes 9-12).
 * ----------------------------------------------------------------------- */
inline size_t cca_build_set_level(uint8_t* pkt, uint32_t source_id, uint32_t target_id,
                                   uint8_t addr_mode, uint16_t level16, uint8_t fade_qs,
                                   uint8_t type_byte)
{
    memset(pkt, 0x00, 22);

    pkt[0] = type_byte;       /* 0x81/82/83 (rotated by TDMA engine if type_rotate=1) */
    /* pkt[1] = seq — set by TDMA engine */

    /* Source ID (zone/bridge) in little-endian */
    cca_write_id_le(pkt + 2, source_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_LEVEL;
    pkt[8] = 0x00; /* flags: normal */

    /* Target device ID in big-endian */
    if (target_id == 0xFFFFFFFF) {
        memset(pkt + 9, 0xFF, 4);
    }
    else {
        cca_write_id_be(pkt + 9, target_id);
    }

    pkt[13] = addr_mode;      /* QS_ADDR_COMPONENT / GROUP / BROADCAST */
    pkt[14] = QS_CLASS_LEVEL;
    pkt[15] = QS_TYPE_EXECUTE;

    /* Level (big-endian 16-bit) */
    pkt[16] = (level16 >> 8) & 0xFF;
    pkt[17] = level16 & 0xFF;

    pkt[18] = 0x00;
    pkt[19] = fade_qs;        /* fade time in quarter-seconds */

    return 22;
}

/* -----------------------------------------------------------------------
 * Build button press packet (SHORT format, 22 bytes)
 *
 * Matches exec_button Phase 1 layout.
 * Device ID in big-endian (pico convention).
 * ----------------------------------------------------------------------- */
inline size_t cca_build_button_short(uint8_t* pkt, uint32_t device_id, uint8_t button,
                                      uint8_t action, uint8_t format, uint8_t type_byte)
{
    memset(pkt, 0x00, 22);

    pkt[0] = type_byte;       /* PKT_BTN_SHORT_A/B */
    /* pkt[1] = seq — set by TDMA engine */
    cca_write_id_be(pkt + 2, device_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = format;          /* QS_FMT_TAP (0x04) or QS_FMT_BEACON (0x0C) */
    pkt[8] = QS_PICO_FRAME;
    pkt[9] = 0x00;
    pkt[10] = button;
    pkt[11] = action;

    /* For dim start (RAISE/LOWER), embed target + class in beacon area */
    if (format == QS_FMT_BEACON && (button == BTN_RAISE || button == BTN_LOWER)) {
        cca_write_id_be(pkt + 12, device_id);
        pkt[16] = 0x00;
        pkt[17] = QS_CLASS_DIM;
        pkt[18] = QS_TYPE_HOLD;
        pkt[19] = (button == BTN_RAISE) ? 0x03 : 0x02;
    }

    return 22;
}

/* -----------------------------------------------------------------------
 * Build button long packet (LONG format, 22 bytes)
 *
 * Matches exec_button Phase 2 layout.
 * ----------------------------------------------------------------------- */
inline size_t cca_build_button_long(uint8_t* pkt, uint32_t device_id, uint8_t button,
                                     uint8_t type_byte)
{
    memset(pkt, 0x00, 22);

    pkt[0] = type_byte;       /* PKT_BTN_LONG_A/B */
    /* pkt[1] = seq — set by TDMA engine */
    cca_write_id_be(pkt + 2, device_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_LEVEL;
    pkt[8] = QS_PICO_FRAME;
    pkt[9] = 0x00;
    pkt[10] = button;
    pkt[11] = ACTION_RELEASE;

    cca_write_id_be(pkt + 12, device_id);
    pkt[16] = 0x00;

    if (button == BTN_RAISE) {
        pkt[17] = QS_CLASS_DIM;
        pkt[18] = QS_TYPE_EXECUTE;
        pkt[19] = 0x01;  /* direction: raise */
        pkt[20] = 0x00;
        pkt[21] = 0x16;
    }
    else if (button == BTN_LOWER) {
        pkt[17] = QS_CLASS_DIM;
        pkt[18] = QS_TYPE_EXECUTE;
        pkt[19] = 0x00;  /* direction: lower */
        pkt[20] = 0x00;
        pkt[21] = 0x43;
    }
    else {
        pkt[17] = QS_CLASS_LEVEL;
        pkt[18] = QS_TYPE_HOLD;
        pkt[19] = QS_PRESET_BASE + button;
    }

    return 22;
}

/* -----------------------------------------------------------------------
 * Build beacon packet (format 0x0C, 22 bytes)
 * ----------------------------------------------------------------------- */
inline size_t cca_build_beacon(uint8_t* pkt, uint32_t zone_id, uint8_t type_byte)
{
    memset(pkt, 0x00, 22);

    pkt[0] = type_byte;       /* PKT_BEACON_91/92/93 */
    /* pkt[1] = seq */
    cca_write_id_le(pkt + 2, zone_id);

    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_BEACON;

    return 22;
}
