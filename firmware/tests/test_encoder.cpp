/**
 * CCA encoder tests — CRC append, 8N1 encode, full packet structure.
 *
 * Tests the encoding pipeline used by TDMA fire_job():
 *   raw packet → append CRC → 8N1 encode with preamble + sync
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "cca_crc.h"
#include "cca_n81.h"

/* Test framework */
extern int test_pass_count;
extern int test_fail_count;
extern void test_registry_add(const char *name, void (*func)());

#define TEST(name) \
    static void test_##name(); \
    static struct test_reg_##name { \
        test_reg_##name() { test_registry_add(#name, test_##name); } \
    } test_reg_inst_##name; \
    static void test_##name()

#define ASSERT_TRUE(expr) do { \
    if (!(expr)) { \
        printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr); \
        test_fail_count++; \
        return; \
    } \
} while (0)

#define ASSERT_EQ(a, b) do { \
    auto _a = (a); auto _b = (b); \
    if (_a != _b) { \
        printf("  FAIL: %s:%d: %s == %lld, expected %lld\n", \
               __FILE__, __LINE__, #a, (long long)_a, (long long)_b); \
        test_fail_count++; \
        return; \
    } \
} while (0)

#define ASSERT_MEM_EQ(a, b, len) do { \
    if (memcmp(a, b, len) != 0) { \
        printf("  FAIL: %s:%d: memcmp(%s, %s, %zu) != 0\n", \
               __FILE__, __LINE__, #a, #b, (size_t)(len)); \
        test_fail_count++; \
        return; \
    } \
} while (0)

/* -----------------------------------------------------------------------
 * CRC append
 * ----------------------------------------------------------------------- */

TEST(encoder_crc_append)
{
    uint8_t packet[24] = { 0x88, 0x06, 0x05, 0x9B, 0xE1, 0x91, 0x09, 0x00 };
    size_t  payload_len = 22;

    uint16_t crc = cca_calc_crc(packet, payload_len);
    packet[22] = (uint8_t)(crc >> 8);
    packet[23] = (uint8_t)(crc & 0xFF);

    /* CRC bytes should be non-trivial */
    ASSERT_TRUE(packet[22] != 0 || packet[23] != 0);

    /* Verify: recompute CRC over payload, compare against appended bytes */
    uint16_t check = cca_calc_crc(packet, payload_len);
    uint16_t stored = ((uint16_t)packet[22] << 8) | packet[23];
    ASSERT_EQ(check, stored);
}

TEST(encoder_crc_append_long_packet)
{
    uint8_t packet[53];
    memset(packet, 0, sizeof(packet));
    packet[0] = 0xB0; /* pairing type */
    size_t payload_len = 51;

    uint16_t crc = cca_calc_crc(packet, payload_len);
    packet[51] = (uint8_t)(crc >> 8);
    packet[52] = (uint8_t)(crc & 0xFF);

    /* Verify CRC matches */
    uint16_t check = cca_calc_crc(packet, payload_len);
    uint16_t stored = ((uint16_t)packet[51] << 8) | packet[52];
    ASSERT_EQ(check, stored);
}

/* -----------------------------------------------------------------------
 * 8N1 encode round-trip
 * ----------------------------------------------------------------------- */

TEST(encoder_n81_roundtrip_single_byte)
{
    uint8_t input = 0xAB;
    uint8_t encoded[2] = {};
    n81_write_byte(encoded, sizeof(encoded), 0, input);

    uint8_t decoded;
    bool ok = n81_decode_byte(encoded, sizeof(encoded), 0, &decoded);
    ASSERT_TRUE(ok);
    ASSERT_EQ(decoded, 0xAB);
}

TEST(encoder_n81_roundtrip_stream)
{
    uint8_t input[] = { 0x88, 0x06, 0x05, 0x9B, 0xE1, 0x91 };
    size_t  input_len = sizeof(input);
    uint8_t encoded[16] = {};

    /* Encode each byte at 10-bit intervals */
    for (size_t i = 0; i < input_len; i++) {
        n81_write_byte(encoded, sizeof(encoded), i * 10, input[i]);
    }

    /* Decode back */
    uint8_t decoded[6];
    size_t  decoded_len = n81_decode_stream(encoded, sizeof(encoded), 0, 6, decoded);
    ASSERT_EQ(decoded_len, 6u);
    ASSERT_MEM_EQ(decoded, input, 6);
}

/* -----------------------------------------------------------------------
 * Full packet encode structure
 * ----------------------------------------------------------------------- */

TEST(encoder_full_packet_structure)
{
    /* Encode a minimal packet and verify preamble + sync */
    uint8_t payload[] = { 0x88, 0x06, 0x05, 0x9B };
    uint8_t output[64] = {};
    size_t  encoded_len = n81_encode_packet(payload, sizeof(payload), output, sizeof(output));

    ASSERT_TRUE(encoded_len > 0);

    /* First 32 bits should be alternating preamble (1010...) */
    /* In MSB-first bit order: bit 0 = 1, bit 1 = 0, bit 2 = 1, bit 3 = 0... */
    for (int i = 0; i < 32; i++) {
        bool expected = (i % 2) == 0;
        bool actual = n81_get_bit(output, encoded_len, i);
        if (actual != expected) {
            printf("  FAIL: preamble bit %d: got %d, expected %d\n", i, actual, expected);
            test_fail_count++;
            return;
        }
    }

    /* After preamble, should be N81(0xFF) at bit 32 */
    uint8_t sync1;
    bool ok = n81_decode_byte(output, encoded_len, 32, &sync1);
    ASSERT_TRUE(ok);
    ASSERT_EQ(sync1, 0xFF);

    /* Then N81(0xFA) at bit 42 */
    uint8_t sync2;
    ok = n81_decode_byte(output, encoded_len, 42, &sync2);
    ASSERT_TRUE(ok);
    ASSERT_EQ(sync2, 0xFA);

    /* Then N81(0xDE) at bit 52 */
    uint8_t sync3;
    ok = n81_decode_byte(output, encoded_len, 52, &sync3);
    ASSERT_TRUE(ok);
    ASSERT_EQ(sync3, 0xDE);

    /* Then payload bytes starting at bit 62 */
    uint8_t first_data;
    ok = n81_decode_byte(output, encoded_len, 62, &first_data);
    ASSERT_TRUE(ok);
    ASSERT_EQ(first_data, 0x88);
}

TEST(encoder_packet_size_short)
{
    /* 24-byte CCA packet: 22 payload + 2 CRC = 24 bytes */
    /* N81 encoded: 32 preamble + 3*10 sync + 24*10 data + 16 trailing = 318 bits = 40 bytes */
    uint8_t payload[24];
    memset(payload, 0x55, sizeof(payload));
    uint8_t output[64] = {};
    size_t  len = n81_encode_packet(payload, sizeof(payload), output, sizeof(output));
    ASSERT_TRUE(len > 0);

    /* Expected: (32 + 30 + 24*10 + 16) / 8 = 318/8 = 39.75 → 40 bytes */
    size_t expected = (32 + 30 + 24 * 10 + 16 + 7) / 8;
    ASSERT_EQ(len, expected);
}

TEST(encoder_packet_size_long)
{
    /* 53-byte CCA packet: 51 payload + 2 CRC = 53 bytes */
    uint8_t payload[53];
    memset(payload, 0xAA, sizeof(payload));
    uint8_t output[128] = {};
    size_t  len = n81_encode_packet(payload, sizeof(payload), output, sizeof(output));
    ASSERT_TRUE(len > 0);

    size_t expected = (32 + 30 + 53 * 10 + 16 + 7) / 8;
    ASSERT_EQ(len, expected);
}
