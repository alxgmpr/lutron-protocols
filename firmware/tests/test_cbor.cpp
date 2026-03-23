/**
 * CBOR encode/decode round-trip + CCX message tests.
 */

#include "ccx_cbor.h"
#include "ccx_msg.h"
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

/* Encode small uint */
TEST(cbor_encode_uint_small)
{
    uint8_t buf[5];
    size_t n = cbor_encode_uint(buf, sizeof(buf), 0);
    ASSERT_EQ(n, (size_t)1);
    ASSERT_EQ(buf[0], (uint8_t)0x00);

    n = cbor_encode_uint(buf, sizeof(buf), 23);
    ASSERT_EQ(n, (size_t)1);
    ASSERT_EQ(buf[0], (uint8_t)23);
}

/* Encode 1-byte uint */
TEST(cbor_encode_uint_1byte)
{
    uint8_t buf[5];
    size_t n = cbor_encode_uint(buf, sizeof(buf), 24);
    ASSERT_EQ(n, (size_t)2);
    ASSERT_EQ(buf[0], (uint8_t)0x18);
    ASSERT_EQ(buf[1], (uint8_t)24);

    n = cbor_encode_uint(buf, sizeof(buf), 255);
    ASSERT_EQ(n, (size_t)2);
    ASSERT_EQ(buf[0], (uint8_t)0x18);
    ASSERT_EQ(buf[1], (uint8_t)255);
}

/* Encode 2-byte uint */
TEST(cbor_encode_uint_2byte)
{
    uint8_t buf[5];
    size_t n = cbor_encode_uint(buf, sizeof(buf), 0xFEFF);
    ASSERT_EQ(n, (size_t)3);
    ASSERT_EQ(buf[0], (uint8_t)0x19);
    ASSERT_EQ(buf[1], (uint8_t)0xFE);
    ASSERT_EQ(buf[2], (uint8_t)0xFF);
}

/* Encode 4-byte uint */
TEST(cbor_encode_uint_4byte)
{
    uint8_t buf[5];
    size_t n = cbor_encode_uint(buf, sizeof(buf), 0x00010000);
    ASSERT_EQ(n, (size_t)5);
    ASSERT_EQ(buf[0], (uint8_t)0x1A);
}

/* Decode uint */
TEST(cbor_decode_uint_roundtrip)
{
    uint8_t buf[5];
    size_t enc_len = cbor_encode_uint(buf, sizeof(buf), 42);

    uint32_t val = 0;
    size_t consumed = 0;
    bool ok = cbor_decode_uint(buf, enc_len, &val, &consumed);
    ASSERT_TRUE(ok);
    ASSERT_EQ(val, (uint32_t)42);
    ASSERT_EQ(consumed, enc_len);
}

/* Decode large uint */
TEST(cbor_decode_uint_large)
{
    uint8_t buf[5];
    cbor_encode_uint(buf, sizeof(buf), 0xFEFF);

    uint32_t val = 0;
    size_t consumed = 0;
    bool ok = cbor_decode_uint(buf, 3, &val, &consumed);
    ASSERT_TRUE(ok);
    ASSERT_EQ(val, (uint32_t)0xFEFF);
}

/* Encode/decode array header */
TEST(cbor_array_header)
{
    uint8_t buf[5];
    size_t n = cbor_encode_array(buf, sizeof(buf), 2);
    ASSERT_EQ(n, (size_t)1);
    ASSERT_EQ(buf[0], (uint8_t)0x82);  /* major 4, value 2 */

    cbor_item_t item;
    bool ok = cbor_decode_item(buf, n, &item);
    ASSERT_TRUE(ok);
    ASSERT_EQ(item.major, (uint8_t)CBOR_MAJOR_ARRAY);
    ASSERT_EQ(item.value, (uint32_t)2);
}

/* Encode/decode map header */
TEST(cbor_map_header)
{
    uint8_t buf[5];
    size_t n = cbor_encode_map(buf, sizeof(buf), 3);
    ASSERT_EQ(n, (size_t)1);
    ASSERT_EQ(buf[0], (uint8_t)0xA3);  /* major 5, value 3 */

    cbor_item_t item;
    bool ok = cbor_decode_item(buf, n, &item);
    ASSERT_TRUE(ok);
    ASSERT_EQ(item.major, (uint8_t)CBOR_MAJOR_MAP);
    ASSERT_EQ(item.value, (uint32_t)3);
}

/* Encode/decode byte string */
TEST(cbor_bstr)
{
    uint8_t data[] = {0xDE, 0xAD, 0xBE, 0xEF};
    uint8_t buf[16];
    size_t n = cbor_encode_bstr(buf, sizeof(buf), data, 4);
    ASSERT_EQ(n, (size_t)5);  /* 1 header + 4 data */
    ASSERT_EQ(buf[0], (uint8_t)0x44);  /* major 2, len 4 */
    ASSERT_EQ(buf[1], (uint8_t)0xDE);

    cbor_item_t item;
    bool ok = cbor_decode_item(buf, n, &item);
    ASSERT_TRUE(ok);
    ASSERT_EQ(item.major, (uint8_t)CBOR_MAJOR_BSTR);
    ASSERT_EQ(item.value, (uint32_t)4);
}

/* CCX level control encode + decode round-trip */
TEST(ccx_level_control_roundtrip)
{
    uint8_t buf[64];
    size_t len = ccx_encode_level_control(buf, sizeof(buf),
                                           961, 0xFEFF, 1, 92);
    ASSERT_TRUE(len > 0);

    ccx_decoded_msg_t msg;
    bool ok = ccx_decode_message(buf, len, &msg);
    ASSERT_TRUE(ok);
    ASSERT_EQ(msg.msg_type, (uint16_t)CCX_MSG_LEVEL_CONTROL);
    ASSERT_EQ(msg.zone_id, (uint16_t)961);
    ASSERT_EQ(msg.level, (uint16_t)0xFEFF);
    ASSERT_EQ(msg.fade, (uint8_t)1);
    ASSERT_EQ(msg.sequence, (uint8_t)92);
}

/* CCX scene recall encode + decode round-trip */
TEST(ccx_scene_recall_roundtrip)
{
    uint8_t buf[64];
    size_t len = ccx_encode_scene_recall(buf, sizeof(buf), 5, 200);
    ASSERT_TRUE(len > 0);

    ccx_decoded_msg_t msg;
    bool ok = ccx_decode_message(buf, len, &msg);
    ASSERT_TRUE(ok);
    ASSERT_EQ(msg.msg_type, (uint16_t)CCX_MSG_SCENE_RECALL);
    ASSERT_EQ(msg.scene_id, (uint16_t)5);
    ASSERT_EQ(msg.sequence, (uint8_t)200);
}

/* ccx_percent_to_level boundary cases */
TEST(ccx_percent_to_level)
{
    ASSERT_EQ(ccx_percent_to_level(0), (uint16_t)CCX_LEVEL_OFF);
    ASSERT_EQ(ccx_percent_to_level(100), (uint16_t)CCX_LEVEL_FULL_ON);
    /* 50% should be roughly half */
    uint16_t half = ccx_percent_to_level(50);
    ASSERT_TRUE(half > 0x7000 && half < 0x8000);
}

/* ccx_msg_type_name */
TEST(ccx_msg_type_names)
{
    ASSERT_EQ(strcmp(ccx_msg_type_name(0), "LEVEL_CONTROL"), 0);
    ASSERT_EQ(strcmp(ccx_msg_type_name(1), "BUTTON_PRESS"), 0);
    ASSERT_EQ(strcmp(ccx_msg_type_name(36), "SCENE_RECALL"), 0);
    ASSERT_EQ(strcmp(ccx_msg_type_name(999), "UNKNOWN"), 0);
}
