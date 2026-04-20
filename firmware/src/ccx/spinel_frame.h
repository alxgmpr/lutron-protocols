#ifndef SPINEL_FRAME_H
#define SPINEL_FRAME_H

/**
 * Spinel frame encode/parse helpers (OpenThread NCP protocol).
 *
 * Wire layout (inside one HDLC frame):
 *   [header: FLG|IID|TID] [command VUI] [property VUI] [value bytes...]
 *
 * Header byte:
 *   bit 7 (FLG)     : always 1
 *   bits 6-4 (IID)  : interface ID (typically 0)
 *   bits 3-0 (TID)  : transaction ID (1..15 for requests, 0 unsolicited)
 *
 * Command and property are encoded as VUI (packed unsigned int):
 *   values < 128     → 1 byte
 *   values < 16384   → 2 bytes (little-endian 7 bits per byte, high bit = continuation)
 *
 * All Lutron-relevant commands (<= 0x07) and properties (<= 0x72) fit in
 * a single byte, but the encoder handles 2-byte VUI for correctness.
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Build a Spinel header byte from IID and TID. IID is 0 in single-interface NCPs. */
uint8_t spinel_header_byte(uint8_t iid, uint8_t tid);

/**
 * Encode a VUI (variable unsigned integer) value.
 * @return bytes written (1 or 2), or 0 on overflow / unsupported value.
 */
size_t spinel_encode_vui(uint8_t* out, size_t out_size, uint32_t value);

/**
 * Decode a VUI.
 * @param consumed [out] number of bytes consumed
 * @return true if a valid VUI was decoded
 */
bool spinel_decode_vui(const uint8_t* in, size_t in_len, uint32_t* value, size_t* consumed);

/**
 * Build a full Spinel frame (header + cmd VUI + prop VUI + value).
 *
 * @return total bytes written, or 0 on overflow.
 */
size_t spinel_build_frame(uint8_t* out, size_t out_size, uint8_t header, uint32_t cmd, uint32_t prop,
                          const uint8_t* value, size_t value_len);

/**
 * Parse a received Spinel frame.
 *
 * @param header       [out] raw header byte (contains FLG|IID|TID)
 * @param cmd          [out] decoded command
 * @param prop         [out] decoded property
 * @param payload      [out] pointer into buf to start of value
 * @param payload_len  [out] remaining bytes after cmd+prop
 * @return true if header bit 7 is set and cmd+prop decode cleanly
 */
bool spinel_parse_frame(const uint8_t* buf, size_t len, uint8_t* header, uint32_t* cmd, uint32_t* prop,
                        const uint8_t** payload, size_t* payload_len);

/** Extract TID (low nibble) from header byte. */
static inline uint8_t spinel_header_tid(uint8_t header)
{
    return header & 0x0F;
}

/** Extract IID (bits 4-6) from header byte. */
static inline uint8_t spinel_header_iid(uint8_t header)
{
    return (header >> 4) & 0x03;
}

#ifdef __cplusplus
}
#endif

#endif /* SPINEL_FRAME_H */
