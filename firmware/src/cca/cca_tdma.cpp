/**
 * CCA TDMA Engine — frame synchronization and slot-aware TX scheduling.
 *
 * Promotes the observation-only slot-lock model from cca_task.cpp into a full
 * TDMA participant: frame sync from RX timestamps, slot occupancy tracking,
 * TX job scheduling at correct slot windows, sequence number management.
 *
 * Key timing model: each seq increment = 12.5ms.  Devices on an 8-slot frame
 * increment seq by their stride (e.g., +6 for slot 6), producing 75ms between
 * retransmissions of the same packet.  Low 3 bits of seq = slot number.
 */

#include "cca_tdma.h"
#include "cca_encoder.h"
#include "cca_crc.h"
#include "cca_types.h"
#include "cc1101.h"
#include "stream.h"

#include "stm32h7xx_hal.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>

/* -----------------------------------------------------------------------
 * Constants
 * ----------------------------------------------------------------------- */
#define SLOT_MS_X2 25          /* 12.5ms in half-ms units */
#define MAX_DSEQ 32            /* max sequence delta to track */
#define WARMUP_SAMPLES 8       /* samples before full confidence weight */
#define GOOD_ERR_Q2 5          /* 2.5ms — acceptable timing error */
#define MAX_DT_MS 400          /* ignore gaps larger than this */
#define STALE_MS 1200          /* evict devices not heard for this long */
#define ERR_SCORE_SPAN_Q2 12   /* 6ms — full error range for scoring */
#define FRAME_SYNC_MIN_CONF 40 /* minimum confidence to use frame sync for TX */

/* -----------------------------------------------------------------------
 * Per-device slot observation
 * ----------------------------------------------------------------------- */
struct TdmaDeviceSlot {
    bool in_use;
    bool have_anchor;
    uint32_t device_id;
    uint32_t last_ts_ms;
    uint32_t last_seen_ms;
    uint8_t last_seq;
    uint8_t dominant_stride;
    uint8_t confidence;
    uint16_t samples;
    uint16_t good_samples;
    uint16_t ema_abs_err_q2;
    uint16_t stride_hist[MAX_DSEQ + 1];
};

/* -----------------------------------------------------------------------
 * TX job
 * ----------------------------------------------------------------------- */
struct CcaTdmaJob {
    bool active;
    uint8_t packet[64]; /* raw packet (pre-CRC, pre-N81) */
    uint8_t packet_len;
    uint8_t slot;       /* assigned slot for this burst */
    uint8_t seq_base;   /* starting sequence (low bits = slot) */
    uint8_t seq_stride; /* = slot_count (8 typical) */
    uint8_t retries_total;
    uint8_t retries_done;
    uint32_t next_fire_ms; /* when to fire next retransmit */
    uint8_t type_rotate;   /* 0=none, 1=rotate 81/82/83 */
    uint8_t priority;

    /* Completion callback */
    void (*on_complete)(CcaTdmaTxRequest* req, bool success);
    void* user_data;
};

/* -----------------------------------------------------------------------
 * Frame sync state
 * ----------------------------------------------------------------------- */
struct TdmaFrameSync {
    uint32_t anchor_ms;  /* inferred slot-0 boundary */
    uint32_t period_ms;  /* frame period (default 75) */
    uint8_t slot_mask;   /* 7 = 8 slots */
    uint8_t slot_count;  /* 8 */
    uint8_t confidence;  /* 0-100 weighted from all device observations */
    uint8_t our_slot;    /* assigned slot for our TX */
    bool our_slot_valid; /* have we picked a slot? */
};

/* -----------------------------------------------------------------------
 * Module state
 * ----------------------------------------------------------------------- */
static TdmaDeviceSlot devices_[CCA_TDMA_MAX_DEVICES] = {};
static CcaTdmaJob jobs_[CCA_TDMA_MAX_JOBS] = {};
static TdmaFrameSync frame_ = {};
static bool paused_ = false;
static bool initialized_ = false;
static TdmaJobGroup groups_[TDMA_MAX_GROUPS] = {};

/* -----------------------------------------------------------------------
 * Device slot observation (promoted from cca_task.cpp slot-lock code)
 * ----------------------------------------------------------------------- */
static void clear_device(TdmaDeviceSlot& d)
{
    d.in_use = false;
    d.have_anchor = false;
    d.device_id = 0;
    d.last_ts_ms = 0;
    d.last_seen_ms = 0;
    d.last_seq = 0;
    d.dominant_stride = 0;
    d.confidence = 0;
    d.samples = 0;
    d.good_samples = 0;
    d.ema_abs_err_q2 = 0;
    memset(d.stride_hist, 0, sizeof(d.stride_hist));
}

static uint8_t compute_confidence(const TdmaDeviceSlot& d)
{
    if (d.samples == 0) return 0;

    uint32_t warmup_pct = (d.samples >= WARMUP_SAMPLES) ? 100u : (uint32_t)d.samples * 100u / WARMUP_SAMPLES;
    uint32_t good_rate_pct = (uint32_t)d.good_samples * 100u / d.samples;

    uint32_t err_score_pct = 0;
    if (d.ema_abs_err_q2 < ERR_SCORE_SPAN_Q2) {
        err_score_pct = 100u - ((uint32_t)d.ema_abs_err_q2 * 100u / ERR_SCORE_SPAN_Q2);
    }

    uint32_t quality_pct = (7u * good_rate_pct + 3u * err_score_pct + 5u) / 10u;
    uint32_t conf = (quality_pct * warmup_pct + 50u) / 100u;
    if (conf > 100u) conf = 100u;
    return (uint8_t)conf;
}

static uint8_t find_dominant_stride(const TdmaDeviceSlot& d)
{
    uint8_t best_stride = 0;
    uint16_t best_count = 0;
    for (uint8_t s = 1; s <= MAX_DSEQ; s++) {
        uint16_t c = d.stride_hist[s];
        if (c > best_count || (c == best_count && c > 0 && s < best_stride)) {
            best_count = c;
            best_stride = s;
        }
    }
    return best_stride;
}

static TdmaDeviceSlot* device_get_or_alloc(uint32_t device_id, uint32_t now_ms)
{
    TdmaDeviceSlot* free_slot = nullptr;
    TdmaDeviceSlot* oldest = nullptr;
    uint32_t oldest_age = 0;

    for (size_t i = 0; i < CCA_TDMA_MAX_DEVICES; i++) {
        TdmaDeviceSlot& d = devices_[i];
        if (d.in_use) {
            if (d.device_id == device_id) return &d;
            uint32_t age = now_ms - d.last_seen_ms;
            if (!oldest || age > oldest_age) {
                oldest = &d;
                oldest_age = age;
            }
        }
        else if (!free_slot) {
            free_slot = &d;
        }
    }

    TdmaDeviceSlot* target = free_slot ? free_slot : oldest;
    if (!target) return nullptr;

    clear_device(*target);
    target->in_use = true;
    target->device_id = device_id;
    target->last_seen_ms = now_ms;
    return target;
}

static void observe_device(const DecodedPacket& pkt, uint32_t timestamp_ms)
{
    if (!pkt.crc_valid || pkt.device_id == 0) return;

    TdmaDeviceSlot* d = device_get_or_alloc(pkt.device_id, timestamp_ms);
    if (!d) return;

    if (!d->have_anchor) {
        d->last_ts_ms = timestamp_ms;
        d->last_seq = pkt.sequence;
        d->last_seen_ms = timestamp_ms;
        d->have_anchor = true;
        return;
    }

    uint32_t dt_ms = timestamp_ms - d->last_ts_ms;
    uint8_t dseq = (uint8_t)((pkt.sequence - d->last_seq) & 0xFFu);

    d->last_ts_ms = timestamp_ms;
    d->last_seq = pkt.sequence;
    d->last_seen_ms = timestamp_ms;

    if (dt_ms == 0 || dt_ms > MAX_DT_MS) return;
    if (dseq == 0 || dseq > MAX_DSEQ) return;

    int32_t err_q2 = (int32_t)(dt_ms * 2u) - (int32_t)(SLOT_MS_X2 * dseq);
    uint16_t abs_err_q2 = (uint16_t)((err_q2 < 0) ? -err_q2 : err_q2);

    if (d->samples < 0xFFFFu) d->samples++;
    if (abs_err_q2 <= GOOD_ERR_Q2 && d->good_samples < 0xFFFFu) d->good_samples++;

    if (d->samples == 1) {
        d->ema_abs_err_q2 = abs_err_q2;
    }
    else {
        uint32_t ema = (uint32_t)d->ema_abs_err_q2 * 8u + (uint32_t)abs_err_q2 * 2u;
        d->ema_abs_err_q2 = (uint16_t)((ema + 5u) / 10u);
    }

    if (d->stride_hist[dseq] < 0xFFFFu) d->stride_hist[dseq]++;
    d->dominant_stride = find_dominant_stride(*d);
    d->confidence = compute_confidence(*d);
}

/* -----------------------------------------------------------------------
 * Frame sync — derive global frame timing from all device observations
 * ----------------------------------------------------------------------- */

/** Get the slot a device is using based on its last sequence and the frame mask. */
static uint8_t device_slot(const TdmaDeviceSlot& d)
{
    return d.last_seq & frame_.slot_mask;
}

/**
 * Update frame anchor from an RX observation.
 * anchor = rx_timestamp - (device_slot * slot_duration_ms)
 * We use a weighted moving average across devices.
 */
static void update_frame_sync(const DecodedPacket& pkt, uint32_t timestamp_ms)
{
    if (!pkt.crc_valid || pkt.device_id == 0) return;

    uint8_t slot = pkt.sequence & frame_.slot_mask;
    uint32_t slot_offset_ms = (uint32_t)slot * frame_.period_ms / frame_.slot_count;
    uint32_t inferred_anchor = timestamp_ms - slot_offset_ms;

    if (frame_.confidence == 0) {
        /* First observation — just set anchor directly */
        frame_.anchor_ms = inferred_anchor;
        frame_.confidence = 10;
    }
    else {
        /* Weighted average: new anchor = 0.8 * old + 0.2 * observed
         * Use modular arithmetic to handle wraparound correctly. */
        int32_t delta = (int32_t)(inferred_anchor - frame_.anchor_ms);

        /* Only adjust if the delta is reasonable (within a few frames) */
        if (delta > -500 && delta < 500) {
            frame_.anchor_ms = frame_.anchor_ms + (uint32_t)(delta / 5);
        }
    }

    /* Update overall confidence from device observations */
    uint32_t total_conf = 0;
    uint32_t count = 0;
    for (size_t i = 0; i < CCA_TDMA_MAX_DEVICES; i++) {
        if (devices_[i].in_use && devices_[i].confidence > 0) {
            total_conf += devices_[i].confidence;
            count++;
        }
    }
    if (count > 0) {
        frame_.confidence = (uint8_t)((total_conf + count / 2) / count);
    }
}

/**
 * Build slot occupancy map — which slots have active devices.
 * Returns bitmap of occupied slots (bit N = slot N occupied).
 */
static uint64_t build_occupancy_map(uint32_t now_ms)
{
    uint64_t occupied = 0;
    for (size_t i = 0; i < CCA_TDMA_MAX_DEVICES; i++) {
        TdmaDeviceSlot& d = devices_[i];
        if (!d.in_use) continue;

        uint32_t age = now_ms - d.last_seen_ms;
        if (age > STALE_MS) {
            clear_device(d);
            continue;
        }

        if (d.confidence > 30) {
            uint8_t slot = device_slot(d);
            occupied |= (1ULL << slot);
        }
    }
    return occupied;
}

/**
 * Pick an unused slot for our TX.
 * Prefers slots not occupied by any observed device.
 */
static uint8_t pick_tx_slot(uint32_t now_ms)
{
    uint64_t occupied = build_occupancy_map(now_ms);

    /* Also mark slots used by active TX jobs */
    for (size_t i = 0; i < CCA_TDMA_MAX_JOBS; i++) {
        if (jobs_[i].active) {
            occupied |= (1ULL << jobs_[i].slot);
        }
    }

    /* Find first free slot */
    for (uint8_t s = 0; s < frame_.slot_count; s++) {
        if (!(occupied & (1ULL << s))) {
            return s;
        }
    }

    /* All occupied — pick the slot with the weakest/oldest device */
    uint8_t best_slot = 0;
    uint32_t best_age = 0;
    for (size_t i = 0; i < CCA_TDMA_MAX_DEVICES; i++) {
        const TdmaDeviceSlot& d = devices_[i];
        if (!d.in_use) continue;
        uint32_t age = now_ms - d.last_seen_ms;
        if (age > best_age) {
            best_age = age;
            best_slot = device_slot(d);
        }
    }
    return best_slot;
}

/* -----------------------------------------------------------------------
 * TX job management
 * ----------------------------------------------------------------------- */
static CcaTdmaJob* alloc_job(void)
{
    for (size_t i = 0; i < CCA_TDMA_MAX_JOBS; i++) {
        if (!jobs_[i].active) return &jobs_[i];
    }
    return nullptr;
}

/**
 * Transmit one packet: CRC append → N81 encode → CC1101 TX → stream echo.
 * Mirrors the transmit_one pattern from cca_task.cpp / cca_commands.cpp.
 */
static bool transmit_one(const uint8_t* packet, size_t packet_len)
{
    /* Append CRC-16 */
    uint8_t with_crc[66];
    if (packet_len + 2 > sizeof(with_crc)) return false;
    cca_append_crc(packet, packet_len, with_crc);

    /* N81 encode with preamble */
    uint8_t encoded[128];
    CcaEncoder encoder;
    size_t encoded_len = encoder.encode_packet(with_crc, packet_len + 2, encoded, sizeof(encoded));
    if (encoded_len == 0) return false;

    /* Radio TX */
    bool ok = cc1101_transmit_raw(encoded, encoded_len);
    if (ok) {
        stream_send_cca_packet(packet, packet_len, 0, true, HAL_GetTick());
    }
    return ok;
}

/**
 * Compute when the next occurrence of our slot falls.
 * Returns absolute ms timestamp for the next slot window.
 */
static uint32_t next_slot_time(uint8_t slot, uint32_t now_ms)
{
    if (frame_.confidence < FRAME_SYNC_MIN_CONF) {
        /* No sync — fire immediately + frame_period for next */
        return now_ms + frame_.period_ms;
    }

    uint32_t slot_offset_ms = (uint32_t)slot * frame_.period_ms / frame_.slot_count;
    uint32_t elapsed = now_ms - frame_.anchor_ms;
    uint32_t frame_phase = elapsed % frame_.period_ms;

    uint32_t target_phase = slot_offset_ms;
    uint32_t wait;
    if (target_phase > frame_phase) {
        wait = target_phase - frame_phase;
    }
    else {
        wait = frame_.period_ms - frame_phase + target_phase;
    }

    /* If the wait is very short (< 2ms), skip to next frame to avoid jitter */
    if (wait < 2) {
        wait += frame_.period_ms;
    }

    return now_ms + wait;
}

/**
 * Fire a single retransmit for a job: update packet seq/type, TX, advance state.
 * Returns true if the job has more retransmits remaining.
 */
static bool fire_job(CcaTdmaJob* job, uint32_t now_ms)
{
    /* Update sequence byte in packet */
    uint8_t seq = job->seq_base + (uint8_t)(job->retries_done * job->seq_stride);
    if (job->packet_len > 1) {
        job->packet[1] = seq;
    }

    /* Rotate type byte if requested (0x81 → 0x82 → 0x83 → 0x81...) */
    if (job->type_rotate && job->packet_len > 0) {
        uint8_t base = 0x81;
        job->packet[0] = base + (uint8_t)(job->retries_done % 3);
    }

    /* Stop RX, transmit, restart RX */
    cc1101_stop_rx();
    bool ok = transmit_one(job->packet, job->packet_len);
    cc1101_start_rx();

    job->retries_done++;

    if (!ok || job->retries_done >= job->retries_total) {
        /* Job complete */
        if (job->on_complete) {
            CcaTdmaTxRequest req;
            memcpy(req.packet, job->packet, job->packet_len);
            req.packet_len = job->packet_len;
            req.retries = job->retries_total;
            req.user_data = job->user_data;
            job->on_complete(&req, ok);
        }
        job->active = false;
        return false;
    }

    /* Schedule next retransmit one frame period after the PREVIOUS scheduled
     * fire time, not from now_ms. This keeps 75ms spacing regardless of TX
     * duration (~5ms). If we've drifted too far, fall back to now_ms. */
    uint32_t next = job->next_fire_ms + frame_.period_ms;
    if ((int32_t)(next - now_ms) < 2 || (int32_t)(next - now_ms) > (int32_t)frame_.period_ms) {
        next = next_slot_time(job->slot, now_ms);
    }
    job->next_fire_ms = next;
    return true;
}

/**
 * Fire one packet from a job group: update seq/type, TX, advance state.
 */
static void fire_group_packet(TdmaJobGroup* g, uint32_t now_ms)
{
    TdmaPhase* phase = &g->phases[g->current_phase];
    uint8_t pkt[53];
    memcpy(pkt, phase->packet.data, phase->packet.len);

    /* Set sequence byte: low bits = slot, upper bits = counter */
    if (phase->packet.len > 1) {
        pkt[1] = g->slot + (uint8_t)(g->current_retransmit * frame_.slot_count);
    }

    /* Rotate type byte if requested (0x81 → 0x82 → 0x83 → 0x81...) */
    if (phase->packet.type_rotate && phase->packet.len > 0) {
        pkt[0] = 0x81 + (uint8_t)(g->current_retransmit % 3);
    }

    /* Stop RX, transmit, restart RX */
    cc1101_stop_rx();
    transmit_one(pkt, phase->packet.len);
    cc1101_start_rx();

    g->current_retransmit++;

    if (g->current_retransmit >= phase->retransmits) {
        /* Phase complete — advance to next */
        g->current_phase++;
        g->current_retransmit = 0;

        if (g->current_phase >= g->phase_count) {
            /* All phases done */
            if (g->on_complete) {
                g->on_complete(g->ctx);
            }
            g->active = false;
            return;
        }

        /* Apply post-delay if specified */
        if (phase->post_delay_ms > 0) {
            g->next_fire_ms = now_ms + phase->post_delay_ms;
        }
        else {
            g->next_fire_ms = next_slot_time(g->slot, now_ms);
        }
    }
    else {
        /* Schedule next retransmit one frame period later */
        uint32_t next = g->next_fire_ms + frame_.period_ms;
        if ((int32_t)(next - now_ms) < 2 || (int32_t)(next - now_ms) > (int32_t)frame_.period_ms) {
            next = next_slot_time(g->slot, now_ms);
        }
        g->next_fire_ms = next;
    }
}

/* -----------------------------------------------------------------------
 * Hot poll — should the task poll at 1ms instead of 2ms?
 * Returns true if any job is due within the next 7ms.
 * ----------------------------------------------------------------------- */
static bool should_hot_poll(uint32_t now_ms)
{
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        if (!groups_[i].active) continue;
        int32_t until = (int32_t)(groups_[i].next_fire_ms - now_ms);
        if (until >= -2 && until <= 7) return true;
    }

    for (size_t i = 0; i < CCA_TDMA_MAX_JOBS; i++) {
        if (!jobs_[i].active) continue;
        int32_t until = (int32_t)(jobs_[i].next_fire_ms - now_ms);
        if (until >= -2 && until <= 7) return true;
    }

    /* Also hot-poll around expected device arrivals for RX quality */
    for (size_t i = 0; i < CCA_TDMA_MAX_DEVICES; i++) {
        const TdmaDeviceSlot& d = devices_[i];
        if (!d.in_use || d.confidence < 60 || d.dominant_stride == 0) continue;

        uint32_t age = now_ms - d.last_seen_ms;
        if (age > STALE_MS) continue;

        uint32_t step_q2 = (uint32_t)d.dominant_stride * SLOT_MS_X2;
        if (step_q2 == 0) continue;

        uint32_t now_q2 = now_ms * 2u;
        uint32_t elapsed_q2 = now_q2 - d.last_ts_ms * 2u;
        uint32_t phase_q2 = elapsed_q2 % step_q2;
        uint32_t dist_q2 = phase_q2;
        uint32_t to_next_q2 = step_q2 - phase_q2;
        if (to_next_q2 < dist_q2) dist_q2 = to_next_q2;

        if (dist_q2 <= 14u) return true; /* within 7ms */
    }

    return false;
}

/* -----------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

void cca_tdma_init(void)
{
    memset(devices_, 0, sizeof(devices_));
    memset(jobs_, 0, sizeof(jobs_));

    frame_.anchor_ms = 0;
    frame_.period_ms = CCA_TDMA_DEFAULT_FRAME_MS;
    frame_.slot_mask = CCA_TDMA_DEFAULT_SLOT_MASK;
    frame_.slot_count = CCA_TDMA_DEFAULT_SLOT_MASK + 1;
    frame_.confidence = 0;
    frame_.our_slot = 0;
    frame_.our_slot_valid = false;

    paused_ = false;
    initialized_ = true;
}

void cca_tdma_on_rx(const DecodedPacket* pkt, uint32_t timestamp_ms)
{
    if (!initialized_ || !pkt) return;
    observe_device(*pkt, timestamp_ms);
    update_frame_sync(*pkt, timestamp_ms);
}

CcaTdmaJob* cca_tdma_submit(const CcaTdmaTxRequest* req)
{
    if (!initialized_ || !req || req->packet_len == 0) return nullptr;

    CcaTdmaJob* job = alloc_job();
    if (!job) {
        printf("[tdma] TX queue full, dropping request\r\n");
        return nullptr;
    }

    uint32_t now = HAL_GetTick();

    /* Pick a slot for this burst */
    if (!frame_.our_slot_valid) {
        frame_.our_slot = pick_tx_slot(now);
        frame_.our_slot_valid = true;
    }

    memset(job, 0, sizeof(*job));
    job->active = true;
    memcpy(job->packet, req->packet, req->packet_len);
    job->packet_len = req->packet_len;
    job->slot = frame_.our_slot;
    job->seq_base = frame_.our_slot; /* low bits = slot number */
    job->seq_stride = frame_.slot_count;
    job->retries_total = req->retries > 0 ? req->retries : CCA_TDMA_RETRIES_NORMAL;
    job->retries_done = 0;
    job->type_rotate = req->type_rotate;
    job->priority = req->priority;
    job->on_complete = req->on_complete;
    job->user_data = req->user_data;

    /* Schedule first TX at next slot window */
    job->next_fire_ms = next_slot_time(job->slot, now);

    /* High-priority jobs fire immediately */
    if (req->priority > 0) {
        job->next_fire_ms = now;
    }

    return job;
}

void cca_tdma_cancel(CcaTdmaJob* job)
{
    if (!job) return;
    job->active = false;
}

bool cca_tdma_submit_group(const TdmaJobGroup* group)
{
    if (!initialized_ || !group || group->phase_count == 0) return false;

    TdmaJobGroup* g = nullptr;
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        if (!groups_[i].active) {
            g = &groups_[i];
            break;
        }
    }
    if (!g) {
        printf("[tdma] Job group queue full\r\n");
        return false;
    }

    uint32_t now = HAL_GetTick();

    if (!frame_.our_slot_valid) {
        frame_.our_slot = pick_tx_slot(now);
        frame_.our_slot_valid = true;
    }

    memcpy(g, group, sizeof(TdmaJobGroup));
    g->slot = frame_.our_slot;
    g->current_phase = 0;
    g->current_retransmit = 0;
    g->next_fire_ms = next_slot_time(g->slot, now);
    g->active = true;

    return true;
}

void cca_tdma_cancel_groups(void)
{
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        groups_[i].active = false;
    }
}

bool cca_tdma_is_idle(void)
{
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        if (groups_[i].active) return false;
    }
    for (size_t i = 0; i < CCA_TDMA_MAX_JOBS; i++) {
        if (jobs_[i].active) return false;
    }
    return true;
}

uint32_t cca_tdma_poll(uint32_t now_ms)
{
    if (!initialized_ || paused_) {
        return should_hot_poll(now_ms) ? 1 : 2;
    }

    /* Fire any due TX jobs */
    for (size_t i = 0; i < CCA_TDMA_MAX_JOBS; i++) {
        CcaTdmaJob* job = &jobs_[i];
        if (!job->active) continue;

        int32_t until = (int32_t)(job->next_fire_ms - now_ms);
        if (until <= 0) {
            fire_job(job, now_ms);
        }
    }

    /* Fire due job group packets */
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        TdmaJobGroup* g = &groups_[i];
        if (!g->active) continue;

        int32_t until = (int32_t)(g->next_fire_ms - now_ms);
        if (until <= 0) {
            fire_group_packet(g, now_ms);
            break; /* at most one TX per poll cycle */
        }
    }

    /* Determine next poll interval */
    return should_hot_poll(now_ms) ? 1 : 2;
}

void cca_tdma_pause(void)
{
    paused_ = true;
}

void cca_tdma_resume(void)
{
    paused_ = false;
}

bool cca_tdma_is_paused(void)
{
    return paused_;
}

void cca_tdma_get_state(CcaTdmaFrameState* out)
{
    if (!out) return;

    out->anchor_ms = frame_.anchor_ms;
    out->period_ms = frame_.period_ms;
    out->slot_mask = frame_.slot_mask;
    out->slot_count = frame_.slot_count;
    out->our_slot = frame_.our_slot;
    out->confidence = frame_.confidence;

    /* Count occupied slots and active devices */
    uint32_t now = HAL_GetTick();
    uint64_t occ = build_occupancy_map(now);
    uint8_t occ_count = 0;
    for (uint8_t s = 0; s < frame_.slot_count; s++) {
        if (occ & (1ULL << s)) occ_count++;
    }
    out->occupied_count = occ_count;

    uint32_t dev_count = 0;
    for (size_t i = 0; i < CCA_TDMA_MAX_DEVICES; i++) {
        if (devices_[i].in_use) dev_count++;
    }
    out->total_devices = dev_count;

    uint8_t active_jobs = 0;
    for (size_t i = 0; i < CCA_TDMA_MAX_JOBS; i++) {
        if (jobs_[i].active) active_jobs++;
    }
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        if (groups_[i].active) active_jobs++;
    }
    out->active_jobs = active_jobs;
}

size_t cca_tdma_get_devices(CcaTdmaDeviceInfo* out, size_t max_devices)
{
    if (!out || max_devices == 0) return 0;

    size_t count = 0;
    for (size_t i = 0; i < CCA_TDMA_MAX_DEVICES && count < max_devices; i++) {
        TdmaDeviceSlot& d = devices_[i];
        if (!d.in_use) continue;

        CcaTdmaDeviceInfo& info = out[count++];
        info.device_id = d.device_id;
        info.last_rx_ms = d.last_seen_ms;
        info.slot = device_slot(d);
        info.last_seq = d.last_seq;
        info.dominant_stride = d.dominant_stride;
        info.confidence = d.confidence;
        info.samples = d.samples;
        info.active = true;
    }
    return count;
}

void cca_tdma_reset(void)
{
    for (size_t i = 0; i < CCA_TDMA_MAX_DEVICES; i++) {
        clear_device(devices_[i]);
    }
    for (size_t i = 0; i < CCA_TDMA_MAX_JOBS; i++) {
        jobs_[i].active = false;
    }
    for (size_t i = 0; i < TDMA_MAX_GROUPS; i++) {
        groups_[i].active = false;
    }
    frame_.confidence = 0;
    frame_.anchor_ms = 0;
    frame_.our_slot_valid = false;
}
