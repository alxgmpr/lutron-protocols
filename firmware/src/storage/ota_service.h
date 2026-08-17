#ifndef OTA_SERVICE_H
#define OTA_SERVICE_H

/**
 * OTA upload session — binds the staging state machine (ota_image.h) to the
 * real slot (ota_flash.h) and holds the one in-flight session.
 *
 * Fills the staging slot on the external SPI NOR (ota_flash.h); the bootloader
 * reads it back from there to install.
 */

#include "ota_image.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    ota_status_t last_status; /* result of the most recent operation */
    uint32_t written;         /* contiguous bytes accepted in this session */
    uint32_t expected_len;    /* 0 when no session is active */
    bool active;
    /* Committed image currently in the slot, if any */
    bool staged_valid;
    uint32_t staged_len;
    uint32_t staged_version;
    uint32_t staged_crc32;
} ota_service_info_t;

/** Largest image the slot can accept. */
uint32_t ota_service_capacity(void);

/**
 * Erase the slot and open a session. Blocks for the sector erase (~1-2 s), so
 * the caller must ack this before the host starts sending chunks.
 */
ota_status_t ota_service_start(uint32_t image_len, uint32_t crc32, uint32_t version);

/** Append a contiguous chunk. OTA_ERR_GAP means "resume from ota_service_written()". */
ota_status_t ota_service_chunk(uint32_t offset, const uint8_t* data, uint32_t len);

/** Verify and commit the header. */
ota_status_t ota_service_end(void);

/** Abandon the in-flight session (leaves the slot erased/partial, no header). */
void ota_service_abort(void);

uint32_t ota_service_written(void);

/** Snapshot for the shell and the stream status response. */
void ota_service_info(ota_service_info_t* out);

/** Human-readable form of a status code, for logs and the shell. */
const char* ota_status_name(ota_status_t s);

#ifdef __cplusplus
}
#endif

#endif /* OTA_SERVICE_H */
