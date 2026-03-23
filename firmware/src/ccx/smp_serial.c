#include "smp_serial.h"
#include "ccx_cbor.h"
#include <string.h>

/* -----------------------------------------------------------------------
 * Base64 encode/decode
 * ----------------------------------------------------------------------- */
static const char b64_table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t base64_encode(uint8_t* out, size_t out_size, const uint8_t* in, size_t in_len)
{
    size_t out_len = 4 * ((in_len + 2) / 3);
    if (out_len > out_size) return 0;

    size_t j = 0;
    for (size_t i = 0; i < in_len;) {
        uint32_t a = (i < in_len) ? in[i++] : 0;
        uint32_t b = (i < in_len) ? in[i++] : 0;
        uint32_t c = (i < in_len) ? in[i++] : 0;
        uint32_t triple = (a << 16) | (b << 8) | c;

        out[j++] = (uint8_t)b64_table[(triple >> 18) & 0x3F];
        out[j++] = (uint8_t)b64_table[(triple >> 12) & 0x3F];
        out[j++] = (uint8_t)b64_table[(triple >> 6) & 0x3F];
        out[j++] = (uint8_t)b64_table[(triple >> 0) & 0x3F];
    }

    /* Padding */
    size_t pad = (3 - (in_len % 3)) % 3;
    for (size_t i = 0; i < pad; i++) {
        out[out_len - 1 - i] = '=';
    }

    return out_len;
}

static int b64_decode_char(uint8_t c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static size_t base64_decode(uint8_t* out, size_t out_size, const uint8_t* in, size_t in_len)
{
    if (in_len == 0 || (in_len % 4) != 0) return 0;

    size_t out_len = (in_len / 4) * 3;
    if (in[in_len - 1] == '=') out_len--;
    if (in[in_len - 2] == '=') out_len--;
    if (out_len > out_size) return 0;

    size_t j = 0;
    for (size_t i = 0; i < in_len; i += 4) {
        int a = b64_decode_char(in[i]);
        int b = b64_decode_char(in[i + 1]);
        int c = (in[i + 2] == '=') ? 0 : b64_decode_char(in[i + 2]);
        int d = (in[i + 3] == '=') ? 0 : b64_decode_char(in[i + 3]);
        if (a < 0 || b < 0 || c < 0 || d < 0) return 0;

        uint32_t triple = ((uint32_t)a << 18) | ((uint32_t)b << 12) | ((uint32_t)c << 6) | (uint32_t)d;

        if (j < out_len) out[j++] = (uint8_t)((triple >> 16) & 0xFF);
        if (j < out_len) out[j++] = (uint8_t)((triple >> 8) & 0xFF);
        if (j < out_len) out[j++] = (uint8_t)((triple >> 0) & 0xFF);
    }

    return out_len;
}

/* -----------------------------------------------------------------------
 * CRC-16/XMODEM (poly 0x1021, init 0x0000) — used by MCUboot SMP serial
 * ----------------------------------------------------------------------- */
static uint16_t crc16_ccitt(uint16_t seed, const uint8_t* data, size_t len)
{
    for (; len > 0; len--) {
        uint16_t x;
        x = ((seed >> 8) ^ *data++) & 0xFF;
        x ^= x >> 4;
        seed = (seed << 8) ^ (x << 12) ^ (x << 5) ^ x;
    }
    return seed;
}

/* -----------------------------------------------------------------------
 * SMP header builder
 * ----------------------------------------------------------------------- */
#define SMP_OP_READ   0x00
#define SMP_OP_WRITE  0x02
#define SMP_GROUP_IMG 0x0001
#define SMP_ID_UPLOAD 0x01
#define SMP_ID_STATE  0x00

static void smp_build_header(uint8_t* hdr, uint8_t op, uint16_t len, uint16_t group, uint8_t seq, uint8_t id)
{
    hdr[0] = op;
    hdr[1] = 0x00; /* flags */
    hdr[2] = (uint8_t)(len >> 8);
    hdr[3] = (uint8_t)(len & 0xFF);
    hdr[4] = (uint8_t)(group >> 8);
    hdr[5] = (uint8_t)(group & 0xFF);
    hdr[6] = seq;
    hdr[7] = id;
}

/* -----------------------------------------------------------------------
 * Build complete SMP serial wire frame
 *
 * raw = len(2 BE) + smp_header(8) + cbor(N) + crc16(2)
 * wire = 0x06 0x09 base64(raw) \n
 * ----------------------------------------------------------------------- */
static size_t smp_wrap_frame(uint8_t* out, size_t out_size, const uint8_t* smp_pkt, size_t smp_len)
{
    /* raw = 2(len) + smp_len + 2(crc) */
    size_t  raw_len = 2 + smp_len + 2;
    uint8_t raw[512];
    if (raw_len > sizeof(raw)) return 0;

    /* Length field: total bytes after length (smp_pkt + crc) */
    uint16_t frame_len = (uint16_t)(smp_len + 2);
    raw[0] = (uint8_t)(frame_len >> 8);
    raw[1] = (uint8_t)(frame_len & 0xFF);

    memcpy(raw + 2, smp_pkt, smp_len);

    /* CRC-16 over everything except the CRC itself */
    uint16_t crc = crc16_ccitt(0, raw, 2 + smp_len);
    raw[2 + smp_len] = (uint8_t)(crc >> 8);
    raw[2 + smp_len + 1] = (uint8_t)(crc & 0xFF);

    /* Base64 encode */
    size_t b64_max = 4 * ((raw_len + 2) / 3);
    if (2 + b64_max + 1 > out_size) return 0;

    out[0] = 0x06;
    out[1] = 0x09;

    size_t b64_len = base64_encode(out + 2, out_size - 3, raw, raw_len);
    if (b64_len == 0) return 0;

    out[2 + b64_len] = '\n';
    return 2 + b64_len + 1;
}

/* -----------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

size_t smp_build_upload(uint8_t* out, size_t out_size, uint32_t offset, const uint8_t* data, size_t data_len,
                        uint32_t image_size, uint8_t seq)
{
    /* Build CBOR payload:
     *   map(2 or 3) {
     *     "off": offset,
     *     "data": data[data_len],
     *     "len": image_size     // only when offset == 0
     *   }
     */
    uint8_t cbor[384];
    size_t  pos = 0;
    size_t  n;

    uint32_t map_count = (offset == 0) ? 3 : 2;
    n = cbor_encode_map(cbor + pos, sizeof(cbor) - pos, map_count);
    if (n == 0) return 0;
    pos += n;

    /* "off": offset */
    n = cbor_encode_tstr(cbor + pos, sizeof(cbor) - pos, "off", 3);
    if (n == 0) return 0;
    pos += n;
    n = cbor_encode_uint(cbor + pos, sizeof(cbor) - pos, offset);
    if (n == 0) return 0;
    pos += n;

    /* "data": chunk bytes */
    n = cbor_encode_tstr(cbor + pos, sizeof(cbor) - pos, "data", 4);
    if (n == 0) return 0;
    pos += n;
    n = cbor_encode_bstr(cbor + pos, sizeof(cbor) - pos, data, data_len);
    if (n == 0) return 0;
    pos += n;

    /* "len": total image size (first chunk only) */
    if (offset == 0) {
        n = cbor_encode_tstr(cbor + pos, sizeof(cbor) - pos, "len", 3);
        if (n == 0) return 0;
        pos += n;
        n = cbor_encode_uint(cbor + pos, sizeof(cbor) - pos, image_size);
        if (n == 0) return 0;
        pos += n;
    }

    /* Build SMP packet: header(8) + cbor */
    uint8_t smp_pkt[400];
    if (8 + pos > sizeof(smp_pkt)) return 0;

    smp_build_header(smp_pkt, SMP_OP_WRITE, (uint16_t)pos, SMP_GROUP_IMG, seq, SMP_ID_UPLOAD);
    memcpy(smp_pkt + 8, cbor, pos);

    return smp_wrap_frame(out, out_size, smp_pkt, 8 + pos);
}

size_t smp_build_image_list(uint8_t* out, size_t out_size, uint8_t seq)
{
    /* Empty CBOR map for image state read */
    uint8_t cbor[4];
    size_t  pos = cbor_encode_map(cbor, sizeof(cbor), 0);
    if (pos == 0) return 0;

    uint8_t smp_pkt[16];
    smp_build_header(smp_pkt, SMP_OP_READ, (uint16_t)pos, SMP_GROUP_IMG, seq, SMP_ID_STATE);
    memcpy(smp_pkt + 8, cbor, pos);

    return smp_wrap_frame(out, out_size, smp_pkt, 8 + pos);
}

bool smp_parse_response(const uint8_t* in, size_t in_len, int* rc, uint32_t* off)
{
    *rc = -1;
    *off = 0;

    /* Skip 0x06 0x09 prefix */
    if (in_len < 4 || in[0] != 0x06 || in[1] != 0x09) return false;
    const uint8_t* b64_start = in + 2;
    size_t         b64_len = in_len - 2;

    /* Strip trailing \n or \r\n */
    while (b64_len > 0 && (b64_start[b64_len - 1] == '\n' || b64_start[b64_len - 1] == '\r')) {
        b64_len--;
    }
    if (b64_len == 0) return false;

    /* Base64 decode */
    uint8_t raw[512];
    size_t  raw_len = base64_decode(raw, sizeof(raw), b64_start, b64_len);
    if (raw_len < 12) return false; /* 2(len) + 8(hdr) + 2(crc) minimum */

    /* Verify CRC: over everything except last 2 bytes */
    uint16_t expected_crc = ((uint16_t)raw[raw_len - 2] << 8) | raw[raw_len - 1];
    uint16_t calc_crc = crc16_ccitt(0, raw, raw_len - 2);
    if (calc_crc != expected_crc) return false;

    /* Skip 2-byte length + 8-byte SMP header → CBOR payload */
    size_t cbor_off = 10;
    size_t cbor_len = raw_len - 12; /* exclude len(2) + hdr(8) + crc(2) */
    if (cbor_len == 0) return false;

    /* Parse CBOR map looking for "rc" and "off" keys */
    const uint8_t* p = raw + cbor_off;
    size_t         remaining = cbor_len;

    cbor_item_t item;
    if (!cbor_decode_item(p, remaining, &item)) return false;
    if (item.major != CBOR_MAJOR_MAP) return false;
    uint32_t map_entries = item.value;
    p += item.header_len;
    remaining -= item.header_len;

    for (uint32_t i = 0; i < map_entries && remaining > 0; i++) {
        /* Decode key (expect text string) */
        if (!cbor_decode_item(p, remaining, &item)) break;
        if (item.major != CBOR_MAJOR_TSTR) {
            /* Skip unknown key+value */
            p += item.header_len + item.value;
            remaining -= item.header_len + item.value;
            /* Skip value */
            if (!cbor_decode_item(p, remaining, &item)) break;
            if (item.major == CBOR_MAJOR_BSTR || item.major == CBOR_MAJOR_TSTR) {
                p += item.header_len + item.value;
                remaining -= item.header_len + item.value;
            }
            else {
                p += item.header_len;
                remaining -= item.header_len;
            }
            continue;
        }

        size_t         key_hdr = item.header_len;
        size_t         key_len = item.value;
        const uint8_t* key_data = p + key_hdr;
        p += key_hdr + key_len;
        remaining -= key_hdr + key_len;

        /* Decode value */
        if (!cbor_decode_item(p, remaining, &item)) break;

        if (key_len == 2 && memcmp(key_data, "rc", 2) == 0 && item.major == CBOR_MAJOR_UINT) {
            *rc = (int)item.value;
        }
        else if (key_len == 3 && memcmp(key_data, "off", 3) == 0 && item.major == CBOR_MAJOR_UINT) {
            *off = item.value;
        }

        /* Advance past value */
        if (item.major == CBOR_MAJOR_BSTR || item.major == CBOR_MAJOR_TSTR) {
            p += item.header_len + item.value;
            remaining -= item.header_len + item.value;
        }
        else {
            p += item.header_len;
            remaining -= item.header_len;
        }
    }

    return (*rc >= 0);
}
