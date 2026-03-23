/**
 * Minimal host-side test runner for portable CCA/CCX codec modules.
 *
 * Compiled with: clang++ -std=c++17 (no STM32 deps)
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>

/* -----------------------------------------------------------------------
 * Test framework macros
 * ----------------------------------------------------------------------- */
int test_pass_count = 0;
int test_fail_count = 0;

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

#define ASSERT_FALSE(expr) ASSERT_TRUE(!(expr))

#define ASSERT_EQ(a, b) do { \
    auto _a = (a); auto _b = (b); \
    if (_a != _b) { \
        printf("  FAIL: %s:%d: %s == %lld, expected %lld\n", \
               __FILE__, __LINE__, #a, (long long)_a, (long long)_b); \
        test_fail_count++; \
        return; \
    } \
} while (0)

#define ASSERT_MEM_EQ(a, b, len) do { \
    if (memcmp(a, b, len) != 0) { \
        printf("  FAIL: %s:%d: memcmp(%s, %s, %zu) != 0\n", \
               __FILE__, __LINE__, #a, #b, (size_t)(len)); \
        test_fail_count++; \
        return; \
    } \
} while (0)

/* Test registry */
struct TestEntry {
    const char *name;
    void (*func)();
};

static TestEntry test_entries[256];
static int test_count = 0;

void test_registry_add(const char *name, void (*func)())
{
    if (test_count < 256) {
        test_entries[test_count++] = {name, func};
    }
}

/* -----------------------------------------------------------------------
 * Main
 * ----------------------------------------------------------------------- */
int main()
{
    printf("Running %d tests...\n\n", test_count);

    for (int i = 0; i < test_count; i++) {
        int before_fail = test_fail_count;
        printf("  [%d/%d] %s ... ", i + 1, test_count, test_entries[i].name);
        test_entries[i].func();
        if (test_fail_count == before_fail) {
            test_pass_count++;
            printf("OK\n");
        }
    }

    printf("\n%d passed, %d failed\n", test_pass_count, test_fail_count);
    return test_fail_count > 0 ? 1 : 0;
}
