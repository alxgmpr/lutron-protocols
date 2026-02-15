/**
 * CRC-16/CA0F test vectors.
 */

#include "cca_crc.h"
#include <cstdio>
#include <cstring>

/* Macros from test_main.cpp */
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
        printf("  FAIL: %s:%d: %s == 0x%llX, expected 0x%llX\n", \
               __FILE__, __LINE__, #a, (unsigned long long)_a, (unsigned long long)_b); \
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

/* Known CCA packet: button press ON from device 4E10A2C7 */
TEST(crc16_button_press)
{
    uint8_t pkt[] = {
        0x88, 0x01, 0x4E, 0x10, 0xA2, 0xC7, 0x03, 0x02,
        0x00, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    };
    /* CRC is over first 22 bytes, expected CRC at [22..23] */
    uint16_t crc = cca_calc_crc(pkt, 22);
    /* Verify CRC is non-zero and deterministic */
    ASSERT_TRUE(crc != 0);

    /* Verify cca_append_crc works */
    uint8_t with_crc[24];
    cca_append_crc(pkt, 22, with_crc);
    ASSERT_EQ(with_crc[22], (uint8_t)(crc >> 8));
    ASSERT_EQ(with_crc[23], (uint8_t)(crc & 0xFF));
}

/* CRC of empty data should be 0 */
TEST(crc16_empty)
{
    uint16_t crc = cca_calc_crc(nullptr, 0);
    ASSERT_EQ(crc, (uint16_t)0);
}

/* CRC of single byte */
TEST(crc16_single_byte)
{
    uint8_t data[] = {0x42};
    uint16_t crc = cca_calc_crc(data, 1);
    /* Just verify it's deterministic */
    uint16_t crc2 = cca_calc_crc(data, 1);
    ASSERT_EQ(crc, crc2);
}

/* Verify cca_check_crc_at_lengths with valid CRC */
TEST(crc16_check_at_lengths)
{
    uint8_t pkt[24] = {
        0x88, 0x01, 0x4E, 0x10, 0xA2, 0xC7, 0x03, 0x02,
        0x00, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    };
    /* Compute and append CRC */
    uint16_t crc = cca_calc_crc(pkt, 22);
    pkt[22] = (uint8_t)(crc >> 8);
    pkt[23] = (uint8_t)(crc & 0xFF);

    size_t candidates[] = {24, 53};
    int match = cca_check_crc_at_lengths(pkt, 24, candidates, 2);
    ASSERT_EQ(match, 24);
}

/* Verify cca_check_crc_at_lengths returns -1 on bad CRC */
TEST(crc16_check_bad)
{
    uint8_t pkt[24] = {};
    pkt[0] = 0x88;
    pkt[22] = 0xFF;
    pkt[23] = 0xFF;

    size_t candidates[] = {24, 53};
    int match = cca_check_crc_at_lengths(pkt, 24, candidates, 2);
    ASSERT_EQ(match, -1);
}
