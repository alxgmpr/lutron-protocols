/**
 * CoAP message build + parse tests.
 * Covers GET/POST with URI-Path, empty ACK, Observe register/deregister, NON,
 * response parsing, and option-header corner cases.
 */

#include "coap.h"
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

TEST(coap_build_get_no_payload)
{
    uint8_t buf[64];
    size_t n = coap_build_request(buf, sizeof(buf), 0x1234, 0xAB, COAP_CODE_GET, "/a/b", nullptr, 0);
    ASSERT_TRUE(n > 0);

    /* Header: Ver=1, Type=CON, TKL=1 → 0x41, Code=GET → 0x01, MID=0x1234 */
    ASSERT_EQ(buf[0], (uint8_t)0x41);
    ASSERT_EQ(buf[1], (uint8_t)COAP_CODE_GET);
    ASSERT_EQ(buf[2], (uint8_t)0x12);
    ASSERT_EQ(buf[3], (uint8_t)0x34);
    ASSERT_EQ(buf[4], (uint8_t)0xAB); /* token */

    /* Option 1: URI-Path "a" (delta 11, len 1) → first byte 0xB1, then 'a' */
    ASSERT_EQ(buf[5], (uint8_t)0xB1);
    ASSERT_EQ(buf[6], (uint8_t)'a');
    /* Option 2: URI-Path "b" (delta 0, len 1) → 0x01, then 'b' */
    ASSERT_EQ(buf[7], (uint8_t)0x01);
    ASSERT_EQ(buf[8], (uint8_t)'b');
    ASSERT_EQ(n, (size_t)9);
}

TEST(coap_build_with_payload_has_marker)
{
    uint8_t payload[] = {0xCA, 0xFE};
    uint8_t buf[64];
    size_t n = coap_build_request(buf, sizeof(buf), 0x0001, 0x10, COAP_CODE_POST, "/x", payload,
                                  sizeof(payload));
    ASSERT_TRUE(n > 0);
    /* Header(4) + token(1) + opt(2) + marker(1) + payload(2) = 10 */
    ASSERT_EQ(n, (size_t)10);
    ASSERT_EQ(buf[7], (uint8_t)0xFF); /* payload marker */
    ASSERT_EQ(buf[8], (uint8_t)0xCA);
    ASSERT_EQ(buf[9], (uint8_t)0xFE);
}

TEST(coap_build_empty_uri_path_ok)
{
    /* NULL uri_path should still produce a valid header+token with no options. */
    uint8_t buf[16];
    size_t n = coap_build_request(buf, sizeof(buf), 0x00FF, 0x01, COAP_CODE_GET, nullptr, nullptr, 0);
    ASSERT_EQ(n, (size_t)5);
    ASSERT_EQ(buf[0], (uint8_t)0x41);
    ASSERT_EQ(buf[1], (uint8_t)COAP_CODE_GET);
}

TEST(coap_build_request_overflow)
{
    uint8_t buf[3]; /* too small for header */
    size_t n = coap_build_request(buf, sizeof(buf), 1, 1, COAP_CODE_GET, "/a", nullptr, 0);
    ASSERT_EQ(n, (size_t)0);
}

TEST(coap_build_ack_shape)
{
    uint8_t buf[4];
    size_t n = coap_build_ack(buf, sizeof(buf), 0xABCD);
    ASSERT_EQ(n, (size_t)4);
    ASSERT_EQ(buf[0], (uint8_t)0x60); /* Ver=1, Type=ACK, TKL=0 */
    ASSERT_EQ(buf[1], (uint8_t)0x00);
    ASSERT_EQ(buf[2], (uint8_t)0xAB);
    ASSERT_EQ(buf[3], (uint8_t)0xCD);

    /* Too-small buffer rejected */
    uint8_t small[3];
    ASSERT_EQ(coap_build_ack(small, sizeof(small), 0x0001), (size_t)0);
}

TEST(coap_build_observe_register_option_order)
{
    uint8_t buf[64];
    size_t n = coap_build_observe_request(buf, sizeof(buf), 0x2222, 0x33, "/obs/path", 0);
    ASSERT_TRUE(n > 0);
    /* Byte 5 begins options. Observe=option 6, len=1 → 0x61, then value 0x00 */
    ASSERT_EQ(buf[5], (uint8_t)0x61);
    ASSERT_EQ(buf[6], (uint8_t)0x00);
    /* Next option: URI-Path "obs" (delta 11-6=5, len 3) → 0x53 then "obs" */
    ASSERT_EQ(buf[7], (uint8_t)0x53);
    ASSERT_EQ(buf[8], (uint8_t)'o');
    ASSERT_EQ(buf[9], (uint8_t)'b');
    ASSERT_EQ(buf[10], (uint8_t)'s');
    /* Then URI-Path "path" (delta 0, len 4) → 0x04 then "path" */
    ASSERT_EQ(buf[11], (uint8_t)0x04);
    ASSERT_EQ(buf[12], (uint8_t)'p');
}

TEST(coap_build_observe_deregister_val)
{
    uint8_t buf[32];
    size_t n = coap_build_observe_request(buf, sizeof(buf), 0, 0, "/x", 1);
    ASSERT_TRUE(n > 0);
    ASSERT_EQ(buf[6], (uint8_t)0x01); /* observe = 1 (deregister) */
}

TEST(coap_build_non_flips_type_bits)
{
    uint8_t con_buf[32];
    uint8_t non_buf[32];
    size_t con_n = coap_build_request(con_buf, sizeof(con_buf), 0x100, 0x01, COAP_CODE_POST, "/p", nullptr, 0);
    size_t non_n = coap_build_non_request(non_buf, sizeof(non_buf), 0x100, 0x01, COAP_CODE_POST, "/p", nullptr,
                                          0);
    ASSERT_EQ(con_n, non_n);
    ASSERT_EQ((uint8_t)(con_buf[0] & 0x30), (uint8_t)0x00);
    ASSERT_EQ((uint8_t)(non_buf[0] & 0x30), (uint8_t)(COAP_TYPE_NON << 4));
    /* Everything beyond byte 0 must match CON path */
    ASSERT_MEM_EQ(con_buf + 1, non_buf + 1, con_n - 1);
}

TEST(coap_parse_response_content)
{
    /* A 2.05 Content ACK with MID 0xBEEF */
    uint8_t pkt[] = {0x60, COAP_CODE_CONTENT, 0xBE, 0xEF};
    uint8_t type = 0xFF;
    uint8_t code = 0xFF;
    uint16_t mid = 0;
    ASSERT_TRUE(coap_parse_response(pkt, sizeof(pkt), &type, &code, &mid));
    ASSERT_EQ(type, (uint8_t)COAP_TYPE_ACK);
    ASSERT_EQ(code, (uint8_t)COAP_CODE_CONTENT);
    ASSERT_EQ(mid, (uint16_t)0xBEEF);
}

TEST(coap_parse_response_with_token)
{
    /* TKL=1, Type=CON, Code=2.04, MID=0x0042, token=0xEE */
    uint8_t pkt[] = {0x41, COAP_CODE_CHANGED, 0x00, 0x42, 0xEE};
    uint8_t type, code;
    uint16_t mid;
    ASSERT_TRUE(coap_parse_response(pkt, sizeof(pkt), &type, &code, &mid));
    ASSERT_EQ(type, (uint8_t)COAP_TYPE_CON);
    ASSERT_EQ(code, (uint8_t)COAP_CODE_CHANGED);
    ASSERT_EQ(mid, (uint16_t)0x0042);
}

TEST(coap_parse_rejects_bad_version)
{
    /* Version 2 (bits 6-7 = 10) → malformed */
    uint8_t pkt[] = {0x80, 0x00, 0x00, 0x00};
    uint8_t type, code;
    uint16_t mid;
    ASSERT_TRUE(!coap_parse_response(pkt, sizeof(pkt), &type, &code, &mid));
}

TEST(coap_parse_rejects_short)
{
    uint8_t pkt[3] = {0x41, 0x00, 0x00};
    uint8_t type, code;
    uint16_t mid;
    ASSERT_TRUE(!coap_parse_response(pkt, sizeof(pkt), &type, &code, &mid));
}

TEST(coap_parse_rejects_token_exceeds_len)
{
    /* TKL=5 but only 4 bytes total (no room for token) */
    uint8_t pkt[] = {0x45, 0x00, 0x00, 0x00};
    uint8_t type, code;
    uint16_t mid;
    ASSERT_TRUE(!coap_parse_response(pkt, sizeof(pkt), &type, &code, &mid));
}

TEST(coap_build_long_uri_segment)
{
    /* Path segment of length > 12 must use extended length form (len nibble=13) */
    const char long_path[] = "/thisisaverylongsegment";
    uint8_t buf[64];
    size_t n = coap_build_request(buf, sizeof(buf), 1, 0, COAP_CODE_GET, long_path, nullptr, 0);
    ASSERT_TRUE(n > 0);
    /* First option byte: delta 11<<4 | len 13 = 0xBD */
    ASSERT_EQ(buf[5], (uint8_t)0xBD);
    /* Next byte: extended length = seg_len - 13 */
    size_t seg_len = strlen(long_path) - 1; /* minus leading '/' */
    ASSERT_EQ(buf[6], (uint8_t)(seg_len - 13));
}
