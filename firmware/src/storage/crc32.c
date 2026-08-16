/**
 * CRC-32 (IEEE 802.3 / zlib): reflected, poly 0xEDB88320, init and final xor
 * 0xFFFFFFFF.
 *
 * The table is derived from the polynomial at first use rather than written out
 * as a literal. A 256-entry literal is exactly the kind of thing that gets
 * transcribed wrong and then silently produces a self-consistent but non-CRC-32
 * checksum. test_ota_image.cpp pins the result against the canonical
 * "123456789" -> 0xCBF43926 vector.
 */

#include "crc32.h"

static uint32_t table[256];
static int table_ready = 0;

static void build_table(void)
{
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) {
            c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        table[i] = c;
    }
    table_ready = 1;
}

uint32_t crc32_update(uint32_t crc, const uint8_t* data, size_t len)
{
    if (!table_ready) build_table();
    if (data == 0) return crc;
    for (size_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ table[(crc ^ data[i]) & 0xFFu];
    }
    return crc;
}

uint32_t crc32_final(uint32_t crc)
{
    return crc ^ 0xFFFFFFFFu;
}

uint32_t crc32_compute(const uint8_t* data, size_t len)
{
    return crc32_final(crc32_update(CRC32_INIT, data, len));
}
