/**
 * Synth-OTA-TX builder tests — verify cca_ota_build_* produce packets that
 * match captured-on-air ground truth (bytes 0-21 / 0-50 for short / long
 * packets, pre-CRC).
 *
 * Ground truth pulled from
 * data/captures/cca-ota-20260428-190439.packets.jsonl
 * (Caseta Pro REP2 → DVRF-6L OTA, subnet 0xEFFD, target serial 0x06FE8020).
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "cca_generated.h"
#include "cca_ota_tx.h"

extern int test_pass_count;
extern int test_fail_count;
extern void test_registry_add(const char* name, void (*func)());

#define TEST(name)                                                   \
    static void test_##name();                                       \
    static struct test_reg_##name {                                  \
        test_reg_##name() { test_registry_add(#name, test_##name); } \
    } test_reg_inst_##name;                                          \
    static void test_##name()

#define ASSERT_EQ(a, b)                                                                                 \
    do {                                                                                                \
        auto _a = (a);                                                                                  \
        auto _b = (b);                                                                                  \
        if (_a != _b) {                                                                                 \
            printf("  FAIL: %s:%d: %s == %lld, expected %lld\n", __FILE__, __LINE__, #a, (long long)_a, \
                   (long long)_b);                                                                      \
            test_fail_count++;                                                                          \
            return;                                                                                     \
        }                                                                                               \
    } while (0)

#define ASSERT_MEM_EQ(a, b, len)                                                                            \
    do {                                                                                                    \
        if (memcmp((a), (b), (len)) != 0) {                                                                 \
            printf("  FAIL: %s:%d: memcmp(%s, %s, %zu) != 0\n", __FILE__, __LINE__, #a, #b, (size_t)(len)); \
            for (size_t _i = 0; _i < (size_t)(len); _i++) {                                                 \
                if (((const uint8_t*)(a))[_i] != ((const uint8_t*)(b))[_i]) {                               \
                    printf("    byte[%zu] got=0x%02X want=0x%02X\n", _i, ((const uint8_t*)(a))[_i],         \
                           ((const uint8_t*)(b))[_i]);                                                      \
                }                                                                                           \
            }                                                                                               \
            test_fail_count++;                                                                              \
            return;                                                                                         \
        }                                                                                                   \
    } while (0)

/* --------------------------------------------------------------------------
 * Ground truth from captured Caseta Pro REP2 → DVRF-6L OTA (2026-04-28).
 * All bytes pre-CRC; CRC-16 added by N81 framer.
 * Sequence byte [1] is set by TDMA engine — builders write 0x00 placeholder.
 * -------------------------------------------------------------------------- */

/* BeginTransfer: type 0x92, sub-op 06 00, payload 02 20 00 00 00 1F.
 * Original capture: 92 01 a1 ef fd 00 21 0e 00 06 fe 80 20 fe 06 00 02 20 00 00 00 1f */
static const uint8_t EXPECT_BEGIN_TRANSFER[22] = {
    0x92, 0x00, 0xA1, 0xEF, 0xFD, 0x00, 0x21, 0x0E, 0x00, 0x06, 0xFE,
    0x80, 0x20, 0xFE, 0x06, 0x00, 0x02, 0x20, 0x00, 0x00, 0x00, 0x1F,
};

/* TransferData: type 0xB3, sub-op 06 02, sub-counter 0x23, addrLo 0x49FD,
 * 31-byte chunk payload (placeholder bytes 0xAA..0xC8 for test).
 * Original capture: b3 01 a1 ef fd 00 21 2b 00 06 fe 80 20 fe 06 02 23 49 fd 1f <31 bytes> */
static const uint8_t EXPECT_TRANSFER_DATA_HEADER[20] = {
    0xB3, 0x00, 0xA1, 0xEF, 0xFD, 0x00, 0x21, 0x2B, 0x00, 0x06,
    0xFE, 0x80, 0x20, 0xFE, 0x06, 0x02, 0x23, 0x49, 0xFD, 0x1F,
};

/* ChangeAddressOffset: type 0x91, sub-op 06 01, payload 00 PREV 00 NEW.
 * Original capture: 91 01 a1 ef fd 00 21 0c 00 06 fe 80 20 fe 06 01 00 01 00 02 cc cc */
static const uint8_t EXPECT_CHANGE_ADDR[22] = {
    0x91, 0x00, 0xA1, 0xEF, 0xFD, 0x00, 0x21, 0x0C, 0x00, 0x06, 0xFE,
    0x80, 0x20, 0xFE, 0x06, 0x01, 0x00, 0x01, 0x00, 0x02, 0xCC, 0xCC,
};

/* Device-poll BROADCAST: type 0x83, sub-op 06 03, body filler cc*6.
 * DeviceClass at bytes 9-12, byte[13]=0xFD broadcast marker.
 * Original capture: 83 01 a1 ef fd 00 21 08 00 04 63 02 01 fd 06 03 cc cc cc cc cc cc */
static const uint8_t EXPECT_OTA_POLL_BROADCAST[22] = {
    0x83, 0x00, 0xA1, 0xEF, 0xFD, 0x00, 0x21, 0x08, 0x00, 0x04, 0x63,
    0x02, 0x01, 0xFD, 0x06, 0x03, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
};

/* Device-poll UNICAST: type 0x92, sub-op 06 03, body filler cc*6.
 * Serial at bytes 9-12, byte[13]=0xFE unicast marker.
 * Original capture: 92 01 a1 ef fd 00 21 08 00 06 fe 80 20 fe 06 03 cc cc cc cc cc cc */
static const uint8_t EXPECT_OTA_POLL_UNICAST[22] = {
    0x92, 0x00, 0xA1, 0xEF, 0xFD, 0x00, 0x21, 0x08, 0x00, 0x06, 0xFE,
    0x80, 0x20, 0xFE, 0x06, 0x03, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC, 0xCC,
};

/* --------------------------------------------------------------------------
 * BeginTransfer
 * -------------------------------------------------------------------------- */

TEST(ota_begin_transfer_matches_capture)
{
    uint8_t pkt[22];
    size_t len = cca_ota_build_begin_transfer(pkt, 0xEFFD, 0x06FE8020);
    ASSERT_EQ(len, 22u);
    ASSERT_MEM_EQ(pkt, EXPECT_BEGIN_TRANSFER, 22);
}

TEST(ota_begin_transfer_unicast_marker)
{
    uint8_t pkt[22];
    cca_ota_build_begin_transfer(pkt, 0xFFFF, 0x12345678);
    ASSERT_EQ(pkt[13], 0xFE); /* unicast marker */
}

TEST(ota_begin_transfer_serial_be)
{
    uint8_t pkt[22];
    cca_ota_build_begin_transfer(pkt, 0xFFFF, 0xDEADBEEF);
    ASSERT_EQ(pkt[9], 0xDE);
    ASSERT_EQ(pkt[10], 0xAD);
    ASSERT_EQ(pkt[11], 0xBE);
    ASSERT_EQ(pkt[12], 0xEF);
}

TEST(ota_begin_transfer_subnet_factory_default)
{
    uint8_t pkt[22];
    cca_ota_build_begin_transfer(pkt, 0xFFFF, 0x06FE8020);
    /* For unpaired devices we use the factory-default subnet 0xFFFF. */
    ASSERT_EQ(pkt[3], 0xFF);
    ASSERT_EQ(pkt[4], 0xFF);
}

/* --------------------------------------------------------------------------
 * TransferData
 * -------------------------------------------------------------------------- */

TEST(ota_transfer_data_header_matches_capture)
{
    uint8_t pkt[51];
    uint8_t chunk[31];
    for (size_t i = 0; i < 31; i++) chunk[i] = (uint8_t)(0xAA + i);

    size_t len = cca_ota_build_transfer_data(pkt, 0xB3, 0xEFFD, 0x06FE8020,
                                             /* sub_counter */ 0x23, /* addr_lo */ 0x49FD, chunk, 31);

    ASSERT_EQ(len, 51u);
    ASSERT_MEM_EQ(pkt, EXPECT_TRANSFER_DATA_HEADER, 20);
}

TEST(ota_transfer_data_carries_chunk_payload)
{
    uint8_t pkt[51];
    uint8_t chunk[31];
    for (size_t i = 0; i < 31; i++) chunk[i] = (uint8_t)(0xAA + i);

    cca_ota_build_transfer_data(pkt, 0xB2, 0xEFFD, 0x06FE8020, 0x10, 0x0000, chunk, 31);

    /* Bytes 20..50 should be the 31-byte chunk verbatim. */
    ASSERT_MEM_EQ(pkt + 20, chunk, 31);
}

TEST(ota_transfer_data_chunk_size_byte)
{
    uint8_t pkt[51];
    uint8_t chunk[31] = {0};
    cca_ota_build_transfer_data(pkt, 0xB2, 0xEFFD, 0x06FE8020, 0x00, 0x0000, chunk, 31);
    ASSERT_EQ(pkt[19], 0x1F); /* chunk size = 31 */
}

TEST(ota_transfer_data_addr_lo_be)
{
    uint8_t pkt[51];
    uint8_t chunk[31] = {0};
    cca_ota_build_transfer_data(pkt, 0xB2, 0xEFFD, 0x06FE8020, 0x00, 0xCAFE, chunk, 31);
    ASSERT_EQ(pkt[17], 0xCA);
    ASSERT_EQ(pkt[18], 0xFE);
}

TEST(ota_transfer_data_rejects_non_b1_b3_carrier)
{
    uint8_t pkt[51];
    uint8_t chunk[31] = {0};
    /* Carrier must be 0xB1, 0xB2, or 0xB3 (3-arm TDMA). Anything else = 0. */
    ASSERT_EQ(cca_ota_build_transfer_data(pkt, 0xA1, 0xEFFD, 0x06FE8020, 0, 0, chunk, 31), 0u);
    ASSERT_EQ(cca_ota_build_transfer_data(pkt, 0xB0, 0xEFFD, 0x06FE8020, 0, 0, chunk, 31), 0u);
    ASSERT_EQ(cca_ota_build_transfer_data(pkt, 0x92, 0xEFFD, 0x06FE8020, 0, 0, chunk, 31), 0u);
}

TEST(ota_transfer_data_rejects_wrong_chunk_len)
{
    uint8_t pkt[51];
    uint8_t chunk[31] = {0};
    ASSERT_EQ(cca_ota_build_transfer_data(pkt, 0xB2, 0xEFFD, 0x06FE8020, 0, 0, chunk, 30), 0u);
    ASSERT_EQ(cca_ota_build_transfer_data(pkt, 0xB2, 0xEFFD, 0x06FE8020, 0, 0, chunk, 32), 0u);
}

/* --------------------------------------------------------------------------
 * ChangeAddressOffset
 * -------------------------------------------------------------------------- */

TEST(ota_change_addr_matches_capture)
{
    uint8_t pkt[22];
    size_t len = cca_ota_build_change_addr_offset(pkt, 0xEFFD, 0x06FE8020,
                                                  /* prev */ 0x0001,
                                                  /* next */ 0x0002);
    ASSERT_EQ(len, 22u);
    ASSERT_MEM_EQ(pkt, EXPECT_CHANGE_ADDR, 22);
}

TEST(ota_change_addr_page_zero_to_one)
{
    /* Inferred page 0 → 1 announce (the captured OTA had page 0→1 lost to
     * bit errors, but this is the expected encoding). */
    uint8_t pkt[22];
    cca_ota_build_change_addr_offset(pkt, 0xEFFD, 0x06FE8020, 0x0000, 0x0001);
    ASSERT_EQ(pkt[16], 0x00);
    ASSERT_EQ(pkt[17], 0x00);
    ASSERT_EQ(pkt[18], 0x00);
    ASSERT_EQ(pkt[19], 0x01);
}

/* --------------------------------------------------------------------------
 * Chunk-stream iterator (helper for streaming an LDF body as TransferData
 * packets, advancing addrLo by 31 per packet, wrapping at 64 KB).
 * -------------------------------------------------------------------------- */

TEST(ota_chunk_iter_advances_31_per_step)
{
    OtaChunkIter it;
    uint8_t fw[100] = {0};
    cca_ota_chunk_iter_init(&it, fw, sizeof(fw));
    ASSERT_EQ(it.addr_lo, 0u);
    cca_ota_chunk_iter_advance(&it);
    ASSERT_EQ(it.addr_lo, 31u);
    cca_ota_chunk_iter_advance(&it);
    ASSERT_EQ(it.addr_lo, 62u);
}

TEST(ota_chunk_iter_emits_page_boundary)
{
    /* At 64 KB boundary the iterator should signal page advance. */
    OtaChunkIter it;
    uint8_t* fw = (uint8_t*)calloc(0x12000, 1); /* >64KB */
    cca_ota_chunk_iter_init(&it, fw, 0x12000);
    /* Manually force addr_lo near wrap: 0xFFE3 + 31 = 0x10002 → wraps. */
    it.addr_lo = 0xFFE3;
    bool wrapped = cca_ota_chunk_iter_advance(&it);
    ASSERT_EQ(wrapped, true);
    ASSERT_EQ(it.page, 1u);
    ASSERT_EQ(it.addr_lo, 2u); /* low 16 bits of 0x10002 */
    free(fw);
}

TEST(ota_chunk_iter_pads_short_final_chunk)
{
    /* If firmware body length is not a multiple of 31, the final chunk
     * should still be 31 bytes — pad with 0x00 (matches LDF body's natural
     * trailing padding). */
    OtaChunkIter it;
    uint8_t fw[40] = {0};
    for (size_t i = 0; i < 40; i++) fw[i] = (uint8_t)(0x10 + i);
    cca_ota_chunk_iter_init(&it, fw, 40);
    cca_ota_chunk_iter_advance(&it); /* skip to chunk 1 (offset 31) */
    uint8_t chunk[31];
    cca_ota_chunk_iter_fill(&it, chunk);
    ASSERT_EQ(chunk[0], 0x10 + 31); /* fw[31] */
    ASSERT_EQ(chunk[8], 0x10 + 39); /* fw[39] = last real byte */
    ASSERT_EQ(chunk[9], 0x00);      /* padding starts */
    ASSERT_EQ(chunk[30], 0x00);     /* pad through chunk end */
}

/* --------------------------------------------------------------------------
 * Device-poll (sub-op 06 03) — safe pre-flight, no flash side effects.
 * Use BEFORE BeginTransfer to verify device reachability without bricking.
 * Refs docs/firmware-re/powpak-conversion-attack.md §"Brick incident".
 * -------------------------------------------------------------------------- */

TEST(ota_poll_broadcast_matches_capture)
{
    uint8_t pkt[22];
    size_t len = cca_ota_build_poll(pkt, 0x83, 0xEFFD, 0x04630201, true);
    ASSERT_EQ(len, 22u);
    ASSERT_MEM_EQ(pkt, EXPECT_OTA_POLL_BROADCAST, 22);
}

TEST(ota_poll_unicast_matches_capture)
{
    uint8_t pkt[22];
    size_t len = cca_ota_build_poll(pkt, 0x92, 0xEFFD, 0x06FE8020, false);
    ASSERT_EQ(len, 22u);
    ASSERT_MEM_EQ(pkt, EXPECT_OTA_POLL_UNICAST, 22);
}

TEST(ota_poll_broadcast_byte13_marker)
{
    uint8_t pkt[22];
    cca_ota_build_poll(pkt, 0x81, 0xFFFF, 0x16030201, true);
    ASSERT_EQ(pkt[13], 0xFD); /* broadcast marker */
}

TEST(ota_poll_unicast_byte13_marker)
{
    uint8_t pkt[22];
    cca_ota_build_poll(pkt, 0x91, 0xFFFF, 0x12345678, false);
    ASSERT_EQ(pkt[13], 0xFE); /* unicast marker */
}

TEST(ota_poll_filler_is_cc)
{
    uint8_t pkt[22];
    cca_ota_build_poll(pkt, 0x92, 0xEFFD, 0x06FE8020, false);
    for (size_t i = 16; i < 22; i++) {
        ASSERT_EQ(pkt[i], 0xCC);
    }
}

TEST(ota_poll_body_length_sig)
{
    uint8_t pkt[22];
    cca_ota_build_poll(pkt, 0x92, 0xEFFD, 0x06FE8020, false);
    ASSERT_EQ(pkt[7], 0x08); /* poll body length signature */
}

TEST(ota_poll_subop)
{
    uint8_t pkt[22];
    cca_ota_build_poll(pkt, 0x92, 0xEFFD, 0x06FE8020, false);
    ASSERT_EQ(pkt[14], 0x06);
    ASSERT_EQ(pkt[15], 0x03); /* OTA_SUB_POLL */
}

TEST(ota_poll_rejects_invalid_carrier)
{
    uint8_t pkt[22];
    /* Broadcast carriers must be 0x81/82/83, unicast must be 0x91/92.
     * Anything else returns 0. */
    ASSERT_EQ(cca_ota_build_poll(pkt, 0xA1, 0xEFFD, 0x16030201, true), 0u);
    ASSERT_EQ(cca_ota_build_poll(pkt, 0xB2, 0xEFFD, 0x16030201, true), 0u);
    ASSERT_EQ(cca_ota_build_poll(pkt, 0x00, 0xEFFD, 0x16030201, true), 0u);
    /* Carrier/flag mismatch must reject too: broadcast carrier with
     * is_broadcast=false is incoherent. */
    ASSERT_EQ(cca_ota_build_poll(pkt, 0x83, 0xEFFD, 0x16030201, false), 0u);
    ASSERT_EQ(cca_ota_build_poll(pkt, 0x92, 0xEFFD, 0x06FE8020, true), 0u);
}

TEST(ota_poll_serial_be_unicast)
{
    uint8_t pkt[22];
    cca_ota_build_poll(pkt, 0x92, 0xFFFF, 0xDEADBEEF, false);
    ASSERT_EQ(pkt[9], 0xDE);
    ASSERT_EQ(pkt[10], 0xAD);
    ASSERT_EQ(pkt[11], 0xBE);
    ASSERT_EQ(pkt[12], 0xEF);
}

TEST(ota_poll_devclass_broadcast)
{
    uint8_t pkt[22];
    cca_ota_build_poll(pkt, 0x83, 0xFFFF, 0x16030201, true);
    /* DeviceClass for RMJ-16R-DV-B target encoded BE at bytes 9-12. */
    ASSERT_EQ(pkt[9], 0x16);
    ASSERT_EQ(pkt[10], 0x03);
    ASSERT_EQ(pkt[11], 0x02);
    ASSERT_EQ(pkt[12], 0x01);
}
