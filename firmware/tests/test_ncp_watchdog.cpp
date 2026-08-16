/**
 * NCP watchdog policy tests.
 *
 * The policy is separated from the actuator so the awkward parts — backoff,
 * attempt counting, and 32-bit tick wraparound — are exercised on the host.
 * The board is meant to run for months unattended; HAL_GetTick() wraps every
 * 49.7 days, and a naive `now > last + timeout` comparison silently stops
 * firing forever at that point. That is not something you find on a bench.
 */

#include "ncp_watchdog.h"
#include "test_harness.h"

namespace {

ncp_wd_cfg_t test_cfg()
{
    ncp_wd_cfg_t c;
    c.liveness_timeout_ms = 30000;
    c.retry_interval_ms = 15000;
    c.backoff_interval_ms = 300000;
    c.max_fast_attempts = 3;
    return c;
}

} // namespace

/* -----------------------------------------------------------------------
 * Healthy operation
 * ----------------------------------------------------------------------- */

TEST(ncp_wd_starts_healthy)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 1000);

    ASSERT_EQ(ncp_wd_state(&wd), NCP_WD_HEALTHY);
    ASSERT_FALSE(ncp_wd_should_recover(&wd, 1000));
}

TEST(ncp_wd_stays_healthy_while_the_ncp_answers)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);

    for (uint32_t t = 0; t < 300000; t += 10000) {
        ncp_wd_alive(&wd, t);
        ASSERT_FALSE(ncp_wd_should_recover(&wd, t));
        ASSERT_EQ(ncp_wd_state(&wd), NCP_WD_HEALTHY);
    }
}

TEST(ncp_wd_does_not_fire_before_the_liveness_timeout)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);
    ncp_wd_alive(&wd, 0);

    ASSERT_FALSE(ncp_wd_should_recover(&wd, 29999));
}

/* -----------------------------------------------------------------------
 * Detecting a dead NCP
 * ----------------------------------------------------------------------- */

TEST(ncp_wd_fires_once_the_liveness_timeout_expires)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);
    ncp_wd_alive(&wd, 0);

    ASSERT_TRUE(ncp_wd_should_recover(&wd, 30000));
}

TEST(ncp_wd_does_not_fire_twice_in_a_row)
{
    /* Recovery resets the part; hammering it every loop iteration would keep
       it permanently in reset and look exactly like a dead dongle. */
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);
    ncp_wd_alive(&wd, 0);

    ASSERT_TRUE(ncp_wd_should_recover(&wd, 30000));
    ncp_wd_recovery_done(&wd, false, 31000);
    ASSERT_FALSE(ncp_wd_should_recover(&wd, 31001));
    ASSERT_FALSE(ncp_wd_should_recover(&wd, 40000));
}

TEST(ncp_wd_retries_after_the_retry_interval)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);
    ncp_wd_alive(&wd, 0);

    ASSERT_TRUE(ncp_wd_should_recover(&wd, 30000));
    ncp_wd_recovery_done(&wd, false, 30000);
    ASSERT_TRUE(ncp_wd_should_recover(&wd, 45000));
}

TEST(ncp_wd_counts_attempts)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);
    ncp_wd_alive(&wd, 0);

    uint32_t t = 30000;
    for (int i = 1; i <= 3; i++) {
        ASSERT_TRUE(ncp_wd_should_recover(&wd, t));
        ncp_wd_recovery_done(&wd, false, t);
        ASSERT_EQ(ncp_wd_attempts(&wd), (uint32_t)i);
        t += 15000;
    }
}

/* -----------------------------------------------------------------------
 * Recovery outcome
 * ----------------------------------------------------------------------- */

TEST(ncp_wd_returns_to_healthy_after_a_successful_recovery)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);
    ncp_wd_alive(&wd, 0);

    ASSERT_TRUE(ncp_wd_should_recover(&wd, 30000));
    ncp_wd_recovery_done(&wd, true, 32000);

    ASSERT_EQ(ncp_wd_state(&wd), NCP_WD_HEALTHY);
    ASSERT_EQ(ncp_wd_attempts(&wd), 0u);
    ASSERT_EQ(ncp_wd_recoveries(&wd), 1u);
    ASSERT_FALSE(ncp_wd_should_recover(&wd, 40000));
}

TEST(ncp_wd_counts_successful_recoveries_over_time)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);

    uint32_t t = 0;
    for (int i = 1; i <= 3; i++) {
        ncp_wd_alive(&wd, t);
        t += 30000;
        ASSERT_TRUE(ncp_wd_should_recover(&wd, t));
        ncp_wd_recovery_done(&wd, true, t);
        ASSERT_EQ(ncp_wd_recoveries(&wd), (uint32_t)i);
    }
}

TEST(ncp_wd_alive_during_cooldown_clears_the_failure)
{
    /* The NCP can come back on its own — a slow Thread rejoin, say. If it
       does, the watchdog must stand down rather than reset a working part. */
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);
    ncp_wd_alive(&wd, 0);

    ASSERT_TRUE(ncp_wd_should_recover(&wd, 30000));
    ncp_wd_recovery_done(&wd, false, 30000);
    ncp_wd_alive(&wd, 35000);

    ASSERT_EQ(ncp_wd_state(&wd), NCP_WD_HEALTHY);
    ASSERT_EQ(ncp_wd_attempts(&wd), 0u);
    ASSERT_FALSE(ncp_wd_should_recover(&wd, 60000));
}

/* -----------------------------------------------------------------------
 * Backoff
 * ----------------------------------------------------------------------- */

TEST(ncp_wd_slows_down_after_the_fast_attempts_are_used)
{
    /* If the dongle is unrecoverable — GPREGRET DFU magic, or physically
       unplugged — resetting every 15 s forever is pure noise. Back off. */
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);
    ncp_wd_alive(&wd, 0);

    uint32_t t = 30000;
    uint32_t last_attempt = 0;
    for (int i = 0; i < 3; i++) {
        ASSERT_TRUE(ncp_wd_should_recover(&wd, t));
        ncp_wd_recovery_done(&wd, false, t);
        last_attempt = t;
        t += 15000;
    }

    /* Fast budget spent: the gap is now the slow one, measured from the last
       attempt rather than from now. */
    ASSERT_EQ(ncp_wd_state(&wd), NCP_WD_BACKOFF);
    ASSERT_FALSE(ncp_wd_should_recover(&wd, last_attempt + 299999u));
    ASSERT_TRUE(ncp_wd_should_recover(&wd, last_attempt + 300000u));
}

TEST(ncp_wd_never_gives_up_permanently)
{
    /* An unattended board must keep trying. Whatever broke the link may be
       fixed hours later without anyone power cycling the Nucleo. */
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    ncp_wd_init(&wd, &cfg, 0);
    ncp_wd_alive(&wd, 0);

    uint32_t t = 30000;
    for (int i = 0; i < 50; i++) {
        ASSERT_TRUE(ncp_wd_should_recover(&wd, t));
        ncp_wd_recovery_done(&wd, false, t);
        t += 300000;
    }
    /* Still trying, and a late success still restores health. */
    ASSERT_TRUE(ncp_wd_should_recover(&wd, t));
    ncp_wd_recovery_done(&wd, true, t);
    ASSERT_EQ(ncp_wd_state(&wd), NCP_WD_HEALTHY);
}

/* -----------------------------------------------------------------------
 * Tick wraparound
 * ----------------------------------------------------------------------- */

TEST(ncp_wd_liveness_survives_tick_wraparound)
{
    /* HAL_GetTick() wraps every 49.7 days. Written naively the watchdog stops
       firing at that point and never fires again. */
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    const uint32_t near_wrap = 0xFFFFFF00u;

    ncp_wd_init(&wd, &cfg, near_wrap);
    ncp_wd_alive(&wd, near_wrap);

    /* 0xFFFFFF00 + 30000 wraps to 0x74AF. */
    uint32_t after = near_wrap + 30000u;
    ASSERT_TRUE(after < near_wrap); /* confirm the test really wraps */
    ASSERT_TRUE(ncp_wd_should_recover(&wd, after));
}

TEST(ncp_wd_does_not_fire_early_across_a_wraparound)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    const uint32_t near_wrap = 0xFFFFFF00u;

    ncp_wd_init(&wd, &cfg, near_wrap);
    ncp_wd_alive(&wd, near_wrap);

    uint32_t after = near_wrap + 29999u;
    ASSERT_TRUE(after < near_wrap);
    ASSERT_FALSE(ncp_wd_should_recover(&wd, after));
}

TEST(ncp_wd_retry_interval_survives_tick_wraparound)
{
    ncp_wd_t wd;
    ncp_wd_cfg_t cfg = test_cfg();
    const uint32_t near_wrap = 0xFFFFFF00u;

    ncp_wd_init(&wd, &cfg, near_wrap - 30000u);
    ncp_wd_alive(&wd, near_wrap - 30000u);

    ASSERT_TRUE(ncp_wd_should_recover(&wd, near_wrap));
    ncp_wd_recovery_done(&wd, false, near_wrap);

    ASSERT_FALSE(ncp_wd_should_recover(&wd, near_wrap + 14999u));
    ASSERT_TRUE(ncp_wd_should_recover(&wd, near_wrap + 15000u));
}
