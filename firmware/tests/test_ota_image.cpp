/**
 * OTA staging tests — flash-word realignment, bounds, resume, CRC, commit order.
 *
 * Runs against a RAM-backed fake flash that enforces the real STM32H7 rules:
 * 32-byte aligned writes only, and no programming a word twice without an erase.
 */

#include "crc32.h"
#include "ota_image.h"
#include <cstdio>
#include <cstring>
#include <vector>

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

#define ASSERT_MEM_EQ(a, b, len)                                                                            \
    do {                                                                                                    \
        if (memcmp(a, b, len) != 0) {                                                                       \
            printf("  FAIL: %s:%d: memcmp(%s, %s, %zu) != 0\n", __FILE__, __LINE__, #a, #b, (size_t)(len)); \
            test_fail_count++;                                                                              \
            return;                                                                                         \
        }                                                                                                   \
    } while (0)

/* -----------------------------------------------------------------------
 * Fake flash slot
 * ----------------------------------------------------------------------- */
namespace {

constexpr uint32_t SLOT_SIZE = 4096; /* small, so capacity edges are cheap to hit */

struct FakeFlash {
    std::vector<uint8_t> mem;
    std::vector<bool> word_written; /* enforce write-once-per-erase */
    int erases = 0;
    int programs = 0;
    bool fail_erase = false;
    int fail_program_after = -1; /* program call index that starts failing */

    FakeFlash() : mem(SLOT_SIZE, 0xFF), word_written(SLOT_SIZE / OTA_FLASH_WORD, false) {}
};

int fake_erase(void* ctx)
{
    auto* f = static_cast<FakeFlash*>(ctx);
    if (f->fail_erase) return -1;
    f->erases++;
    std::fill(f->mem.begin(), f->mem.end(), 0xFF);
    std::fill(f->word_written.begin(), f->word_written.end(), false);
    return 0;
}

int fake_program(void* ctx, uint32_t offset, const uint8_t word[OTA_FLASH_WORD])
{
    auto* f = static_cast<FakeFlash*>(ctx);
    if (f->fail_program_after >= 0 && f->programs >= f->fail_program_after) return -1;
    /* The real peripheral faults on these; make the fake just as strict. */
    if (offset % OTA_FLASH_WORD != 0) return -1;
    if (offset + OTA_FLASH_WORD > SLOT_SIZE) return -1;
    if (f->word_written[offset / OTA_FLASH_WORD]) return -1;
    f->word_written[offset / OTA_FLASH_WORD] = true;
    memcpy(&f->mem[offset], word, OTA_FLASH_WORD);
    f->programs++;
    return 0;
}

int fake_read(void* ctx, uint32_t offset, uint8_t* out, uint32_t len)
{
    auto* f = static_cast<FakeFlash*>(ctx);
    if (offset + len > SLOT_SIZE) return -1;
    memcpy(out, &f->mem[offset], len);
    return 0;
}

struct Slot {
    FakeFlash flash;
    ota_flash_ops_t ops;
    ota_stage_t st{};

    Slot()
    {
        ops.erase = fake_erase;
        ops.program = fake_program;
        ops.read = fake_read;
        ops.capacity = SLOT_SIZE;
        ops.ctx = &flash;
    }
};

std::vector<uint8_t> pattern(uint32_t n)
{
    std::vector<uint8_t> v(n);
    for (uint32_t i = 0; i < n; i++) v[i] = (uint8_t)(i * 7 + 3);
    return v;
}

/* Stage a whole image in one write. Returns the finish() status. */
ota_status_t stage_all(Slot& s, const std::vector<uint8_t>& img, uint32_t version = 1)
{
    if (ota_stage_begin(&s.st, &s.ops, (uint32_t)img.size()) != OTA_OK) return OTA_ERR_STATE;
    ota_status_t w = ota_stage_write(&s.st, 0, img.data(), (uint32_t)img.size());
    if (w != OTA_OK) return w;
    return ota_stage_finish(&s.st, crc32_compute(img.data(), img.size()), version);
}

} // namespace

/* -----------------------------------------------------------------------
 * CRC-32 — pin the algorithm so the two call sites can never drift
 * ----------------------------------------------------------------------- */

TEST(crc32_matches_known_vector)
{
    const char* s = "123456789";
    ASSERT_EQ(crc32_compute((const uint8_t*)s, 9), 0xCBF43926u);
}

TEST(crc32_streaming_matches_one_shot)
{
    auto img = pattern(300);
    uint32_t c = CRC32_INIT;
    c = crc32_update(c, img.data(), 100);
    c = crc32_update(c, img.data() + 100, 200);
    ASSERT_EQ(crc32_final(c), crc32_compute(img.data(), img.size()));
}

/* -----------------------------------------------------------------------
 * Capacity
 * ----------------------------------------------------------------------- */

TEST(ota_max_image_reserves_one_word_for_the_header)
{
    Slot s;
    ASSERT_EQ(ota_stage_max_image(&s.ops), SLOT_SIZE - OTA_FLASH_WORD);
}

TEST(ota_begin_rejects_image_larger_than_slot)
{
    Slot s;
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, SLOT_SIZE - OTA_FLASH_WORD + 1), OTA_ERR_CAPACITY);
    /* A rejected begin must not have erased anything. */
    ASSERT_EQ(s.flash.erases, 0);
}

TEST(ota_begin_rejects_zero_length)
{
    Slot s;
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, 0), OTA_ERR_ARG);
}

TEST(ota_begin_erases_up_front)
{
    Slot s;
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, 64), OTA_OK);
    ASSERT_EQ(s.flash.erases, 1);
    ASSERT_EQ(ota_stage_written(&s.st), 0u);
}

TEST(ota_begin_reports_flash_failure)
{
    Slot s;
    s.flash.fail_erase = true;
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, 64), OTA_ERR_FLASH);
}

/* -----------------------------------------------------------------------
 * Realignment — the reason this module exists
 * ----------------------------------------------------------------------- */

TEST(ota_stages_image_that_is_an_exact_multiple_of_the_flash_word)
{
    Slot s;
    auto img = pattern(OTA_FLASH_WORD * 4);
    ASSERT_EQ(stage_all(s, img), OTA_OK);
    ASSERT_MEM_EQ(s.flash.mem.data(), img.data(), img.size());
}

TEST(ota_pads_a_trailing_partial_flash_word)
{
    Slot s;
    auto img = pattern(70); /* 2 full words + 6 bytes */
    ASSERT_EQ(stage_all(s, img), OTA_OK);
    ASSERT_MEM_EQ(s.flash.mem.data(), img.data(), img.size());
    /* Padding must be erase-state, not zeros — 0x00 is a real programmed value. */
    for (uint32_t i = 70; i < OTA_FLASH_WORD * 3; i++) ASSERT_EQ(s.flash.mem[i], 0xFF);
}

TEST(ota_reassembles_writes_that_straddle_flash_words)
{
    /* 240-byte chunks are what the existing upload protocol sends, and 240 is
     * not a multiple of 32 — every chunk after the first is misaligned. */
    Slot s;
    auto img = pattern(240 * 3 + 17);
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, (uint32_t)img.size()), OTA_OK);

    uint32_t off = 0;
    while (off < img.size()) {
        uint32_t n = (uint32_t)img.size() - off;
        if (n > 240) n = 240;
        ASSERT_EQ(ota_stage_write(&s.st, off, img.data() + off, n), OTA_OK);
        off += n;
    }
    ASSERT_EQ(ota_stage_finish(&s.st, crc32_compute(img.data(), img.size()), 1), OTA_OK);
    ASSERT_MEM_EQ(s.flash.mem.data(), img.data(), img.size());
}

TEST(ota_handles_single_byte_writes)
{
    Slot s;
    auto img = pattern(65);
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, (uint32_t)img.size()), OTA_OK);
    for (uint32_t i = 0; i < img.size(); i++) {
        ASSERT_EQ(ota_stage_write(&s.st, i, &img[i], 1), OTA_OK);
    }
    ASSERT_EQ(ota_stage_finish(&s.st, crc32_compute(img.data(), img.size()), 1), OTA_OK);
    ASSERT_MEM_EQ(s.flash.mem.data(), img.data(), img.size());
}

/* -----------------------------------------------------------------------
 * Resume after packet loss
 * ----------------------------------------------------------------------- */

TEST(ota_rejects_a_gap_and_reports_the_resume_point)
{
    Slot s;
    auto img = pattern(200);
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, (uint32_t)img.size()), OTA_OK);
    ASSERT_EQ(ota_stage_write(&s.st, 0, img.data(), 100), OTA_OK);
    ASSERT_EQ(ota_stage_written(&s.st), 100u);

    /* Datagram for [100,140) was lost; host sent [140,200) instead. */
    ASSERT_EQ(ota_stage_write(&s.st, 140, img.data() + 140, 60), OTA_ERR_GAP);
    /* State is unchanged, so the host can resume from exactly here. */
    ASSERT_EQ(ota_stage_written(&s.st), 100u);

    ASSERT_EQ(ota_stage_write(&s.st, 100, img.data() + 100, 100), OTA_OK);
    ASSERT_EQ(ota_stage_finish(&s.st, crc32_compute(img.data(), img.size()), 1), OTA_OK);
    ASSERT_MEM_EQ(s.flash.mem.data(), img.data(), img.size());
}

TEST(ota_rejects_a_rewind_rather_than_double_programming)
{
    /* Re-sending already-accepted bytes would program a flash word twice. */
    Slot s;
    auto img = pattern(200);
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, (uint32_t)img.size()), OTA_OK);
    ASSERT_EQ(ota_stage_write(&s.st, 0, img.data(), 100), OTA_OK);
    ASSERT_EQ(ota_stage_write(&s.st, 64, img.data() + 64, 36), OTA_ERR_GAP);
    ASSERT_EQ(ota_stage_written(&s.st), 100u);
}

TEST(ota_rejects_writing_past_the_declared_length)
{
    Slot s;
    auto img = pattern(100);
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, 100), OTA_OK);
    ASSERT_EQ(ota_stage_write(&s.st, 0, img.data(), 100), OTA_OK);
    uint8_t extra = 0xAA;
    ASSERT_EQ(ota_stage_write(&s.st, 100, &extra, 1), OTA_ERR_OVERRUN);
}

TEST(ota_rejects_write_without_begin)
{
    Slot s;
    uint8_t b = 1;
    ASSERT_EQ(ota_stage_write(&s.st, 0, &b, 1), OTA_ERR_STATE);
}

/* -----------------------------------------------------------------------
 * Finish, verification, and commit ordering
 * ----------------------------------------------------------------------- */

TEST(ota_finish_rejects_a_short_image)
{
    Slot s;
    auto img = pattern(200);
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, 200), OTA_OK);
    ASSERT_EQ(ota_stage_write(&s.st, 0, img.data(), 150), OTA_OK);
    ASSERT_EQ(ota_stage_finish(&s.st, crc32_compute(img.data(), img.size()), 1), OTA_ERR_INCOMPLETE);
}

TEST(ota_finish_rejects_a_bad_crc_and_leaves_no_header)
{
    Slot s;
    auto img = pattern(128);
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, (uint32_t)img.size()), OTA_OK);
    ASSERT_EQ(ota_stage_write(&s.st, 0, img.data(), (uint32_t)img.size()), OTA_OK);
    ASSERT_EQ(ota_stage_finish(&s.st, 0xDEADBEEF, 1), OTA_ERR_CRC);

    ota_image_header_t h;
    ASSERT_EQ(ota_image_read_header(&s.ops, &h), OTA_ERR_CRC);
}

TEST(ota_finish_writes_a_valid_header_last)
{
    Slot s;
    auto img = pattern(300);
    ASSERT_EQ(stage_all(s, img, 0x1234), OTA_OK);

    ota_image_header_t h;
    ASSERT_EQ(ota_image_read_header(&s.ops, &h), OTA_OK);
    ASSERT_EQ(h.magic, OTA_IMAGE_MAGIC);
    ASSERT_EQ(h.image_len, img.size());
    ASSERT_EQ(h.image_crc32, crc32_compute(img.data(), img.size()));
    ASSERT_EQ(h.version, 0x1234u);
}

TEST(ota_header_is_absent_on_a_blank_slot)
{
    Slot s;
    ota_image_header_t h;
    ASSERT_EQ(ota_image_read_header(&s.ops, &h), OTA_ERR_CRC);
}

TEST(ota_header_rejects_a_corrupted_field)
{
    Slot s;
    auto img = pattern(128);
    ASSERT_EQ(stage_all(s, img), OTA_OK);
    /* Flip a bit in image_len; header_crc32 must catch it. */
    s.flash.mem[SLOT_SIZE - OTA_FLASH_WORD + 4] ^= 0x01;

    ota_image_header_t h;
    ASSERT_EQ(ota_image_read_header(&s.ops, &h), OTA_ERR_CRC);
}

TEST(ota_finish_is_not_repeatable)
{
    Slot s;
    auto img = pattern(64);
    ASSERT_EQ(stage_all(s, img), OTA_OK);
    ASSERT_EQ(ota_stage_finish(&s.st, crc32_compute(img.data(), img.size()), 1), OTA_ERR_STATE);
}

TEST(ota_reports_flash_failure_during_program)
{
    Slot s;
    auto img = pattern(256);
    ASSERT_EQ(ota_stage_begin(&s.st, &s.ops, (uint32_t)img.size()), OTA_OK);
    s.flash.fail_program_after = 2;
    ASSERT_EQ(ota_stage_write(&s.st, 0, img.data(), (uint32_t)img.size()), OTA_ERR_FLASH);
}

TEST(ota_fills_the_slot_exactly)
{
    Slot s;
    auto img = pattern(SLOT_SIZE - OTA_FLASH_WORD);
    ASSERT_EQ(stage_all(s, img), OTA_OK);
    ASSERT_MEM_EQ(s.flash.mem.data(), img.data(), img.size());

    ota_image_header_t h;
    ASSERT_EQ(ota_image_read_header(&s.ops, &h), OTA_OK);
    ASSERT_EQ(h.image_len, img.size());
}

TEST(ota_header_struct_is_exactly_one_flash_word)
{
    ASSERT_EQ(sizeof(ota_image_header_t), (size_t)OTA_FLASH_WORD);
}
