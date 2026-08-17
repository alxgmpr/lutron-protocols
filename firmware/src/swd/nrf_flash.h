#ifndef NRF_FLASH_H
#define NRF_FLASH_H

/**
 * Program an nRF52840's application region from an Intel HEX stream.
 *
 * This is the piece that sits between ihex.c and nrf_swd.c and turns a hex
 * file arriving over the network into programmed flash. It exists as its own
 * module rather than as shell code because everything it has to get right is
 * testable against the fake SWD target, and none of it is testable on the
 * bench without risking the part.
 *
 * The stream is consumed as it arrives. A 630 KB .hex does not fit in the
 * STM32's RAM, so nothing larger than one 4 KB target page is ever held: bytes
 * are staged into a page buffer, and the page is erased, programmed and
 * verified when the stream moves past it.
 *
 * Three rules this module enforces, in descending order of how badly they end:
 *
 *  - **Never ERASEALL.** CTRL-AP ERASEALL takes the factory USB bootloader with
 *    it, and after that nrfutil DFU no longer exists and SWD is the only way to
 *    program the part, forever. Ordinary flashing page-erases and nothing else.
 *    Unlocking a protected part is nrf_swd_recover(), a different command with a
 *    different name for exactly that reason.
 *
 *  - **Stay inside the region.** The app lives at 0x1000, above the MBR and
 *    below the bootloader. A record addressed outside [start, end) is refused
 *    before anything is erased, not after.
 *
 *  - **Verify off the part.** Programming flash only clears bits, so a word
 *    written over an unerased or marginal cell reads back as old AND new. Every
 *    page is read back over the wire and compared.
 *
 * Errors latch: the first failure is remembered, subsequent feeds are refused
 * with the same status, and nrf_flash_finish() reports it. A caller that
 * ignores the return of one feed still cannot end up thinking the flash worked.
 */

#include "ihex.h"
#include "nrf_swd.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    NRF_FLASH_OK = 0,
    NRF_FLASH_ERR_STATE = -1,      /* fed before begin, or after finish */
    NRF_FLASH_ERR_RANGE = -2,      /* addressed outside the permitted region */
    NRF_FLASH_ERR_HEX = -3,        /* malformed record or bad checksum */
    NRF_FLASH_ERR_SWD = -4,        /* the link or the NVMC stopped cooperating */
    NRF_FLASH_ERR_VERIFY = -5,     /* a page did not read back as programmed */
    NRF_FLASH_ERR_INCOMPLETE = -6, /* finished without an EOF record */
    NRF_FLASH_ERR_LOCKED = -7,     /* AP0 blocked — APPROTECT, likely in DFU */
    NRF_FLASH_ERR_ORDER = -8       /* went backwards into an already-written page */
} nrf_flash_status_t;

/** Longest input line accepted. A full 255-byte record is 521 characters. */
#define NRF_FLASH_MAX_LINE 544

/**
 * Called once per page before the erase/program/verify run. A page takes
 * appreciably longer than the caller can spend without refreshing a 10 s
 * hardware watchdog, so this is where it gets refreshed.
 */
typedef void (*nrf_flash_tick_fn)(void* ctx);

typedef struct {
    nrf_swd_t* nrf;
    uint32_t region_start; /* inclusive, page aligned */
    uint32_t region_end;   /* exclusive, page aligned */

    nrf_flash_tick_fn tick;
    void* tick_ctx;

    ihex_t hex;

    /* Partial line carried between feeds — the upload transport splits on
       chunk boundaries, which land mid-record on almost every image. */
    char partial[NRF_FLASH_MAX_LINE];
    size_t partial_len;

    /* The one page currently being staged. Words, because that is what the
       programming and verify calls take; bytes go in through a uint8_t* cast,
       which is the aliasing direction that is always allowed. */
    uint32_t page[NRF_FLASH_PAGE / 4u];
    uint32_t page_addr;
    bool page_staged;

    uint32_t image_bytes;
    uint32_t pages_written;

    bool active;
    nrf_flash_status_t err; /* first error, latched */
} nrf_flash_t;

/**
 * Bind to a live link and open a session over [start, end).
 *
 * Both bounds must be page aligned — they are erase bounds, and a start
 * halfway into a page would let that page's erase take the half below it.
 * Returns NRF_FLASH_ERR_LOCKED if AP0 is not answering, which is what a dongle
 * sitting in its factory USB bootloader looks like.
 */
nrf_flash_status_t nrf_flash_begin(nrf_flash_t* f, nrf_swd_t* n, uint32_t start, uint32_t end);

/** Install the per-page callback. Optional; call after nrf_flash_begin(). */
void nrf_flash_set_tick(nrf_flash_t* f, nrf_flash_tick_fn fn, void* ctx);

/**
 * Consume a slice of hex text. Lines may be split across calls. Programming
 * happens here, as the stream moves past each page.
 */
nrf_flash_status_t nrf_flash_feed(nrf_flash_t* f, const char* text, size_t len);

/**
 * Flush the last staged page and close the session.
 *
 * Requires that an EOF record was seen: a dropped chunk at the tail of a lossy
 * upload is otherwise indistinguishable from a shorter image.
 */
nrf_flash_status_t nrf_flash_finish(nrf_flash_t* f);

uint32_t nrf_flash_image_bytes(const nrf_flash_t* f);
uint32_t nrf_flash_pages_written(const nrf_flash_t* f);

/**
 * The bootloader's start address out of UICR NRFFW[0] — the ceiling the app
 * region must stay below. Returns @p fallback when the word is erased or holds
 * something that is not a plausible page-aligned flash address.
 */
uint32_t nrf_flash_bootloader_base(nrf_swd_t* n, uint32_t fallback);

/** Short, human-readable form of a status, for shell output. */
const char* nrf_flash_strerror(nrf_flash_status_t st);

#ifdef __cplusplus
}
#endif

#endif /* NRF_FLASH_H */
