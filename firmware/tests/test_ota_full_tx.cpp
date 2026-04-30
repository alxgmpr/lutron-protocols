/**
 * cca_ota_full_tx_walk — pure orchestration of BeginTransfer +
 * TransferData× + ChangeAddrOff packets. Walks the cca_ota_session body
 * via OtaChunkIter and invokes a callback for each on-air packet.
 *
 * Tests verify the packet sequence (types, body-length signatures, carrier
 * rotation, page-wrap behaviour) without touching any TX engine.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>

#include "cca_ota_session.h"
#include "cca_ota_tx.h"

extern int test_fail_count;
extern void test_registry_add(const char* name, void (*func)());

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
        test_fail_count++; return; \
    } \
} while (0)

struct PacketLogEntry {
    uint8_t type;
    uint8_t body_len_sig;
    size_t  len;
};

static PacketLogEntry s_log[256];
static size_t s_log_n = 0;

static void log_callback(const uint8_t* pkt, size_t len, void* /*ctx*/)
{
    if (s_log_n < 256) {
        s_log[s_log_n].type = pkt[0];
        s_log[s_log_n].body_len_sig = pkt[7];
        s_log[s_log_n].len = len;
        s_log_n++;
    }
}

/* For large bodies (>256 packets) — counts each packet class without
 * recording every packet. */
struct CountCtx {
    uint32_t begin_count;
    uint32_t transfer_count;
    uint32_t change_addr_count;
};

static void count_callback(const uint8_t* pkt, size_t /*len*/, void* ctx_v)
{
    CountCtx* c = (CountCtx*)ctx_v;
    if (pkt[0] == 0x92 && pkt[7] == 0x0E) c->begin_count++;
    else if (pkt[0] == 0x91 && pkt[7] == 0x0C) c->change_addr_count++;
    else if (pkt[0] >= 0xB1 && pkt[0] <= 0xB3 && pkt[7] == 0x2B) c->transfer_count++;
}

static void fill_session(uint32_t total)
{
    cca_ota_session_reset();
    cca_ota_session_start(total);
    /* Write in 256-byte blocks of 0x00 (we only care about packet sequence,
     * not chunk content). */
    uint8_t block[256] = {0};
    for (uint32_t off = 0; off < total; off += 256) {
        uint32_t n = (off + 256 <= total) ? 256 : (total - off);
        cca_ota_session_write(off, block, n);
    }
}

TEST(ota_full_tx_walk_emits_begin_then_each_chunk_no_wrap)
{
    /* 62 bytes -> 2 TransferData chunks (62 / 31 = 2 exact), no page wrap. */
    fill_session(62);
    s_log_n = 0;
    cca_ota_full_tx_walk(0xeffd, 0x06fe8020, log_callback, nullptr);
    /* Expected: 1 BeginTransfer (0x92, body_len 0x0E) + 2 TransferData (B1/B2, body_len 0x2B). */
    ASSERT_EQ(s_log_n, 3u);
    ASSERT_EQ(s_log[0].type, 0x92u);
    ASSERT_EQ(s_log[0].body_len_sig, 0x0Eu);
    ASSERT_EQ(s_log[0].len, 22u);
    ASSERT_EQ(s_log[1].body_len_sig, 0x2Bu);
    ASSERT_EQ(s_log[1].len, 51u);
    ASSERT_EQ(s_log[2].body_len_sig, 0x2Bu);
}

TEST(ota_full_tx_walk_carriers_cycle_b1_b2_b3)
{
    /* 6 chunks -> carriers B1 B2 B3 B1 B2 B3 */
    fill_session(31u * 6u);
    s_log_n = 0;
    cca_ota_full_tx_walk(0xeffd, 0x06fe8020, log_callback, nullptr);
    ASSERT_EQ(s_log_n, 7u);
    ASSERT_EQ(s_log[1].type, 0xB1u);
    ASSERT_EQ(s_log[2].type, 0xB2u);
    ASSERT_EQ(s_log[3].type, 0xB3u);
    ASSERT_EQ(s_log[4].type, 0xB1u);
    ASSERT_EQ(s_log[5].type, 0xB2u);
    ASSERT_EQ(s_log[6].type, 0xB3u);
}

TEST(ota_full_tx_walk_emits_change_addr_at_page_wrap)
{
    /* 64 KB + 31 bytes -> exactly one page wrap (page 0 -> page 1). */
    fill_session(0x10000u + 31u);
    CountCtx ctx = {};
    cca_ota_full_tx_walk(0xeffd, 0x06fe8020, count_callback, &ctx);

    ASSERT_EQ(ctx.begin_count, 1u);
    ASSERT_EQ(ctx.change_addr_count, 1u);
    /* 65567 bytes / 31 bytes/chunk = 2115.7 -> 2116 TransferData packets. */
    ASSERT_EQ(ctx.transfer_count, 2116u);
}

TEST(ota_full_tx_walk_no_change_addr_for_exactly_one_page_body)
{
    /* Body that ends exactly at the 64 KB boundary should NOT emit a
     * ChangeAddressOffset, because no further TransferData follows. */
    fill_session(0x10000u);
    CountCtx ctx = {};
    cca_ota_full_tx_walk(0xeffd, 0x06fe8020, count_callback, &ctx);

    ASSERT_EQ(ctx.begin_count, 1u);
    ASSERT_EQ(ctx.change_addr_count, 0u);
    /* 65536 / 31 = 2114.06 -> 2115 TransferData packets (last chunk padded). */
    ASSERT_EQ(ctx.transfer_count, 2115u);
}

TEST(ota_full_tx_walk_no_packets_for_empty_body)
{
    /* An empty session (no body uploaded) should still emit BeginTransfer
     * — the orchestrator doesn't gate on body_len, only on what
     * OtaChunkIter sees. The caller (exec_ota_full_tx) is the gate. */
    cca_ota_session_reset();
    cca_ota_session_start(1);
    uint8_t b = 0;
    cca_ota_session_write(0, &b, 1); /* one byte body, will pad to 31 */

    s_log_n = 0;
    cca_ota_full_tx_walk(0xeffd, 0x06fe8020, log_callback, nullptr);

    /* BeginTransfer + 1 TransferData (one chunk, padded). */
    ASSERT_EQ(s_log_n, 2u);
    ASSERT_EQ(s_log[0].type, 0x92u);
    ASSERT_EQ(s_log[1].body_len_sig, 0x2Bu);
}
