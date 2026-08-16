/**
 * Stream wire-format serializer — see stream_frame.h for the layout.
 *
 * Pure and dependency-free so the host test runner can link it directly.
 */

#include "stream_frame.h"

#include <string.h>

static void put_le32(uint8_t* dst, uint32_t val)
{
    dst[0] = (uint8_t)(val);
    dst[1] = (uint8_t)(val >> 8);
    dst[2] = (uint8_t)(val >> 16);
    dst[3] = (uint8_t)(val >> 24);
}

size_t stream_frame_build(uint8_t* out, size_t out_cap, uint8_t flags, const uint8_t* data, uint8_t len, uint32_t ts_ms,
                          uint32_t ts_cyc, const uint8_t* src_addr)
{
    if (out == NULL) return 0;
    if (data == NULL && len > 0) return 0;

    const size_t trailer = (src_addr != NULL) ? STREAM_SRC_ADDR_LEN : 0;
    const size_t total = STREAM_FRAME_HEADER_LEN + (size_t)len + trailer;
    if (out_cap < total) return 0;

    /* The flag mirrors what we actually write — it can never overstate. */
    out[0] = (src_addr != NULL) ? (uint8_t)(flags | STREAM_FLAG_SRC) : (uint8_t)(flags & (uint8_t)~STREAM_FLAG_SRC);
    out[1] = len;
    put_le32(out + 2, ts_ms);
    put_le32(out + 6, ts_cyc);
    if (len > 0) memcpy(out + STREAM_FRAME_HEADER_LEN, data, len);
    if (trailer > 0) memcpy(out + STREAM_FRAME_HEADER_LEN + len, src_addr, STREAM_SRC_ADDR_LEN);

    return total;
}
