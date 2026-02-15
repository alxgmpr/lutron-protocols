/**
 * CCA pairing engine — Pico direct pairing + bridge handshake.
 *
 * Pico pairing: TX-only, alternates type_a/type_b 53-byte packets.
 * Bridge pairing: beacon → challenge collection (RX) → echo (TX).
 *
 * Both run synchronously in the CCA task context.
 *
 * Source: ESP32 lutron_pairing.cpp / cc1101_cca.cpp
 */

#include "cca_pairing.h"
#include "cca_commands.h"
#include "cca_crc.h"
#include "cca_encoder.h"
#include "cca_types.h"
#include "cca_task.h"
#include "cc1101.h"
#include "stream.h"
#include "bsp.h"

#include "FreeRTOS.h"
#include "task.h"

#include <cstdio>
#include <cstring>

/* -----------------------------------------------------------------------
 * Shared transmit helper (same as cca_commands.cpp — duplicated to keep
 * linkage simple; the linker will merge identical code).
 * ----------------------------------------------------------------------- */
static uint32_t pair_tx_count = 0;

static bool transmit_one(const uint8_t *packet, size_t len)
{
    uint8_t with_crc[64 + 2];
    cca_append_crc(packet, len, with_crc);

    uint8_t encoded[128];
    CcaEncoder encoder;
    size_t encoded_len = encoder.encode_packet(with_crc, len + 2,
                                                encoded, sizeof(encoded));
    if (encoded_len == 0) return false;

    bool ok = cc1101_transmit_raw(encoded, encoded_len);
    if (ok) {
        pair_tx_count++;
        stream_send_cca_packet(packet, len, 0, true);
    }
    return ok;
}

/* -----------------------------------------------------------------------
 * Pico type presets
 * ----------------------------------------------------------------------- */
struct PicoPreset {
    uint8_t type_a;
    uint8_t type_b;
    uint8_t byte10;
    uint8_t byte30;
    uint8_t byte31;
    uint8_t byte37;
    uint8_t byte38;
};

static const PicoPreset pico_presets[] = {
    { 0xB9, 0xBB, 0x04, 0x03, 0x00, 0x02, 0x06 },  /* 0: 5-button */
    { 0xB9, 0xBB, 0x04, 0x03, 0x08, 0x01, 0x01 },  /* 1: 2-button */
    { 0xB9, 0xBB, 0x0B, 0x02, 0x00, 0x02, 0x21 },  /* 2: 4-btn R/L */
    { 0xB8, 0xBA, 0x0B, 0x04, 0x00, 0x02, 0x27 },  /* 3: 4-btn scene */
};

/* -----------------------------------------------------------------------
 * Pico direct pairing — TX only, no RX needed
 * ----------------------------------------------------------------------- */
static void exec_pico_pair(uint32_t device_id, uint8_t pico_type,
                            uint8_t duration_sec)
{
    if (pico_type > 3) pico_type = 0;
    if (duration_sec == 0) duration_sec = 10;

    const PicoPreset &p = pico_presets[pico_type];

    printf("[cca] CMD pico_pair dev=%08X type=%u dur=%us\r\n",
           (unsigned)device_id, pico_type, duration_sec);

    cc1101_stop_rx();

    uint8_t packet[53];
    uint8_t seq = 0x01;
    bool use_type_a = true;
    uint32_t start = HAL_GetTick();

    while ((HAL_GetTick() - start) < (uint32_t)duration_sec * 1000) {
        memset(packet, 0xCC, sizeof(packet));

        /* [0]: alternating type_a / type_b */
        packet[0] = use_type_a ? p.type_a : p.type_b;
        use_type_a = !use_type_a;

        /* [1]: sequence */
        packet[1] = seq;

        /* [2-5]: device_id big-endian */
        packet[2] = (device_id >> 24) & 0xFF;
        packet[3] = (device_id >> 16) & 0xFF;
        packet[4] = (device_id >> 8) & 0xFF;
        packet[5] = device_id & 0xFF;

        /* [6-12]: header bytes */
        packet[6]  = 0x21;
        packet[7]  = 0x25;
        packet[8]  = 0x04;
        packet[9]  = 0x00;
        packet[10] = p.byte10;
        packet[11] = 0x03;
        packet[12] = 0x00;

        /* [13-17]: broadcast 0xFF x 5 */
        packet[13] = 0xFF;
        packet[14] = 0xFF;
        packet[15] = 0xFF;
        packet[16] = 0xFF;
        packet[17] = 0xFF;

        /* [18-19] */
        packet[18] = 0x0D;
        packet[19] = 0x05;

        /* [20-27]: device_id BE x 2 */
        packet[20] = (device_id >> 24) & 0xFF;
        packet[21] = (device_id >> 16) & 0xFF;
        packet[22] = (device_id >> 8) & 0xFF;
        packet[23] = device_id & 0xFF;
        packet[24] = (device_id >> 24) & 0xFF;
        packet[25] = (device_id >> 16) & 0xFF;
        packet[26] = (device_id >> 8) & 0xFF;
        packet[27] = device_id & 0xFF;

        /* [28-40]: capability bytes */
        packet[28] = 0x00;
        packet[29] = 0x20;
        packet[30] = p.byte30;
        packet[31] = p.byte31;
        packet[32] = 0x08;
        packet[33] = 0x07;
        packet[34] = p.byte30;
        packet[35] = 0x01;
        packet[36] = 0x07;
        packet[37] = p.byte37;
        packet[38] = p.byte38;
        packet[39] = 0x00;
        packet[40] = 0x00;

        /* [41-44]: 0xFF padding */
        packet[41] = 0xFF;
        packet[42] = 0xFF;
        packet[43] = 0xFF;
        packet[44] = 0xFF;

        /* [45-50]: 0xCC padding (already set by memset) */

        /* CRC is over [0-50], appended by transmit_one */
        transmit_one(packet, 51);

        seq = (seq + 6) & 0xFF;
        if (seq >= 0x48) seq = 0x01;

        vTaskDelay(pdMS_TO_TICKS(75));
    }

    cc1101_start_rx();
    printf("[cca] CMD pico_pair complete (%lu pkts)\r\n",
           (unsigned long)pair_tx_count);
}

/* -----------------------------------------------------------------------
 * Bridge pairing — handshake state machine
 * ----------------------------------------------------------------------- */

/* Handshake challenge storage */
static uint8_t hs_challenges[4][22];
static bool    hs_received[4];
static int     hs_count;

/* RX hook for capturing handshake challenges */
static void bridge_rx_hook(const DecodedPacket *pkt)
{
    if (!pkt || !pkt->valid) return;

    uint8_t t = pkt->type_byte;

    /* Odd handshake types are challenges from dimmer: C1, C7, CD, D3, D9, DF */
    bool is_challenge = (t == 0xC1 || t == 0xC7 || t == 0xCD ||
                         t == 0xD3 || t == 0xD9 || t == 0xDF);
    if (!is_challenge) return;

    /* Map sequence byte to slot: 0x20=0, 0x40=1, 0x60=2, 0x80=3 */
    int slot = -1;
    if (pkt->sequence == 0x20) slot = 0;
    else if (pkt->sequence == 0x40) slot = 1;
    else if (pkt->sequence == 0x60) slot = 2;
    else if (pkt->sequence == 0x80) slot = 3;

    if (slot < 0 || slot >= 4) return;
    if (hs_received[slot]) return;

    /* Store raw payload (up to 22 bytes of a 24-byte packet) */
    size_t copy_len = pkt->raw_len < 22 ? pkt->raw_len : 22;
    memcpy(hs_challenges[slot], pkt->raw, copy_len);
    hs_received[slot] = true;
    hs_count++;

    printf("[cca] HS challenge slot=%d type=0x%02X seq=0x%02X\r\n",
           slot, t, pkt->sequence);
}

static void exec_bridge_pair(uint32_t bridge_id, uint32_t target_id,
                              uint8_t beacon_sec)
{
    if (beacon_sec == 0) beacon_sec = 5;

    printf("[cca] CMD bridge_pair bridge=%08X target=%08X beacon=%us\r\n",
           (unsigned)bridge_id, (unsigned)target_id, beacon_sec);

    /* Reset handshake state */
    memset(hs_challenges, 0, sizeof(hs_challenges));
    memset(hs_received, 0, sizeof(hs_received));
    hs_count = 0;

    /* ---- Phase 1: BEACON ---- */
    printf("[cca] Bridge pair: beacon phase (%us)\r\n", beacon_sec);

    uint8_t packet[24];
    uint8_t seq = 0x01;
    uint32_t start = HAL_GetTick();

    while ((HAL_GetTick() - start) < (uint32_t)beacon_sec * 1000) {
        /* TX: send beacon pair */
        cc1101_stop_rx();

        for (int sub = 0; sub < 3; sub++) {
            memset(packet, 0x00, sizeof(packet));

            packet[0] = 0xB1 + sub;
            packet[1] = seq;

            /* Bridge ID big-endian */
            packet[2] = (bridge_id >> 24) & 0xFF;
            packet[3] = (bridge_id >> 16) & 0xFF;
            packet[4] = (bridge_id >> 8) & 0xFF;
            packet[5] = bridge_id & 0xFF;

            packet[6] = 0x21;
            packet[7] = 0x0C;
            packet[8] = 0x00;

            /* Broadcast */
            packet[9]  = 0xFF;
            packet[10] = 0xFF;
            packet[11] = 0xFF;
            packet[12] = 0xFF;
            packet[13] = 0xFF;

            transmit_one(packet, 22);
            vTaskDelay(pdMS_TO_TICKS(65));
        }

        seq = (seq + 5 + (seq & 1)) & 0xFF;

        /* RX: listen for ~200ms */
        cc1101_start_rx();
        for (int poll = 0; poll < 20; poll++) {
            cc1101_check_rx();
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }

    /* ---- Phase 2: CHALLENGE COLLECTION (up to 10 seconds) ---- */
    printf("[cca] Bridge pair: challenge collection\r\n");

    /* Install RX hook */
    cca_set_rx_hook(bridge_rx_hook);
    cc1101_start_rx();

    start = HAL_GetTick();
    while (hs_count < 4 && (HAL_GetTick() - start) < 10000) {
        cc1101_check_rx();
        /* flush_rx_pending is called by the normal task loop —
         * but we're blocking the task, so call it manually via
         * the hook which fires from on_rx_packet → flush path.
         * Actually, we need to call check_rx which triggers
         * on_rx_packet → pending queue → we process below. */
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    /* Remove RX hook before echo phase */
    cca_set_rx_hook(NULL);

    if (hs_count == 0) {
        printf("[cca] Bridge pair: no challenges received, aborting\r\n");
        return;
    }

    printf("[cca] Bridge pair: got %d challenges, echo phase\r\n", hs_count);

    /* ---- Phase 3: ECHO ---- */
    cc1101_stop_rx();

    /* Even handshake types for echo: C2, C8, CE, D4, DA, E0 */
    static const uint8_t echo_types[] = { 0xC2, 0xC8, 0xCE, 0xD4, 0xDA, 0xE0 };

    for (int slot = 0; slot < 4; slot++) {
        if (!hs_received[slot]) continue;

        uint8_t echo_seq = hs_challenges[slot][1] + 5;

        for (int t = 0; t < 6; t++) {
            uint8_t echo_pkt[24];
            memcpy(echo_pkt, hs_challenges[slot], 22);

            echo_pkt[0] = echo_types[t];
            echo_pkt[1] = echo_seq;

            /* Slot 0 special: set bit pattern on byte[5] */
            if (slot == 0) {
                echo_pkt[5] |= 0x90;
            }

            transmit_one(echo_pkt, 22);
            vTaskDelay(pdMS_TO_TICKS(75));
        }
    }

    cc1101_start_rx();
    printf("[cca] CMD bridge_pair complete (%d challenges echoed)\r\n", hs_count);
}

/* -----------------------------------------------------------------------
 * Vive pairing — beacon → auto-accept → multi-phase config
 * ----------------------------------------------------------------------- */

/* B8 detection state */
static volatile bool vive_device_detected = false;
static uint32_t      vive_detected_device_id = 0;

/* Put a 32-bit ID big-endian into buffer */
static inline void put_be32(uint8_t *dst, uint32_t val)
{
    dst[0] = (val >> 24) & 0xFF;
    dst[1] = (val >> 16) & 0xFF;
    dst[2] = (val >> 8)  & 0xFF;
    dst[3] =  val        & 0xFF;
}

/* RX hook for capturing B8 pairing requests */
static void vive_rx_hook(const DecodedPacket *pkt)
{
    if (!pkt || !pkt->valid) return;
    if (pkt->type_byte != 0xB8) return;

    /* Extract device_id from raw[2..5] big-endian */
    uint32_t dev_id = ((uint32_t)pkt->raw[2] << 24) |
                      ((uint32_t)pkt->raw[3] << 16) |
                      ((uint32_t)pkt->raw[4] << 8)  |
                       (uint32_t)pkt->raw[5];

    vive_detected_device_id = dev_id;
    vive_device_detected = true;

    printf("[cca] Vive B8 detected: device=%08X\r\n", (unsigned)dev_id);
}

/* Send all accept + config phases for a detected device */
static void send_vive_accept_config(uint32_t hub_id, uint32_t device_id,
                                     uint8_t zone_byte)
{
    uint8_t pkt[51];

    printf("[cca] Vive accept+config: dev=%08X zone=0x%02X\r\n",
           (unsigned)device_id, zone_byte);

    cc1101_stop_rx();

    /* ---- Phase 1: BA Accept (1 packet, 53 bytes) ---- */
    memset(pkt, 0xCC, sizeof(pkt));
    pkt[0]  = 0xBA;
    pkt[1]  = 0x01;
    put_be32(pkt + 2, hub_id);
    pkt[6]  = 0x21;
    pkt[7]  = 0x10;         /* format: accept */
    pkt[8]  = 0x00;
    put_be32(pkt + 9, device_id);
    pkt[13] = 0xFE;
    pkt[14] = 0x60;
    pkt[15] = 0x0A;
    put_be32(pkt + 16, hub_id);
    put_be32(pkt + 20, hub_id);
    /* [24-50] = 0xCC (already set) */
    transmit_one(pkt, 51);
    vTaskDelay(pdMS_TO_TICKS(70));

    /* ---- Phase 2: Accept retransmissions (no seq byte, fields shift left) ---- */
    static const uint8_t accept_retx_types[] = { 0x87, 0x8D, 0x93, 0x9F, 0xAB, 0xB1 };
    for (int i = 0; i < 6; i++) {
        memset(pkt, 0xCC, sizeof(pkt));
        pkt[0] = accept_retx_types[i];
        put_be32(pkt + 1, hub_id);       /* byte 1, NOT 2 */
        pkt[5]  = 0x21;
        pkt[6]  = 0x10;
        pkt[7]  = 0x00;
        put_be32(pkt + 8, device_id);
        pkt[12] = 0xFE;
        pkt[13] = 0x60;
        pkt[14] = 0x0A;
        put_be32(pkt + 15, hub_id);
        put_be32(pkt + 19, hub_id);
        /* [23-50] = 0xCC */
        transmit_one(pkt, 51);
        vTaskDelay(pdMS_TO_TICKS(70));
    }

    /* ---- Phase 2b: Format 0x13 — Dimming Capability (5 packets) ---- */
    static const uint8_t fmt13_types[] = { 0xAB, 0xA9, 0xAA, 0x8D, 0x93 };
    for (int i = 0; i < 5; i++) {
        memset(pkt, 0xCC, sizeof(pkt));
        pkt[0] = fmt13_types[i];
        pkt[1] = 0x01;
        put_be32(pkt + 2, hub_id);
        pkt[6]  = 0x21;
        pkt[7]  = 0x13;
        pkt[8]  = 0x00;
        put_be32(pkt + 9, device_id);
        pkt[13] = 0xFE;
        pkt[14] = 0x06;
        pkt[15] = 0x50;
        pkt[16] = 0x00;
        pkt[17] = 0x0D;
        pkt[18] = 0x08;
        pkt[19] = 0x02;
        pkt[20] = 0x0F;
        pkt[21] = 0x03;
        put_be32(pkt + 22, device_id);   /* repeated device_id */
        pkt[26] = 0x00;
        /* [27-50] = 0xCC */
        transmit_one(pkt, 51);
        vTaskDelay(pdMS_TO_TICKS(70));
    }

    /* ---- Phase 3: Format 0x28 — Zone Assignment A (5 packets) ---- */
    static const uint8_t fmt28a_types[] = { 0xA9, 0x9F, 0xAB, 0xB7, 0xBD };
    for (int i = 0; i < 5; i++) {
        memset(pkt, 0xCC, sizeof(pkt));
        pkt[0] = fmt28a_types[i];
        pkt[1] = 0x01;
        put_be32(pkt + 2, hub_id);
        pkt[6]  = 0x28;
        pkt[7]  = 0x03;
        pkt[8]  = 0x01;
        pkt[9]  = 0x50;                  /* dimmer */
        pkt[10] = zone_byte + 0x23;      /* zone reference */
        pkt[11] = 0x21;
        pkt[12] = 0x1A;
        pkt[13] = 0x00;
        put_be32(pkt + 14, device_id);
        pkt[18] = 0xFE;
        pkt[19] = 0x06;
        pkt[20] = 0x40;
        pkt[21] = 0x00;
        pkt[22] = 0x00;
        pkt[23] = 0x00;
        pkt[24] = 0x01;
        pkt[25] = 0xEF;
        pkt[26] = 0x20;
        pkt[27] = 0x00;
        pkt[28] = 0x03;
        pkt[29] = 0x09;
        pkt[30] = 0x2B;
        pkt[31] = 0x32;                  /* Phase 3 variant */
        pkt[32] = 0xFF;
        pkt[33] = 0xFF;
        pkt[34] = 0x00;
        pkt[35] = 0x00;
        pkt[36] = 0xB4;
        pkt[37] = 0x00;
        pkt[38] = 0x00;
        /* [39-50] = 0xCC */
        transmit_one(pkt, 51);
        vTaskDelay(pdMS_TO_TICKS(70));
    }

    /* ---- Phase 4: Format 0x14 — Function Mapping (5 packets) ---- */
    static const uint8_t fmt14_types[] = { 0xAB, 0xA9, 0xAA, 0x8D, 0x93 };
    for (int i = 0; i < 5; i++) {
        memset(pkt, 0xCC, sizeof(pkt));
        pkt[0] = fmt14_types[i];
        pkt[1] = 0x01;
        put_be32(pkt + 2, hub_id);
        pkt[6]  = 0x21;
        pkt[7]  = 0x14;
        pkt[8]  = 0x00;
        put_be32(pkt + 9, device_id);
        pkt[13] = 0xFE;
        pkt[14] = 0x06;
        pkt[15] = 0x50;
        pkt[16] = 0x00;
        pkt[17] = 0x0B;
        pkt[18] = 0x09;
        pkt[19] = 0xFE;
        pkt[20] = 0xFF;
        pkt[21] = 0x00;
        pkt[22] = 0x02;                  /* dimmer capability */
        pkt[23] = 0x00;
        /* [24-50] = 0xCC */
        transmit_one(pkt, 51);
        vTaskDelay(pdMS_TO_TICKS(70));
    }

    /* ---- Phase 4b: Format 0x28 — Zone Assignment B (5 packets) ---- */
    static const uint8_t fmt28b_types[] = { 0xAB, 0xA9, 0xAA, 0x9F, 0xB7 };
    for (int i = 0; i < 5; i++) {
        memset(pkt, 0xCC, sizeof(pkt));
        pkt[0] = fmt28b_types[i];
        pkt[1] = 0x01;
        put_be32(pkt + 2, hub_id);
        pkt[6]  = 0x28;
        pkt[7]  = 0x03;
        pkt[8]  = 0x01;
        pkt[9]  = 0x50;
        pkt[10] = zone_byte + 0x23;
        pkt[11] = 0x21;
        pkt[12] = 0x1A;
        pkt[13] = 0x00;
        put_be32(pkt + 14, device_id);
        pkt[18] = 0xFE;
        pkt[19] = 0x06;
        pkt[20] = 0x40;
        pkt[21] = 0x00;
        pkt[22] = 0x00;
        pkt[23] = 0x00;
        pkt[24] = 0x01;
        pkt[25] = 0xEF;
        pkt[26] = 0x20;
        pkt[27] = 0x00;
        pkt[28] = 0x03;
        pkt[29] = 0x09;
        pkt[30] = 0x2B;
        pkt[31] = 0xFF;                  /* Phase 4b variant */
        pkt[32] = 0x00;
        pkt[33] = 0xFF;
        pkt[34] = 0x00;
        pkt[35] = 0x00;
        pkt[36] = 0xB4;
        pkt[37] = 0x00;
        pkt[38] = 0x00;
        /* [39-50] = 0xCC */
        transmit_one(pkt, 51);
        vTaskDelay(pdMS_TO_TICKS(70));
    }

    /* ---- Phase 5: Format 0x12 — Final Config with Zone ID (8 packets, 50ms) ---- */
    static const uint8_t fmt12_types[] = { 0xA9, 0x8D, 0x93, 0x9F, 0xAB, 0xB7, 0xBD, 0xC3 };
    for (int i = 0; i < 8; i++) {
        memset(pkt, 0xCC, sizeof(pkt));
        pkt[0] = fmt12_types[i];
        pkt[1] = 0x01;
        put_be32(pkt + 2, hub_id);
        pkt[6]  = 0x21;
        pkt[7]  = 0x12;
        pkt[8]  = 0x00;
        put_be32(pkt + 9, device_id);
        pkt[13] = 0xFE;
        pkt[14] = 0x06;
        pkt[15] = 0x6E;
        pkt[16] = 0x01;
        pkt[17] = 0x00;
        pkt[18] = 0x07;
        pkt[19] = 0x00;
        pkt[20] = 0x02;
        pkt[21] = 0x00;
        pkt[22] = 0x00;
        pkt[23] = 0x00;
        pkt[24] = zone_byte;             /* THE CRITICAL ZONE ASSIGNMENT */
        pkt[25] = 0xEF;
        /* [26-50] = 0xCC */
        transmit_one(pkt, 51);
        vTaskDelay(pdMS_TO_TICKS(50));
    }

    printf("[cca] Vive accept+config complete for dev=%08X\r\n",
           (unsigned)device_id);
}

/* Main Vive pairing loop */
static void exec_vive_pair(uint32_t hub_id, uint8_t zone_byte,
                            uint8_t duration_sec)
{
    if (duration_sec == 0) duration_sec = 30;

    printf("[cca] CMD vive_pair hub=%08X zone=0x%02X dur=%us\r\n",
           (unsigned)hub_id, zone_byte, duration_sec);

    vive_device_detected = false;
    vive_detected_device_id = 0;

    uint8_t pkt[51];
    uint8_t seq = 0x01;
    uint32_t start = HAL_GetTick();
    int devices_paired = 0;

    while ((HAL_GetTick() - start) < (uint32_t)duration_sec * 1000) {
        /* ---- TX: B9 beacon burst (9 packets, ~90ms spacing) ---- */
        cc1101_stop_rx();

        for (int b = 0; b < 9; b++) {
            memset(pkt, 0xCC, sizeof(pkt));
            pkt[0]  = 0xB9;
            pkt[1]  = seq;
            put_be32(pkt + 2, hub_id);
            pkt[6]  = 0x21;
            pkt[7]  = 0x11;              /* format: pairing mode */
            pkt[8]  = 0x00;
            pkt[9]  = 0xFF;              /* broadcast */
            pkt[10] = 0xFF;
            pkt[11] = 0xFF;
            pkt[12] = 0xFF;
            pkt[13] = 0xFF;
            pkt[14] = 0x60;
            pkt[15] = 0x00;
            put_be32(pkt + 16, hub_id);
            pkt[20] = 0xFF;              /* broadcast */
            pkt[21] = 0xFF;
            pkt[22] = 0xFF;
            pkt[23] = 0xFF;
            pkt[24] = 0x3C;              /* timer: active */
            /* [25-50] = 0xCC */
            transmit_one(pkt, 51);

            seq += 8;
            if (seq >= 0x48) seq = 0x01;
            vTaskDelay(pdMS_TO_TICKS(90));
        }

        /* ---- RX: listen for B8 (~5 seconds) ---- */
        vive_device_detected = false;
        cca_set_rx_hook(vive_rx_hook);
        cc1101_start_rx();

        for (int poll = 0; poll < 500; poll++) {   /* 500 * 10ms = 5s */
            cc1101_check_rx();
            if (vive_device_detected) break;
            vTaskDelay(pdMS_TO_TICKS(10));
        }

        cca_set_rx_hook(NULL);

        if (vive_device_detected) {
            uint32_t dev_id = vive_detected_device_id;
            vive_device_detected = false;

            send_vive_accept_config(hub_id, dev_id, zone_byte);
            devices_paired++;

            /* Brief pause then resume beaconing for more devices */
            cc1101_start_rx();
            vTaskDelay(pdMS_TO_TICKS(500));
        }
    }

    /* ---- Send stop beacon (timer=0x00) ---- */
    cc1101_stop_rx();
    for (int b = 0; b < 3; b++) {
        memset(pkt, 0xCC, sizeof(pkt));
        pkt[0]  = 0xB9;
        pkt[1]  = seq;
        put_be32(pkt + 2, hub_id);
        pkt[6]  = 0x21;
        pkt[7]  = 0x11;
        pkt[8]  = 0x00;
        pkt[9]  = 0xFF;
        pkt[10] = 0xFF;
        pkt[11] = 0xFF;
        pkt[12] = 0xFF;
        pkt[13] = 0xFF;
        pkt[14] = 0x60;
        pkt[15] = 0x00;
        put_be32(pkt + 16, hub_id);
        pkt[20] = 0xFF;
        pkt[21] = 0xFF;
        pkt[22] = 0xFF;
        pkt[23] = 0xFF;
        pkt[24] = 0x00;                  /* timer: STOP */
        transmit_one(pkt, 51);

        seq += 8;
        if (seq >= 0x48) seq = 0x01;
        vTaskDelay(pdMS_TO_TICKS(90));
    }

    cc1101_start_rx();
    printf("[cca] CMD vive_pair complete (%d devices paired)\r\n",
           devices_paired);
}

/* -----------------------------------------------------------------------
 * Public dispatcher — called from cca_cmd_execute()
 * ----------------------------------------------------------------------- */
void cca_pairing_execute(const CcaCmdItem *item)
{
    switch (item->cmd) {
        case CCA_CMD_PICO_PAIR:
            exec_pico_pair(item->device_id, item->pico_type,
                           item->duration_sec);
            break;
        case CCA_CMD_BRIDGE_PAIR:
            exec_bridge_pair(item->device_id, item->target_id,
                             item->duration_sec);
            break;
        case CCA_CMD_VIVE_PAIR:
            exec_vive_pair(item->device_id, item->zone_byte,
                           item->duration_sec);
            break;
        default:
            printf("[cca] Unknown pairing command: 0x%02X\r\n", item->cmd);
            break;
    }
}
