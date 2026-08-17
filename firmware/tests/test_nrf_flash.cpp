/**
 * Programming the NCP's application region from an Intel HEX stream.
 *
 * This is the layer that turns "the SWD primitives work" into "the dongle can
 * be reflashed without touching it", and almost everything that can go wrong
 * here goes wrong silently:
 *
 *  - Erasing below 0x1000 takes the MBR with it, and erasing at or above the
 *    bootloader takes the USB DFU recovery path with it. Either one leaves a
 *    part that only SWD can ever program again. The region guard is the whole
 *    safety story, so it is tested from both ends.
 *
 *  - A verify that always passes is indistinguishable from a working one until
 *    the day the flash does not take the program. The fake can drop a bit on a
 *    chosen word specifically so that case has a test.
 *
 *  - A truncated upload is a normal outcome of a lossy UDP transport, and the
 *    difference between "the image ended" and "the image stopped" is the EOF
 *    record. Finishing without one must fail rather than release a half-written
 *    part to run.
 */

#include "fake_swd_target.h"
#include "ihex.h"
#include "nrf_flash.h"
#include "nrf_swd.h"
#include "swd.h"
#include "test_harness.h"

#include <string>
#include <vector>

namespace {

/** The application region of an nRF52840 dongle: above the MBR, below the
 *  factory USB bootloader. */
constexpr uint32_t APP_START = 0x1000u;
constexpr uint32_t APP_END = 0xE0000u;

struct Rig {
    FakeSwdTarget target;
    swd_t swd;
    nrf_swd_t nrf;
    nrf_flash_t fl;

    Rig()
    {
        swd_io_t io = target.io();
        swd_init(&swd, &io);
        nrf_swd_init(&nrf, &swd);
        nrf_swd_connect(&nrf);
    }

    nrf_flash_status_t begin(uint32_t start = APP_START, uint32_t end = APP_END)
    {
        return nrf_flash_begin(&fl, &nrf, start, end);
    }

    nrf_flash_status_t feed(const std::string& s)
    {
        return nrf_flash_feed(&fl, s.data(), s.size());
    }
};

/** Build one Intel HEX record with a correct checksum. */
std::string rec(uint8_t type, uint16_t addr, const std::vector<uint8_t>& data)
{
    static const char* hexd = "0123456789ABCDEF";
    std::vector<uint8_t> body;
    body.push_back((uint8_t)data.size());
    body.push_back((uint8_t)(addr >> 8));
    body.push_back((uint8_t)(addr & 0xFF));
    body.push_back(type);
    for (uint8_t b : data) {
        body.push_back(b);
    }
    uint8_t sum = 0;
    for (uint8_t b : body) {
        sum = (uint8_t)(sum + b);
    }
    body.push_back((uint8_t)(-(int)sum & 0xFF));

    std::string out = ":";
    for (uint8_t b : body) {
        out.push_back(hexd[b >> 4]);
        out.push_back(hexd[b & 0xF]);
    }
    out += "\n";
    return out;
}

/** Extended linear address record — sets the upper 16 bits of the address. */
std::string ela(uint16_t upper)
{
    return rec(0x04, 0, {(uint8_t)(upper >> 8), (uint8_t)(upper & 0xFF)});
}

std::string eof()
{
    return rec(0x01, 0, {});
}

/** `n` bytes of recognisable filler starting at `seed`. */
std::vector<uint8_t> filler(size_t n, uint8_t seed)
{
    std::vector<uint8_t> v;
    for (size_t i = 0; i < n; i++) {
        v.push_back((uint8_t)(seed + i));
    }
    return v;
}

/** A byte of target flash, read through the fake's backdoor. */
uint8_t flash_byte(const FakeSwdTarget& t, uint32_t addr)
{
    uint32_t w = t.peek(addr & ~3u);
    return (uint8_t)(w >> ((addr & 3u) * 8));
}

} // namespace

/* -----------------------------------------------------------------------
 * Entry conditions
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_begin_accepts_a_reachable_part)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
}

TEST(nrf_flash_begin_refuses_a_part_whose_ahb_ap_is_blocked)
{
    /* This is what a dongle sitting in its factory USB bootloader looks like:
       APPROTECT is engaged and AP0 does not answer. Programming cannot start,
       and saying so beats writing into a fault pattern. */
    Rig r;
    r.target.set_locked(true);
    ASSERT_EQ(r.begin(), NRF_FLASH_ERR_LOCKED);
}

TEST(nrf_flash_begin_rejects_an_inverted_region)
{
    Rig r;
    ASSERT_EQ(r.begin(0x20000u, 0x10000u), NRF_FLASH_ERR_RANGE);
}

TEST(nrf_flash_begin_rejects_an_unaligned_region)
{
    /* The region bounds are page bounds. A start halfway into a page would let
       the erase of that page take the half below it. */
    Rig r;
    ASSERT_EQ(r.begin(0x1800u, APP_END), NRF_FLASH_ERR_RANGE);
}

TEST(nrf_flash_feed_before_begin_is_a_state_error)
{
    Rig r;
    nrf_flash_t fl = {};
    ASSERT_EQ(nrf_flash_feed(&fl, ":00000001FF\n", 12), NRF_FLASH_ERR_STATE);
}

TEST(nrf_flash_begin_halts_the_core)
{
    /* The application owns the flash it is being programmed over. Leaving it
       running during the erase is asking the two of them to disagree. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_TRUE(r.target.core_halted());
}

TEST(nrf_flash_finish_releases_the_core_even_when_it_failed)
{
    /* A part left halted looks exactly like the dead dongle this is meant to
       fix, so the release cannot be conditional on success. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_INCOMPLETE);
    ASSERT_FALSE(r.target.core_halted());
}

/* -----------------------------------------------------------------------
 * The happy path
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_programs_a_record_into_flash)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, {0xDE, 0xAD, 0xBE, 0xEF})), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.peek(0x1000u), 0xEFBEADDEu);
}

TEST(nrf_flash_reflashes_over_a_page_that_already_holds_an_image)
{
    /* The normal case on the bench: the dongle already has firmware on it.
       Flash programming only clears bits, so a page programmed without being
       erased first reads back as old AND new — for these two words, zero. */
    Rig r;
    r.target.poke(0x1000u, 0x00000000u);
    r.target.poke(0x1004u, 0x00000000u);
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, {0xEF, 0xBE, 0xAD, 0xDE, 0x0D, 0xF0, 0xFE, 0xCA})), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.peek(0x1000u), 0xDEADBEEFu);
    ASSERT_EQ(r.target.peek(0x1004u), 0xCAFEF00Du);
}

TEST(nrf_flash_leaves_the_rest_of_a_partly_filled_page_erased)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, {1, 2, 3, 4})), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.peek(0x1004u), 0xFFFFFFFFu);
    ASSERT_EQ(r.target.peek(0x1FFCu), 0xFFFFFFFFu);
}

TEST(nrf_flash_programs_across_a_page_boundary)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    /* Last 8 bytes of the 0x1000 page and the first 8 of the 0x2000 page. */
    ASSERT_EQ(r.feed(rec(0x00, 0x1FF8, filler(8, 0x10))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x2000, filler(8, 0x80))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(flash_byte(r.target, 0x1FF8u), 0x10);
    ASSERT_EQ(flash_byte(r.target, 0x1FFFu), 0x17);
    ASSERT_EQ(flash_byte(r.target, 0x2000u), 0x80);
    ASSERT_EQ(flash_byte(r.target, 0x2007u), 0x87);
    ASSERT_EQ(nrf_flash_pages_written(&r.fl), 2u);
}

TEST(nrf_flash_follows_an_extended_linear_address_record)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(ela(0x0003)), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x0000, {0xAA, 0xBB, 0xCC, 0xDD})), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.peek(0x30000u), 0xDDCCBBAAu);
}

TEST(nrf_flash_ignores_a_start_address_record)
{
    /* Pinned against the real image: ot-ncp-ftd.hex ends with this exact type
       03 record, and its 0x31591 entry point matched the reset vector read back
       off the part over SWD. It carries an entry point, not data. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, {1, 2, 3, 4})), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(std::string(":040000033000159123\n")), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(nrf_flash_pages_written(&r.fl), 1u);
}

TEST(nrf_flash_counts_the_image_bytes_it_accepted)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1010, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(nrf_flash_image_bytes(&r.fl), 32u);
}

/* -----------------------------------------------------------------------
 * Line framing
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_carries_a_line_split_across_two_feeds)
{
    /* The image arrives as offset-addressed UDP chunks that know nothing about
       record boundaries, so a record will be cut in half at some point in every
       real upload. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);

    std::string line = rec(0x00, 0x1000, {0x11, 0x22, 0x33, 0x44});
    ASSERT_EQ(r.feed(line.substr(0, 5)), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(line.substr(5)), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.peek(0x1000u), 0x44332211u);
}

TEST(nrf_flash_accepts_crlf_line_endings)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(":04100000AABBCCDDDE\r\n:00000001FF\r\n"), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.peek(0x1000u), 0xDDCCBBAAu);
}

/* -----------------------------------------------------------------------
 * The region guard — the part that protects the MBR and the bootloader
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_rejects_a_record_below_the_region)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x0000, {1, 2, 3, 4})), NRF_FLASH_ERR_RANGE);
}

TEST(nrf_flash_does_not_erase_the_mbr_page_when_it_rejects_a_record)
{
    /* Rejecting after the erase would be worse than not rejecting at all. */
    Rig r;
    r.target.poke(0x0000u, 0x600D600Du);
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x0000, {1, 2, 3, 4})), NRF_FLASH_ERR_RANGE);

    ASSERT_EQ(r.target.peek(0x0000u), 0x600D600Du);
    ASSERT_EQ(nrf_flash_pages_written(&r.fl), 0u);
}

TEST(nrf_flash_rejects_a_record_at_the_bootloader_base)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(ela(0x000E)), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x0000, {1, 2, 3, 4})), NRF_FLASH_ERR_RANGE);
}

TEST(nrf_flash_rejects_a_record_that_starts_inside_and_runs_past_the_region)
{
    /* The last permitted page is 0xDF000. A record straddling 0xE0000 has a
       legal first byte and an illegal last one. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(ela(0x000D)), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0xFFF8, filler(16, 0))), NRF_FLASH_ERR_RANGE);
}

TEST(nrf_flash_leaves_the_bootloader_alone_across_a_whole_image)
{
    Rig r;
    r.target.poke(0xE0000u, 0xB007107Du);
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.peek(0xE0000u), 0xB007107Du);
}

TEST(nrf_flash_never_triggers_eraseall)
{
    /* CTRL-AP ERASEALL takes the factory USB bootloader with it and there is no
       way back from that but SWD. Ordinary flashing must never reach for it. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.eraseall_count(), 0);
}

TEST(nrf_flash_erases_only_the_pages_the_image_covers)
{
    Rig r;
    r.target.poke(0x5000u, 0x12345678u);
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.peek(0x5000u), 0x12345678u);
}

TEST(nrf_flash_rejects_a_record_that_moves_back_into_a_finished_page)
{
    /* Pages are erased as the stream moves past them, so going backwards would
       erase content that was already programmed and verified. Refusing beats
       quietly losing it. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x2000, filler(4, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(4, 0))), NRF_FLASH_ERR_ORDER);
}

/* -----------------------------------------------------------------------
 * Malformed and truncated input
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_rejects_a_record_with_a_bad_checksum)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(":04100000AABBCCDD00\n"), NRF_FLASH_ERR_HEX);
}

TEST(nrf_flash_rejects_a_line_that_is_not_a_record)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed("not a hex record\n"), NRF_FLASH_ERR_HEX);
}

TEST(nrf_flash_finish_without_an_eof_record_is_incomplete)
{
    /* A dropped UDP chunk at the tail looks exactly like a shorter image. The
       EOF record is the only thing that distinguishes them. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_INCOMPLETE);
}

TEST(nrf_flash_finish_with_no_data_at_all_is_incomplete)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_INCOMPLETE);
}

TEST(nrf_flash_an_eof_record_with_no_data_before_it_is_incomplete)
{
    /* An upload that lost everything but its last chunk is well-formed hex
       carrying no image. Reporting that as a successful flash would be worse
       than reporting nothing at all. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_INCOMPLETE);
}

TEST(nrf_flash_finish_without_an_eof_record_programs_nothing)
{
    /* Refusing after writing a partial image would leave the part in the state
       the refusal is meant to prevent. */
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_INCOMPLETE);

    ASSERT_EQ(nrf_flash_pages_written(&r.fl), 0u);
    ASSERT_EQ(r.target.peek(0x1000u), 0xFFFFFFFFu);
}

TEST(nrf_flash_latches_the_first_error_and_stops_programming)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x0000, {1, 2, 3, 4})), NRF_FLASH_ERR_RANGE);
    /* A well-formed record after the failure must not resurrect the session. */
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, {1, 2, 3, 4})), NRF_FLASH_ERR_RANGE);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_RANGE);
    ASSERT_EQ(nrf_flash_pages_written(&r.fl), 0u);
}

/* -----------------------------------------------------------------------
 * Verify
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_reports_a_word_that_did_not_take_the_program)
{
    /* The mutation test for the verify step: a flash routine whose verify can
       never fail looks identical to a working one right up until it matters. */
    Rig r;
    r.target.set_stuck_bits(0x1004u, 0x00000010u);
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, {0, 0, 0, 0, 0, 0, 0, 0})), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_VERIFY);
}

TEST(nrf_flash_verify_failure_stops_the_rest_of_the_image)
{
    /* A page that failed to verify must not be followed by more programming,
       and must still be the answer at the end. */
    Rig r;
    r.target.set_stuck_bits(0x1000u, 0x00000001u);
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, {0, 0, 0, 0})), NRF_FLASH_OK);
    /* Crossing into the next page forces the bad one out. */
    ASSERT_EQ(r.feed(rec(0x00, 0x2000, filler(4, 0))), NRF_FLASH_ERR_VERIFY);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_ERR_VERIFY);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_VERIFY);
    ASSERT_EQ(nrf_flash_pages_written(&r.fl), 0u);
    ASSERT_EQ(r.target.peek(0x2000u), 0xFFFFFFFFu);
}

TEST(nrf_flash_verify_reads_the_part_back_rather_than_its_own_buffer)
{
    /* Same idea from the other side: if verify compared the staging buffer with
       itself, a target that dropped the whole page would still pass. */
    Rig r;
    r.target.set_stuck_bits(0x1008u, 0xFFFFFFFFu);
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 1))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_VERIFY);
}

/* -----------------------------------------------------------------------
 * NVMC sequencing
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_waits_for_the_nvmc_between_operations)
{
    Rig r;
    r.target.set_nvmc_busy_polls(3);
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.nvmc_busy_violations(), 0);
}

TEST(nrf_flash_never_programs_with_the_nvmc_in_the_wrong_mode)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x2000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.nvmc_write_violations(), 0);
    ASSERT_EQ(r.target.nvmc_erase_violations(), 0);
}

TEST(nrf_flash_leaves_the_nvmc_read_only_when_it_is_done)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(r.target.nvmc_config(), (uint32_t)NRF_NVMC_CONFIG_REN);
}

TEST(nrf_flash_reports_a_link_that_stopped_answering)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    r.target.set_present(false);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_ERR_SWD);
}

TEST(nrf_flash_reports_a_link_that_died_mid_image)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    r.target.set_present(false);
    /* Crossing into the next page is what forces the staged page out. */
    ASSERT_EQ(r.feed(rec(0x00, 0x2000, filler(16, 0))), NRF_FLASH_ERR_SWD);
}

/* -----------------------------------------------------------------------
 * Watchdog tick
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_ticks_at_least_once_per_page)
{
    /* Erasing and programming a page takes far longer than the 10 s IWDG
       timeout allows between feeds, so the driver has to offer the caller a
       place to refresh it. */
    Rig r;
    int ticks = 0;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);
    nrf_flash_set_tick(
        &r.fl, [](void* ctx) { (*(int*)ctx)++; }, &ticks);

    ASSERT_EQ(r.feed(rec(0x00, 0x1000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x2000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(rec(0x00, 0x3000, filler(16, 0))), NRF_FLASH_OK);
    ASSERT_EQ(r.feed(eof()), NRF_FLASH_OK);
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(nrf_flash_pages_written(&r.fl), 3u);
    ASSERT_TRUE(ticks >= 3);
}

/* -----------------------------------------------------------------------
 * Where the region ceiling comes from
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_bootloader_base_reads_uicr_nrffw0)
{
    /* 0x000E0000 is not a guess: it is what the bench dongle actually holds.
       Read back over SWD from the running board —
         [10001014] = 000E0000   NRFFW[0], bootloader start
         [10001018] = 000FE000   NRFFW[1], bootloader settings page
       and the image it is protecting spans 0x1000..0x37FB8. */
    Rig r;
    r.target.poke(0x10001014u, 0x000E0000u);
    ASSERT_EQ(nrf_flash_bootloader_base(&r.nrf, 0x12345u), 0x000E0000u);
}

TEST(nrf_flash_bootloader_base_falls_back_when_uicr_is_erased)
{
    /* A part whose bootloader was erased reads 0xFFFFFFFF there. Taking that at
       face value would put the ceiling past the end of flash. */
    Rig r;
    ASSERT_EQ(nrf_flash_bootloader_base(&r.nrf, 0xE0000u), 0xE0000u);
}

TEST(nrf_flash_bootloader_base_falls_back_on_an_implausible_value)
{
    Rig r;
    r.target.poke(0x10001014u, 0x00000800u);
    ASSERT_EQ(nrf_flash_bootloader_base(&r.nrf, 0xE0000u), 0xE0000u);
}

/* -----------------------------------------------------------------------
 * A whole small image, end to end
 * ----------------------------------------------------------------------- */

TEST(nrf_flash_round_trips_a_multi_page_image)
{
    Rig r;
    ASSERT_EQ(r.begin(), NRF_FLASH_OK);

    std::string img;
    for (uint32_t addr = 0x1000; addr < 0x4000; addr += 16) {
        img += rec(0x00, (uint16_t)addr, filler(16, (uint8_t)(addr >> 4)));
    }
    img += eof();

    /* Fed in 100-byte slices, the way the upload transport delivers it. */
    for (size_t off = 0; off < img.size(); off += 100) {
        size_t n = img.size() - off < 100 ? img.size() - off : 100;
        ASSERT_EQ(nrf_flash_feed(&r.fl, img.data() + off, n), NRF_FLASH_OK);
    }
    ASSERT_EQ(nrf_flash_finish(&r.fl), NRF_FLASH_OK);

    ASSERT_EQ(nrf_flash_pages_written(&r.fl), 3u);
    ASSERT_EQ(nrf_flash_image_bytes(&r.fl), 0x3000u);
    for (uint32_t addr = 0x1000; addr < 0x4000; addr += 16) {
        ASSERT_EQ(flash_byte(r.target, addr), (uint8_t)(addr >> 4));
        ASSERT_EQ(flash_byte(r.target, addr + 15), (uint8_t)((addr >> 4) + 15));
    }
    ASSERT_EQ(r.target.peek(0x0000u), 0xFFFFFFFFu);
    ASSERT_EQ(r.target.eraseall_count(), 0);
    ASSERT_EQ(r.target.protocol_errors(), 0);
}
