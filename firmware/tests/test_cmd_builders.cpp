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

TEST(cmd_pico_level_group)
{
    TdmaJobGroup g = cca_jobs_pico_level(0x08692D70, 50);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x81);
    ASSERT_EQ(g.phases[0].packet.len, 22);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_LEVEL);
    ASSERT_EQ(g.phases[0].packet.data[9], 0x07);
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_LEVEL);
    ASSERT_EQ(g.phases[0].packet.data[16], 0x7F);
    ASSERT_EQ(g.phases[0].packet.data[17], 0x7F);
}

TEST(cmd_broadcast_level_group)
{
    TdmaJobGroup g = cca_jobs_broadcast_level(0x00010002, 100, 4);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x81);
    ASSERT_EQ(g.phases[0].packet.data[13], QS_ADDR_BROADCAST);
    ASSERT_EQ(g.phases[0].packet.data[16], 0xFE);
    ASSERT_EQ(g.phases[0].packet.data[17], 0xFF);
}

TEST(cmd_scene_exec_group)
{
    TdmaJobGroup g = cca_jobs_scene_exec(0x00010002, 0x00030004, 75, 8);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_SCENE);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_EXECUTE);
    ASSERT_EQ(g.phases[0].packet.data[19], 8);
}

TEST(cmd_state_report_group)
{
    TdmaJobGroup g = cca_jobs_state_report(0x08692D70, 100);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_STATE);
    ASSERT_EQ(g.phases[0].packet.data[9], QS_STATE_ENTITY_COMP);
    ASSERT_EQ(g.phases[0].packet.data[11], QS_LEVEL_MAX_8);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_LEVEL_MAX_8);
}

TEST(cmd_unpair_group_two_phases)
{
    TdmaJobGroup g = cca_jobs_unpair(0x00010002, 0x00030004);
    ASSERT_EQ(g.phase_count, 2);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BURST);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_CTRL);
    ASSERT_EQ(g.phases[0].post_delay_ms, 800);
    ASSERT_EQ(g.phases[1].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[1].packet.data[7], QS_FMT_BEACON);
    ASSERT_EQ(g.phases[1].packet.data[13], QS_ADDR_COMPONENT);
}

TEST(cmd_save_fav_group_two_phases)
{
    TdmaJobGroup g = cca_jobs_save_fav(0x08692D70);
    ASSERT_EQ(g.phase_count, 2);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BURST);
    ASSERT_EQ(g.phases[0].packet.data[10], BTN_FAVORITE);
    ASSERT_EQ(g.phases[0].packet.data[11], ACTION_SAVE);
    ASSERT_EQ(g.phases[1].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[1].packet.data[10], BTN_FAVORITE);
    ASSERT_EQ(g.phases[1].packet.data[11], ACTION_SAVE);
}

TEST(cmd_identify_group)
{
    TdmaJobGroup g = cca_jobs_identify(0x00030004);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x81);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_CTRL);
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_DEVICE);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_IDENTIFY);
    ASSERT_EQ(g.phases[0].packet.data[16], 0x01);
}

TEST(cmd_query_group)
{
    TdmaJobGroup g = cca_jobs_query(0x00030004);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_SELECT);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_EXECUTE);
    ASSERT_EQ(g.phases[0].packet.data[16], 0x0D);
}

TEST(cmd_led_config_group)
{
    TdmaJobGroup g = cca_jobs_led_config(0x00010002, 0x00030004, 2);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.type_base, 0xA1);
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_LED);
    ASSERT_EQ(g.phases[0].packet.data[23], 0x00);
    ASSERT_EQ(g.phases[0].packet.data[24], 0xFF);
}

TEST(cmd_fade_config_group)
{
    TdmaJobGroup g = cca_jobs_fade_config(0x00010002, 0x00030004, 0x0040, 0x0080);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_FADE);
    ASSERT_EQ(g.phases[0].packet.data[23], 0x40);
    ASSERT_EQ(g.phases[0].packet.data[24], 0x00);
    ASSERT_EQ(g.phases[0].packet.data[25], 0x80);
    ASSERT_EQ(g.phases[0].packet.data[26], 0x00);
}

TEST(cmd_trim_config_group)
{
    TdmaJobGroup g = cca_jobs_trim_config(0x00010002, 0x00030004, 100, 10);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_TRIM);
    ASSERT_EQ(g.phases[0].packet.data[20], 0xFE);
    ASSERT_EQ(g.phases[0].packet.data[21], 25);
}

TEST(cmd_phase_config_group)
{
    TdmaJobGroup g = cca_jobs_phase_config(0x00010002, 0x00030004, 0x42);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_TRIM);
    ASSERT_EQ(g.phases[0].packet.data[20], QS_LEVEL_MAX_8);
    ASSERT_EQ(g.phases[0].packet.data[21], 0x03);
    ASSERT_EQ(g.phases[0].packet.data[22], 0x42);
}

TEST(cmd_dim_config_group)
{
    uint8_t cfg[] = {0x01, 0x02, 0x03};
    TdmaJobGroup g = cca_jobs_dim_config(0x00010002, 0x00030004, cfg, 3);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].packet.len, 51);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_DIM_CAP);
    ASSERT_EQ(g.phases[0].packet.data[14], QS_CLASS_LEGACY);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_DIM_CONFIG);
    ASSERT_EQ(g.phases[0].packet.data[16], 0x01);
    ASSERT_EQ(g.phases[0].packet.data[17], 0x02);
    ASSERT_EQ(g.phases[0].packet.data[18], 0x03);
}

TEST(cmd_vive_level_group)
{
    TdmaJobGroup g = cca_jobs_vive_level(0xDEADBEEF, 0x03, 50, 4);
    ASSERT_EQ(g.phase_count, 1);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x89);
    ASSERT_EQ(g.phases[0].packet.type_rotate, 1);
    ASSERT_EQ(g.phases[0].packet.len, 22);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_LEVEL);
    ASSERT_EQ(g.phases[0].packet.data[12], 0x03);
    ASSERT_EQ(g.phases[0].packet.data[13], QS_ADDR_GROUP);
    ASSERT_EQ(g.phases[0].packet.data[19], 4);
}

TEST(cmd_vive_dim_group_two_phases)
{
    TdmaJobGroup g = cca_jobs_vive_dim(0xDEADBEEF, 0x03, 0x03);
    ASSERT_EQ(g.phase_count, 2);
    ASSERT_EQ(g.phases[0].tx_count, CCA_TX_COUNT_BURST);
    ASSERT_EQ(g.phases[0].packet.type_base, 0x89);
    ASSERT_EQ(g.phases[0].packet.data[7], QS_FMT_CTRL);
    ASSERT_EQ(g.phases[0].packet.data[15], QS_TYPE_HOLD);
    ASSERT_EQ(g.phases[0].packet.data[16], 0x03);
    ASSERT_EQ(g.phases[0].post_delay_ms, 50);
    ASSERT_EQ(g.phases[1].tx_count, CCA_TX_COUNT_NORMAL);
    ASSERT_EQ(g.phases[1].packet.data[7], QS_FMT_DIM_STEP);
    ASSERT_EQ(g.phases[1].packet.data[15], QS_TYPE_EXECUTE);
    ASSERT_EQ(g.phases[1].packet.data[16], 0x03);
}

TEST(cmd_to_jobs_routes_all_commands)
{
    uint8_t cmds[] = {
        CCA_CMD_BUTTON, CCA_CMD_BRIDGE_LEVEL, CCA_CMD_PICO_LEVEL,
        CCA_CMD_STATE_REPORT, CCA_CMD_BEACON, CCA_CMD_UNPAIR,
        CCA_CMD_LED_CONFIG, CCA_CMD_FADE_CONFIG, CCA_CMD_TRIM_CONFIG,
        CCA_CMD_PHASE_CONFIG, CCA_CMD_SAVE_FAV, CCA_CMD_VIVE_LEVEL,
        CCA_CMD_VIVE_DIM, CCA_CMD_BROADCAST_LEVEL, CCA_CMD_IDENTIFY,
        CCA_CMD_QUERY, CCA_CMD_RAW, CCA_CMD_SCENE_EXEC, CCA_CMD_DIM_CONFIG,
    };
    for (size_t i = 0; i < sizeof(cmds); i++) {
        CcaCmdItem item = {};
        item.cmd = cmds[i];
        item.device_id = 0x00010002;
        item.target_id = 0x00030004;
        item.level_pct = 50;
        item.fade_qs = 4;
        item.zone_byte = 0x01;
        item.direction = 0x03;
        item.raw_payload_len = 4;
        item.raw_repeat = 5;
        TdmaJobGroup g = cca_cmd_to_jobs(&item);
        ASSERT_TRUE(g.phase_count > 0);
    }
}

TEST(cmd_to_jobs_pairing_returns_empty)
{
    uint8_t pairing_cmds[] = {
        CCA_CMD_PICO_PAIR, CCA_CMD_BRIDGE_PAIR, CCA_CMD_VIVE_PAIR,
        CCA_CMD_ANNOUNCE, CCA_CMD_HYBRID_PAIR, CCA_CMD_SUBNET_PAIR,
    };
    for (size_t i = 0; i < sizeof(pairing_cmds); i++) {
        CcaCmdItem item = {};
        item.cmd = pairing_cmds[i];
        TdmaJobGroup g = cca_cmd_to_jobs(&item);
        ASSERT_EQ(g.phase_count, 0);
    }
}
