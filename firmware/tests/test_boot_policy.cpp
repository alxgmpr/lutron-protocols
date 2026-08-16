/**
 * Bootloader decision tests.
 *
 * The expensive mistakes here are: overwriting a good application nobody asked
 * to replace, refusing to boot an ST-LINK-flashed image, and looping forever on
 * an install that never sticks. One test each.
 */

#include "boot_policy.h"
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

#define ASSERT_TRUE(expr)                                             \
    do {                                                              \
        if (!(expr)) {                                                \
            printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr); \
            test_fail_count++;                                        \
            return;                                                   \
        }                                                             \
    } while (0)

#define ASSERT_FALSE(expr) ASSERT_TRUE(!(expr))

namespace {
constexpr uint32_t APP_BASE = 0x08020000u;
constexpr uint32_t APP_SIZE = 384u * 1024u;

boot_state_t st(bool app_bootable, bool staged_valid, bool requested, uint32_t attempts = 0)
{
    boot_state_t s;
    s.app_bootable = app_bootable;
    s.staged_valid = staged_valid;
    s.install_requested = requested;
    s.install_attempts = attempts;
    return s;
}
} // namespace

/* -----------------------------------------------------------------------
 * Normal boots
 * ----------------------------------------------------------------------- */

TEST(boot_runs_the_app_when_nothing_is_pending)
{
    auto s = st(true, false, false);
    ASSERT_EQ(boot_decide(&s), BOOT_RUN_APP);
}

TEST(boot_does_not_install_a_staged_image_nobody_asked_for)
{
    /* The single most damaging possible bug: a staged image left over from a
     * previous upload must NOT replace a working application on its own. */
    auto s = st(true, true, false);
    ASSERT_EQ(boot_decide(&s), BOOT_RUN_APP);
}

TEST(boot_installs_when_the_app_asked_for_it)
{
    auto s = st(true, true, true);
    ASSERT_EQ(boot_decide(&s), BOOT_INSTALL);
}

TEST(boot_ignores_a_request_with_no_valid_staged_image)
{
    auto s = st(true, false, true);
    ASSERT_EQ(boot_decide(&s), BOOT_RUN_APP);
}

/* -----------------------------------------------------------------------
 * Recovery
 * ----------------------------------------------------------------------- */

TEST(boot_recovers_an_unbootable_app_from_staging)
{
    /* Blank or half-copied application region, but a verified image is on hand. */
    auto s = st(false, true, false);
    ASSERT_EQ(boot_decide(&s), BOOT_INSTALL);
}

TEST(boot_halts_when_nothing_is_bootable)
{
    auto s = st(false, false, false);
    ASSERT_EQ(boot_decide(&s), BOOT_HALT);
}

/* -----------------------------------------------------------------------
 * Attempt ceiling — do not loop forever
 * ----------------------------------------------------------------------- */

TEST(boot_retries_an_interrupted_install)
{
    /* Power lost mid-copy: app is broken, retry is exactly right. */
    auto s = st(false, true, true, BOOT_MAX_INSTALL_ATTEMPTS - 1);
    ASSERT_EQ(boot_decide(&s), BOOT_INSTALL);
}

TEST(boot_gives_up_after_the_attempt_ceiling_and_runs_what_it_has)
{
    auto s = st(true, true, true, BOOT_MAX_INSTALL_ATTEMPTS);
    ASSERT_EQ(boot_decide(&s), BOOT_RUN_APP);
}

TEST(boot_halts_rather_than_looping_when_retries_are_spent_and_app_is_dead)
{
    auto s = st(false, true, true, BOOT_MAX_INSTALL_ATTEMPTS);
    ASSERT_EQ(boot_decide(&s), BOOT_HALT);
}

TEST(boot_ceiling_also_bounds_unrequested_recovery)
{
    auto s = st(false, true, false, BOOT_MAX_INSTALL_ATTEMPTS);
    ASSERT_EQ(boot_decide(&s), BOOT_HALT);
}

TEST(boot_null_state_halts)
{
    ASSERT_EQ(boot_decide(nullptr), BOOT_HALT);
}

/* -----------------------------------------------------------------------
 * Vector-table plausibility
 * ----------------------------------------------------------------------- */

TEST(boot_accepts_a_normal_vector_table)
{
    /* What our own image looks like: SP at top of DTCM, reset vector in flash. */
    ASSERT_TRUE(boot_vector_plausible(BOOT_DTCM_BASE + BOOT_DTCM_SIZE, APP_BASE + 0x301, APP_BASE, APP_SIZE));
}

TEST(boot_rejects_erased_flash)
{
    ASSERT_FALSE(boot_vector_plausible(0xFFFFFFFFu, 0xFFFFFFFFu, APP_BASE, APP_SIZE));
}

TEST(boot_rejects_an_all_zero_vector_table)
{
    ASSERT_FALSE(boot_vector_plausible(0, 0, APP_BASE, APP_SIZE));
}

TEST(boot_rejects_a_stack_pointer_outside_ram)
{
    ASSERT_FALSE(boot_vector_plausible(0x08000000u, APP_BASE + 0x301, APP_BASE, APP_SIZE));
}

TEST(boot_rejects_a_reset_vector_outside_the_app_region)
{
    /* An image linked for the old base would point into the bootloader. */
    ASSERT_FALSE(boot_vector_plausible(BOOT_DTCM_BASE + BOOT_DTCM_SIZE, 0x08000301u, APP_BASE, APP_SIZE));
    /* ...or past the end of the region. */
    ASSERT_FALSE(
        boot_vector_plausible(BOOT_DTCM_BASE + BOOT_DTCM_SIZE, APP_BASE + APP_SIZE + 0x101, APP_BASE, APP_SIZE));
}

TEST(boot_rejects_a_reset_vector_without_the_thumb_bit)
{
    /* An even reset vector would fault the moment we branched to it. */
    ASSERT_FALSE(boot_vector_plausible(BOOT_DTCM_BASE + BOOT_DTCM_SIZE, APP_BASE + 0x300, APP_BASE, APP_SIZE));
}

TEST(boot_accepts_a_stack_pointer_in_any_on_chip_ram)
{
    const uint32_t pc = APP_BASE + 0x301;
    ASSERT_TRUE(boot_vector_plausible(BOOT_AXI_BASE + BOOT_AXI_SIZE, pc, APP_BASE, APP_SIZE));
    ASSERT_TRUE(boot_vector_plausible(BOOT_D2_BASE + BOOT_D2_SIZE, pc, APP_BASE, APP_SIZE));
    ASSERT_TRUE(boot_vector_plausible(BOOT_D3_BASE + BOOT_D3_SIZE, pc, APP_BASE, APP_SIZE));
}

TEST(boot_rejects_a_stack_pointer_just_past_the_end_of_ram)
{
    ASSERT_FALSE(boot_vector_plausible(BOOT_D3_BASE + BOOT_D3_SIZE + 4, APP_BASE + 0x301, APP_BASE, APP_SIZE));
}

TEST(boot_rejects_a_misaligned_stack_pointer)
{
    /* The hardware requires an 8-byte aligned SP; a misaligned one means the
     * word is not really a stack pointer. */
    ASSERT_FALSE(boot_vector_plausible(BOOT_DTCM_BASE + 0x101, APP_BASE + 0x301, APP_BASE, APP_SIZE));
}
