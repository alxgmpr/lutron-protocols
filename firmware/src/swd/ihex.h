#ifndef IHEX_H
#define IHEX_H

/**
 * Streaming Intel HEX parser.
 *
 * Line at a time, so an image arriving over Ethernet can be flashed as it
 * lands rather than buffered whole — a 630 KB .hex will not fit in the STM32's
 * RAM alongside everything else.
 *
 * Record types handled:
 *   00 data
 *   01 end of file
 *   02 extended segment address  (base = value << 4)
 *   03 start segment address     (entry point; ignored)
 *   04 extended linear address   (base = value << 16)
 *   05 start linear address      (entry point; ignored)
 *
 * Type 02 matters here specifically: firmware/ncp/ot-ncp-ftd.hex uses it, not
 * the type 04 that most parsers implement. A parser that ignores 02 places the
 * whole image at the wrong address without complaining, because every
 * individual record still checksums correctly.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    IHEX_OK = 0,
    IHEX_ERR_FORMAT = -1,   /* missing start code, bad hex digit, wrong length */
    IHEX_ERR_CHECKSUM = -2, /* record checksum did not verify */
    IHEX_ERR_RECORD = -3,   /* unknown record type, or data after EOF */
    IHEX_ERR_SINK = -4      /* the data callback reported a failure */
} ihex_status_t;

/** Longest data payload a record can carry. */
#define IHEX_MAX_DATA 255

/**
 * Called for each data record, with the fully resolved absolute address.
 * Return 0 to continue, nonzero to abort the parse with IHEX_ERR_SINK.
 */
typedef int (*ihex_data_fn)(void* ctx, uint32_t addr, const uint8_t* data, uint8_t len);

typedef struct {
    uint32_t base;     /* address base from the last type 02/04 record */
    uint32_t min_addr; /* lowest address seen */
    uint32_t max_addr; /* one past the highest address seen */
    bool any_data;
    bool eof;
} ihex_t;

void ihex_init(ihex_t* h);

/**
 * Parse one line. @p len excludes any terminator, but trailing CR/LF are
 * tolerated. Blank lines are ignored.
 */
ihex_status_t ihex_parse_line(ihex_t* h, const char* line, size_t len, ihex_data_fn fn, void* ctx);

/** True once the EOF record has been seen. */
bool ihex_complete(const ihex_t* h);

/** Lowest address seen, or 0 if no data records have been parsed. */
uint32_t ihex_min_address(const ihex_t* h);

/** One past the highest address seen, or 0 if no data records. */
uint32_t ihex_max_address(const ihex_t* h);

#ifdef __cplusplus
}
#endif

#endif /* IHEX_H */
