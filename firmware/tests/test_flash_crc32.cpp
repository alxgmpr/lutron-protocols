/**
 * CRC-32 test vectors for firmware/src/storage/crc32.c (GLAB-109).
 *
 * flash_store previously carried a literal 256-entry table commented
 * "same polynomial as zlib / Ethernet" in which 114 entries were wrong and
 * 80 values were duplicated. Because the same function both wrote and
 * validated the record, nothing looked broken — it was simply an arbitrary
 * self-consistent checksum with none of CRC-32's error-detection
 * properties.
 *
 * These tests pin the replacement to the real algorithm so that cannot
 * recur silently:
 *   - the canonical "123456789" -> 0xCBF43926 vector,
 *   - agreement with a table independently derived from poly 0xEDB88320,
 *   - detection of every single-bit flip in a settings-sized record,
 *   - a regression note recording specific entries the old table got wrong.
 */

#include "crc32.h"
#include <cstdio>
#include <cstring>

/* Macros from test_main.cpp */
extern int test_fail_count;
extern void test_registry_add(const char *name, void (*func)());

#define TEST(name) \
    static void test_##name(); \
    static struct test_reg_##name { \
        test_reg_##name() { test_registry_add(#name, test_##name); } \
    } test_reg_inst_##name; \
    static void test_##name()

#define ASSERT_EQ(a, b) do { \
    auto _a = (a); auto _b = (b); \
    if (_a != _b) { \
        printf("  FAIL: %s:%d: %s == 0x%llX, expected 0x%llX\n", \
               __FILE__, __LINE__, #a, (unsigned long long)_a, (unsigned long long)_b); \
        test_fail_count++; \
        return; \
    } \
} while (0)

#define ASSERT_TRUE(expr) do { \
    if (!(expr)) { \
        printf("  FAIL: %s:%d: %s\n", __FILE__, __LINE__, #expr); \
        test_fail_count++; \
        return; \
    } \
} while (0)

/* -----------------------------------------------------------------------
 * Reference implementation, derived here from the polynomial so that it is
 * independent of whatever crc32.c does internally.
 * ----------------------------------------------------------------------- */
#define REF_POLY 0xEDB88320u

static void ref_build_table(uint32_t table[256])
{
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) {
            c = (c & 1u) ? (REF_POLY ^ (c >> 1)) : (c >> 1);
        }
        table[i] = c;
    }
}

static uint32_t ref_crc32(const void *data, size_t len)
{
    uint32_t table[256];
    ref_build_table(table);

    const uint8_t *p = (const uint8_t *)data;
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ table[(crc ^ p[i]) & 0xFFu];
    }
    return crc ^ 0xFFFFFFFFu;
}

/* -----------------------------------------------------------------------
 * Canonical vectors
 * ----------------------------------------------------------------------- */

TEST(crc32_canonical_check_vector)
{
    /* The standard CRC-32 check value. */
    ASSERT_EQ(crc32_compute("123456789", 9), 0xCBF43926u);
}

TEST(crc32_known_short_vectors)
{
    ASSERT_EQ(crc32_compute("", 0), 0x00000000u);
    ASSERT_EQ(crc32_compute("a", 1), 0xE8B7BE43u);
    ASSERT_EQ(crc32_compute("abc", 3), 0x352441C2u);
    ASSERT_EQ(crc32_compute("message digest", 14), 0x20159D7Fu);
    ASSERT_EQ(crc32_compute("abcdefghijklmnopqrstuvwxyz", 26), 0x4C2750BDu);
}

TEST(crc32_null_data_with_zero_length)
{
    /* Must not dereference the pointer when there is nothing to read. */
    ASSERT_EQ(crc32_compute(nullptr, 0), 0x00000000u);
}

/* -----------------------------------------------------------------------
 * The guard against silent rot: agreement with poly 0xEDB88320
 * ----------------------------------------------------------------------- */

TEST(crc32_matches_table_derived_from_poly_edb88320)
{
    /* Every length from 0..255, over a byte pattern that exercises all 256
     * table indices, must agree with the independently derived reference. */
    uint8_t buf[256];
    for (int i = 0; i < 256; i++) {
        buf[i] = (uint8_t)((i * 31 + 7) & 0xFF);
    }

    for (size_t len = 0; len <= sizeof(buf); len++) {
        uint32_t got = crc32_compute(buf, len);
        uint32_t want = ref_crc32(buf, len);
        if (got != want) {
            printf("  FAIL: %s:%d: len=%zu got=0x%08X want=0x%08X\n", __FILE__, __LINE__, len, got, want);
            test_fail_count++;
            return;
        }
    }
}

TEST(crc32_poly_table_entries_are_all_distinct)
{
    /* The real table has 256 distinct entries. The table this replaces had
     * 80 duplicate values — the signature of the bad transcription. */
    uint32_t table[256];
    ref_build_table(table);

    int duplicates = 0;
    for (int i = 0; i < 256; i++) {
        for (int j = i + 1; j < 256; j++) {
            if (table[i] == table[j]) duplicates++;
        }
    }
    ASSERT_EQ(duplicates, 0);
}

/* -----------------------------------------------------------------------
 * Error detection — the reason a CRC is used here at all
 * ----------------------------------------------------------------------- */

TEST(crc32_detects_every_single_bit_flip_in_a_settings_record)
{
    /* FlashSettings is 256 bytes and the CRC covers the first 252. */
    const size_t kCovered = 252;
    uint8_t buf[kCovered];
    for (size_t i = 0; i < kCovered; i++) {
        buf[i] = (uint8_t)(i * 7 + 3);
    }

    const uint32_t baseline = crc32_compute(buf, kCovered);

    for (size_t byte = 0; byte < kCovered; byte++) {
        for (int bit = 0; bit < 8; bit++) {
            buf[byte] ^= (uint8_t)(1u << bit);
            uint32_t flipped = crc32_compute(buf, kCovered);
            buf[byte] ^= (uint8_t)(1u << bit); /* restore */

            if (flipped == baseline) {
                printf("  FAIL: %s:%d: bit %d of byte %zu did not change the CRC\n", __FILE__, __LINE__, bit, byte);
                test_fail_count++;
                return;
            }
        }
    }
}

TEST(crc32_detects_short_burst_errors)
{
    /* CRC-32 detects any burst error up to 32 bits. Sweep a corrupting
     * burst across the record and confirm none of them survive. */
    const size_t kCovered = 252;
    uint8_t buf[kCovered];
    for (size_t i = 0; i < kCovered; i++) {
        buf[i] = (uint8_t)(i * 11 + 5);
    }

    const uint32_t baseline = crc32_compute(buf, kCovered);

    for (size_t start = 0; start + 4 <= kCovered; start++) {
        uint8_t saved[4];
        memcpy(saved, &buf[start], 4);

        /* A 32-bit burst: invert four consecutive bytes. */
        for (int k = 0; k < 4; k++) buf[start + k] = (uint8_t)~buf[start + k];
        uint32_t corrupted = crc32_compute(buf, kCovered);
        memcpy(&buf[start], saved, 4); /* restore */

        if (corrupted == baseline) {
            printf("  FAIL: %s:%d: 32-bit burst at offset %zu was not detected\n", __FILE__, __LINE__, start);
            test_fail_count++;
            return;
        }
    }
}

/* -----------------------------------------------------------------------
 * Regression note: what the old flash_store table actually contained
 * ----------------------------------------------------------------------- */

TEST(flash_store_v1_table_was_not_crc32)
{
    /* Entries the removed table got wrong, from the GLAB-109 survey.
     * Kept so the defect stays legible: the left column is what shipped,
     * the right column is what poly 0xEDB88320 actually produces. */
    struct { int index; uint32_t was; uint32_t correct; } kWrongEntries[] = {
        {10,  0xE0D5E91Bu, 0xE0D5E91Eu},
        {13,  0x7EB17CBFu, 0x7EB17CBDu},
        {14,  0xE7B82D09u, 0xE7B82D07u},
        {15,  0x90BF1D9Fu, 0x90BF1D91u},
        {52,  0x21B4F6B5u, 0x21B4F4B5u},
        {76,  0x7F6A0D6Bu, 0x7F6A0DBBu},
        {92,  0x62DD1D7Fu, 0x62DD1DDFu},
        {111, 0xDD0D7822u, 0xDD0D7CC9u},
    };

    uint32_t table[256];
    ref_build_table(table);

    for (const auto &e : kWrongEntries) {
        /* The documented "correct" value really is the CRC-32 table entry... */
        ASSERT_EQ(table[e.index], e.correct);
        /* ...and the value that shipped was not. */
        ASSERT_TRUE(table[e.index] != e.was);
    }
}
