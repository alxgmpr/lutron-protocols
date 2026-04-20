/**
 * Spinel frame tests — VUI encode/decode, frame build/parse, header byte.
 */

#include "spinel_frame.h"
#include <cstdio>
#include <cstring>

/* Pulled from spinel_props.h — that header includes thread_config.h which
 * is kept outside of source control, so we re-declare the constants we need. */
#define SPINEL_CMD_PROP_SET 0x03
#define SPINEL_CMD_PROP_IS 0x06
#define SPINEL_PROP_PHY_CHAN 0x21
#define SPINEL_PROP_MAC_15_4_PANID 0x36
#define SPINEL_PROP_NET_ROLE 0x43
#define SPINEL_PROP_STREAM_NET 0x72

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

TEST(spinel_header_byte_format)
{
    /* FLG bit always set; IID and TID placed correctly */
    uint8_t h = spinel_header_byte(0, 1);
    ASSERT_EQ(h, (uint8_t)0x81);
    ASSERT_EQ((uint8_t)(h & 0x80), (uint8_t)0x80);
    ASSERT_EQ(spinel_header_tid(h), (uint8_t)1);
    ASSERT_EQ(spinel_header_iid(h), (uint8_t)0);

    h = spinel_header_byte(2, 15);
    ASSERT_EQ(h, (uint8_t)0xAF);
    ASSERT_EQ(spinel_header_iid(h), (uint8_t)2);
    ASSERT_EQ(spinel_header_tid(h), (uint8_t)15);
}

TEST(spinel_vui_single_byte)
{
    uint8_t buf[4];
    size_t n = spinel_encode_vui(buf, sizeof(buf), 0x7F);
    ASSERT_EQ(n, (size_t)1);
    ASSERT_EQ(buf[0], (uint8_t)0x7F);

    uint32_t v = 0;
    size_t c = 0;
    ASSERT_TRUE(spinel_decode_vui(buf, 1, &v, &c));
    ASSERT_EQ(v, (uint32_t)0x7F);
    ASSERT_EQ(c, (size_t)1);
}

TEST(spinel_vui_two_byte)
{
    uint8_t buf[4];
    /* Value 0x2000: bits 0-6 = 0x00 -> byte0 = 0x80; bits 7-13 = 0x40 -> byte1 = 0x40 */
    size_t n = spinel_encode_vui(buf, sizeof(buf), 0x2000);
    ASSERT_EQ(n, (size_t)2);
    ASSERT_EQ(buf[0], (uint8_t)0x80);
    ASSERT_EQ(buf[1], (uint8_t)0x40);

    uint32_t v = 0;
    size_t c = 0;
    ASSERT_TRUE(spinel_decode_vui(buf, 2, &v, &c));
    ASSERT_EQ(v, (uint32_t)0x2000);
    ASSERT_EQ(c, (size_t)2);
}

TEST(spinel_vui_rejects_oversized)
{
    /* Value too large for 14-bit VUI */
    uint8_t buf[4];
    size_t n = spinel_encode_vui(buf, sizeof(buf), 0x4000);
    ASSERT_EQ(n, (size_t)0);
}

TEST(spinel_vui_decode_rejects_3byte_continuation)
{
    /* 0x80 0x80 ... — high bit set on byte[1] means 3+ byte VUI, which the
     * decoder explicitly refuses. */
    uint8_t buf[3] = {0x80, 0x80, 0x01};
    uint32_t v = 0;
    size_t c = 0;
    ASSERT_TRUE(!spinel_decode_vui(buf, sizeof(buf), &v, &c));
}

TEST(spinel_build_prop_set_single_byte)
{
    /* Build PROP_SET for SPINEL_PROP_PHY_CHAN (0x21) = channel 15 */
    uint8_t value = 15;
    uint8_t frame[16];
    uint8_t hdr = spinel_header_byte(0, 3);
    size_t n = spinel_build_frame(frame, sizeof(frame), hdr, SPINEL_CMD_PROP_SET, SPINEL_PROP_PHY_CHAN,
                                  &value, 1);
    /* header(1) + cmd(1) + prop(1) + value(1) = 4 */
    ASSERT_EQ(n, (size_t)4);
    ASSERT_EQ(frame[0], (uint8_t)0x83);
    ASSERT_EQ(frame[1], (uint8_t)SPINEL_CMD_PROP_SET);
    ASSERT_EQ(frame[2], (uint8_t)SPINEL_PROP_PHY_CHAN);
    ASSERT_EQ(frame[3], (uint8_t)15);
}

TEST(spinel_build_prop_set_stream_net_payload)
{
    /* PROP_SET STREAM_NET with a multi-byte body */
    uint8_t ipv6_udp[] = {0x60, 0x00, 0x00, 0x00, 0x00, 0x08, 0x11, 0x40};
    uint8_t frame[64];
    uint8_t hdr = spinel_header_byte(0, 7);
    size_t n = spinel_build_frame(frame, sizeof(frame), hdr, SPINEL_CMD_PROP_SET, SPINEL_PROP_STREAM_NET,
                                  ipv6_udp, sizeof(ipv6_udp));
    ASSERT_EQ(n, (size_t)3 + sizeof(ipv6_udp));
    ASSERT_EQ(frame[0], (uint8_t)0x87);
    ASSERT_EQ(frame[1], (uint8_t)SPINEL_CMD_PROP_SET);
    ASSERT_EQ(frame[2], (uint8_t)SPINEL_PROP_STREAM_NET);
    ASSERT_MEM_EQ(frame + 3, ipv6_udp, sizeof(ipv6_udp));
}

TEST(spinel_roundtrip_parse_frame)
{
    uint8_t value[] = {0xDE, 0xAD, 0xBE, 0xEF};
    uint8_t frame[32];
    uint8_t hdr = spinel_header_byte(0, 5);
    size_t n = spinel_build_frame(frame, sizeof(frame), hdr, SPINEL_CMD_PROP_IS, SPINEL_PROP_NET_ROLE, value,
                                  sizeof(value));
    ASSERT_TRUE(n > 0);

    uint8_t out_hdr = 0;
    uint32_t out_cmd = 0, out_prop = 0;
    const uint8_t* payload = nullptr;
    size_t payload_len = 0;
    ASSERT_TRUE(spinel_parse_frame(frame, n, &out_hdr, &out_cmd, &out_prop, &payload, &payload_len));
    ASSERT_EQ(out_hdr, hdr);
    ASSERT_EQ(out_cmd, (uint32_t)SPINEL_CMD_PROP_IS);
    ASSERT_EQ(out_prop, (uint32_t)SPINEL_PROP_NET_ROLE);
    ASSERT_EQ(payload_len, sizeof(value));
    ASSERT_MEM_EQ(payload, value, sizeof(value));
}

TEST(spinel_parse_rejects_no_flg)
{
    uint8_t frame[4] = {0x01, 0x06, 0x00, 0x00}; /* bit 7 clear */
    uint8_t h;
    uint32_t c, p;
    const uint8_t* payload;
    size_t pl;
    ASSERT_TRUE(!spinel_parse_frame(frame, sizeof(frame), &h, &c, &p, &payload, &pl));
}

TEST(spinel_parse_rejects_too_short)
{
    uint8_t frame[2] = {0x81, 0x06};
    uint8_t h;
    uint32_t c, p;
    const uint8_t* payload;
    size_t pl;
    ASSERT_TRUE(!spinel_parse_frame(frame, sizeof(frame), &h, &c, &p, &payload, &pl));
}

TEST(spinel_build_matches_inline_bytes)
{
    /* ccx_task.cpp historically built Spinel frames inline as
     *   frame[0]=header; frame[1]=cmd; frame[2]=prop; memcpy(frame+3, value, value_len)
     * For all props < 0x80 this must match spinel_build_frame byte-for-byte. */
    uint8_t value[] = {0x01, 0x02, 0x03};
    uint8_t inline_frame[16];
    uint8_t hdr = spinel_header_byte(0, 4);
    inline_frame[0] = hdr;
    inline_frame[1] = SPINEL_CMD_PROP_SET;
    inline_frame[2] = SPINEL_PROP_MAC_15_4_PANID;
    memcpy(inline_frame + 3, value, sizeof(value));

    uint8_t built[16];
    size_t n = spinel_build_frame(built, sizeof(built), hdr, SPINEL_CMD_PROP_SET, SPINEL_PROP_MAC_15_4_PANID,
                                  value, sizeof(value));
    ASSERT_EQ(n, (size_t)3 + sizeof(value));
    ASSERT_MEM_EQ(built, inline_frame, n);
}
