/**
 * nRF52840 flash programming over SWD.
 *
 * The two things that bite here:
 *
 *  - NVMC CONFIG gates everything. Program a word with CONFIG still at ReadOnly
 *    and the write is dropped on the floor — no fault, no ACK error, the word
 *    just stays erased. The fake counts those attempts so the tests can catch
 *    a missing CONFIG the way hardware never would.
 *
 *  - A part with APPROTECT set has no working AHB-AP at all, so every normal
 *    recovery path is unavailable. CTRL-AP ERASEALL is the only way back, and
 *    it is also the only path that cannot be tested by "just try flashing it".
 */

#include "fake_swd_target.h"
#include "nrf_swd.h"
#include "swd.h"
#include "test_harness.h"

namespace {

struct Rig {
    FakeSwdTarget target;
    swd_t swd;
    nrf_swd_t nrf;

    Rig()
    {
        swd_io_t io = target.io();
        swd_init(&swd, &io);
        nrf_swd_init(&nrf, &swd);
    }
};

} // namespace

/* -----------------------------------------------------------------------
 * Bring-up
 * ----------------------------------------------------------------------- */

TEST(nrf_swd_connect_identifies_the_part)
{
    Rig r;
    ASSERT_EQ(nrf_swd_connect(&r.nrf), SWD_OK);
    ASSERT_TRUE(r.target.debug_powered());
    ASSERT_EQ(r.target.protocol_errors(), 0);
}

TEST(nrf_swd_connect_reports_a_locked_part_as_locked)
{
    /* Not as a fault. "AHB-AP faulted" sends you looking at wiring; "APPROTECT
       is set" tells you to run recovery. */
    Rig r;
    r.target.set_locked(true);
    ASSERT_EQ(nrf_swd_connect(&r.nrf), SWD_ERR_LOCKED);
}

TEST(nrf_swd_is_locked_reads_ctrl_ap_approtectstatus)
{
    Rig r;
    bool locked = false;

    ASSERT_EQ(nrf_swd_is_locked(&r.nrf, &locked), SWD_OK);
    ASSERT_FALSE(locked);

    r.target.set_locked(true);
    ASSERT_EQ(nrf_swd_is_locked(&r.nrf, &locked), SWD_OK);
    ASSERT_TRUE(locked);
}

/* -----------------------------------------------------------------------
 * Erase
 * ----------------------------------------------------------------------- */

TEST(nrf_swd_erase_page_clears_the_page)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    r.target.poke(0x00010000u, 0x00000000u);
    r.target.poke(0x00010FFCu, 0x00000000u);

    ASSERT_EQ(nrf_swd_erase_page(&r.nrf, 0x00010000u), SWD_OK);
    ASSERT_EQ(r.target.peek(0x00010000u), 0xFFFFFFFFu);
    ASSERT_EQ(r.target.peek(0x00010FFCu), 0xFFFFFFFFu);
    ASSERT_EQ(r.target.nvmc_erase_violations(), 0);
}

TEST(nrf_swd_erase_page_leaves_a_neighbouring_page_alone)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    r.target.poke(0x00011000u, 0x5A5A5A5Au);

    ASSERT_EQ(nrf_swd_erase_page(&r.nrf, 0x00010000u), SWD_OK);
    ASSERT_EQ(r.target.peek(0x00011000u), 0x5A5A5A5Au);
}

TEST(nrf_swd_erase_page_returns_nvmc_to_read_only)
{
    /* Leaving NVMC in EraseEnable means the next stray write erases a page. */
    Rig r;
    nrf_swd_connect(&r.nrf);
    ASSERT_EQ(nrf_swd_erase_page(&r.nrf, 0x00010000u), SWD_OK);
    ASSERT_EQ(r.target.nvmc_config(), NRF_NVMC_CONFIG_REN);
}

TEST(nrf_swd_erase_page_rejects_an_unaligned_address)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    ASSERT_EQ(nrf_swd_erase_page(&r.nrf, 0x00010004u), SWD_ERR_ARG);
}

TEST(nrf_swd_erase_page_rejects_an_address_past_the_flash)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    ASSERT_EQ(nrf_swd_erase_page(&r.nrf, 0x00100000u), SWD_ERR_ARG);
}

TEST(nrf_swd_erase_page_waits_for_nvmc_ready)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    r.target.poke(0x00010000u, 0u);
    r.target.set_nvmc_busy_polls(5);

    ASSERT_EQ(nrf_swd_erase_page(&r.nrf, 0x00010000u), SWD_OK);
    ASSERT_EQ(r.target.peek(0x00010000u), 0xFFFFFFFFu);
    /* The erase command must not have been issued while NVMC was busy. */
    ASSERT_EQ(r.target.nvmc_busy_violations(), 0);
}

TEST(nrf_swd_write_waits_for_nvmc_ready)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    r.target.set_nvmc_busy_polls(5);

    const uint32_t src[2] = {0x0BADC0DEu, 0x0BADC0DFu};
    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x00020000u, src, 2), SWD_OK);
    ASSERT_EQ(r.target.nvmc_busy_violations(), 0);
    ASSERT_EQ(r.target.peek(0x00020000u), 0x0BADC0DEu);
    ASSERT_EQ(r.target.peek(0x00020004u), 0x0BADC0DFu);
}

TEST(nrf_swd_erase_all_clears_the_whole_flash)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    r.target.poke(0x00000000u, 0u);
    r.target.poke(0x000FFFFCu, 0u);

    ASSERT_EQ(nrf_swd_erase_all(&r.nrf), SWD_OK);
    ASSERT_EQ(r.target.peek(0x00000000u), 0xFFFFFFFFu);
    ASSERT_EQ(r.target.peek(0x000FFFFCu), 0xFFFFFFFFu);
    ASSERT_EQ(r.target.nvmc_erase_violations(), 0);
}

/* -----------------------------------------------------------------------
 * Program
 * ----------------------------------------------------------------------- */

TEST(nrf_swd_write_programs_words_into_flash)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    const uint32_t src[4] = {0x11111111u, 0x22222222u, 0x33333333u, 0x44444444u};

    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x00020000u, src, 4), SWD_OK);
    for (uint32_t i = 0; i < 4; i++) {
        ASSERT_EQ(r.target.peek(0x00020000u + i * 4u), src[i]);
    }
    ASSERT_EQ(r.target.nvmc_write_violations(), 0);
}

TEST(nrf_swd_write_enables_the_nvmc_before_programming)
{
    /* Without CONFIG=WriteEnable every word is silently discarded and the
       flash reads back erased. */
    Rig r;
    nrf_swd_connect(&r.nrf);
    const uint32_t src[1] = {0xA5A5A5A5u};

    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x00020000u, src, 1), SWD_OK);
    ASSERT_EQ(r.target.nvmc_write_violations(), 0);
    ASSERT_EQ(r.target.peek(0x00020000u), 0xA5A5A5A5u);
}

TEST(nrf_swd_write_returns_nvmc_to_read_only)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    const uint32_t src[1] = {0x1u};
    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x00020000u, src, 1), SWD_OK);
    ASSERT_EQ(r.target.nvmc_config(), NRF_NVMC_CONFIG_REN);
}

TEST(nrf_swd_write_crosses_the_1k_auto_increment_boundary)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    uint32_t src[512];
    for (uint32_t i = 0; i < 512; i++) {
        src[i] = 0xD0000000u ^ (i * 2654435761u);
    }

    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x00030000u, src, 512), SWD_OK);
    for (uint32_t i = 0; i < 512; i++) {
        ASSERT_EQ(r.target.peek(0x00030000u + i * 4u), src[i]);
    }
}

TEST(nrf_swd_write_rejects_an_unaligned_address)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    const uint32_t src[1] = {0u};
    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x00020002u, src, 1), SWD_ERR_ARG);
}

TEST(nrf_swd_write_rejects_a_run_past_the_end_of_flash)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    const uint32_t src[4] = {0u, 0u, 0u, 0u};
    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x000FFFF8u, src, 4), SWD_ERR_ARG);
}

/* -----------------------------------------------------------------------
 * Read back and verify
 * ----------------------------------------------------------------------- */

TEST(nrf_swd_verify_accepts_a_matching_image)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    const uint32_t src[4] = {0xAAu, 0xBBu, 0xCCu, 0xDDu};
    nrf_swd_write(&r.nrf, 0x00040000u, src, 4);

    ASSERT_EQ(nrf_swd_verify(&r.nrf, 0x00040000u, src, 4), SWD_OK);
}

TEST(nrf_swd_verify_rejects_a_mismatched_image)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    const uint32_t src[4] = {0xAAu, 0xBBu, 0xCCu, 0xDDu};
    nrf_swd_write(&r.nrf, 0x00040000u, src, 4);
    r.target.poke(0x00040008u, 0xDEADBEEFu);

    ASSERT_EQ(nrf_swd_verify(&r.nrf, 0x00040000u, src, 4), SWD_ERR_VERIFY);
}

TEST(nrf_swd_verify_catches_an_unerased_page)
{
    /* Programming flash can only clear bits. Writing over a word that was not
       erased first yields old AND new, which is exactly the failure a verify
       pass exists to catch. */
    Rig r;
    nrf_swd_connect(&r.nrf);
    r.target.poke(0x00050000u, 0x0F0F0F0Fu);

    const uint32_t src[1] = {0xFFFF0000u};
    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x00050000u, src, 1), SWD_OK);
    ASSERT_EQ(r.target.peek(0x00050000u), 0x0F0F0000u);
    ASSERT_EQ(nrf_swd_verify(&r.nrf, 0x00050000u, src, 1), SWD_ERR_VERIFY);
}

TEST(nrf_swd_erase_then_program_then_verify_round_trips)
{
    Rig r;
    nrf_swd_connect(&r.nrf);
    r.target.poke(0x00060000u, 0x00000000u); /* page is dirty to begin with */

    uint32_t src[1024];
    for (uint32_t i = 0; i < 1024; i++) {
        src[i] = 0xE0000000u ^ (i * 40503u);
    }

    ASSERT_EQ(nrf_swd_erase_page(&r.nrf, 0x00060000u), SWD_OK);
    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x00060000u, src, 1024), SWD_OK);
    ASSERT_EQ(nrf_swd_verify(&r.nrf, 0x00060000u, src, 1024), SWD_OK);
    ASSERT_EQ(r.target.protocol_errors(), 0);
}

/* -----------------------------------------------------------------------
 * Recovery of a locked part
 * ----------------------------------------------------------------------- */

TEST(nrf_swd_locked_part_refuses_ahb_ap_access)
{
    /* Establishes the premise for the recovery tests below. */
    Rig r;
    r.target.set_locked(true);
    uint32_t v = 0;
    ASSERT_EQ(nrf_swd_read(&r.nrf, 0x00000000u, &v, 1), SWD_ERR_FAULT);
}

/* -----------------------------------------------------------------------
 * CTRL-AP pin reset
 * ----------------------------------------------------------------------- */

TEST(nrf_swd_pin_reset_pulses_and_releases_ctrl_ap_reset)
{
    /* Leaving RESET asserted holds the part down permanently, which presents
       exactly as the dead dongle the watchdog is trying to fix. */
    Rig r;
    nrf_swd_connect(&r.nrf);

    ASSERT_EQ(nrf_swd_pin_reset(&r.nrf), SWD_OK);
    ASSERT_EQ(r.target.ctrl_ap_reset(), 0u);
    ASSERT_EQ(r.target.protocol_errors(), 0);
}

TEST(nrf_swd_pin_reset_works_while_approtect_blocks_the_ahb_ap)
{
    /* This is the case that matters. A dongle sitting in its bootloader has
       APPROTECT engaged, so the AHB-AP is unreachable and every normal
       recovery route is gone. CTRL-AP is the one that still answers, and the
       reset has to go through it. */
    Rig r;
    r.target.set_locked(true);

    uint32_t v = 0;
    ASSERT_EQ(nrf_swd_read(&r.nrf, 0x00000000u, &v, 1), SWD_ERR_FAULT);
    ASSERT_EQ(nrf_swd_pin_reset(&r.nrf), SWD_OK);
    ASSERT_EQ(r.target.ctrl_ap_reset(), 0u);
    /* A pin reset must not erase anything — the part stays locked. */
    ASSERT_TRUE(r.target.locked());
    ASSERT_EQ(r.target.eraseall_count(), 0);
}

TEST(nrf_swd_pin_reset_does_not_clear_gpregret)
{
    /* Documents the limitation the watchdog is built around: GPREGRET
       survives a pin reset, so a dongle put into DFU by the 0xB1 magic will
       come straight back to DFU. Only a real power cycle clears it. */
    Rig r;
    nrf_swd_connect(&r.nrf);
    r.target.poke(0x4000051Cu, 0x000000B1u);

    ASSERT_EQ(nrf_swd_pin_reset(&r.nrf), SWD_OK);
    ASSERT_EQ(r.target.peek(0x4000051Cu), 0x000000B1u);
}

TEST(nrf_swd_recover_unlocks_a_protected_part)
{
    Rig r;
    r.target.set_locked(true);

    ASSERT_EQ(nrf_swd_recover(&r.nrf), SWD_OK);
    ASSERT_FALSE(r.target.locked());

    bool locked = true;
    ASSERT_EQ(nrf_swd_is_locked(&r.nrf, &locked), SWD_OK);
    ASSERT_FALSE(locked);
}

TEST(nrf_swd_recover_erases_the_flash)
{
    Rig r;
    r.target.poke(0x00000000u, 0x12345678u);
    r.target.set_locked(true);

    ASSERT_EQ(nrf_swd_recover(&r.nrf), SWD_OK);
    ASSERT_EQ(r.target.eraseall_count(), 1);
    ASSERT_EQ(r.target.peek(0x00000000u), 0xFFFFFFFFu);
}

TEST(nrf_swd_recover_waits_for_eraseallstatus_to_clear)
{
    Rig r;
    r.target.set_locked(true);
    r.target.set_eraseall_busy_polls(8);

    ASSERT_EQ(nrf_swd_recover(&r.nrf), SWD_OK);
    ASSERT_FALSE(r.target.locked());
}

TEST(nrf_swd_recover_releases_the_ctrl_ap_reset_it_asserted)
{
    /* Recovery holds the core in reset while erasing. Leaving it asserted
       leaves the dongle dead in a way that looks exactly like the fault we are
       trying to fix. */
    Rig r;
    r.target.set_locked(true);

    ASSERT_EQ(nrf_swd_recover(&r.nrf), SWD_OK);
    ASSERT_EQ(r.target.ctrl_ap_reset(), 0u);
}

TEST(nrf_swd_recovered_part_can_be_programmed)
{
    Rig r;
    r.target.set_locked(true);
    ASSERT_EQ(nrf_swd_recover(&r.nrf), SWD_OK);
    ASSERT_EQ(nrf_swd_connect(&r.nrf), SWD_OK);

    const uint32_t src[2] = {0xC0FFEE00u, 0xC0FFEE01u};
    ASSERT_EQ(nrf_swd_write(&r.nrf, 0x00000000u, src, 2), SWD_OK);
    ASSERT_EQ(nrf_swd_verify(&r.nrf, 0x00000000u, src, 2), SWD_OK);
}
