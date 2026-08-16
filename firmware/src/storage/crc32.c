#include "crc32.h"

/* Reflected CRC-32 polynomial (IEEE 802.3 / zlib). */
#define CRC32_POLY 0xEDB88320u

uint32_t crc32_update(uint32_t crc, const void* data, size_t len)
{
    const uint8_t* p = (const uint8_t*)data;

    for (size_t i = 0; i < len; i++) {
        crc ^= p[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc & 1u) ? ((crc >> 1) ^ CRC32_POLY) : (crc >> 1);
        }
    }

    return crc;
}

uint32_t crc32_final(uint32_t crc)
{
    return crc ^ 0xFFFFFFFFu;
}

uint32_t crc32_compute(const void* data, size_t len)
{
    return crc32_final(crc32_update(CRC32_INIT, data, len));
}
