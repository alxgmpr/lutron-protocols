/**
 * Intel HEX -> nRF52840 flash. See nrf_flash.h for the design notes and for
 * why the region guard and the read-back verify are the two things this module
 * exists to get right.
 */

#include "nrf_flash.h"

#include <string.h>

/** UICR NRFFW[0] — where the SoftDevice/bootloader convention records the
 *  bootloader's start address. */
#define NRF_UICR_NRFFW0 (NRF_UICR_BASE + 0x14u)

#define PAGE_MASK (NRF_FLASH_PAGE - 1u)
#define PAGE_WORDS (NRF_FLASH_PAGE / 4u)

/* -----------------------------------------------------------------------
 * Page staging
 * ----------------------------------------------------------------------- */

/** Begin staging the page at @p base. Unwritten bytes stay erased. */
static void stage_page(nrf_flash_t* f, uint32_t base)
{
    memset(f->page, 0xFF, sizeof(f->page));
    f->page_addr = base;
    f->page_staged = true;
}

/**
 * Erase, program and verify the staged page.
 *
 * Erase first, unconditionally: programming only clears bits, so a word laid
 * over an unerased one reads back as old AND new. The verify is a read over
 * the wire rather than a comparison against the buffer we just sent, which is
 * the only version of this check that can actually fail.
 */
static nrf_flash_status_t flush_page(nrf_flash_t* f)
{
    if (!f->page_staged) {
        return NRF_FLASH_OK;
    }

    if (f->tick != NULL) {
        f->tick(f->tick_ctx);
    }

    if (nrf_swd_erase_page(f->nrf, f->page_addr) != SWD_OK) {
        return NRF_FLASH_ERR_SWD;
    }
    if (nrf_swd_write(f->nrf, f->page_addr, f->page, PAGE_WORDS) != SWD_OK) {
        return NRF_FLASH_ERR_SWD;
    }

    swd_status_t st = nrf_swd_verify(f->nrf, f->page_addr, f->page, PAGE_WORDS);
    if (st == SWD_ERR_VERIFY) {
        return NRF_FLASH_ERR_VERIFY;
    }
    if (st != SWD_OK) {
        return NRF_FLASH_ERR_SWD;
    }

    f->page_staged = false;
    f->pages_written++;
    return NRF_FLASH_OK;
}

/* -----------------------------------------------------------------------
 * ihex data sink
 * ----------------------------------------------------------------------- */

/**
 * One data record, at its fully resolved absolute address.
 *
 * Returns nonzero to abort the parse; the specific reason is latched in
 * f->err first, because ihex.c can only report "the sink refused".
 */
static int sink_record(void* ctx, uint32_t addr, const uint8_t* data, uint8_t len)
{
    nrf_flash_t* f = (nrf_flash_t*)ctx;

    if (len == 0) {
        return 0;
    }

    /* Both ends of the record, checked before anything is erased. A record
       that starts inside the region and runs past its end is the case that
       reaches the bootloader. */
    if (addr < f->region_start || addr >= f->region_end || (uint32_t)len > f->region_end - addr) {
        f->err = NRF_FLASH_ERR_RANGE;
        return -1;
    }

    for (uint8_t i = 0; i < len; i++) {
        uint32_t a = addr + i;
        uint32_t base = a & ~PAGE_MASK;

        if (!f->page_staged) {
            stage_page(f, base);
        }
        else if (base != f->page_addr) {
            if (base < f->page_addr) {
                /* Pages are erased as the stream moves past them, so stepping
                   back would erase what was already programmed and verified. */
                f->err = NRF_FLASH_ERR_ORDER;
                return -1;
            }
            nrf_flash_status_t st = flush_page(f);
            if (st != NRF_FLASH_OK) {
                f->err = st;
                return -1;
            }
            stage_page(f, base);
        }

        ((uint8_t*)f->page)[a - f->page_addr] = data[i];
    }

    f->image_bytes += len;
    return 0;
}

/* -----------------------------------------------------------------------
 * Session
 * ----------------------------------------------------------------------- */

nrf_flash_status_t nrf_flash_begin(nrf_flash_t* f, nrf_swd_t* n, uint32_t start, uint32_t end)
{
    if (f == NULL || n == NULL) {
        return NRF_FLASH_ERR_STATE;
    }

    /* The bounds are erase bounds. Unaligned ones would let a page erase reach
       outside the region the caller asked for. */
    if ((start & PAGE_MASK) != 0 || (end & PAGE_MASK) != 0) {
        return NRF_FLASH_ERR_RANGE;
    }
    if (start >= end || end > NRF_FLASH_SIZE) {
        return NRF_FLASH_ERR_RANGE;
    }

    /* With APPROTECT engaged the AP still ACKs and returns a fixed pattern, so
       "the read succeeded" proves nothing — the IDR has to be the right value. */
    uint32_t idr = 0;
    if (swd_mem_read_idr(&n->mem, &idr) != SWD_OK || idr != NRF_AHB_AP_IDR_EXPECTED) {
        return NRF_FLASH_ERR_LOCKED;
    }

    memset(f, 0, sizeof(*f));
    f->nrf = n;
    f->region_start = start;
    f->region_end = end;
    ihex_init(&f->hex);

    if (nrf_swd_halt(n) != SWD_OK) {
        return NRF_FLASH_ERR_SWD;
    }

    f->active = true;
    return NRF_FLASH_OK;
}

void nrf_flash_set_tick(nrf_flash_t* f, nrf_flash_tick_fn fn, void* ctx)
{
    if (f == NULL) {
        return;
    }
    f->tick = fn;
    f->tick_ctx = ctx;
}

/** Parse one complete line and translate ihex's verdict into ours. */
static nrf_flash_status_t consume_line(nrf_flash_t* f, const char* line, size_t len)
{
    ihex_status_t hs = ihex_parse_line(&f->hex, line, len, sink_record, f);
    if (hs == IHEX_OK) {
        return NRF_FLASH_OK;
    }
    if (hs == IHEX_ERR_SINK) {
        /* sink_record already latched the specific reason. */
        return f->err != NRF_FLASH_OK ? f->err : NRF_FLASH_ERR_RANGE;
    }
    return NRF_FLASH_ERR_HEX;
}

nrf_flash_status_t nrf_flash_feed(nrf_flash_t* f, const char* text, size_t len)
{
    if (f == NULL || !f->active) {
        return NRF_FLASH_ERR_STATE;
    }
    if (f->err != NRF_FLASH_OK) {
        return f->err;
    }
    if (text == NULL) {
        return NRF_FLASH_ERR_STATE;
    }

    for (size_t i = 0; i < len; i++) {
        char c = text[i];
        if (c != '\n') {
            if (f->partial_len < sizeof(f->partial)) {
                f->partial[f->partial_len++] = c;
            }
            else {
                /* A line longer than any legal record. Truncating it silently
                   would hand the parser a record it could still checksum. */
                f->err = NRF_FLASH_ERR_HEX;
                return f->err;
            }
            continue;
        }

        nrf_flash_status_t st = consume_line(f, f->partial, f->partial_len);
        f->partial_len = 0;
        if (st != NRF_FLASH_OK) {
            f->err = st;
            return st;
        }
    }

    return NRF_FLASH_OK;
}

nrf_flash_status_t nrf_flash_finish(nrf_flash_t* f)
{
    if (f == NULL || !f->active) {
        return NRF_FLASH_ERR_STATE;
    }

    nrf_flash_status_t st = f->err;

    /* Any trailing bytes with no newline after them are still a line. */
    if (st == NRF_FLASH_OK && f->partial_len > 0) {
        st = consume_line(f, f->partial, f->partial_len);
        f->partial_len = 0;
    }

    /* Completeness before programming, not after. A dropped chunk at the tail
       of a lossy upload is indistinguishable from a shorter image, and the
       staged page must not reach the part if the image is not whole. */
    if (st == NRF_FLASH_OK && (!ihex_complete(&f->hex) || f->image_bytes == 0)) {
        st = NRF_FLASH_ERR_INCOMPLETE;
    }

    if (st == NRF_FLASH_OK) {
        st = flush_page(f);
    }

    /* Always release. A part left halted is the dead dongle this is meant to
       fix, so this cannot be conditional on the outcome. */
    (void)nrf_swd_run(f->nrf);

    f->active = false;
    f->page_staged = false;
    if (f->err == NRF_FLASH_OK) {
        f->err = st;
    }
    return st;
}

uint32_t nrf_flash_image_bytes(const nrf_flash_t* f)
{
    return f == NULL ? 0u : f->image_bytes;
}

uint32_t nrf_flash_pages_written(const nrf_flash_t* f)
{
    return f == NULL ? 0u : f->pages_written;
}

uint32_t nrf_flash_bootloader_base(nrf_swd_t* n, uint32_t fallback)
{
    uint32_t v = 0;
    if (n == NULL || swd_mem_read32(&n->mem, NRF_UICR_NRFFW0, &v) != SWD_OK) {
        return fallback;
    }
    /* Erased UICR reads 0xFFFFFFFF; anything unaligned or outside flash is not
       a bootloader address either. Taking either at face value would put the
       ceiling somewhere that is not a ceiling. */
    if ((v & PAGE_MASK) != 0 || v < NRF_FLASH_PAGE || v >= NRF_FLASH_SIZE) {
        return fallback;
    }
    return v;
}

const char* nrf_flash_strerror(nrf_flash_status_t st)
{
    switch (st) {
    case NRF_FLASH_OK:
        return "ok";
    case NRF_FLASH_ERR_STATE:
        return "no flash session open";
    case NRF_FLASH_ERR_RANGE:
        return "address outside the permitted region";
    case NRF_FLASH_ERR_HEX:
        return "malformed Intel HEX";
    case NRF_FLASH_ERR_SWD:
        return "SWD link or NVMC failure";
    case NRF_FLASH_ERR_VERIFY:
        return "read-back did not match";
    case NRF_FLASH_ERR_INCOMPLETE:
        return "image incomplete (no EOF record)";
    case NRF_FLASH_ERR_LOCKED:
        return "AP0 blocked (APPROTECT / bootloader)";
    case NRF_FLASH_ERR_ORDER:
        return "records went backwards into a written page";
    }
    return "unknown";
}
