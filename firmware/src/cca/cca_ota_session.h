#ifndef CCA_OTA_SESSION_H
#define CCA_OTA_SESSION_H

/**
 * cca_ota_session — static buffer that holds the LDF body the host has
 * uploaded for a full-OTA TX session. The orchestrator (`cca_ota_full_tx_walk`
 * in cca_ota_tx.h) walks this buffer to drive on-air TX.
 *
 * The host uploads the body via the stream protocol's
 * STREAM_CMD_OTA_UPLOAD_{START,CHUNK,END} commands (see firmware/src/net/stream.h).
 *
 * Buffer is statically allocated (no heap, no FreeRTOS deps) — works in
 * the host-side test runner unchanged.
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Capacity of the static LDF body buffer (110 KB; LMJ body is ~102 KB). */
#define CCA_OTA_SESSION_CAPACITY (110u * 1024u)

/** Reset session — clears expected_len and body_len. */
void cca_ota_session_reset(void);

/** Begin a session. Returns false if expected_len > capacity. */
bool cca_ota_session_start(uint32_t expected_len);

/** Write `len` bytes at `offset` into the body buffer. Returns false if
 *  the session hasn't started, or offset+len would exceed expected_len.
 *  body_len is updated to max(prev, offset+len). */
bool cca_ota_session_write(uint32_t offset, const uint8_t* data, uint32_t len);

uint32_t cca_ota_session_expected_len(void);
uint32_t cca_ota_session_body_len(void);

/** True iff expected_len > 0 and body_len has caught up to it. */
bool cca_ota_session_complete(void);

/** Pointer to the static body buffer (read-only). */
const uint8_t* cca_ota_session_body(void);

#ifdef __cplusplus
}
#endif

#endif /* CCA_OTA_SESSION_H */
