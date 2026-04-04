/**
 * Non-blocking auto-pair engine — full Vive pairing sequence via TDMA.
 *
 * Sequence (from real Vive hub capture):
 *   1. BB beacons (format 0x11, timer=0x3C) — continuous
 *   2. B8 detected from device
 *   3. B9 accept (format 0x10) — directed to device
 *   4. Config: 0x13 dimming cap, 0x28 zone, 0x14 func map, 0x28 zone B, 0x12 final
 *   5. BB stop beacon (timer=0x00)
 *   6. B0 announce to RA3 (interleaved throughout)
 *
 * All TX via TDMA job groups — RX stays live between every slot.
 */

#include "cca_auto_pair.h"
#include "cca_tdma.h"
#include "cca_generated.h"
#include "cca_task.h"
#include "cca_pairing.h"
#include "bsp.h"

#include <cstdio>
#include <cstring>

static inline void put_be32(uint8_t* dst, uint32_t val)
{
    dst[0] = (val >> 24) & 0xFF;
    dst[1] = (val >> 16) & 0xFF;
    dst[2] = (val >> 8) & 0xFF;
    dst[3] = val & 0xFF;
}

/* -----------------------------------------------------------------------
 * State
 * ----------------------------------------------------------------------- */
static AutoPairState state_ = AUTO_PAIR_IDLE;
static uint32_t hub_id_;
static uint32_t device_class_;
static uint16_t subnet_;
static uint8_t zone_byte_;
static uint32_t start_ms_;
static uint32_t duration_ms_;

static uint32_t detected_serial_;
static uint32_t detect_time_ms_;

static bool beacon_active_;
static bool announce_active_;
static bool config_submitted_;

/* -----------------------------------------------------------------------
 * BB Vive beacon group (auto-resubmits)
 * ----------------------------------------------------------------------- */
static void beacon_complete(void* ctx);

static void submit_beacon_group(void)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint8_t* pkt = g.phases[0].packet.data;
    memset(pkt, 0xCC, 51);
    pkt[0] = 0xBB;
    put_be32(pkt + 2, hub_id_);
    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_LED; /* 0x11 */
    pkt[8] = 0x00;
    pkt[9] = QS_ADDR_BROADCAST;
    pkt[10] = QS_ADDR_BROADCAST;
    pkt[11] = QS_ADDR_BROADCAST;
    pkt[12] = QS_ADDR_BROADCAST;
    pkt[13] = QS_ADDR_BROADCAST;
    pkt[14] = 0x60;
    pkt[15] = 0x00;
    put_be32(pkt + 16, hub_id_);
    pkt[20] = 0xFF;
    pkt[21] = 0xFF;
    pkt[22] = 0xFF;
    pkt[23] = 0xFF;
    pkt[24] = 0x3C; /* timer: active */

    g.phases[0].packet.len = 51;
    g.phases[0].retransmits = 10;
    g.on_complete = beacon_complete;

    if (cca_tdma_submit_group(&g)) {
        beacon_active_ = true;
    }
}

static void beacon_complete(void* ctx)
{
    (void)ctx;
    beacon_active_ = false;
    if (state_ != AUTO_PAIR_IDLE && state_ != AUTO_PAIR_DONE) {
        submit_beacon_group();
    }
}

/* -----------------------------------------------------------------------
 * B0 spoofed announce group (auto-resubmits)
 * ----------------------------------------------------------------------- */
static void announce_complete(void* ctx);

static void submit_announce_group(void)
{
    if (detected_serial_ == 0) return;

    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint8_t* pkt = g.phases[0].packet.data;
    memset(pkt, 0xCC, 51);
    pkt[0] = 0xB0;
    pkt[2] = 0xA1;
    pkt[3] = (subnet_ >> 8) & 0xFF;
    pkt[4] = subnet_ & 0xFF;
    pkt[5] = 0x7F;
    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = 0x13;
    pkt[8] = 0x00;
    pkt[9] = 0xFF;
    pkt[10] = 0xFF;
    pkt[11] = 0xFF;
    pkt[12] = 0xFF;
    pkt[13] = 0xFF;
    pkt[14] = 0x08;
    pkt[15] = 0x05;
    put_be32(pkt + 16, detected_serial_);
    put_be32(pkt + 20, device_class_);
    pkt[24] = 0xFF;
    pkt[25] = 0x00;
    pkt[26] = 0x00;

    g.phases[0].packet.len = 51;
    g.phases[0].retransmits = 10;
    g.on_complete = announce_complete;

    if (cca_tdma_submit_group(&g)) {
        announce_active_ = true;
    }
}

static void announce_complete(void* ctx)
{
    (void)ctx;
    announce_active_ = false;
    if (state_ == AUTO_PAIR_ANNOUNCING) {
        submit_announce_group();
    }
}

/* -----------------------------------------------------------------------
 * Accept + Config multi-phase TDMA group
 *
 * Matches real Vive hub capture:
 *   Phase 0: B9 accept (format 0x10)
 *   Phase 1: Config format 0x13 — dimming capability
 *   Phase 2: Config format 0x28 — zone assignment A
 *   Phase 3: Config format 0x14 — function mapping
 *   Phase 4: Config format 0x28 — zone assignment B
 *   Phase 5: Config format 0x12 — final config with zone byte
 * ----------------------------------------------------------------------- */
static void config_complete(void* ctx);

static void submit_config_group(void)
{
    uint32_t dev = detected_serial_;
    if (dev == 0) return;

    TdmaJobGroup g = {};
    uint8_t* p;

    /* Phase 0: B9 Accept (format 0x10) — real hub uses B9 not BA */
    p = g.phases[0].packet.data;
    memset(p, 0xCC, 51);
    p[0] = 0xB9;
    put_be32(p + 2, hub_id_);
    p[6] = QS_PROTO_RADIO_TX;
    p[7] = QS_FMT_ACCEPT; /* 0x10 */
    p[8] = 0x00;
    put_be32(p + 9, dev);
    p[13] = QS_ADDR_COMPONENT; /* 0xFE */
    p[14] = 0x60;
    p[15] = 0x0A;
    put_be32(p + 16, hub_id_);
    put_be32(p + 20, hub_id_);
    g.phases[0].packet.len = 51;
    g.phases[0].retransmits = 5;
    g.phases[0].post_delay_ms = 200; /* let device process accept */

    /* Phase 1: Format 0x13 — Dimming Capability */
    p = g.phases[1].packet.data;
    memset(p, 0xCC, 51);
    p[0] = 0xAB;
    p[1] = 0x01;
    put_be32(p + 2, hub_id_);
    p[6] = QS_PROTO_RADIO_TX;
    p[7] = QS_FMT_DIM_CAP; /* 0x13 */
    p[8] = 0x00;
    put_be32(p + 9, dev);
    p[13] = QS_ADDR_COMPONENT;
    p[14] = QS_CLASS_LEGACY; /* 0x06 */
    p[15] = QS_COMP_DIMMER;  /* 0x50 */
    p[16] = 0x00;
    p[17] = 0x0D;
    p[18] = 0x08;
    p[19] = 0x02;
    p[20] = 0x0F;
    p[21] = 0x03;
    put_be32(p + 22, dev);
    g.phases[1].packet.len = 51;
    g.phases[1].retransmits = 5;
    g.phases[1].post_delay_ms = 200;

    /* Phase 2: Format 0x28 — Zone Assignment A */
    p = g.phases[2].packet.data;
    memset(p, 0xCC, 51);
    p[0] = 0xAA;
    p[1] = 0x01;
    put_be32(p + 2, hub_id_);
    p[6] = QS_FMT_ZONE; /* 0x28 — format at byte 6 */
    p[7] = 0x03;
    p[8] = 0x01;
    p[9] = QS_COMP_DIMMER;
    p[10] = zone_byte_ + 0x23;
    p[11] = QS_PROTO_RADIO_TX;
    p[12] = 0x1A;
    p[13] = 0x00;
    put_be32(p + 14, dev);
    p[18] = QS_ADDR_COMPONENT;
    p[19] = QS_CLASS_LEGACY;
    p[20] = QS_CLASS_LEVEL; /* 0x40 */
    p[24] = 0x01;
    p[25] = QS_ADDR_GROUP; /* 0xEF */
    p[26] = 0x20;
    p[28] = 0x03;
    p[29] = 0x09;
    p[30] = 0x2B;
    p[31] = 0x32;
    p[32] = 0xFF;
    p[33] = 0xFF;
    p[36] = 0xB4;
    g.phases[2].packet.len = 51;
    g.phases[2].retransmits = 5;
    g.phases[2].post_delay_ms = 200;

    /* Phase 3: Format 0x14 — Function Mapping */
    p = g.phases[3].packet.data;
    memset(p, 0xCC, 51);
    p[0] = 0xAB;
    p[1] = 0x01;
    put_be32(p + 2, hub_id_);
    p[6] = QS_PROTO_RADIO_TX;
    p[7] = QS_FMT_FUNC_MAP; /* 0x14 */
    p[8] = 0x00;
    put_be32(p + 9, dev);
    p[13] = QS_ADDR_COMPONENT;
    p[14] = QS_CLASS_LEGACY;
    p[15] = QS_COMP_DIMMER;
    p[17] = 0x0B;
    p[18] = 0x09;
    p[19] = 0xFE;
    p[20] = 0xFF;
    p[22] = 0x02;
    g.phases[3].packet.len = 51;
    g.phases[3].retransmits = 5;
    g.phases[3].post_delay_ms = 200;

    /* Phase 4: Format 0x28 — Zone Assignment B */
    p = g.phases[4].packet.data;
    memset(p, 0xCC, 51);
    p[0] = 0xA9;
    p[1] = 0x01;
    put_be32(p + 2, hub_id_);
    p[6] = QS_FMT_ZONE;
    p[7] = 0x03;
    p[8] = 0x01;
    p[9] = QS_COMP_DIMMER;
    p[10] = zone_byte_ + 0x23;
    p[11] = QS_PROTO_RADIO_TX;
    p[12] = 0x1A;
    p[13] = 0x00;
    put_be32(p + 14, dev);
    p[18] = QS_ADDR_COMPONENT;
    p[19] = QS_CLASS_LEGACY;
    p[20] = QS_CLASS_LEVEL;
    p[24] = 0x01;
    p[25] = QS_ADDR_GROUP;
    p[26] = 0x20;
    p[28] = 0x03;
    p[29] = 0x09;
    p[30] = 0x2B;
    p[31] = 0xFF; /* variant B */
    p[33] = 0xFF;
    p[36] = 0xB4;
    g.phases[4].packet.len = 51;
    g.phases[4].retransmits = 5;
    g.phases[4].post_delay_ms = 200;

    /* Phase 5: Format 0x12 — Final Config with Zone Byte */
    p = g.phases[5].packet.data;
    memset(p, 0xCC, 51);
    p[0] = 0xAA;
    p[1] = 0x01;
    put_be32(p + 2, hub_id_);
    p[6] = QS_PROTO_RADIO_TX;
    p[7] = QS_FMT_FINAL; /* 0x12 */
    p[8] = 0x00;
    put_be32(p + 9, dev);
    p[13] = QS_ADDR_COMPONENT;
    p[14] = QS_CLASS_LEGACY;
    p[15] = 0x6E;
    p[16] = 0x01;
    p[18] = 0x07;
    p[20] = 0x02;
    p[24] = zone_byte_;    /* THE ZONE ASSIGNMENT */
    p[25] = QS_ADDR_GROUP; /* 0xEF */
    g.phases[5].packet.len = 51;
    g.phases[5].retransmits = 8;
    g.phases[5].post_delay_ms = 0;

    g.phase_count = 6;
    g.on_complete = config_complete;

    if (cca_tdma_submit_group(&g)) {
        config_submitted_ = true;
        printf("[auto-pair] Config group submitted (6 phases)\r\n");
    }
    else {
        printf("[auto-pair] Config group submit FAILED\r\n");
    }
}

static void config_complete(void* ctx)
{
    (void)ctx;
    printf("[auto-pair] Config complete — device should be paired\r\n");
    config_submitted_ = false;
}

/* -----------------------------------------------------------------------
 * Stop beacon (timer=0x00)
 * ----------------------------------------------------------------------- */
static void submit_stop_beacon(void)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;

    uint8_t* pkt = g.phases[0].packet.data;
    memset(pkt, 0xCC, 51);
    pkt[0] = 0xBB;
    put_be32(pkt + 2, hub_id_);
    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = QS_FMT_LED;
    pkt[8] = 0x00;
    pkt[9] = QS_ADDR_BROADCAST;
    pkt[10] = QS_ADDR_BROADCAST;
    pkt[11] = QS_ADDR_BROADCAST;
    pkt[12] = QS_ADDR_BROADCAST;
    pkt[13] = QS_ADDR_BROADCAST;
    pkt[14] = 0x60;
    pkt[15] = 0x00;
    put_be32(pkt + 16, hub_id_);
    pkt[20] = 0xFF;
    pkt[21] = 0xFF;
    pkt[22] = 0xFF;
    pkt[23] = 0xFF;
    pkt[24] = 0x00; /* timer: STOP */

    g.phases[0].packet.len = 51;
    g.phases[0].retransmits = 3;
    cca_tdma_submit_group(&g);
}

/* -----------------------------------------------------------------------
 * RX hook
 * ----------------------------------------------------------------------- */
static void auto_pair_rx_hook(const DecodedPacket* pkt)
{
    if (!pkt || !pkt->valid) return;

    /* Device announce — B8, B9 (alternate), or BA. RMJS uses B9 format 0x23.
     * Filter out our own hub_id to avoid catching our accept packets. */
    if ((pkt->type_byte == 0xB8 || pkt->type_byte == 0xB9 || pkt->type_byte == 0xBA) &&
        (state_ == AUTO_PAIR_BEACONING || state_ == AUTO_PAIR_ANNOUNCING)) {
        uint32_t dev_id = ((uint32_t)pkt->raw[2] << 24) | ((uint32_t)pkt->raw[3] << 16) | ((uint32_t)pkt->raw[4] << 8) |
                          (uint32_t)pkt->raw[5];

        if (dev_id == hub_id_) return; /* ignore our own accept packets */

        if (detected_serial_ == 0) {
            detected_serial_ = dev_id;
            detect_time_ms_ = HAL_GetTick();
            state_ = AUTO_PAIR_ANNOUNCING;

            printf("[auto-pair] 0x%02X detected: serial=%08X — accept+config+announce\r\n", pkt->type_byte,
                   (unsigned)dev_id);

            submit_announce_group();
            submit_config_group();
        }
        return;
    }

    /* 0x0B ACK from device — log it */
    if (pkt->type_byte == 0x0B && state_ == AUTO_PAIR_ANNOUNCING) {
        /* Device is acknowledging config packets — good sign */
    }
}

/* -----------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

void cca_auto_pair_start(uint32_t hub_id, uint32_t device_class, uint16_t subnet, uint8_t zone_byte,
                         uint8_t duration_sec)
{
    if (state_ != AUTO_PAIR_IDLE) cca_auto_pair_stop();

    hub_id_ = hub_id;
    device_class_ = device_class;
    subnet_ = subnet;
    zone_byte_ = zone_byte;
    duration_ms_ = (duration_sec == 0 ? 60 : duration_sec) * 1000;
    start_ms_ = HAL_GetTick();
    detected_serial_ = 0;
    detect_time_ms_ = 0;
    beacon_active_ = false;
    announce_active_ = false;
    config_submitted_ = false;

    printf("[auto-pair] START hub=%08X class=%08X subnet=%04X zone=0x%02X dur=%lus\r\n", (unsigned)hub_id,
           (unsigned)device_class, subnet, zone_byte, (unsigned long)(duration_ms_ / 1000));

    state_ = AUTO_PAIR_BEACONING;
    cca_set_rx_hook(auto_pair_rx_hook);
    submit_beacon_group();
}

void cca_auto_pair_stop(void)
{
    if (state_ == AUTO_PAIR_IDLE) return;

    printf("[auto-pair] STOP (serial=%08X)\r\n", (unsigned)detected_serial_);

    cca_tdma_cancel_groups();
    submit_stop_beacon();
    cca_set_rx_hook(NULL);
    state_ = AUTO_PAIR_IDLE;
    beacon_active_ = false;
    announce_active_ = false;
    config_submitted_ = false;
}

void cca_auto_pair_poll(void)
{
    if (state_ == AUTO_PAIR_IDLE || state_ == AUTO_PAIR_DONE) return;

    uint32_t now = HAL_GetTick();

    if ((now - start_ms_) >= duration_ms_) {
        printf("[auto-pair] Timeout after %lus\r\n", (unsigned long)((now - start_ms_) / 1000));
        cca_auto_pair_stop();
        return;
    }

    /* Safety: resubmit beacon if expired */
    if (!beacon_active_ && state_ != AUTO_PAIR_IDLE) {
        submit_beacon_group();
    }
    /* Safety: resubmit announce if expired */
    if (!announce_active_ && state_ == AUTO_PAIR_ANNOUNCING && detected_serial_ != 0) {
        submit_announce_group();
    }
}

AutoPairState cca_auto_pair_state(void)
{
    return state_;
}

uint32_t cca_auto_pair_detected_serial(void)
{
    return detected_serial_;
}
