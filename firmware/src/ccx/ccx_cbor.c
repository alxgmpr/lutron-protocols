#include "ccx_cbor.h"
#include <string.h>

/* -----------------------------------------------------------------------
 * Internal: encode a CBOR major type + additional info header.
 * Returns bytes written (1, 2, 3, or 5), or 0 if buf too small.
 * ----------------------------------------------------------------------- */
static size_t cbor_encode_header(uint8_t *buf, size_t buf_size,
                                  uint8_t major, uint32_t value)
{
    uint8_t mt = (uint8_t)(major << 5);

    if (value < 24) {
        if (buf_size < 1) return 0;
        buf[0] = mt | (uint8_t)value;
        return 1;
    }
    if (value < 0x100) {
        if (buf_size < 2) return 0;
        buf[0] = mt | 24;
        buf[1] = (uint8_t)value;
        return 2;
    }
    if (value < 0x10000) {
        if (buf_size < 3) return 0;
        buf[0] = mt | 25;
        buf[1] = (uint8_t)(value >> 8);
        buf[2] = (uint8_t)(value & 0xFF);
        return 3;
    }
    /* 32-bit value */
    if (buf_size < 5) return 0;
    buf[0] = mt | 26;
    buf[1] = (uint8_t)(value >> 24);
    buf[2] = (uint8_t)(value >> 16);
    buf[3] = (uint8_t)(value >> 8);
    buf[4] = (uint8_t)(value);
    return 5;
}

/* -----------------------------------------------------------------------
 * Encoder
 * ----------------------------------------------------------------------- */

size_t cbor_encode_uint(uint8_t *buf, size_t buf_size, uint32_t val)
{
    return cbor_encode_header(buf, buf_size, CBOR_MAJOR_UINT, val);
}

size_t cbor_encode_array(uint8_t *buf, size_t buf_size, uint32_t count)
{
    return cbor_encode_header(buf, buf_size, CBOR_MAJOR_ARRAY, count);
}

size_t cbor_encode_map(uint8_t *buf, size_t buf_size, uint32_t count)
{
    return cbor_encode_header(buf, buf_size, CBOR_MAJOR_MAP, count);
}

size_t cbor_encode_bstr(uint8_t *buf, size_t buf_size,
                        const uint8_t *data, size_t len)
{
    size_t hdr_len = cbor_encode_header(buf, buf_size, CBOR_MAJOR_BSTR, (uint32_t)len);
    if (hdr_len == 0) return 0;
    if (hdr_len + len > buf_size) return 0;
    memcpy(buf + hdr_len, data, len);
    return hdr_len + len;
}

size_t cbor_encode_tstr(uint8_t *buf, size_t buf_size,
                        const char *str, size_t len)
{
    size_t hdr_len = cbor_encode_header(buf, buf_size, CBOR_MAJOR_TSTR, (uint32_t)len);
    if (hdr_len == 0) return 0;
    if (hdr_len + len > buf_size) return 0;
    memcpy(buf + hdr_len, str, len);
    return hdr_len + len;
}

/* -----------------------------------------------------------------------
 * Decoder
 * ----------------------------------------------------------------------- */

bool cbor_decode_item(const uint8_t *buf, size_t len, cbor_item_t *item)
{
    if (len < 1) return false;

    item->major = (buf[0] >> 5) & 0x07;
    uint8_t ai = buf[0] & 0x1F;

    if (ai < 24) {
        item->value = ai;
        item->header_len = 1;
        return true;
    }
    if (ai == 24) {
        if (len < 2) return false;
        item->value = buf[1];
        item->header_len = 2;
        return true;
    }
    if (ai == 25) {
        if (len < 3) return false;
        item->value = ((uint32_t)buf[1] << 8) | buf[2];
        item->header_len = 3;
        return true;
    }
    if (ai == 26) {
        if (len < 5) return false;
        item->value = ((uint32_t)buf[1] << 24)
                    | ((uint32_t)buf[2] << 16)
                    | ((uint32_t)buf[3] << 8)
                    | buf[4];
        item->header_len = 5;
        return true;
    }

    /* ai == 27 (64-bit), 28-30 reserved, 31 (indefinite) — not supported */
    return false;
}

bool cbor_decode_uint(const uint8_t *buf, size_t len,
                      uint32_t *val, size_t *consumed)
{
    cbor_item_t item;
    if (!cbor_decode_item(buf, len, &item)) return false;
    if (item.major != CBOR_MAJOR_UINT) return false;
    *val = item.value;
    *consumed = item.header_len;
    return true;
}
