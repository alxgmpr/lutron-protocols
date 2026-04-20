/**
 * SMP serial DFU tests — wire frame structure, CRC, base64, response parse.
 */

#include "smp_serial.h"
#include "ccx_cbor.h"
#include <cstdio>
#include <cstring>

extern int test_fail_count;
extern void test_registry_add(const char* name, void (*func)());

#define TEST(name)                                                   \
    static void test_##name();                                       \
    static struct test_reg_##name {                                  \
        test_reg_##name() { test_registry_add(#name, test_##name); } \
    } test_reg_inst_##name;                                          \
    static void test_##name()

#define ASSERT_EQ(a, b)                                                                 \
    do {                                                                                \
        auto _a = (a);                                                                  \
        auto _b = (b);                                                                  \
        if (_a != _b) {                                                                 \
            printf("  FAIL: %s:%d: %s == %lld, expected %lld\n", __FILE__, __LINE__,    \
                   #a, (long long)_a, (long long)_b);                                   \
            test_fail_count++;                                                          \
            return;                                                                     \
        }                                                                               \
    } while (0)

#define ASSERT_TRUE(expr)                                                          \
    do {                                                                           \
        if (!(expr)) {                                                             \
            printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr);              \
            test_fail_count++;                                                     \
            return;                                                                \
        }                                                                          \
    } while (0)

/* -----------------------------------------------------------------------
 * Local base64 decoder (for inspecting the built wire frames in tests).
 * ----------------------------------------------------------------------- */
static int b64_decode_char(uint8_t c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static size_t b64_decode(uint8_t* out, size_t out_size, const uint8_t* in, size_t in_len)
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
        if (j < out_len) out[j++] = (uint8_t)(triple >> 16);
        if (j < out_len) out[j++] = (uint8_t)(triple >> 8);
        if (j < out_len) out[j++] = (uint8_t)(triple >> 0);
    }
    return out_len;
}

/* Same CRC-16/XMODEM used by smp_serial.c — needed to construct a valid
 * fake response for smp_parse_response tests. */
static uint16_t crc16_xmodem(const uint8_t* data, size_t len)
{
    uint16_t seed = 0;
    for (; len > 0; len--) {
        uint16_t x = ((seed >> 8) ^ *data++) & 0xFF;
        x ^= x >> 4;
        seed = (seed << 8) ^ (x << 12) ^ (x << 5) ^ x;
    }
    return seed;
}

static const uint8_t B64_TABLE[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t b64_encode(uint8_t* out, size_t out_size, const uint8_t* in, size_t in_len)
{
    size_t out_len = 4 * ((in_len + 2) / 3);
    if (out_len > out_size) return 0;
    size_t j = 0;
    for (size_t i = 0; i < in_len;) {
        uint32_t a = (i < in_len) ? in[i++] : 0;
        uint32_t b = (i < in_len) ? in[i++] : 0;
        uint32_t c = (i < in_len) ? in[i++] : 0;
        uint32_t triple = (a << 16) | (b << 8) | c;
        out[j++] = B64_TABLE[(triple >> 18) & 0x3F];
        out[j++] = B64_TABLE[(triple >> 12) & 0x3F];
        out[j++] = B64_TABLE[(triple >> 6) & 0x3F];
        out[j++] = B64_TABLE[(triple >> 0) & 0x3F];
    }
    size_t pad = (3 - (in_len % 3)) % 3;
    for (size_t i = 0; i < pad; i++) out[out_len - 1 - i] = '=';
    return out_len;
}

/* -----------------------------------------------------------------------
 * Tests
 * ----------------------------------------------------------------------- */

TEST(smp_upload_wire_prefix_and_suffix)
{
    uint8_t data[16];
    memset(data, 0x55, sizeof(data));
    uint8_t out[512];
    size_t n = smp_build_upload(out, sizeof(out), /*offset=*/0, data, sizeof(data), /*image_size=*/1024,
                                /*seq=*/42);
    ASSERT_TRUE(n > 4);
    ASSERT_EQ(out[0], (uint8_t)0x06);
    ASSERT_EQ(out[1], (uint8_t)0x09);
    ASSERT_EQ(out[n - 1], (uint8_t)'\n');
}

TEST(smp_upload_header_write_op_group_id)
{
    uint8_t data[8];
    memset(data, 0xA5, sizeof(data));
    uint8_t wire[512];
    size_t n = smp_build_upload(wire, sizeof(wire), 0, data, sizeof(data), 2048, 7);
    ASSERT_TRUE(n > 0);

    /* Strip prefix/suffix and base64-decode to inspect the raw frame */
    uint8_t raw[256];
    size_t raw_len = b64_decode(raw, sizeof(raw), wire + 2, n - 3);
    ASSERT_TRUE(raw_len >= 12);

    /* Layout: [len_hi, len_lo, op, flags, len_hi, len_lo, grp_hi, grp_lo, seq, id, cbor..., crc_hi, crc_lo] */
    ASSERT_EQ(raw[2], (uint8_t)0x02);  /* SMP op = WRITE */
    ASSERT_EQ(raw[3], (uint8_t)0x00);  /* flags */
    ASSERT_EQ(raw[6], (uint8_t)0x00);  /* group hi */
    ASSERT_EQ(raw[7], (uint8_t)0x01);  /* group lo = IMG */
    ASSERT_EQ(raw[8], (uint8_t)7);     /* seq */
    ASSERT_EQ(raw[9], (uint8_t)0x01);  /* id = UPLOAD */

    /* Verify CRC over everything except the trailing 2 CRC bytes */
    uint16_t expected = ((uint16_t)raw[raw_len - 2] << 8) | raw[raw_len - 1];
    uint16_t calc = crc16_xmodem(raw, raw_len - 2);
    ASSERT_EQ(expected, calc);
}

TEST(smp_upload_first_chunk_has_len_key)
{
    uint8_t data[4] = {0xDE, 0xAD, 0xBE, 0xEF};
    uint8_t wire[512];
    size_t n = smp_build_upload(wire, sizeof(wire), /*offset=*/0, data, sizeof(data),
                                /*image_size=*/0x4000, /*seq=*/1);
    ASSERT_TRUE(n > 0);

    uint8_t raw[256];
    size_t raw_len = b64_decode(raw, sizeof(raw), wire + 2, n - 3);
    ASSERT_TRUE(raw_len > 12);

    /* CBOR payload starts at raw[10] (after length[2] + SMP header[8]). */
    uint8_t cbor_first = raw[10];
    /* Major type 5 (map) with count 3 → 0xA3 */
    ASSERT_EQ(cbor_first, (uint8_t)0xA3);
}

TEST(smp_upload_subsequent_chunk_no_len_key)
{
    uint8_t data[4] = {0x11, 0x22, 0x33, 0x44};
    uint8_t wire[512];
    size_t n = smp_build_upload(wire, sizeof(wire), /*offset=*/0x1000, data, sizeof(data),
                                /*image_size=*/0x4000, /*seq=*/2);
    ASSERT_TRUE(n > 0);

    uint8_t raw[256];
    size_t raw_len = b64_decode(raw, sizeof(raw), wire + 2, n - 3);
    ASSERT_TRUE(raw_len > 12);

    /* Map count should be 2 when offset != 0 → 0xA2 */
    ASSERT_EQ(raw[10], (uint8_t)0xA2);
}

TEST(smp_image_list_is_read_op)
{
    uint8_t wire[256];
    size_t n = smp_build_image_list(wire, sizeof(wire), /*seq=*/99);
    ASSERT_TRUE(n > 0);
    ASSERT_EQ(wire[0], (uint8_t)0x06);
    ASSERT_EQ(wire[1], (uint8_t)0x09);
    ASSERT_EQ(wire[n - 1], (uint8_t)'\n');

    uint8_t raw[128];
    size_t raw_len = b64_decode(raw, sizeof(raw), wire + 2, n - 3);
    ASSERT_TRUE(raw_len >= 12);
    ASSERT_EQ(raw[2], (uint8_t)0x00); /* op = READ */
    ASSERT_EQ(raw[9], (uint8_t)0x00); /* id = STATE */
}

/* Helper: build a synthetic SMP response {"rc": rc, "off": off}. */
static size_t make_smp_response(uint8_t* out, size_t out_size, uint32_t rc, uint32_t off)
{
    /* CBOR map(2): "rc": rc, "off": off */
    uint8_t cbor[32];
    size_t cpos = 0;
    cpos += cbor_encode_map(cbor + cpos, sizeof(cbor) - cpos, 2);
    cpos += cbor_encode_tstr(cbor + cpos, sizeof(cbor) - cpos, "rc", 2);
    cpos += cbor_encode_uint(cbor + cpos, sizeof(cbor) - cpos, rc);
    cpos += cbor_encode_tstr(cbor + cpos, sizeof(cbor) - cpos, "off", 3);
    cpos += cbor_encode_uint(cbor + cpos, sizeof(cbor) - cpos, off);

    /* SMP packet: header(8) + cbor(cpos) */
    uint8_t smp[64];
    smp[0] = 0x03; /* WRITE_RSP */
    smp[1] = 0x00;
    smp[2] = (uint8_t)(cpos >> 8);
    smp[3] = (uint8_t)(cpos & 0xFF);
    smp[4] = 0x00;
    smp[5] = 0x01;
    smp[6] = 0x00;
    smp[7] = 0x01;
    memcpy(smp + 8, cbor, cpos);
    size_t smp_len = 8 + cpos;

    /* Raw frame: len(2) + smp + crc(2) */
    uint8_t raw[128];
    uint16_t frame_len = (uint16_t)(smp_len + 2);
    raw[0] = (uint8_t)(frame_len >> 8);
    raw[1] = (uint8_t)(frame_len & 0xFF);
    memcpy(raw + 2, smp, smp_len);
    uint16_t crc = crc16_xmodem(raw, 2 + smp_len);
    raw[2 + smp_len] = (uint8_t)(crc >> 8);
    raw[2 + smp_len + 1] = (uint8_t)(crc & 0xFF);
    size_t raw_len = 2 + smp_len + 2;

    /* Wire: 0x06 0x09 b64(raw) \n */
    if (out_size < 4) return 0;
    out[0] = 0x06;
    out[1] = 0x09;
    size_t b64_len = b64_encode(out + 2, out_size - 3, raw, raw_len);
    out[2 + b64_len] = '\n';
    return 2 + b64_len + 1;
}

TEST(smp_parse_success_response)
{
    uint8_t wire[256];
    size_t n = make_smp_response(wire, sizeof(wire), /*rc=*/0, /*off=*/0x800);
    ASSERT_TRUE(n > 0);

    int rc = -99;
    uint32_t off = 0;
    ASSERT_TRUE(smp_parse_response(wire, n, &rc, &off));
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(off, (uint32_t)0x800);
}

TEST(smp_parse_error_rc)
{
    uint8_t wire[256];
    size_t n = make_smp_response(wire, sizeof(wire), /*rc=*/5, /*off=*/0);
    ASSERT_TRUE(n > 0);

    int rc = -99;
    uint32_t off = 0xFFFFFFFF;
    ASSERT_TRUE(smp_parse_response(wire, n, &rc, &off));
    ASSERT_EQ(rc, 5);
    ASSERT_EQ(off, (uint32_t)0);
}

TEST(smp_parse_rejects_missing_prefix)
{
    uint8_t wire[8] = {0x00, 0x00, 0x00, 0x00};
    int rc = -99;
    uint32_t off = 0;
    ASSERT_TRUE(!smp_parse_response(wire, sizeof(wire), &rc, &off));
}

TEST(smp_parse_rejects_bad_crc)
{
    uint8_t wire[256];
    size_t n = make_smp_response(wire, sizeof(wire), 0, 0x100);
    ASSERT_TRUE(n > 0);

    /* Corrupt a base64 character in the middle (changes the decoded CRC) */
    wire[10] = (wire[10] == 'A') ? 'B' : 'A';

    int rc = -99;
    uint32_t off = 0;
    ASSERT_TRUE(!smp_parse_response(wire, n, &rc, &off));
}
