/**
 * Winbond W25Q SPI NOR driver.
 *
 * The three rules this hardware enforces silently, and so the tests do loudly:
 *
 *  - Every program and erase needs its own write enable. WEL clears itself when
 *    the operation completes, so one 06h does not cover two writes. Miss it and
 *    the data is dropped with no error anywhere.
 *
 *  - A page program stops at the end of its 256-byte page. Run past it and the
 *    address wraps to the *start of the same page* and overwrites what was just
 *    written — the buffer looks fine, the flash does not.
 *
 *  - Programming only clears bits, so a page written twice without an erase
 *    reads back as the AND of the two. Verify has to read the part back.
 */

#include "fake_w25q.h"
#include "test_harness.h"
#include "w25q.h"

#include <string>
#include <vector>

namespace {

struct Rig {
    FakeW25Q part;
    w25q_t f;

    Rig()
    {
        w25q_io_t io = part.io();
        w25q_init(&f, &io);
    }
};

std::vector<uint8_t> pattern(size_t n, uint8_t seed = 0)
{
    std::vector<uint8_t> v;
    for (size_t i = 0; i < n; i++) {
        v.push_back((uint8_t)(seed + i));
    }
    return v;
}

} // namespace

/* -----------------------------------------------------------------------
 * Identification
 * ----------------------------------------------------------------------- */

TEST(w25q_probe_reads_the_jedec_id)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_manufacturer(&r.f), 0xEF);
    ASSERT_EQ(w25q_capacity(&r.f), 16u * 1024u * 1024u);
}

TEST(w25q_probe_decodes_capacity_from_the_id_exponent)
{
    /* Byte 3 of the JEDEC ID is log2 of the size. 0x18 is 16 MB; getting this
       wrong scales every bounds check on the part. */
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_capacity(&r.f), 1u << FAKE_W25Q_CAPACITY_CODE);
}

TEST(w25q_probe_reports_an_absent_part)
{
    /* An unwired or dead part leaves MISO pulled high, so the ID reads as all
       ones. That is not a Winbond device and must not look like one. */
    Rig r;
    r.part.set_present(false);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_ERR_NO_DEVICE);
}

TEST(w25q_probe_rejects_a_plausible_capacity_from_an_implausible_manufacturer)
{
    /* A floating MISO does not always read as a clean 0xFF — crosstalk off the
       adjacent clock can leave one field looking sane. Checking only the
       capacity byte would accept this as a 16 MB Winbond. */
    Rig r;
    r.part.set_id(0xFF, 0x40, 0x18);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_ERR_NO_DEVICE);
}

TEST(w25q_probe_rejects_an_implausible_capacity_from_a_real_manufacturer)
{
    Rig r;
    r.part.set_id(0xEF, 0x40, 0xFF);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_ERR_NO_DEVICE);
}

TEST(w25q_operations_before_probe_are_refused)
{
    Rig r;
    uint8_t buf[4];
    ASSERT_EQ(w25q_read(&r.f, 0, buf, sizeof(buf)), W25Q_ERR_STATE);
}

/* -----------------------------------------------------------------------
 * Read
 * ----------------------------------------------------------------------- */

TEST(w25q_read_returns_erased_bytes_from_a_blank_part)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    uint8_t buf[8] = {0};
    ASSERT_EQ(w25q_read(&r.f, 0x1000, buf, sizeof(buf)), W25Q_OK);
    for (uint8_t b : buf) {
        ASSERT_EQ(b, 0xFF);
    }
}

TEST(w25q_read_sends_the_address_most_significant_byte_first)
{
    /* A byte-swapped 24-bit address reads the wrong place and still succeeds,
       which is why this is pinned against a known byte rather than a round
       trip through the driver's own writer. */
    Rig r;
    r.part.poke(0x123456, 0xA5);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);

    uint8_t v = 0;
    ASSERT_EQ(w25q_read(&r.f, 0x123456, &v, 1), W25Q_OK);
    ASSERT_EQ(v, 0xA5);
}

TEST(w25q_read_streams_across_page_and_sector_boundaries)
{
    Rig r;
    for (uint32_t a = 0x0FF0; a < 0x1010; a++) {
        r.part.poke(a, (uint8_t)a);
    }
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);

    uint8_t buf[0x20] = {0};
    ASSERT_EQ(w25q_read(&r.f, 0x0FF0, buf, sizeof(buf)), W25Q_OK);
    for (uint32_t i = 0; i < sizeof(buf); i++) {
        ASSERT_EQ(buf[i], (uint8_t)(0x0FF0 + i));
    }
}

TEST(w25q_read_rejects_a_run_past_the_end_of_the_device)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    uint8_t buf[16];
    ASSERT_EQ(w25q_read(&r.f, w25q_capacity(&r.f) - 4, buf, sizeof(buf)), W25Q_ERR_RANGE);
}

/* -----------------------------------------------------------------------
 * Program
 * ----------------------------------------------------------------------- */

TEST(w25q_program_writes_bytes)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    const uint8_t data[4] = {0xDE, 0xAD, 0xBE, 0xEF};
    ASSERT_EQ(w25q_program(&r.f, 0x2000, data, sizeof(data)), W25Q_OK);

    ASSERT_EQ(r.part.peek(0x2000), 0xDE);
    ASSERT_EQ(r.part.peek(0x2003), 0xEF);
}

TEST(w25q_program_write_enables_before_every_page)
{
    /* WEL clears itself when a program completes, so a multi-page write needs
       one 06h per page. A single one up front programs the first page and
       silently drops the rest. */
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    std::vector<uint8_t> data = pattern(768); /* three full pages */
    ASSERT_EQ(w25q_program(&r.f, 0, data.data(), data.size()), W25Q_OK);

    ASSERT_EQ(r.part.wel_violations(), 0);
    for (size_t i = 0; i < data.size(); i++) {
        ASSERT_EQ(r.part.peek((uint32_t)i), data[i]);
    }
}

TEST(w25q_program_never_lets_a_page_wrap)
{
    /* The failure this exists to prevent: a write starting mid-page and running
       long wraps to the start of that page on real silicon. */
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    std::vector<uint8_t> data = pattern(300, 1);
    ASSERT_EQ(w25q_program(&r.f, 0x80, data.data(), data.size()), W25Q_OK);

    ASSERT_EQ(r.part.page_wraps(), 0);
    for (size_t i = 0; i < data.size(); i++) {
        ASSERT_EQ(r.part.peek((uint32_t)(0x80 + i)), data[i]);
    }
}

TEST(w25q_program_splits_an_unaligned_run_at_the_first_page_boundary)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    std::vector<uint8_t> data = pattern(4, 0x11);
    ASSERT_EQ(w25q_program(&r.f, 0xFE, data.data(), data.size()), W25Q_OK);

    ASSERT_EQ(r.part.peek(0xFE), 0x11);
    ASSERT_EQ(r.part.peek(0xFF), 0x12);
    ASSERT_EQ(r.part.peek(0x100), 0x13);
    ASSERT_EQ(r.part.peek(0x101), 0x14);
    ASSERT_EQ(r.part.page_wraps(), 0);
}

TEST(w25q_program_waits_for_busy_to_clear_between_pages)
{
    Rig r;
    r.part.set_busy_polls(3);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    std::vector<uint8_t> data = pattern(512);
    ASSERT_EQ(w25q_program(&r.f, 0, data.data(), data.size()), W25Q_OK);

    ASSERT_EQ(r.part.busy_violations(), 0);
}

TEST(w25q_program_rejects_a_run_past_the_end_of_the_device)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    const uint8_t data[8] = {0};
    ASSERT_EQ(w25q_program(&r.f, w25q_capacity(&r.f) - 4, data, sizeof(data)), W25Q_ERR_RANGE);
}

TEST(w25q_program_only_clears_bits)
{
    /* NOR semantics, and the reason erase exists. Programming over unerased
       data gives old AND new rather than new. */
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    const uint8_t first = 0xF0;
    const uint8_t second = 0x0F;
    ASSERT_EQ(w25q_program(&r.f, 0x30, &first, 1), W25Q_OK);
    ASSERT_EQ(w25q_program(&r.f, 0x30, &second, 1), W25Q_OK);

    ASSERT_EQ(r.part.peek(0x30), 0x00);
}

/* -----------------------------------------------------------------------
 * Erase
 * ----------------------------------------------------------------------- */

TEST(w25q_erase_sector_clears_the_sector)
{
    Rig r;
    r.part.poke(0x5000, 0x00);
    r.part.poke(0x5FFF, 0x00);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x5000), W25Q_OK);

    ASSERT_EQ(r.part.peek(0x5000), 0xFF);
    ASSERT_EQ(r.part.peek(0x5FFF), 0xFF);
}

TEST(w25q_erase_sector_leaves_the_neighbouring_sector_alone)
{
    Rig r;
    r.part.poke(0x4FFF, 0x11);
    r.part.poke(0x6000, 0x22);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x5000), W25Q_OK);

    ASSERT_EQ(r.part.peek(0x4FFF), 0x11);
    ASSERT_EQ(r.part.peek(0x6000), 0x22);
}

TEST(w25q_erase_sector_accepts_an_address_inside_the_sector)
{
    Rig r;
    r.part.poke(0x5800, 0x00);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x5ABC), W25Q_OK);

    ASSERT_EQ(r.part.peek(0x5800), 0xFF);
}

TEST(w25q_erase_sector_write_enables_first)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x1000), W25Q_OK);

    ASSERT_EQ(r.part.wel_violations(), 0);
    ASSERT_EQ(r.part.erases(), 1);
}

TEST(w25q_erase_sector_waits_for_busy_to_clear)
{
    Rig r;
    r.part.set_busy_polls(5);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x1000), W25Q_OK);
    /* The next command must not be issued while the erase is still running. */
    const uint8_t b = 0x5A;
    ASSERT_EQ(w25q_program(&r.f, 0x1000, &b, 1), W25Q_OK);

    ASSERT_EQ(r.part.busy_violations(), 0);
    ASSERT_EQ(r.part.peek(0x1000), 0x5A);
}

TEST(w25q_erase_block_clears_sixteen_sectors)
{
    Rig r;
    r.part.poke(0x30000, 0x00);
    r.part.poke(0x3FFFF, 0x00);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_erase_block(&r.f, 0x30000), W25Q_OK);

    ASSERT_EQ(r.part.peek(0x30000), 0xFF);
    ASSERT_EQ(r.part.peek(0x3FFFF), 0xFF);
}

TEST(w25q_erase_block_leaves_the_neighbouring_block_alone)
{
    Rig r;
    r.part.poke(0x2FFFF, 0x11);
    r.part.poke(0x40000, 0x22);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_erase_block(&r.f, 0x38000), W25Q_OK);

    ASSERT_EQ(r.part.peek(0x2FFFF), 0x11);
    ASSERT_EQ(r.part.peek(0x40000), 0x22);
}

TEST(w25q_erase_block_write_enables_and_waits)
{
    Rig r;
    r.part.set_busy_polls(6);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_erase_block(&r.f, 0), W25Q_OK);
    const uint8_t b = 0x5A;
    ASSERT_EQ(w25q_program(&r.f, 0, &b, 1), W25Q_OK);

    ASSERT_EQ(r.part.wel_violations(), 0);
    ASSERT_EQ(r.part.busy_violations(), 0);
    ASSERT_EQ(r.part.peek(0), 0x5A);
}

TEST(w25q_erase_sector_rejects_an_address_past_the_device)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_erase_sector(&r.f, w25q_capacity(&r.f)), W25Q_ERR_RANGE);
}

/* -----------------------------------------------------------------------
 * Round trip
 * ----------------------------------------------------------------------- */

TEST(w25q_erase_program_read_round_trips_over_a_sector)
{
    Rig r;
    r.part.set_busy_polls(2);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);

    std::vector<uint8_t> data = pattern(4096, 3);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x9000), W25Q_OK);
    ASSERT_EQ(w25q_program(&r.f, 0x9000, data.data(), data.size()), W25Q_OK);

    std::vector<uint8_t> back(4096, 0);
    ASSERT_EQ(w25q_read(&r.f, 0x9000, back.data(), back.size()), W25Q_OK);
    ASSERT_TRUE(back == data);

    ASSERT_EQ(r.part.wel_violations(), 0);
    ASSERT_EQ(r.part.busy_violations(), 0);
    ASSERT_EQ(r.part.page_wraps(), 0);
    ASSERT_EQ(r.part.cs_violations(), 0);
}

TEST(w25q_verify_reads_the_part_back)
{
    /* Same mutation guard as the SWD side: a verify that cannot fail is
       indistinguishable from one that works. */
    Rig r;
    r.part.set_stuck_bits(0x7002, 0x04);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);

    const uint8_t data[4] = {0, 0, 0, 0};
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x7000), W25Q_OK);
    ASSERT_EQ(w25q_program(&r.f, 0x7000, data, sizeof(data)), W25Q_OK);
    ASSERT_EQ(w25q_verify(&r.f, 0x7000, data, sizeof(data)), W25Q_ERR_VERIFY);
}

/* -----------------------------------------------------------------------
 * Quad Enable
 *
 * With QE clear, pins 3 and 7 are WP# and HOLD#: live, active-low inputs that
 * abort a transfer if they drift low. Setting QE turns them into IO2/IO3,
 * which in single-SPI mode are simply unused — which is what makes leaving
 * them unconnected safe.
 *
 * The register this lives in also holds bits that cannot be taken back. SRL
 * locks the status register permanently, and LB1..LB3 are one-time
 * programmable. Setting any of them by accident is not recoverable, so the
 * tests pin that they stay clear rather than trusting the constant.
 * ----------------------------------------------------------------------- */

TEST(w25q_set_quad_enable_sets_the_qe_bit)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_set_quad_enable(&r.f), W25Q_OK);

    uint8_t sr2 = 0;
    ASSERT_EQ(w25q_read_status_reg(&r.f, 2, &sr2), W25Q_OK);
    ASSERT_EQ(sr2 & 0x02, 0x02);
}

TEST(w25q_set_quad_enable_never_sets_the_status_register_lock)
{
    /* SRL is a one-way door: with it set, the status register can never be
       written again, and QE could never be cleared. */
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_set_quad_enable(&r.f), W25Q_OK);

    ASSERT_EQ(r.part.srl_attempts(), 0);
    uint8_t sr2 = 0;
    ASSERT_EQ(w25q_read_status_reg(&r.f, 2, &sr2), W25Q_OK);
    ASSERT_EQ(sr2 & 0x01, 0);
}

TEST(w25q_set_quad_enable_never_sets_the_one_time_lock_bits)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_set_quad_enable(&r.f), W25Q_OK);

    ASSERT_EQ(r.part.otp_attempts(), 0);
    uint8_t sr2 = 0;
    ASSERT_EQ(w25q_read_status_reg(&r.f, 2, &sr2), W25Q_OK);
    ASSERT_EQ(sr2 & 0x38, 0);
}

TEST(w25q_set_quad_enable_write_enables_first)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_set_quad_enable(&r.f), W25Q_OK);
    ASSERT_EQ(r.part.wel_violations(), 0);
}

TEST(w25q_set_quad_enable_waits_for_the_write_to_finish)
{
    /* A non-volatile status write takes milliseconds. Issuing the next command
       while it is still running loses it. */
    Rig r;
    r.part.set_busy_polls(4);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_set_quad_enable(&r.f), W25Q_OK);
    /* The collision only shows up against a following command, so issue one —
       the part ignores everything but a status read while it is busy. */
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x1000), W25Q_OK);
    ASSERT_EQ(r.part.busy_violations(), 0);
}

TEST(w25q_set_quad_enable_preserves_bits_it_does_not_own)
{
    /* CMP changes what the block-protect bits mean. Clobbering it while
       setting QE would silently change the protection scheme. */
    Rig r;
    r.part.set_sr2(0x40); /* CMP set */
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_set_quad_enable(&r.f), W25Q_OK);

    uint8_t sr2 = 0;
    ASSERT_EQ(w25q_read_status_reg(&r.f, 2, &sr2), W25Q_OK);
    ASSERT_EQ(sr2 & 0x40, 0x40);
    ASSERT_EQ(sr2 & 0x02, 0x02);
}

TEST(w25q_set_quad_enable_on_an_already_enabled_part_is_a_no_op)
{
    Rig r;
    r.part.set_sr2(0x02);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_set_quad_enable(&r.f), W25Q_OK);
    /* Nothing to change, so nothing should have been written. */
    ASSERT_EQ(r.part.status_writes(), 0);
}

TEST(w25q_set_quad_enable_refuses_a_locked_status_register)
{
    /* If SRL is already set the write cannot land, and reporting success would
       send the caller off believing the pins are safe to float. */
    Rig r;
    r.part.set_sr2(0x01);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    ASSERT_EQ(w25q_set_quad_enable(&r.f), W25Q_ERR_LOCKED);
}

TEST(w25q_verify_accepts_a_matching_image)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    std::vector<uint8_t> data = pattern(600, 7);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0xA000), W25Q_OK);
    ASSERT_EQ(w25q_program(&r.f, 0xA000, data.data(), data.size()), W25Q_OK);
    ASSERT_EQ(w25q_verify(&r.f, 0xA000, data.data(), data.size()), W25Q_OK);
}

/* -----------------------------------------------------------------------
 * Transport failures
 *
 * The transport used to return void, so a timed-out or overrun transfer was
 * indistinguishable from a good one. That is the worst possible direction for
 * this driver to fail in: a read hands back whatever was already in the
 * caller's buffer, and a status poll can read BUSY clear when nothing was ever
 * clocked — which ends an erase early and reports success.
 * ----------------------------------------------------------------------- */

TEST(w25q_read_reports_a_failure_in_the_address_phase)
{
    /* The opcode and address never reach the part, so the data phase that
       follows is reading from nowhere in particular. It must not come back
       W25Q_OK — which is what a driver that ignores the transport does, since
       the bytes it collects look like a perfectly ordinary erased-flash read. */
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    std::vector<uint8_t> data = pattern(64, 3);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x2000), W25Q_OK);
    ASSERT_EQ(w25q_program(&r.f, 0x2000, data.data(), data.size()), W25Q_OK);

    uint8_t out[64];
    memset(out, 0x5A, sizeof(out));

    r.part.fail_next_xfers(1);
    ASSERT_EQ(w25q_read(&r.f, 0x2000, out, sizeof(out)), W25Q_ERR_IO);
    /* And specifically not the data that is genuinely at 0x2000. */
    ASSERT_EQ(out[0] == data[0], false);
}

TEST(w25q_read_reports_a_failure_in_the_data_phase)
{
    /* The address goes out fine and the payload is what gets starved — the
       shape an RX overrun actually takes, and the one a driver watching only
       the first transfer would miss. A read is two transfers: the 03h plus
       address, then the data. */
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    std::vector<uint8_t> data = pattern(16, 4);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x2000), W25Q_OK);
    ASSERT_EQ(w25q_program(&r.f, 0x2000, data.data(), data.size()), W25Q_OK);

    uint8_t out[16];
    memset(out, 0x5A, sizeof(out));

    r.part.fail_xfers_after(1, 1);
    ASSERT_EQ(w25q_read(&r.f, 0x2000, out, sizeof(out)), W25Q_ERR_IO);
    ASSERT_EQ(out[0], 0x5A);
}

TEST(w25q_probe_separates_a_dead_link_from_an_absent_part)
{
    /* "No device" sends someone to check the part; "IO" sends them to check
       the wiring and the peripheral. Reporting the first for the second wastes
       the trip. */
    Rig r;
    r.part.fail_next_xfers(1);
    ASSERT_EQ(w25q_probe(&r.f), W25Q_ERR_IO);
    ASSERT_EQ(w25q_capacity(&r.f), 0u);
}

TEST(w25q_erase_does_not_spin_on_a_dead_link)
{
    /* wait_ready() polls a million times before giving up. If a failed poll
       reads back as 0xFF the BUSY bit is set, so a dead link used to cost the
       full budget and then report a timeout rather than a link fault. */
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    r.part.fail_next_xfers(1);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x3000), W25Q_ERR_IO);
}

TEST(w25q_program_reports_a_failed_transfer)
{
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    std::vector<uint8_t> data = pattern(32, 1);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x4000), W25Q_OK);
    r.part.fail_next_xfers(1);
    ASSERT_EQ(w25q_program(&r.f, 0x4000, data.data(), data.size()), W25Q_ERR_IO);
}

TEST(w25q_recovers_once_the_link_comes_back)
{
    /* The flag is per operation, not sticky for the life of the device — a
       transient overrun must not condemn the part. */
    Rig r;
    ASSERT_EQ(w25q_probe(&r.f), W25Q_OK);
    r.part.fail_next_xfers(1);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x5000), W25Q_ERR_IO);

    std::vector<uint8_t> data = pattern(48, 9);
    ASSERT_EQ(w25q_erase_sector(&r.f, 0x5000), W25Q_OK);
    ASSERT_EQ(w25q_program(&r.f, 0x5000, data.data(), data.size()), W25Q_OK);
    ASSERT_EQ(w25q_verify(&r.f, 0x5000, data.data(), data.size()), W25Q_OK);
}
