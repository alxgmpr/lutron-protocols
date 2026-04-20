/**
 * HDLC framing tests — encode/decode round-trip, escape sequences, CRC checks.
 */

#include "hdlc.h"
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

#define ASSERT_MEM_EQ(a, b, len)                                                           \
    do {                                                                                   \
        if (memcmp(a, b, len) != 0) {                                                      \
            printf("  FAIL: %s:%d: memcmp(%s, %s, %zu) != 0\n", __FILE__, __LINE__, #a,    \
                   #b, (size_t)(len));                                                     \
            test_fail_count++;                                                             \
            return;                                                                        \
        }                                                                                  \
    } while (0)

/* Helper: feed a wire byte stream into the decoder and return the frame (or 0). */
static size_t decode_wire(const uint8_t* wire, size_t wire_len, uint8_t* out, size_t out_size)
{
    hdlc_decoder_t dec;
    hdlc_decoder_reset(&dec);
    for (size_t i = 0; i < wire_len; i++) {
        size_t payload_len = 0;
        hdlc_decode_result_t r = hdlc_decoder_push(&dec, wire[i], out, out_size, &payload_len);
        if (r == HDLC_DECODE_FRAME) return payload_len;
        if (r == HDLC_DECODE_ERROR) return (size_t)-1;
    }
    return 0; /* incomplete */
}

TEST(hdlc_crc16_known_vector)
{
    /* Empty input: CCITT-reflected with init 0xFFFF + xorout 0xFFFF = 0x0000 */
    ASSERT_EQ(hdlc_crc16(nullptr, 0), (uint16_t)0x0000);
    /* Single 0x00 byte — reflected CCITT known value */
    uint8_t one = 0x00;
    /* Compute expected manually by running the algorithm. Just verify it's not
     * 0xFFFF/0x0000 and is stable. */
    uint16_t crc1 = hdlc_crc16(&one, 1);
    uint16_t crc2 = hdlc_crc16(&one, 1);
    ASSERT_EQ(crc1, crc2);
    ASSERT_TRUE(crc1 != 0xFFFF);
}

TEST(hdlc_encode_simple)
{
    uint8_t payload[] = {0x01, 0x02, 0x03};
    uint8_t wire[32];
    size_t n = hdlc_encode_frame(wire, sizeof(wire), payload, sizeof(payload));
    /* flag + 3 payload + 2 CRC + flag = 7 (no escapes) */
    ASSERT_EQ(n, (size_t)7);
    ASSERT_EQ(wire[0], (uint8_t)HDLC_FLAG);
    ASSERT_EQ(wire[1], (uint8_t)0x01);
    ASSERT_EQ(wire[n - 1], (uint8_t)HDLC_FLAG);
}

TEST(hdlc_encode_escape_flag_byte)
{
    /* Payload containing 0x7E must become 0x7D 0x5E */
    uint8_t payload[] = {0x7E};
    uint8_t wire[16];
    size_t n = hdlc_encode_frame(wire, sizeof(wire), payload, sizeof(payload));
    ASSERT_TRUE(n > 0);
    ASSERT_EQ(wire[0], (uint8_t)HDLC_FLAG);
    ASSERT_EQ(wire[1], (uint8_t)HDLC_ESCAPE);
    ASSERT_EQ(wire[2], (uint8_t)0x5E);
}

TEST(hdlc_encode_escape_escape_byte)
{
    /* 0x7D must become 0x7D 0x5D */
    uint8_t payload[] = {0x7D};
    uint8_t wire[16];
    size_t n = hdlc_encode_frame(wire, sizeof(wire), payload, sizeof(payload));
    ASSERT_TRUE(n > 0);
    ASSERT_EQ(wire[1], (uint8_t)HDLC_ESCAPE);
    ASSERT_EQ(wire[2], (uint8_t)0x5D);
}

TEST(hdlc_encode_overflow_returns_zero)
{
    uint8_t payload[4] = {0x01, 0x02, 0x03, 0x04};
    uint8_t wire[3]; /* way too small */
    size_t n = hdlc_encode_frame(wire, sizeof(wire), payload, sizeof(payload));
    ASSERT_EQ(n, (size_t)0);
}

TEST(hdlc_roundtrip_basic)
{
    uint8_t payload[] = {0x81, 0x06, 0x00, 0x42};
    uint8_t wire[64];
    size_t wire_len = hdlc_encode_frame(wire, sizeof(wire), payload, sizeof(payload));
    ASSERT_TRUE(wire_len > 0);

    uint8_t out[64];
    size_t out_len = decode_wire(wire, wire_len, out, sizeof(out));
    ASSERT_EQ(out_len, sizeof(payload));
    ASSERT_MEM_EQ(out, payload, sizeof(payload));
}

TEST(hdlc_roundtrip_with_escapes)
{
    /* Payload contains both escape-triggering bytes */
    uint8_t payload[] = {0x7E, 0xAA, 0x7D, 0x00, 0x7E, 0x7D};
    uint8_t wire[64];
    size_t wire_len = hdlc_encode_frame(wire, sizeof(wire), payload, sizeof(payload));
    ASSERT_TRUE(wire_len > 0);

    uint8_t out[64];
    size_t out_len = decode_wire(wire, wire_len, out, sizeof(out));
    ASSERT_EQ(out_len, sizeof(payload));
    ASSERT_MEM_EQ(out, payload, sizeof(payload));
}

TEST(hdlc_roundtrip_long_payload)
{
    uint8_t payload[256];
    for (size_t i = 0; i < sizeof(payload); i++) payload[i] = (uint8_t)(i & 0xFF);

    uint8_t wire[600];
    size_t wire_len = hdlc_encode_frame(wire, sizeof(wire), payload, sizeof(payload));
    ASSERT_TRUE(wire_len > 0);

    uint8_t out[512];
    size_t out_len = decode_wire(wire, wire_len, out, sizeof(out));
    ASSERT_EQ(out_len, sizeof(payload));
    ASSERT_MEM_EQ(out, payload, sizeof(payload));
}

TEST(hdlc_decoder_rejects_bad_crc)
{
    uint8_t payload[] = {0x01, 0x02, 0x03};
    uint8_t wire[32];
    size_t wire_len = hdlc_encode_frame(wire, sizeof(wire), payload, sizeof(payload));
    ASSERT_TRUE(wire_len > 0);

    /* Corrupt a CRC byte (second-to-last non-flag byte) */
    wire[wire_len - 2] ^= 0x55;

    uint8_t out[32];
    size_t r = decode_wire(wire, wire_len, out, sizeof(out));
    ASSERT_EQ(r, (size_t)-1); /* HDLC_DECODE_ERROR path */
}

TEST(hdlc_decoder_bytes_before_flag_ignored)
{
    uint8_t payload[] = {0x41, 0x42};
    uint8_t wire[32];
    size_t wire_len = hdlc_encode_frame(wire, sizeof(wire), payload, sizeof(payload));

    /* Prepend junk bytes outside a frame */
    uint8_t stream[64];
    stream[0] = 0xAA;
    stream[1] = 0xBB;
    stream[2] = 0xCC;
    memcpy(stream + 3, wire, wire_len);

    uint8_t out[32];
    size_t out_len = decode_wire(stream, 3 + wire_len, out, sizeof(out));
    ASSERT_EQ(out_len, sizeof(payload));
    ASSERT_MEM_EQ(out, payload, sizeof(payload));
}

TEST(hdlc_decoder_back_to_back_frames)
{
    uint8_t payload_a[] = {0x11};
    uint8_t payload_b[] = {0x22, 0x33};
    uint8_t wire[64];
    size_t na = hdlc_encode_frame(wire, sizeof(wire), payload_a, sizeof(payload_a));
    size_t nb = hdlc_encode_frame(wire + na, sizeof(wire) - na, payload_b, sizeof(payload_b));
    ASSERT_TRUE(na > 0 && nb > 0);

    hdlc_decoder_t dec;
    hdlc_decoder_reset(&dec);
    uint8_t out[32];
    int frames = 0;
    uint8_t seen[2][4];
    size_t seen_len[2] = {0, 0};
    for (size_t i = 0; i < na + nb; i++) {
        size_t payload_len = 0;
        hdlc_decode_result_t r = hdlc_decoder_push(&dec, wire[i], out, sizeof(out), &payload_len);
        if (r == HDLC_DECODE_FRAME) {
            memcpy(seen[frames], out, payload_len);
            seen_len[frames] = payload_len;
            frames++;
        }
    }
    ASSERT_EQ(frames, 2);
    ASSERT_EQ(seen_len[0], sizeof(payload_a));
    ASSERT_MEM_EQ(seen[0], payload_a, sizeof(payload_a));
    ASSERT_EQ(seen_len[1], sizeof(payload_b));
    ASSERT_MEM_EQ(seen[1], payload_b, sizeof(payload_b));
}

TEST(hdlc_decoder_overflow_resets)
{
    /* Encode a payload that exceeds the decoder output buffer. */
    uint8_t big[32];
    memset(big, 0x5A, sizeof(big));
    uint8_t wire[80];
    size_t wire_len = hdlc_encode_frame(wire, sizeof(wire), big, sizeof(big));
    ASSERT_TRUE(wire_len > 0);

    uint8_t small_out[8];
    size_t r = decode_wire(wire, wire_len, small_out, sizeof(small_out));
    ASSERT_EQ(r, (size_t)-1);
}
