#include "spinel_frame.h"
#include <string.h>

uint8_t spinel_header_byte(uint8_t iid, uint8_t tid)
{
    return (uint8_t)(0x80 | ((iid & 0x03) << 4) | (tid & 0x0F));
}

size_t spinel_encode_vui(uint8_t* out, size_t out_size, uint32_t value)
{
    if (value < 0x80) {
        if (out_size < 1) return 0;
        out[0] = (uint8_t)value;
        return 1;
    }
    if (value < 0x4000) {
        if (out_size < 2) return 0;
        out[0] = (uint8_t)(0x80 | (value & 0x7F));
        out[1] = (uint8_t)((value >> 7) & 0x7F);
        return 2;
    }
    /* Higher VUI widths not used by current NCP — refuse rather than silently truncate. */
    return 0;
}

bool spinel_decode_vui(const uint8_t* in, size_t in_len, uint32_t* value, size_t* consumed)
{
    if (in_len == 0) return false;
    if ((in[0] & 0x80) == 0) {
        *value = in[0];
        *consumed = 1;
        return true;
    }
    if (in_len < 2) return false;
    /* Up to 2-byte VUI (14 bits): low 7 in byte 0, high 7 in byte 1. */
    if (in[1] & 0x80) return false; /* reject 3+ byte VUI (unused in this codebase) */
    *value = (uint32_t)(in[0] & 0x7F) | ((uint32_t)in[1] << 7);
    *consumed = 2;
    return true;
}

size_t spinel_build_frame(uint8_t* out, size_t out_size, uint8_t header, uint32_t cmd, uint32_t prop,
                          const uint8_t* value, size_t value_len)
{
    if (out_size < 1) return 0;
    size_t pos = 0;
    out[pos++] = header;

    size_t n = spinel_encode_vui(out + pos, out_size - pos, cmd);
    if (n == 0) return 0;
    pos += n;

    n = spinel_encode_vui(out + pos, out_size - pos, prop);
    if (n == 0) return 0;
    pos += n;

    if (value_len > 0) {
        if (pos + value_len > out_size) return 0;
        memcpy(out + pos, value, value_len);
        pos += value_len;
    }
    return pos;
}

bool spinel_parse_frame(const uint8_t* buf, size_t len, uint8_t* header, uint32_t* cmd, uint32_t* prop,
                        const uint8_t** payload, size_t* payload_len)
{
    if (len < 3) return false;
    if ((buf[0] & 0x80) == 0) return false;
    *header = buf[0];

    size_t off = 1;
    size_t n = 0;
    if (!spinel_decode_vui(buf + off, len - off, cmd, &n)) return false;
    off += n;

    if (!spinel_decode_vui(buf + off, len - off, prop, &n)) return false;
    off += n;

    *payload = buf + off;
    *payload_len = len - off;
    return true;
}
