#ifndef CRC32_H
#define CRC32_H

/**
 * CRC-32 (IEEE 802.3 / zlib): reflected polynomial 0xEDB88320,
 * init 0xFFFFFFFF, final XOR 0xFFFFFFFF.
 *
 * Pinned against the canonical vector "123456789" -> 0xCBF43926.
 *
 * Computed bitwise from the polynomial rather than from a transcribed
 * lookup table. flash_store previously carried a literal 256-entry table
 * annotated "same polynomial as zlib / Ethernet" in which 114 entries were
 * wrong and 80 values were duplicated (GLAB-109), which is what made the
 * checksum an arbitrary self-consistent function instead of a CRC. There is
 * no table here to transcribe incorrectly.
 *
 * Callers needing table-driven throughput over large buffers can add a
 * lookup table behind this same signature; tests/test_flash_crc32.cpp
 * checks the output against a table derived from the polynomial, so such a
 * change stays honest.
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * CRC-32 over `len` bytes at `data`. Returns 0 for an empty buffer.
 * Stateless and reentrant.
 */
uint32_t crc32_compute(const void* data, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* CRC32_H */
