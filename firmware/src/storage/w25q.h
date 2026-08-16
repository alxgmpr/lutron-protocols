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
#define W25Q_CMD_JEDEC_ID 0x9F

#define W25Q_PAGE_SIZE 256u
#define W25Q_SECTOR_SIZE 4096u

/** Status register 1 bits. */
#define W25Q_STATUS_BUSY 0x01
#define W25Q_STATUS_WEL 0x02

/** Status polls allowed before an operation is called failed. */
#define W25Q_POLL_LIMIT 1000000

typedef enum {
    W25Q_OK = 0,
    W25Q_ERR_STATE = -1,     /* used before a successful probe */
    W25Q_ERR_NO_DEVICE = -2, /* JEDEC ID is not a plausible part */
    W25Q_ERR_RANGE = -3,     /* address or length outside the device */
    W25Q_ERR_TIMEOUT = -4,   /* BUSY never cleared */
    W25Q_ERR_VERIFY = -5,    /* read-back did not match */
    W25Q_ERR_ARG = -6
} w25q_status_t;

typedef struct {
    /** Full-duplex transfer of @p len bytes. @p tx or @p rx may be NULL. */
    void (*xfer)(void* ctx, const uint8_t* tx, uint8_t* rx, size_t len);
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

/** Read back and compare. W25Q_ERR_VERIFY on the first mismatching byte. */
w25q_status_t w25q_verify(w25q_t* f, uint32_t addr, const uint8_t* data, size_t len);

const char* w25q_strerror(w25q_status_t st);

#ifdef __cplusplus
}
#endif

#endif /* W25Q_H */
