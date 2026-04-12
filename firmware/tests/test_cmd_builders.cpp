/**
 * Command builder tests — verify cca_jobs_* produce correct TdmaJobGroups.
 */

#include <cstdint>
#include <cstdio>
#include <cstring>

#include "cca_tdma.h"
#include "cca_commands.h"
#include "cca_tx_builder.h"
#include "cca_generated.h"

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

TEST(cmd_bridge_level_group)
{
    TdmaJobGroup g = cca_jobs_bridge_level(0x00010002, 0xFFFFFFFF, 75, 8);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
    ASSERT_EQ(g.phases[0].packet.len, 22);
    /* 75% = 75 * 65279 / 100 = 48959 = 0xBF3F */
    ASSERT_EQ(g.phases[0].packet.data[16], 0xBF);
    ASSERT_EQ(g.phases[0].packet.data[17], 0x3F);
    ASSERT_EQ(g.phases[0].packet.data[19], 8);
}

TEST(cmd_button_group_has_two_phases)
{
    TdmaJobGroup g = cca_jobs_button(0x08692D70, 0x02);
    ASSERT_EQ(g.phase_count, 2);
    ASSERT_EQ(g.phases[0].packet.len, 22);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BURST);
    ASSERT_EQ(g.phases[0].packet.data[11], ACTION_PRESS);
    ASSERT_EQ(g.phases[1].packet.len, 22);
    ASSERT_EQ(g.phases[1].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[1].packet.data[11], ACTION_RELEASE);
}

TEST(cmd_beacon_group)
{
    TdmaJobGroup g = cca_jobs_beacon(0xAABBCCDD, 0x92);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BEACON);
    ASSERT_EQ(g.phases[0].packet.data[0], 0x92);
    ASSERT_EQ(g.phases[0].packet.len, 22);
}

TEST(cmd_raw_group)
{
    uint8_t payload[22] = {0x81, 0x00, 0xDE, 0xAD};
    TdmaJobGroup g = cca_jobs_raw(payload, 22, 10);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, 10);
    ASSERT_EQ(g.phases[0].packet.data[0], 0x81);
    ASSERT_EQ(g.phases[0].packet.data[2], 0xDE);
}

TEST(cmd_to_jobs_level)
{
    CcaCmdItem item = {};
    item.cmd = CCA_CMD_BRIDGE_LEVEL;
    item.device_id = 0x00010002;
    item.target_id = 0xFFFFFFFF;
    item.level_pct = 50;
    item.fade_qs = 4;
    TdmaJobGroup g = cca_cmd_to_jobs(&item);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
}

TEST(cmd_to_jobs_unknown_returns_empty)
{
    CcaCmdItem item = {};
    item.cmd = 0xFF;
    TdmaJobGroup g = cca_cmd_to_jobs(&item);
    ASSERT_EQ(g.phase_count, 0);
}
