#ifndef OTA_IMAGE_H
#define OTA_IMAGE_H

/**
 * OTA staging — accept a firmware image into the staging slot and verify it.
 *
 * This module owns the fiddly parts of writing an image to STM32H7 flash and
 * nothing else: 32-byte flash-word realignment, bounds, resume-after-loss, and
 * end-to-end CRC. It never erases the running image and never jumps anywhere,
 * so exercising it cannot brick the board.
 *
 * The flash backend is injected (ota_flash_ops_t) so the whole state machine is
 * host-testable against a RAM-backed fake — see firmware/tests/test_ota_image.cpp.
 *
 * Slot layout:
 *   [ image bytes ............................ ][ pad ][ header:32 ]
 *   ^ slot offset 0                                    ^ capacity - 32
 *
 * The header is written LAST, only after the image CRC verifies. A slot with a
 * valid header therefore always holds a complete, checked image — which is the
 * property a future bootloader needs in order to trust it.
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** STM32H7 programs flash in 256-bit words; every write must be 32-byte aligned. */
#define OTA_FLASH_WORD 32u

/** "OTA1" — bump the trailing digit if the header layout ever changes. */
#define OTA_IMAGE_MAGIC 0x4F544131u

/** Header occupies exactly one flash word at the end of the slot. */
typedef struct {
    uint32_t magic;        /* OTA_IMAGE_MAGIC */
    uint32_t image_len;    /* bytes of application image (unpadded) */
    uint32_t image_crc32;  /* CRC-32 over exactly image_len bytes */
    uint32_t version;      /* caller-supplied build identifier */
    uint32_t header_crc32; /* CRC-32 over the four fields above */
    uint32_t _reserved[3]; /* pad to OTA_FLASH_WORD */
} ota_image_header_t;

/** Result codes. Negative values are failures. */
typedef enum {
    OTA_OK = 0,
    OTA_ERR_ARG = -1,        /* null pointer or nonsensical length */
    OTA_ERR_CAPACITY = -2,   /* image does not fit the slot */
    OTA_ERR_STATE = -3,      /* no session active, or already finished */
    OTA_ERR_GAP = -4,        /* offset != bytes_written — caller must resume */
    OTA_ERR_OVERRUN = -5,    /* write would exceed expected_len */
    OTA_ERR_FLASH = -6,      /* backend erase/program/read failed */
    OTA_ERR_CRC = -7,        /* image CRC mismatch at finish */
    OTA_ERR_INCOMPLETE = -8, /* finish called before expected_len bytes arrived */
} ota_status_t;

/**
 * Flash backend. Offsets are relative to the start of the staging slot.
 * All three return 0 on success, nonzero on failure.
 */
typedef struct {
    int (*erase)(void* ctx);
    int (*program)(void* ctx, uint32_t offset, const uint8_t word[OTA_FLASH_WORD]);
    int (*read)(void* ctx, uint32_t offset, uint8_t* out, uint32_t len);
    uint32_t capacity; /* total slot size in bytes; must be a multiple of OTA_FLASH_WORD */
    void* ctx;
} ota_flash_ops_t;

typedef struct {
    const ota_flash_ops_t* ops;
    uint32_t expected_len;
    uint32_t written;                /* contiguous bytes accepted so far */
    uint8_t pending[OTA_FLASH_WORD]; /* partial flash word not yet programmed */
    uint32_t pending_len;
    bool active;
} ota_stage_t;

/** Largest image the slot can hold (capacity minus the header word). */
uint32_t ota_stage_max_image(const ota_flash_ops_t* ops);

/**
 * Erase the staging slot and start accepting an image.
 * Erasing is done up front so no erase stalls occur mid-transfer.
 */
ota_status_t ota_stage_begin(ota_stage_t* st, const ota_flash_ops_t* ops, uint32_t expected_len);

/**
 * Append @p len bytes that begin at slot offset @p offset.
 *
 * Writes must be contiguous. A non-matching offset returns OTA_ERR_GAP without
 * changing state, so a caller that lost a datagram can read ota_stage_written()
 * and resume from there rather than restarting the whole transfer.
 */
ota_status_t ota_stage_write(ota_stage_t* st, uint32_t offset, const uint8_t* data, uint32_t len);

/** Contiguous bytes accepted so far — the resume point after OTA_ERR_GAP. */
uint32_t ota_stage_written(const ota_stage_t* st);

/**
 * Flush the final partial flash word, verify the image CRC by reading the slot
 * back, and only then commit the header. Leaves no header on failure.
 */
ota_status_t ota_stage_finish(ota_stage_t* st, uint32_t expected_crc32, uint32_t version);

/** Read and validate the staged image header. OTA_ERR_CRC if absent/corrupt. */
ota_status_t ota_image_read_header(const ota_flash_ops_t* ops, ota_image_header_t* out);

#ifdef __cplusplus
}
#endif

#endif /* OTA_IMAGE_H */
