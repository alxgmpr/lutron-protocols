/**
 * Winbond W25Q SPI NOR. See w25q.h for the three silicon rules this enforces.
 */

#include "w25q.h"

#include <string.h>

/* -----------------------------------------------------------------------
 * Transport helpers
 * ----------------------------------------------------------------------- */

static void cs(w25q_t* f, bool assert)
{
    f->io.cs(f->io.ctx, assert);
}

static void xfer(w25q_t* f, const uint8_t* tx, uint8_t* rx, size_t len)
{
    f->io.xfer(f->io.ctx, tx, rx, len);
}

/** A command with no address and no data — 06h, 04h. */
static void cmd_only(w25q_t* f, uint8_t op)
{
    cs(f, true);
    xfer(f, &op, NULL, 1);
    cs(f, false);
}

/** Opcode followed by a 24-bit address, MSB first. Leaves CS asserted. */
static void begin_addressed(w25q_t* f, uint8_t op, uint32_t addr)
{
    uint8_t hdr[4] = {op, (uint8_t)(addr >> 16), (uint8_t)(addr >> 8), (uint8_t)addr};
    cs(f, true);
    xfer(f, hdr, NULL, sizeof(hdr));
}

static uint8_t read_status(w25q_t* f)
{
    uint8_t op = W25Q_CMD_READ_STATUS1;
    uint8_t st = 0xFF;
    cs(f, true);
    xfer(f, &op, NULL, 1);
    xfer(f, NULL, &st, 1);
    cs(f, false);
    return st;
}

/** Spin until BUSY clears. Every program and erase must be followed by this. */
static w25q_status_t wait_ready(w25q_t* f)
{
    for (uint32_t i = 0; i < W25Q_POLL_LIMIT; i++) {
        if ((read_status(f) & W25Q_STATUS_BUSY) == 0) {
            return W25Q_OK;
        }
    }
    return W25Q_ERR_TIMEOUT;
}

/* -----------------------------------------------------------------------
 * Identification
 * ----------------------------------------------------------------------- */

void w25q_init(w25q_t* f, const w25q_io_t* io)
{
    if (f == NULL || io == NULL) {
        return;
    }
    memset(f, 0, sizeof(*f));
    f->io = *io;
}

w25q_status_t w25q_probe(w25q_t* f)
{
    if (f == NULL || f->io.xfer == NULL || f->io.cs == NULL) {
        return W25Q_ERR_ARG;
    }

    uint8_t op = W25Q_CMD_JEDEC_ID;
    uint8_t id[3] = {0, 0, 0};
    cs(f, true);
    xfer(f, &op, NULL, 1);
    xfer(f, NULL, id, sizeof(id));
    cs(f, false);

    /* Two independent sanity checks, because a miswired part fails in two
       different ways. An absent or unpowered device gives all 0xFF (MISO on
       its pull-up) or all 0x00, but a floating MISO picking up crosstalk can
       return a byte pattern where one field looks plausible and the other does
       not — so neither check alone is enough.

       0x00 and 0xFF are not assignable JEDEC manufacturer codes. */
    if (id[0] == 0x00 || id[0] == 0xFF) {
        f->present = false;
        return W25Q_ERR_NO_DEVICE;
    }
    /* Capacity is log2 of the byte count: 16 is 64 KB, 26 is 64 MB. Outside
       that is a garbled read, and taking 0xFF at face value would claim a
       2^255-byte flash and disable every bounds check downstream. */
    if (id[2] < 16 || id[2] > 26) {
        f->present = false;
        return W25Q_ERR_NO_DEVICE;
    }

    f->manufacturer = id[0];
    f->mem_type = id[1];
    f->capacity_code = id[2];
    f->capacity = 1u << id[2];
    f->present = true;
    return W25Q_OK;
}

w25q_status_t w25q_read_status_reg(w25q_t* f, uint8_t which, uint8_t* out)
{
    if (f == NULL || out == NULL) {
        return W25Q_ERR_ARG;
    }
    uint8_t op;
    switch (which) {
    case 1:
        op = W25Q_CMD_READ_STATUS1;
        break;
    case 2:
        op = W25Q_CMD_READ_STATUS2;
        break;
    case 3:
        op = W25Q_CMD_READ_STATUS3;
        break;
    default:
        return W25Q_ERR_ARG;
    }

    cs(f, true);
    xfer(f, &op, NULL, 1);
    xfer(f, NULL, out, 1);
    cs(f, false);
    return W25Q_OK;
}

w25q_status_t w25q_write_enable(w25q_t* f)
{
    if (f == NULL) {
        return W25Q_ERR_ARG;
    }
    cmd_only(f, W25Q_CMD_WRITE_ENABLE);
    return W25Q_OK;
}

w25q_status_t w25q_set_quad_enable(w25q_t* f)
{
    if (f == NULL) {
        return W25Q_ERR_ARG;
    }
    if (!f->present) {
        return W25Q_ERR_STATE;
    }

    uint8_t sr2 = 0;
    w25q_status_t st = w25q_read_status_reg(f, 2, &sr2);
    if (st != W25Q_OK) {
        return st;
    }
    if (sr2 & W25Q_SR2_SRL) {
        return W25Q_ERR_LOCKED;
    }
    if (sr2 & W25Q_SR2_QE) {
        return W25Q_OK; /* nothing to do; do not burn a write cycle */
    }

    /* Keep every bit we do not own (CMP in particular changes what the
       block-protect bits mean), and force the one-way bits clear so a garbled
       read cannot talk us into burning them permanently. */
    uint8_t want = (uint8_t)((sr2 | W25Q_SR2_QE) & ~(W25Q_SR2_SRL | W25Q_SR2_LB_MASK));

    cmd_only(f, W25Q_CMD_WRITE_ENABLE);

    uint8_t tx[2] = {W25Q_CMD_WRITE_STATUS2, want};
    cs(f, true);
    xfer(f, tx, NULL, sizeof(tx));
    cs(f, false);

    return wait_ready(f);
}

uint8_t w25q_manufacturer(const w25q_t* f)
{
    return f == NULL ? 0 : f->manufacturer;
}

uint32_t w25q_capacity(const w25q_t* f)
{
    return f == NULL ? 0 : f->capacity;
}

/** Is [addr, addr+len) inside the device? Overflow-safe. */
static bool range_ok(const w25q_t* f, uint32_t addr, size_t len)
{
    if (addr >= f->capacity) {
        return false;
    }
    return len <= (size_t)(f->capacity - addr);
}

/* -----------------------------------------------------------------------
 * Read
 * ----------------------------------------------------------------------- */

w25q_status_t w25q_read(w25q_t* f, uint32_t addr, uint8_t* out, size_t len)
{
    if (f == NULL || out == NULL) {
        return W25Q_ERR_ARG;
    }
    if (!f->present) {
        return W25Q_ERR_STATE;
    }
    if (!range_ok(f, addr, len)) {
        return W25Q_ERR_RANGE;
    }
    if (len == 0) {
        return W25Q_OK;
    }

    /* 03h streams continuously; the part's own address counter runs across
       page and sector boundaries, so this needs no splitting. */
    begin_addressed(f, W25Q_CMD_READ_DATA, addr);
    xfer(f, NULL, out, len);
    cs(f, false);
    return W25Q_OK;
}

/* -----------------------------------------------------------------------
 * Program
 * ----------------------------------------------------------------------- */

/** One page-bounded program. @p len must not cross a page boundary. */
static w25q_status_t program_page(w25q_t* f, uint32_t addr, const uint8_t* data, size_t len)
{
    /* Per operation, not per call: the part clears WEL itself when this
       finishes, so the next page needs its own. */
    cmd_only(f, W25Q_CMD_WRITE_ENABLE);

    begin_addressed(f, W25Q_CMD_PAGE_PROGRAM, addr);
    xfer(f, data, NULL, len);
    cs(f, false);

    return wait_ready(f);
}

w25q_status_t w25q_program(w25q_t* f, uint32_t addr, const uint8_t* data, size_t len)
{
    if (f == NULL || data == NULL) {
        return W25Q_ERR_ARG;
    }
    if (!f->present) {
        return W25Q_ERR_STATE;
    }
    if (!range_ok(f, addr, len)) {
        return W25Q_ERR_RANGE;
    }

    while (len > 0) {
        /* Stop at the end of the page this address lands in. Running past it
           wraps to the start of the same page on real silicon and quietly
           overwrites what was just written. */
        uint32_t page_end = (addr & ~(W25Q_PAGE_SIZE - 1u)) + W25Q_PAGE_SIZE;
        size_t chunk = page_end - addr;
        if (chunk > len) {
            chunk = len;
        }

        w25q_status_t st = program_page(f, addr, data, chunk);
        if (st != W25Q_OK) {
            return st;
        }

        addr += (uint32_t)chunk;
        data += chunk;
        len -= chunk;
    }
    return W25Q_OK;
}

/* -----------------------------------------------------------------------
 * Erase
 * ----------------------------------------------------------------------- */

w25q_status_t w25q_erase_sector(w25q_t* f, uint32_t addr)
{
    if (f == NULL) {
        return W25Q_ERR_ARG;
    }
    if (!f->present) {
        return W25Q_ERR_STATE;
    }
    if (addr >= f->capacity) {
        return W25Q_ERR_RANGE;
    }

    cmd_only(f, W25Q_CMD_WRITE_ENABLE);

    /* The part masks the address to the sector itself, but sending the base is
       what the caller means and keeps the intent visible on a logic analyser. */
    begin_addressed(f, W25Q_CMD_SECTOR_ERASE, addr & ~(W25Q_SECTOR_SIZE - 1u));
    cs(f, false);

    return wait_ready(f);
}

/* -----------------------------------------------------------------------
 * Verify
 * ----------------------------------------------------------------------- */

w25q_status_t w25q_verify(w25q_t* f, uint32_t addr, const uint8_t* data, size_t len)
{
    if (f == NULL || data == NULL) {
        return W25Q_ERR_ARG;
    }
    if (!f->present) {
        return W25Q_ERR_STATE;
    }
    if (!range_ok(f, addr, len)) {
        return W25Q_ERR_RANGE;
    }

    /* Read the part back rather than comparing the caller's buffer with
       itself. Programming only clears bits, so a write over unerased flash
       succeeds at every step and still leaves the wrong bytes behind. */
    uint8_t chunk[64];
    while (len > 0) {
        size_t n = len < sizeof(chunk) ? len : sizeof(chunk);
        w25q_status_t st = w25q_read(f, addr, chunk, n);
        if (st != W25Q_OK) {
            return st;
        }
        if (memcmp(chunk, data, n) != 0) {
            return W25Q_ERR_VERIFY;
        }
        addr += (uint32_t)n;
        data += n;
        len -= n;
    }
    return W25Q_OK;
}

const char* w25q_strerror(w25q_status_t st)
{
    switch (st) {
    case W25Q_OK:
        return "ok";
    case W25Q_ERR_STATE:
        return "not probed";
    case W25Q_ERR_NO_DEVICE:
        return "no device (check CS/MISO/MOSI/SCK and 3V3)";
    case W25Q_ERR_RANGE:
        return "address outside the device";
    case W25Q_ERR_TIMEOUT:
        return "BUSY never cleared";
    case W25Q_ERR_VERIFY:
        return "read-back did not match";
    case W25Q_ERR_ARG:
        return "bad argument";
    case W25Q_ERR_LOCKED:
        return "status register locked (SRL set)";
    }
    return "unknown";
}
