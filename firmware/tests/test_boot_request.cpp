/**
 * Install-request record tests.
 *
 * The record lives in uninitialised SRAM, so the case that matters most is
 * "random bytes must not read as a pending install".
 */

#include "boot_request.h"
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

TEST(boot_request_set_then_pending)
{
    boot_request_t r;
    boot_request_set(&r);
    ASSERT_TRUE(boot_request_valid(&r));
    ASSERT_TRUE(boot_request_pending(&r));
    ASSERT_EQ(boot_request_attempts(&r), 0u);
}

TEST(boot_request_clear_leaves_a_valid_but_empty_record)
{
    boot_request_t r;
    boot_request_set(&r);
    boot_request_clear(&r);
    ASSERT_TRUE(boot_request_valid(&r));
    ASSERT_FALSE(boot_request_pending(&r));
}

TEST(boot_request_bump_counts_attempts)
{
    boot_request_t r;
    boot_request_set(&r);
    boot_request_bump(&r);
    boot_request_bump(&r);
    ASSERT_EQ(boot_request_attempts(&r), 2u);
    /* Bumping must not lose the request itself. */
    ASSERT_TRUE(boot_request_pending(&r));
}

TEST(boot_request_rejects_all_zero_ram)
{
    boot_request_t r;
    memset(&r, 0x00, sizeof(r));
    ASSERT_FALSE(boot_request_valid(&r));
    ASSERT_FALSE(boot_request_pending(&r));
    ASSERT_EQ(boot_request_attempts(&r), 0u);
}

TEST(boot_request_rejects_all_ones_ram)
{
    boot_request_t r;
    memset(&r, 0xFF, sizeof(r));
    ASSERT_FALSE(boot_request_valid(&r));
    ASSERT_FALSE(boot_request_pending(&r));
}

TEST(boot_request_rejects_the_magic_alone)
{
    /* Power-on SRAM could contain the magic by chance; the check word is what
     * stops that from reading as a pending install. */
    boot_request_t r;
    memset(&r, 0x5A, sizeof(r));
    r.magic = BOOT_REQUEST_MAGIC;
    r.install = 1;
    ASSERT_FALSE(boot_request_valid(&r));
    ASSERT_FALSE(boot_request_pending(&r));
}

TEST(boot_request_rejects_a_tampered_attempt_count)
{
    boot_request_t r;
    boot_request_set(&r);
    r.attempts = 7; /* without recomputing the check word */
    ASSERT_FALSE(boot_request_valid(&r));
    ASSERT_EQ(boot_request_attempts(&r), 0u);
}

TEST(boot_request_rejects_an_out_of_range_install_value)
{
    boot_request_t r;
    boot_request_set(&r);
    r.install = 2;
    r.check = r.magic ^ r.install ^ r.attempts ^ BOOT_REQUEST_MAGIC;
    ASSERT_FALSE(boot_request_valid(&r));
}

TEST(boot_request_bump_on_garbage_starts_from_a_known_state)
{
    boot_request_t r;
    memset(&r, 0xA5, sizeof(r));
    boot_request_bump(&r);
    ASSERT_TRUE(boot_request_valid(&r));
    ASSERT_EQ(boot_request_attempts(&r), 1u);
}

TEST(boot_request_null_is_safe)
{
    ASSERT_FALSE(boot_request_valid(nullptr));
    ASSERT_FALSE(boot_request_pending(nullptr));
    ASSERT_EQ(boot_request_attempts(nullptr), 0u);
    boot_request_set(nullptr);
    boot_request_bump(nullptr);
    boot_request_clear(nullptr);
}

TEST(boot_request_fits_the_reserved_area)
{
    ASSERT_TRUE(sizeof(boot_request_t) <= BOOT_REQUEST_RESERVED);
}
