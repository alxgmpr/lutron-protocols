/**
 * N81 encode/decode round-trip tests.
 */

#include "cca_n81.h"
#include <cstdio>
#include <cstring>

extern int test_fail_count;
extern void test_registry_add(const char *name, void (*func)());

#define TEST(name) \
    static void test_##name(); \
    static struct test_reg_##name { \
        test_reg_##name() { test_registry_add(#name, test_##name); } \
    } test_reg_inst_##name; \
    static void test_##name()

#define ASSERT_EQ(a, b) do { \
    auto _a = (a); auto _b = (b); \
    if (_a != _b) { \
        printf("  FAIL: %s:%d: %s == %lld, expected %lld\n", \
               __FILE__, __LINE__, #a, (long long)_a, (long long)_b); \
        test_fail_count++; \
        return; \
    } \
} while (0)

#define ASSERT_TRUE(expr) do { \
    if (!(expr)) { \
        printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr); \
        test_fail_count++; \
        return; \
    } \
} while (0)

/* Single byte encode/decode round-trip */
TEST(n81_single_byte_roundtrip)
{
    uint8_t bits[2] = {};
    n81_write_byte(bits, sizeof(bits), 0, 0x42);

    uint8_t out = 0;
    bool ok = n81_decode_byte(bits, sizeof(bits), 0, &out);
    ASSERT_TRUE(ok);
    ASSERT_EQ(out, (uint8_t)0x42);
}

/* Multi-byte stream encode/decode */
TEST(n81_stream_roundtrip)
{
    uint8_t payload[] = {0x88, 0x01, 0x4E, 0x10, 0xA2, 0xC7};
    uint8_t encoded[128] = {};

    size_t encoded_len = n81_encode_packet(payload, sizeof(payload),
                                            encoded, sizeof(encoded));
    ASSERT_TRUE(encoded_len > 0);

    /* Find sync and decode */
    int data_start = n81_find_sync_offset_from(encoded, encoded_len, 0, 200);
    ASSERT_TRUE(data_start >= 0);

    uint8_t decoded[16];
    size_t decoded_len = n81_decode_stream(encoded, encoded_len,
                                            (size_t)data_start, 16, decoded);
    ASSERT_TRUE(decoded_len >= sizeof(payload));

    for (size_t i = 0; i < sizeof(payload); i++) {
        ASSERT_EQ(decoded[i], payload[i]);
    }
}

/* Encode 24-byte packet and decode back */
TEST(n81_full_packet_roundtrip)
{
    uint8_t pkt[24];
    for (size_t i = 0; i < 24; i++) pkt[i] = (uint8_t)(i + 0x80);

    uint8_t encoded[256];
    size_t elen = n81_encode_packet(pkt, 24, encoded, sizeof(encoded));
    ASSERT_TRUE(elen > 0);

    int start = n81_find_sync_offset_from(encoded, elen, 0, 300);
    ASSERT_TRUE(start >= 0);

    uint8_t decoded[56];
    size_t dlen = n81_decode_stream(encoded, elen, (size_t)start, 56, decoded);
    ASSERT_TRUE(dlen >= 24);

    for (size_t i = 0; i < 24; i++) {
        ASSERT_EQ(decoded[i], pkt[i]);
    }
}

/* Bit get/set */
TEST(n81_bit_operations)
{
    uint8_t buf[2] = {0x00, 0x00};

    n81_set_bit(buf, 2, 0, true);    /* MSB of byte 0 */
    ASSERT_EQ(buf[0], (uint8_t)0x80);

    n81_set_bit(buf, 2, 7, true);    /* LSB of byte 0 */
    ASSERT_EQ(buf[0], (uint8_t)0x81);

    ASSERT_TRUE(n81_get_bit(buf, 2, 0));
    ASSERT_TRUE(!n81_get_bit(buf, 2, 1));
    ASSERT_TRUE(n81_get_bit(buf, 2, 7));
}

/* Tolerant decode with framing errors */
TEST(n81_tolerant_decode)
{
    uint8_t payload[] = {0xAA, 0xBB, 0xCC, 0xDD};
    uint8_t encoded[128] = {};

    size_t elen = n81_encode_packet(payload, sizeof(payload),
                                     encoded, sizeof(encoded));
    ASSERT_TRUE(elen > 0);

    int start = n81_find_sync_offset_from(encoded, elen, 0, 200);
    ASSERT_TRUE(start >= 0);

    uint8_t decoded[16];
    uint8_t errors = 0;
    size_t dlen = n81_decode_stream_tolerant(encoded, elen,
                                              (size_t)start,
                                              sizeof(payload),
                                              decoded, &errors);
    ASSERT_TRUE(dlen >= 4);
    ASSERT_EQ(errors, (uint8_t)0);
    ASSERT_EQ(decoded[0], (uint8_t)0xAA);
    ASSERT_EQ(decoded[1], (uint8_t)0xBB);
    ASSERT_EQ(decoded[2], (uint8_t)0xCC);
    ASSERT_EQ(decoded[3], (uint8_t)0xDD);
}

/* Sync finder returns -1 on garbage */
TEST(n81_no_sync_in_garbage)
{
    uint8_t garbage[32];
    memset(garbage, 0x55, sizeof(garbage));

    int result = n81_find_sync_offset_from(garbage, sizeof(garbage), 0, 200);
    ASSERT_EQ(result, -1);
}
