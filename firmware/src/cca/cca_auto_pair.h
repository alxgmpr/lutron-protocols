#ifndef CCA_AUTO_PAIR_H
#define CCA_AUTO_PAIR_H

/**
 * Non-blocking auto-pair engine — Vive B9 beacons + B0 spoofed announce,
 * all via TDMA job groups so everything interleaves naturally.
 *
 * Flow:
 *   1. Submit B9 beacon group (auto-resubmits via on_complete)
 *   2. RX hook catches B8 announce from device → grabs serial
 *   3. Submit B0 announce group to RA3 (auto-resubmits)
 *   4. RX hook catches RA3 bridge challenges → submits echo groups
 *   5. Beacon + announce continue throughout — everything interleaves
 *
 * Called from CCA task context (non-blocking):
 *   - cca_auto_pair_start() installs RX hook + submits initial beacon
 *   - cca_auto_pair_rx() called per RX packet (via rx_hook)
 *   - cca_auto_pair_poll() called each task loop iteration for timeouts
 *   - cca_auto_pair_stop() cancels everything
 */

#include <stdint.h>
#include <stdbool.h>

struct DecodedPacket;

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    AUTO_PAIR_IDLE = 0,
    AUTO_PAIR_BEACONING,  /* B9 beacons active, waiting for B8 */
    AUTO_PAIR_ANNOUNCING, /* B8 detected, B0 announce + B9 beacon active */
    AUTO_PAIR_DONE,       /* Timed out or manually stopped */
} AutoPairState;

/**
 * Start the auto-pair engine.
 *
 * @param hub_id       RA3 processor serial (goes in B9 beacon + B0 announce)
 * @param device_class QSDeviceClassTypeID for B0 announce (e.g. 0x16060101)
 * @param subnet       RA3 subnet (e.g. 0x82D7)
 * @param zone_byte    CCA zone byte for the device
 * @param duration_sec How long to beacon (0 = 60s default)
 */
void cca_auto_pair_start(uint32_t hub_id, uint32_t device_class,
                         uint16_t subnet, uint8_t zone_byte,
                         uint8_t duration_sec);

/** Stop the auto-pair engine (cancel all groups, remove RX hook). */
void cca_auto_pair_stop(void);

/** Poll for timeouts. Called from CCA task main loop. */
void cca_auto_pair_poll(void);

/** Current state (for shell status display). */
AutoPairState cca_auto_pair_state(void);

/** Device serial captured from B8 (0 if none yet). */
uint32_t cca_auto_pair_detected_serial(void);

#ifdef __cplusplus
}
#endif

#endif /* CCA_AUTO_PAIR_H */
