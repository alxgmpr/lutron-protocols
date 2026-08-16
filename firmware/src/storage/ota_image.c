/**
 * OTA staging — see ota_image.h.
 *
 * No HAL, no FreeRTOS: the flash backend is injected, so this file is compiled
 * unchanged into the host test runner.
 */

#include "ota_image.h"
#include "crc32.h"

#include <string.h>

/* Offset of the header word within the slot. */
static uint32_t header_offset(const ota_flash_ops_t* ops)
{
    return ops->capacity - OTA_FLASH_WORD;
}

uint32_t ota_stage_max_image(const ota_flash_ops_t* ops)
{
    if (ops == NULL || ops->capacity < OTA_FLASH_WORD) return 0;
    return ops->capacity - OTA_FLASH_WORD;
}

ota_status_t ota_stage_begin(ota_stage_t* st, const ota_flash_ops_t* ops, uint32_t expected_len)
{
    if (st == NULL || ops == NULL || ops->erase == NULL || ops->program == NULL || ops->read == NULL) {
        return OTA_ERR_ARG;
    }
    if (expected_len == 0) return OTA_ERR_ARG;
    if (ops->capacity % OTA_FLASH_WORD != 0) return OTA_ERR_ARG;
    /* Check capacity before erasing: a rejected request must not destroy a
     * previously staged image. */
    if (expected_len > ota_stage_max_image(ops)) return OTA_ERR_CAPACITY;

    if (ops->erase(ops->ctx) != 0) return OTA_ERR_FLASH;

    memset(st, 0, sizeof(*st));
    st->ops = ops;
    st->expected_len = expected_len;
    st->active = true;
    return OTA_OK;
}

uint32_t ota_stage_written(const ota_stage_t* st)
{
    return (st != NULL) ? st->written : 0;
}

ota_status_t ota_stage_write(ota_stage_t* st, uint32_t offset, const uint8_t* data, uint32_t len)
{
    if (st == NULL || (data == NULL && len > 0)) return OTA_ERR_ARG;
    if (!st->active) return OTA_ERR_STATE;
    /* Writes are strictly sequential. Anything else — a gap from a lost
     * datagram, or a rewind that would re-program a flash word — is refused
     * without touching state, so the caller can resume from st->written. */
    if (offset != st->written) return OTA_ERR_GAP;
    if (len > st->expected_len - st->written) return OTA_ERR_OVERRUN;
    if (len == 0) return OTA_OK;

    uint32_t consumed = 0;
    while (consumed < len) {
        uint32_t space = OTA_FLASH_WORD - st->pending_len;
        uint32_t n = len - consumed;
        if (n > space) n = space;
        memcpy(st->pending + st->pending_len, data + consumed, n);
        st->pending_len += n;
        consumed += n;

        if (st->pending_len == OTA_FLASH_WORD) {
            /* base = offset of the word we are about to program */
            uint32_t base = st->written + consumed - OTA_FLASH_WORD;
            if (st->ops->program(st->ops->ctx, base, st->pending) != 0) {
                /* Keep `written` at the last durably programmed byte. */
                st->written += consumed - OTA_FLASH_WORD;
                st->pending_len = 0;
                return OTA_ERR_FLASH;
            }
            st->pending_len = 0;
        }
    }

    st->written += len;
    return OTA_OK;
}

ota_status_t ota_stage_finish(ota_stage_t* st, uint32_t expected_crc32, uint32_t version)
{
    if (st == NULL) return OTA_ERR_ARG;
    if (!st->active) return OTA_ERR_STATE;
    if (st->written != st->expected_len) return OTA_ERR_INCOMPLETE;

    const ota_flash_ops_t* ops = st->ops;

    /* Flush the trailing partial word, padded with erase-state so the padding
     * is indistinguishable from never-written flash. */
    if (st->pending_len > 0) {
        uint8_t word[OTA_FLASH_WORD];
        memset(word, 0xFF, sizeof(word));
        memcpy(word, st->pending, st->pending_len);
        uint32_t base = st->written - st->pending_len;
        if (ops->program(ops->ctx, base, word) != 0) return OTA_ERR_FLASH;
        st->pending_len = 0;
    }

    /* Verify by reading back what is actually in flash, not what we think we
     * sent — this is the only check that covers a silently failed program. */
    uint32_t crc = CRC32_INIT;
    uint8_t buf[OTA_FLASH_WORD * 4];
    uint32_t remaining = st->expected_len;
    uint32_t pos = 0;
    while (remaining > 0) {
        uint32_t n = (remaining > sizeof(buf)) ? (uint32_t)sizeof(buf) : remaining;
        if (ops->read(ops->ctx, pos, buf, n) != 0) return OTA_ERR_FLASH;
        crc = crc32_update(crc, buf, n);
        pos += n;
        remaining -= n;
    }
    if (crc32_final(crc) != expected_crc32) return OTA_ERR_CRC;

    /* Commit the header last: its presence is what marks the slot trustworthy. */
    ota_image_header_t hdr;
    memset(&hdr, 0xFF, sizeof(hdr));
    hdr.magic = OTA_IMAGE_MAGIC;
    hdr.image_len = st->expected_len;
    hdr.image_crc32 = expected_crc32;
    hdr.version = version;
    hdr.header_crc32 = crc32_compute((const uint8_t*)&hdr, offsetof(ota_image_header_t, header_crc32));

    if (ops->program(ops->ctx, header_offset(ops), (const uint8_t*)&hdr) != 0) return OTA_ERR_FLASH;

    st->active = false;
    return OTA_OK;
}

ota_status_t ota_image_read_header(const ota_flash_ops_t* ops, ota_image_header_t* out)
{
    if (ops == NULL || ops->read == NULL || out == NULL) return OTA_ERR_ARG;
    if (ops->capacity < OTA_FLASH_WORD) return OTA_ERR_ARG;

    ota_image_header_t hdr;
    if (ops->read(ops->ctx, header_offset(ops), (uint8_t*)&hdr, sizeof(hdr)) != 0) return OTA_ERR_FLASH;

    if (hdr.magic != OTA_IMAGE_MAGIC) return OTA_ERR_CRC;
    uint32_t want = crc32_compute((const uint8_t*)&hdr, offsetof(ota_image_header_t, header_crc32));
    if (want != hdr.header_crc32) return OTA_ERR_CRC;
    if (hdr.image_len == 0 || hdr.image_len > ota_stage_max_image(ops)) return OTA_ERR_CRC;

    *out = hdr;
    return OTA_OK;
}
