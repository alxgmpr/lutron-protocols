#ifndef W25Q_H
#define W25Q_H

/**
 * Winbond W25Q SPI NOR flash.
 *
 * Transport-agnostic: the caller supplies a full-duplex byte transfer and a
 * chip-select, so the whole driver runs against a fake part on the host and
 * only the four wires need hardware.
 *
 * Three properties of this silicon shape the API, and all three fail quietly
 * on real parts:
 *
 *  - **Write enable is per operation.** WEL is set by 06h and cleared by the
 *    part itself when a program or erase finishes. One 06h does not cover two
 *    writes; the second is discarded with no error anywhere.
 *
 *  - **Page program does not cross a page.** Start mid-page and run long and
 *    the address wraps to the *start of the same page*, overwriting what was
 *    just written. w25q_program() splits at page boundaries so callers never
 *    have to think about it.
 *
 *  - **Programming only clears bits.** A page written twice without an erase
 *    reads back as the AND of the two. w25q_verify() reads the part back
 *    rather than trusting the buffer it was handed.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Commands used here. */
#define W25Q_CMD_WRITE_ENABLE 0x06
#define W25Q_CMD_WRITE_DISABLE 0x04
#define W25Q_CMD_READ_STATUS1 0x05
#define W25Q_CMD_READ_DATA 0x03
#define W25Q_CMD_PAGE_PROGRAM 0x02
#define W25Q_CMD_SECTOR_ERASE 0x20
#define W25Q_CMD_BLOCK_ERASE_64K 0xD8
#define W25Q_CMD_JEDEC_ID 0x9F
#define W25Q_CMD_READ_STATUS2 0x35
#define W25Q_CMD_READ_STATUS3 0x15
#define W25Q_CMD_WRITE_STATUS2 0x31

#define W25Q_PAGE_SIZE 256u
#define W25Q_SECTOR_SIZE 4096u
#define W25Q_BLOCK_SIZE 65536u

/** Status register 1 bits. */
#define W25Q_STATUS_BUSY 0x01
#define W25Q_STATUS_WEL 0x02

/* Status register 2 bits. SRL and the LB bits are one-way: once set they can
 * never be cleared, so nothing here may write them. */
#define W25Q_SR2_SRL 0x01
#define W25Q_SR2_QE 0x02
#define W25Q_SR2_LB_MASK 0x38

/** Status polls allowed before an operation is called failed. */
#define W25Q_POLL_LIMIT 1000000

typedef enum {
    W25Q_OK = 0,
    W25Q_ERR_STATE = -1,     /* used before a successful probe */
    W25Q_ERR_NO_DEVICE = -2, /* JEDEC ID is not a plausible part */
    W25Q_ERR_RANGE = -3,     /* address or length outside the device */
    W25Q_ERR_TIMEOUT = -4,   /* BUSY never cleared */
    W25Q_ERR_VERIFY = -5,    /* read-back did not match */
    W25Q_ERR_ARG = -6,
    W25Q_ERR_LOCKED = -7, /* status register is locked (SRL set) */
    W25Q_ERR_IO = -8      /* the transport did not move the bytes */
} w25q_status_t;

typedef struct {
    /**
     * Full-duplex transfer of @p len bytes. @p tx or @p rx may be NULL.
     *
     * Returns false if any byte did not move. This matters more than it looks:
     * a transport that silently gives up leaves the caller's rx buffer holding
     * whatever was in it, and a read of stale bytes reported as success is
     * indistinguishable from a real one. A status poll is the worst case — it
     * can read BUSY clear when nothing was ever clocked.
     */
    bool (*xfer)(void* ctx, const uint8_t* tx, uint8_t* rx, size_t len);
    /** Assert (true) or release (false) chip select. */
    void (*cs)(void* ctx, bool assert);
    void* ctx;
} w25q_io_t;

typedef struct {
    w25q_io_t io;
    uint8_t manufacturer;
    uint8_t mem_type;
    uint8_t capacity_code;
    uint32_t capacity;
    bool present;
    /** Latched by any failed transfer; every entry point clears it and then
     *  refuses to report success while it is set. */
    bool io_error;
} w25q_t;

/** Bind to a transport. Does not touch the wire. */
void w25q_init(w25q_t* f, const w25q_io_t* io);

/**
 * Read the JEDEC ID and work out the capacity.
 *
 * Must succeed before anything else is allowed. An unwired part leaves MISO
 * pulled high and reads back all ones, which is rejected rather than treated
 * as a 16 MB device.
 */
w25q_status_t w25q_probe(w25q_t* f);

uint8_t w25q_manufacturer(const w25q_t* f);
/** Device size in bytes, decoded from the ID's log2 capacity byte. */
uint32_t w25q_capacity(const w25q_t* f);

w25q_status_t w25q_read(w25q_t* f, uint32_t addr, uint8_t* out, size_t len);

/** Program @p len bytes, splitting at page boundaries and write-enabling each. */
w25q_status_t w25q_program(w25q_t* f, uint32_t addr, const uint8_t* data, size_t len);

/** Erase the 4 KB sector containing @p addr. */
w25q_status_t w25q_erase_sector(w25q_t* f, uint32_t addr);

/**
 * Erase the 64 KB block containing @p addr.
 *
 * Sixteen of these clear a megabyte; the same span as sector erases is 256
 * commands and takes long enough to matter during an update.
 */
w25q_status_t w25q_erase_block(w25q_t* f, uint32_t addr);

/** Read back and compare. W25Q_ERR_VERIFY on the first mismatching byte. */
w25q_status_t w25q_verify(w25q_t* f, uint32_t addr, const uint8_t* data, size_t len);

/**
 * Read status register 1, 2 or 3 — diagnostics only.
 *
 * SR1 carries BUSY, WEL and the block-protect bits; SR2 carries QE and SRP1;
 * SR3 carries the drive strength and WPS. When a program reports success and
 * the data does not appear, these say why: memory locked by BP2:0, or a write
 * enable that is not sticking.
 */
w25q_status_t w25q_read_status_reg(w25q_t* f, uint8_t which, uint8_t* out);

/** Issue 06h. Exposed so a caller can check whether WEL actually latches. */
w25q_status_t w25q_write_enable(w25q_t* f);

/**
 * Set the Quad Enable bit, which retires WP# and HOLD#.
 *
 * With QE clear those two pins are live active-low inputs: leave them floating
 * and a long transfer aborts partway, so a program reports success and no data
 * appears. Setting QE turns them into IO2/IO3, unused in single-SPI mode, and
 * unconnected becomes harmless.
 *
 * Non-volatile, and a no-op if QE is already set. Never writes SRL or the LB
 * bits — they cannot be undone. Returns W25Q_ERR_LOCKED if SRL is already set,
 * because then the write cannot land and saying otherwise would send the
 * caller away believing the pins are safe to float.
 */
w25q_status_t w25q_set_quad_enable(w25q_t* f);

const char* w25q_strerror(w25q_status_t st);

#ifdef __cplusplus
}
#endif

#endif /* W25Q_H */
