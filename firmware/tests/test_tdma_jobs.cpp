/**
 * TDMA job group engine tests — group struct validation and packet builders.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>

#include "cca_tdma.h"
#include "cca_tx_builder.h"

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

/* --- Helper: build a simple single-phase group for testing --- */
static TdmaJobGroup make_test_group(uint8_t tx_count, uint16_t post_delay_ms)
{
    TdmaJobGroup g = {};
    g.phase_count = 1;
    g.phases[0].packet.len = 22;
    g.phases[0].packet.data[0] = 0x81;
    g.phases[0].tx_count = tx_count;
    g.phases[0].post_delay_ms = post_delay_ms;
    g.on_complete = nullptr;
    g.ctx = nullptr;
    return g;
}

static TdmaJobGroup make_two_phase_group(uint8_t r1, uint16_t delay1, uint8_t r2)
{
    TdmaJobGroup g = {};
    g.phase_count = 2;
    g.phases[0].packet.len = 22;
    g.phases[0].packet.data[0] = 0x89;
    g.phases[0].tx_count = r1;
    g.phases[0].post_delay_ms = delay1;
    g.phases[1].packet.len = 22;
    g.phases[1].packet.data[0] = 0x88;
    g.phases[1].tx_count = r2;
    g.phases[1].post_delay_ms = 0;
    g.on_complete = nullptr;
    g.ctx = nullptr;
    return g;
}

TEST(job_group_struct_constants)
{
    ASSERT_EQ(TDMA_MAX_PHASES, 8);
    ASSERT_EQ(TDMA_MAX_GROUPS, 4);
    ASSERT_TRUE(sizeof(TdmaPacket) >= 55);
    ASSERT_TRUE(sizeof(TdmaJobGroup) > sizeof(TdmaPhase));
}

TEST(job_group_single_phase_init)
{
    TdmaJobGroup g = make_test_group(5, 0);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, 5);
    ASSERT_EQ(g.phases[0].post_delay_ms, 0);
    ASSERT_EQ(g.phases[0].packet.len, 22);
    ASSERT_EQ(g.phases[0].packet.data[0], 0x81);
    ASSERT_EQ(g.active, false);
}

TEST(job_group_two_phase_init)
{
    TdmaJobGroup g = make_two_phase_group(2, 75, 7);
    ASSERT_EQ(g.phase_count, 2);
    ASSERT_EQ(g.phases[0].tx_count, 2);
    ASSERT_EQ(g.phases[0].post_delay_ms, 75);
    ASSERT_EQ(g.phases[0].packet.data[0], 0x89);
    ASSERT_EQ(g.phases[1].tx_count, 7);
    ASSERT_EQ(g.phases[1].post_delay_ms, 0);
    ASSERT_EQ(g.phases[1].packet.data[0], 0x88);
}

TEST(job_group_level_builder)
{
    uint8_t pkt[22];
    size_t len = cca_build_set_level(pkt, 0x00010002, 0xFFFFFFFF,
                                     QS_ADDR_BROADCAST, 0xFEFF, 4, 0x81);
    ASSERT_EQ(len, (size_t)22);
    ASSERT_EQ(pkt[0], 0x81);
    ASSERT_EQ(pkt[7], QS_FMT_LEVEL);
    ASSERT_EQ(pkt[13], QS_ADDR_BROADCAST);
    ASSERT_EQ(pkt[14], QS_CLASS_LEVEL);
    ASSERT_EQ(pkt[15], QS_TYPE_EXECUTE);
    ASSERT_EQ(pkt[16], 0xFE);
    ASSERT_EQ(pkt[17], 0xFF);
    ASSERT_EQ(pkt[19], 4);
}

TEST(job_group_beacon_builder)
{
    uint8_t pkt[22];
    size_t len = cca_build_beacon(pkt, 0xAABBCCDD, 0x91);
    ASSERT_EQ(len, (size_t)22);
    ASSERT_EQ(pkt[0], 0x91);
    ASSERT_EQ(pkt[2], 0xAA);
    ASSERT_EQ(pkt[3], 0xBB);
    ASSERT_EQ(pkt[4], 0xCC);
    ASSERT_EQ(pkt[5], 0xDD);
    ASSERT_EQ(pkt[7], QS_FMT_BEACON);
}
