/**
 * Stream wire-framing tests — header layout, optional source-address trailer.
 *
 * Covers the GLAB-78 framing change: CCX frames may carry the sender's
 * 16-byte IPv6 source address as a trailer, signalled by STREAM_FLAG_SRC.
 */

#include "stream_frame.h"
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

#define ASSERT_EQ(a, b)                                                                                       \
    do {                                                                                                      \
        auto _a = (a);                                                                                        \
        auto _b = (b);                                                                                        \
        if (_a != _b) {                                                                                       \
            printf("  FAIL: %s:%d: %s == %lld, expected %lld\n", __FILE__, __LINE__, #a, (long long)_a,       \
                   (long long)_b);                                                                            \
            test_fail_count++;                                                                                \
            return;                                                                                           \
        }                                                                                                     \
    } while (0)

#define ASSERT_TRUE(expr)                                                     \
    do {                                                                      \
        if (!(expr)) {                                                        \
            printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr);         \
            test_fail_count++;                                                \
            return;                                                           \
        }                                                                     \
    } while (0)

#define ASSERT_MEM_EQ(a, b, len)                                                                              \
    do {                                                                                                      \
        if (memcmp(a, b, len) != 0) {                                                                         \
            printf("  FAIL: %s:%d: memcmp(%s, %s, %zu) != 0\n", __FILE__, __LINE__, #a, #b, (size_t)(len));   \
            test_fail_count++;                                                                                \
            return;                                                                                           \
        }                                                                                                     \
    } while (0)

/* Mesh-local RLOC address: fd0d:...:0000:00ff:fe00:8401 */
static const uint8_t SRC_RLOC[STREAM_SRC_ADDR_LEN] = {0xFD, 0x0D, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
                                                      0x00, 0x00, 0x00, 0xFF, 0xFE, 0x00, 0x84, 0x01};

/* Sleepy-child ML-EID: no RLOC pattern in bytes 8..13 */
static const uint8_t SRC_MLEID[STREAM_SRC_ADDR_LEN] = {0xFD, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                                       0x0A, 0xBB, 0xCC, 0xDD, 0xEE, 0x11, 0x22, 0x33};

static const uint8_t CBOR[] = {0x82, 0x00, 0xA3, 0x01, 0x18, 0x2A};

/* -----------------------------------------------------------------------
 * Header layout — unchanged from the pre-GLAB-78 framing
 * ----------------------------------------------------------------------- */

TEST(stream_frame_header_layout_is_flags_len_ts_ms_ts_cyc)
{
    uint8_t out[64];
    size_t n = stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX, CBOR, sizeof(CBOR), 0x11223344, 0xAABBCCDD,
                                  nullptr);

    ASSERT_EQ(n, STREAM_FRAME_HEADER_LEN + sizeof(CBOR));
    ASSERT_EQ(out[0], STREAM_FLAG_CCX);
    ASSERT_EQ(out[1], sizeof(CBOR));
    /* TS_MS little-endian at offset 2 */
    ASSERT_EQ(out[2], 0x44);
    ASSERT_EQ(out[3], 0x33);
    ASSERT_EQ(out[4], 0x22);
    ASSERT_EQ(out[5], 0x11);
    /* TS_CYC little-endian at offset 6 */
    ASSERT_EQ(out[6], 0xDD);
    ASSERT_EQ(out[7], 0xCC);
    ASSERT_EQ(out[8], 0xBB);
    ASSERT_EQ(out[9], 0xAA);
    ASSERT_MEM_EQ(out + STREAM_FRAME_HEADER_LEN, CBOR, sizeof(CBOR));
}

/* -----------------------------------------------------------------------
 * Source-address trailer
 * ----------------------------------------------------------------------- */

TEST(stream_frame_appends_src_addr_after_payload_and_sets_flag)
{
    uint8_t out[64];
    size_t n =
        stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX, CBOR, sizeof(CBOR), 1000, 2000, SRC_RLOC);

    ASSERT_EQ(n, STREAM_FRAME_HEADER_LEN + sizeof(CBOR) + STREAM_SRC_ADDR_LEN);
    ASSERT_TRUE((out[0] & STREAM_FLAG_SRC) != 0);
    ASSERT_TRUE((out[0] & STREAM_FLAG_CCX) != 0);
    /* LEN still counts the payload only — an old client slicing [10, 10+LEN)
     * recovers the exact same CBOR it did before the change. */
    ASSERT_EQ(out[1], sizeof(CBOR));
    ASSERT_MEM_EQ(out + STREAM_FRAME_HEADER_LEN, CBOR, sizeof(CBOR));
    ASSERT_MEM_EQ(out + STREAM_FRAME_HEADER_LEN + sizeof(CBOR), SRC_RLOC, STREAM_SRC_ADDR_LEN);
}

TEST(stream_frame_carries_rloc_less_mleid_verbatim)
{
    /* Sleepy children have no RLOC16; the full address is the only attribution
     * available for them, so it must survive byte-for-byte. */
    uint8_t out[64];
    size_t n = stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX, CBOR, sizeof(CBOR), 1, 2, SRC_MLEID);

    ASSERT_EQ(n, STREAM_FRAME_HEADER_LEN + sizeof(CBOR) + STREAM_SRC_ADDR_LEN);
    ASSERT_MEM_EQ(out + STREAM_FRAME_HEADER_LEN + sizeof(CBOR), SRC_MLEID, STREAM_SRC_ADDR_LEN);
}

TEST(stream_frame_omits_flag_when_no_src_addr)
{
    /* Locally-originated TX has no meaningful sender: the flag must be clear
     * and no trailer emitted — never a zero address. */
    uint8_t out[64];
    memset(out, 0xEE, sizeof(out));
    size_t n = stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX, CBOR, sizeof(CBOR), 1, 2, nullptr);

    ASSERT_EQ(n, STREAM_FRAME_HEADER_LEN + sizeof(CBOR));
    ASSERT_EQ(out[0] & STREAM_FLAG_SRC, 0);
    /* Nothing written past the payload */
    ASSERT_EQ(out[STREAM_FRAME_HEADER_LEN + sizeof(CBOR)], 0xEE);
}

TEST(stream_frame_never_lets_the_flag_lie)
{
    /* A caller that pre-sets STREAM_FLAG_SRC but passes no address must not
     * produce a frame claiming a trailer that isn't there. */
    uint8_t out[64];
    size_t n = stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX | STREAM_FLAG_SRC, CBOR, sizeof(CBOR), 1, 2,
                                  nullptr);

    ASSERT_EQ(n, STREAM_FRAME_HEADER_LEN + sizeof(CBOR));
    ASSERT_EQ(out[0] & STREAM_FLAG_SRC, 0);
}

TEST(stream_frame_preserves_other_flag_bits)
{
    uint8_t out[64];
    stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX | STREAM_FLAG_RAW | STREAM_FLAG_TX, CBOR, sizeof(CBOR), 1,
                       2, SRC_RLOC);

    ASSERT_EQ(out[0], STREAM_FLAG_CCX | STREAM_FLAG_RAW | STREAM_FLAG_TX | STREAM_FLAG_SRC);
}

/* -----------------------------------------------------------------------
 * CCA frames — bit 4 is RSSI magnitude, not STREAM_FLAG_SRC
 * ----------------------------------------------------------------------- */

TEST(stream_frame_preserves_cca_rssi_bit_four)
{
    /* |RSSI| = 0x14 (-20 dBm) sets bit 4, which is STREAM_FLAG_SRC's bit. On a
     * CCA frame that bit belongs to the RSSI magnitude, so clearing it would
     * silently report -4 dBm instead. Every |RSSI| in 16..31 hits this. */
    uint8_t out[64];
    const uint8_t rssi_flags = 0x14 & STREAM_FLAG_RSSI_MASK;
    size_t n = stream_frame_build(out, sizeof(out), rssi_flags, CBOR, sizeof(CBOR), 1, 2, nullptr);

    ASSERT_EQ(n, STREAM_FRAME_HEADER_LEN + sizeof(CBOR));
    ASSERT_EQ(out[0], rssi_flags);
    ASSERT_EQ(out[0] & STREAM_FLAG_RSSI_MASK, 0x14);
}

TEST(stream_frame_rejects_src_addr_on_non_ccx_frame)
{
    /* A trailer on a CCA frame is unfindable — the reader cannot tell
     * STREAM_FLAG_SRC from an RSSI bit — so building one must fail loudly
     * rather than emit an unparseable frame. */
    uint8_t out[64];
    size_t n = stream_frame_build(out, sizeof(out), 0x14, CBOR, sizeof(CBOR), 1, 2, SRC_RLOC);
    ASSERT_EQ(n, 0);
}

/* -----------------------------------------------------------------------
 * Capacity and argument guards
 * ----------------------------------------------------------------------- */

TEST(stream_frame_rejects_buffer_too_small_for_trailer)
{
    uint8_t out[STREAM_FRAME_HEADER_LEN + sizeof(CBOR) + STREAM_SRC_ADDR_LEN - 1];
    size_t n = stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX, CBOR, sizeof(CBOR), 1, 2, SRC_RLOC);
    ASSERT_EQ(n, 0);
}

TEST(stream_frame_fits_exactly_at_max_capacity)
{
    uint8_t payload[STREAM_FRAME_MAX_PAYLOAD];
    memset(payload, 0x5A, sizeof(payload));
    uint8_t out[STREAM_FRAME_MAX_LEN];

    size_t n = stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX, payload, sizeof(payload), 1, 2, SRC_RLOC);
    ASSERT_EQ(n, STREAM_FRAME_MAX_LEN);
    ASSERT_MEM_EQ(out + STREAM_FRAME_HEADER_LEN + sizeof(payload), SRC_RLOC, STREAM_SRC_ADDR_LEN);
}

TEST(stream_frame_rejects_null_payload_with_nonzero_len)
{
    uint8_t out[64];
    ASSERT_EQ(stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX, nullptr, 4, 1, 2, nullptr), 0);
}

TEST(stream_frame_allows_empty_payload)
{
    uint8_t out[64];
    size_t n = stream_frame_build(out, sizeof(out), STREAM_FLAG_CCX, nullptr, 0, 1, 2, SRC_RLOC);
    ASSERT_EQ(n, STREAM_FRAME_HEADER_LEN + STREAM_SRC_ADDR_LEN);
    ASSERT_EQ(out[1], 0);
    ASSERT_MEM_EQ(out + STREAM_FRAME_HEADER_LEN, SRC_RLOC, STREAM_SRC_ADDR_LEN);
}
