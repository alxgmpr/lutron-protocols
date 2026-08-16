#ifndef TEST_HARNESS_H
#define TEST_HARNESS_H

/**
 * Shared TEST()/ASSERT_*() macros for host tests.
 *
 * The older test files each carry their own copy of these; new files include
 * this instead. Same runner, same semantics — an assertion prints, bumps
 * test_fail_count, and returns from the test body.
 */

#include <cstdio>
#include <cstring>

extern int test_fail_count;
void test_registry_add(const char* name, void (*func)());

#define TEST(name) \
    static void test_##name(); \
    static struct test_reg_##name { \
        test_reg_##name() { test_registry_add(#name, test_##name); } \
    } test_reg_inst_##name; \
    static void test_##name()

#define ASSERT_TRUE(expr) \
    do { \
        if (!(expr)) { \
            printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr); \
            test_fail_count++; \
            return; \
        } \
    } while (0)

#define ASSERT_FALSE(expr) ASSERT_TRUE(!(expr))

#define ASSERT_EQ(a, b) \
    do { \
        auto _a = (a); \
        auto _b = (b); \
        if (_a != _b) { \
            printf("  FAIL: %s:%d: %s == 0x%llX (%lld), expected 0x%llX (%lld)\n", __FILE__, \
                   __LINE__, #a, (unsigned long long)_a, (long long)_a, (unsigned long long)_b, \
                   (long long)_b); \
            test_fail_count++; \
            return; \
        } \
    } while (0)

#define ASSERT_MEM_EQ(a, b, len) \
    do { \
        if (memcmp(a, b, len) != 0) { \
            printf("  FAIL: %s:%d: memcmp(%s, %s, %zu) != 0\n", __FILE__, __LINE__, #a, #b, \
                   (size_t)(len)); \
            test_fail_count++; \
            return; \
        } \
    } while (0)

#endif /* TEST_HARNESS_H */
