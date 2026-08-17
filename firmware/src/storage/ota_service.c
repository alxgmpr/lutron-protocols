/**
 * OTA upload session — see ota_service.h.
 */

#include "ota_service.h"
#include "ota_flash.h"

#include <stdio.h>
#include <string.h>

static ota_stage_t stage;
static bool session_active = false;
static uint32_t session_crc32 = 0;
static uint32_t session_version = 0;
static ota_status_t last_status = OTA_OK;
/** Set when an END committed a header; lets a retried END answer OK. */
static bool session_committed = false;

/**
 * What the host may actually send: the smaller of what the slot holds and what
 * the bootloader will install. The slot is the larger of the two, so reporting
 * it alone would invite an image that stages perfectly and then never boots.
 */
uint32_t ota_service_capacity(void)
{
    uint32_t slot = ota_stage_max_image(ota_flash_ops());
    return slot < OTA_APP_REGION_SIZE ? slot : OTA_APP_REGION_SIZE;
}

ota_status_t ota_service_start(uint32_t image_len, uint32_t crc32, uint32_t version)
{
    printf("[ota] Start: %lu bytes crc=0x%08lX version=%lu (erasing slot...)\r\n", (unsigned long)image_len,
           (unsigned long)crc32, (unsigned long)version);

    /* Before the erase, not after: refusing here costs the host a round trip,
     * refusing at install time costs it the whole upload and says nothing. */
    if (image_len > OTA_APP_REGION_SIZE) {
        last_status = OTA_ERR_CAPACITY;
        session_active = false;
        printf("[ota] Start rejected: %lu bytes exceeds the %lu byte application region\r\n", (unsigned long)image_len,
               (unsigned long)OTA_APP_REGION_SIZE);
        return OTA_ERR_CAPACITY;
    }

    ota_status_t st = ota_stage_begin(&stage, ota_flash_ops(), image_len);
    last_status = st;
    if (st != OTA_OK) {
        session_active = false;
        printf("[ota] Start rejected: %s\r\n", ota_status_name(st));
        return st;
    }

    session_crc32 = crc32;
    session_version = version;
    session_active = true;
    session_committed = false;
    printf("[ota] Slot erased, ready\r\n");
    return OTA_OK;
}

ota_status_t ota_service_chunk(uint32_t offset, const uint8_t* data, uint32_t len)
{
    if (!session_active) {
        last_status = OTA_ERR_STATE;
        return OTA_ERR_STATE;
    }
    ota_status_t st = ota_stage_write(&stage, offset, data, len);
    last_status = st;
    /* A gap is an expected consequence of a lost datagram, not an error worth
     * logging on every retry — the host resolves it from the acked high-water
     * mark. Anything else is worth seeing. */
    if (st != OTA_OK && st != OTA_ERR_GAP) {
        printf("[ota] Chunk at %lu (%lu bytes) failed: %s\r\n", (unsigned long)offset, (unsigned long)len,
               ota_status_name(st));
    }
    return st;
}

/**
 * Did the slot already commit the image this session was staging?
 *
 * END reads the whole slot back over a 1 MHz link, so it is the command most
 * likely to outrun the host's timeout — and the host retries it. Without this
 * the retry lands on a closed session and reports failure for an upload that
 * succeeded. A committed header carrying this session's CRC is proof it did.
 */
static bool staged_matches_session(void)
{
    ota_image_header_t hdr;
    if (ota_image_read_header(ota_flash_ops(), &hdr) != OTA_OK) return false;
    return hdr.image_crc32 == session_crc32 && hdr.image_len == stage.expected_len;
}

ota_status_t ota_service_end(void)
{
    if (!session_active) {
        /* A repeat of an END that already worked, not a stray one. */
        if (session_committed && staged_matches_session()) {
            last_status = OTA_OK;
            printf("[ota] Finish repeated; image already staged\r\n");
            return OTA_OK;
        }
        last_status = OTA_ERR_STATE;
        return OTA_ERR_STATE;
    }
    ota_status_t st = ota_stage_finish(&stage, session_crc32, session_version);
    last_status = st;
    session_active = false;
    session_committed = (st == OTA_OK);

    if (st == OTA_OK) {
        printf("[ota] Image staged and verified (%lu bytes, version %lu)\r\n", (unsigned long)stage.expected_len,
               (unsigned long)session_version);
    }
    else {
        printf("[ota] Finish failed: %s\r\n", ota_status_name(st));
    }
    return st;
}

void ota_service_abort(void)
{
    if (session_active) printf("[ota] Session aborted\r\n");
    session_active = false;
    session_committed = false;
    memset(&stage, 0, sizeof(stage));
}

uint32_t ota_service_written(void)
{
    return session_active ? ota_stage_written(&stage) : 0;
}

void ota_service_info(ota_service_info_t* out)
{
    if (out == NULL) return;
    memset(out, 0, sizeof(*out));
    out->last_status = last_status;
    out->active = session_active;
    out->written = ota_service_written();
    out->expected_len = session_active ? stage.expected_len : 0;

    ota_image_header_t hdr;
    if (ota_image_read_header(ota_flash_ops(), &hdr) == OTA_OK) {
        out->staged_valid = true;
        out->staged_len = hdr.image_len;
        out->staged_version = hdr.version;
        out->staged_crc32 = hdr.image_crc32;
    }
}

const char* ota_status_name(ota_status_t s)
{
    switch (s) {
    case OTA_OK:
        return "ok";
    case OTA_ERR_ARG:
        return "bad argument";
    case OTA_ERR_CAPACITY:
        return "image too large for slot";
    case OTA_ERR_STATE:
        return "no session active";
    case OTA_ERR_GAP:
        return "out of order — resume from written";
    case OTA_ERR_OVERRUN:
        return "write past declared length";
    case OTA_ERR_FLASH:
        return "flash error";
    case OTA_ERR_CRC:
        return "crc mismatch";
    case OTA_ERR_INCOMPLETE:
        return "incomplete image";
    }
    return "unknown";
}
