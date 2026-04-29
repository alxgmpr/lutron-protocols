/**
 * cca_ota_session — static LDF body buffer that the stream protocol uploads
 * to. The firmware-side OTA orchestrator (cca_ota_full_tx_walk) reads from
 * this buffer to drive the on-air TX.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>

#include "cca_ota_session.h"

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

TEST(ota_session_starts_empty)
{
    cca_ota_session_reset();
    ASSERT_EQ(cca_ota_session_body_len(), 0u);
    ASSERT_EQ(cca_ota_session_expected_len(), 0u);
    ASSERT_EQ(cca_ota_session_complete(), false);
}

TEST(ota_session_start_sets_expected_len)
{
    cca_ota_session_reset();
    bool ok = cca_ota_session_start(102516);
    ASSERT_EQ(ok, true);
    ASSERT_EQ(cca_ota_session_expected_len(), 102516u);
    ASSERT_EQ(cca_ota_session_body_len(), 0u);
}

TEST(ota_session_rejects_oversize_start)
{
    cca_ota_session_reset();
    /* Over the 110KB cap defined by CCA_OTA_SESSION_CAPACITY. */
    bool ok = cca_ota_session_start(200u * 1024u);
    ASSERT_EQ(ok, false);
}

TEST(ota_session_writes_chunks_at_offset)
{
    cca_ota_session_reset();
    cca_ota_session_start(64);

    uint8_t a[16];
    for (int i = 0; i < 16; i++) a[i] = (uint8_t)(0x10 + i);
    uint8_t b[16];
    for (int i = 0; i < 16; i++) b[i] = (uint8_t)(0x20 + i);

    bool r1 = cca_ota_session_write(0, a, 16);
    bool r2 = cca_ota_session_write(48, b, 16);
    ASSERT_EQ(r1, true);
    ASSERT_EQ(r2, true);
    ASSERT_EQ(cca_ota_session_body_len(), 64u);

    const uint8_t* body = cca_ota_session_body();
    ASSERT_EQ(body[0], 0x10);
    ASSERT_EQ(body[15], 0x1F);
    ASSERT_EQ(body[48], 0x20);
    ASSERT_EQ(body[63], 0x2F);
}

TEST(ota_session_rejects_write_past_expected_len)
{
    cca_ota_session_reset();
    cca_ota_session_start(64);
    uint8_t buf[16] = {0};
    /* offset 56 + len 16 = 72 > expected 64 */
    bool r = cca_ota_session_write(56, buf, 16);
    ASSERT_EQ(r, false);
}

TEST(ota_session_rejects_write_without_start)
{
    cca_ota_session_reset();
    uint8_t buf[16] = {0};
    bool r = cca_ota_session_write(0, buf, 16);
    ASSERT_EQ(r, false);
}

TEST(ota_session_complete_when_filled)
{
    cca_ota_session_reset();
    cca_ota_session_start(32);
    uint8_t buf[16] = {0};

    cca_ota_session_write(0, buf, 16);
    ASSERT_EQ(cca_ota_session_complete(), false);

    cca_ota_session_write(16, buf, 16);
    ASSERT_EQ(cca_ota_session_complete(), true);
}

TEST(ota_session_body_len_tracks_high_water_mark)
{
    cca_ota_session_reset();
    cca_ota_session_start(64);
    uint8_t buf[16] = {0};
    /* Out-of-order writes — body_len should reflect the highest end seen. */
    cca_ota_session_write(48, buf, 16);
    ASSERT_EQ(cca_ota_session_body_len(), 64u);
    cca_ota_session_write(0, buf, 16);
    ASSERT_EQ(cca_ota_session_body_len(), 64u); /* still 64, not regressed */
}
