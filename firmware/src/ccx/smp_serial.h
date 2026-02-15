#ifndef SMP_SERIAL_H
#define SMP_SERIAL_H

/**
 * MCUboot SMP serial transport — frame builder and response parser.
 *
 * Wire format:
 *   0x06 0x09 <base64(len_hi, len_lo, smp_header[8], cbor[N], crc_hi, crc_lo)> \n
 *
 * SMP header (8 bytes):
 *   Op(1) | Flags(1) | Len(2 BE) | Group(2 BE) | Seq(1) | ID(1)
 *
 * Image upload CBOR payload:
 *   { "off": <offset>, "data": <bytes>, "len": <total_image_size> }
 *   ("len" only present in first chunk where offset == 0)
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Build a complete SMP serial image-upload frame.
 *
 * Returns total wire frame length (0x06 0x09 ... \n), 0 on error.
 * Caller must provide a buffer large enough for base64 overhead.
 * Rule of thumb: out_size >= 4 * ((10 + data_len + 20) / 3) + 10
 */
size_t smp_build_upload(uint8_t *out, size_t out_size,
                        uint32_t offset, const uint8_t *data,
                        size_t data_len, uint32_t image_size,
                        uint8_t seq);

/**
 * Build an SMP serial image-list (read) frame for probing the bootloader.
 * Returns wire frame length, 0 on error.
 */
size_t smp_build_image_list(uint8_t *out, size_t out_size, uint8_t seq);

/**
 * Parse an SMP serial response line.
 *
 * @param in       Raw bytes received (should start with 0x06 0x09)
 * @param in_len   Length of input
 * @param rc       [out] SMP return code (0 = success)
 * @param off      [out] Byte offset acknowledged by bootloader
 * @return true if response was valid and parsed
 */
bool smp_parse_response(const uint8_t *in, size_t in_len,
                        int *rc, uint32_t *off);

#ifdef __cplusplus
}
#endif

#endif /* SMP_SERIAL_H */
