#ifndef CRC32_H
#define CRC32_H

/**
 * CRC-32 (IEEE 802.3 / zlib, reflected, init/final 0xFFFFFFFF).
 *
 * NOTE: flash_store.cpp has its own `calc_crc32()` which is NOT this function.
 * Its literal table has 114 wrong entries, so despite the comment there it does
 * not implement CRC-32 — it is a self-consistent checksum with unknown error
 * detection properties. Do not assume the two agree, and do not use one to
 * validate data written by the other. See GLAB-109.
 */

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** One-shot CRC-32 over a buffer. */
uint32_t crc32_compute(const uint8_t* data, size_t len);

/** Streaming form. Seed with CRC32_INIT, finalize with crc32_final(). */
#define CRC32_INIT 0xFFFFFFFFu
uint32_t crc32_update(uint32_t crc, const uint8_t* data, size_t len);
uint32_t crc32_final(uint32_t crc);

#ifdef __cplusplus
}
#endif

#endif /* CRC32_H */
