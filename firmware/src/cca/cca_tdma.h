#ifndef CCA_TDMA_H
#define CCA_TDMA_H

/**
 * CCA TDMA Engine — frame synchronization and slot-aware TX scheduling.
 *
 * Lutron CCA uses TDMA: the sequence byte's low bits encode the slot number.
 * Devices stay in their assigned slot across retransmits by incrementing the
 * sequence by the slot count (typically 8).  Frame period is ~75ms for 8 slots
 * (~9.375ms per slot).
 *
 * This module:
 *   1. Observes RX timestamps to build a frame sync model
 *   2. Tracks which slots are occupied by which devices
 *   3. Schedules TX jobs to fire at the correct slot within each frame
 *   4. Manages sequence numbers (low bits = slot, upper bits = counter)
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* Forward declaration — defined in cca_generated.h / cca_types.h */
struct DecodedPacket;

#ifdef __cplusplus
extern "C" {
#endif

/* -----------------------------------------------------------------------
 * Constants
 * ----------------------------------------------------------------------- */
#define CCA_TDMA_DEFAULT_SLOT_MASK 7    /* 8 slots (AND #7) — standard CCA */
#define CCA_TDMA_DEFAULT_FRAME_MS  75   /* 8 slots × ~9.375ms */
#define CCA_TDMA_SLOT_DURATION_US  9375 /* 75ms / 8 in microseconds */
#define CCA_TDMA_MAX_SLOTS         64   /* maximum possible (AND #63) */
#define CCA_TDMA_MAX_DEVICES       32   /* tracked device slots */
#define CCA_TDMA_MAX_JOBS          4    /* concurrent TX jobs */

/* Retry counts matching Lutron firmware */
#define CCA_TDMA_RETRIES_NORMAL       5
#define CCA_TDMA_RETRIES_LEVEL        20
#define CCA_TDMA_RETRIES_BUTTON_SHORT 6
#define CCA_TDMA_RETRIES_BUTTON_LONG  10
#define CCA_TDMA_RETRIES_PAIRING      10
#define CCA_TDMA_RETRIES_SCENE        10

/* -----------------------------------------------------------------------
 * Frame sync state (read-only snapshot for telemetry)
 * ----------------------------------------------------------------------- */
typedef struct {
    uint32_t anchor_ms;      /* timestamp of last inferred slot-0 boundary */
    uint32_t period_ms;      /* observed frame period (default 75) */
    uint8_t  slot_mask;      /* active mask (7 = 8 slots) */
    uint8_t  slot_count;     /* slot_mask + 1 */
    uint8_t  our_slot;       /* slot assigned to our TX */
    uint8_t  confidence;     /* 0-100 frame sync quality */
    uint8_t  occupied_count; /* number of slots with active devices */
    uint8_t  active_jobs;    /* number of pending TX jobs */
    uint32_t total_devices;  /* tracked devices */
} CcaTdmaFrameState;

/* -----------------------------------------------------------------------
 * Per-device slot info (for telemetry display)
 * ----------------------------------------------------------------------- */
typedef struct {
    uint32_t device_id;
    uint32_t last_rx_ms;
    uint8_t  slot;
    uint8_t  last_seq;
    uint8_t  dominant_stride;
    uint8_t  confidence;
    uint16_t samples;
    bool     active;
} CcaTdmaDeviceInfo;

/* -----------------------------------------------------------------------
 * TX request — caller fills this and submits to TDMA engine
 * ----------------------------------------------------------------------- */
typedef struct CcaTdmaTxRequest {
    uint8_t packet[64];  /* raw packet data (pre-CRC, pre-N81) */
    uint8_t packet_len;  /* 22 or 51 (before 2-byte CRC) */
    uint8_t retries;     /* total retransmissions (5/10/20) */
    uint8_t type_rotate; /* 0=no rotation, 1=rotate type 0x81/82/83 */
    uint8_t priority;    /* 0=normal, 1=high (pairing) */

    /* Optional completion callback (called from CCA task context) */
    void (*on_complete)(struct CcaTdmaTxRequest* req, bool success);
    void* user_data; /* opaque pointer for callback */
} CcaTdmaTxRequest;

/* Opaque job handle */
typedef struct CcaTdmaJob CcaTdmaJob;

/* -----------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

/** Initialize the TDMA engine. Call once from cca_task_start(). */
void cca_tdma_init(void);

/**
 * Feed an RX packet observation into the frame sync model.
 * Called from the RX callback path for every CRC-valid packet.
 */
void cca_tdma_on_rx(const struct DecodedPacket* pkt, uint32_t timestamp_ms);

/**
 * Submit a TX request for TDMA-scheduled transmission.
 * The engine copies the request and manages retransmissions.
 * Returns a job handle for cancellation, or NULL if queue is full.
 */
CcaTdmaJob* cca_tdma_submit(const CcaTdmaTxRequest* req);

/** Cancel a pending TX job. Safe to call with NULL. */
void cca_tdma_cancel(CcaTdmaJob* job);

/**
 * Poll for due TX jobs. Called from the CCA task main loop.
 * Fires any TX whose slot window has arrived.
 * Returns suggested ms until next event (for poll interval tuning).
 */
uint32_t cca_tdma_poll(uint32_t now_ms);

/** Suppress TX scheduling (pairing engine calls this during handshake). */
void cca_tdma_pause(void);

/** Resume TX scheduling after pairing. */
void cca_tdma_resume(void);

/** Check if TDMA TX is paused. */
bool cca_tdma_is_paused(void);

/** Get current frame sync state snapshot. */
void cca_tdma_get_state(CcaTdmaFrameState* out);

/**
 * Get device slot info for telemetry display.
 * Fills up to max_devices entries, returns actual count.
 */
size_t cca_tdma_get_devices(CcaTdmaDeviceInfo* out, size_t max_devices);

/** Reset all TDMA state (frame sync, device slots, active jobs). */
void cca_tdma_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* CCA_TDMA_H */
