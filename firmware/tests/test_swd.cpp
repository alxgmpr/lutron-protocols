/**
 * SWD line-protocol tests.
 *
 * The request bytes asserted here are the canonical ADIv5 values that every SWD
 * implementation produces — 0xA5 for a DPIDR read, 0x81 for an ABORT write, and
 * so on. They are worth pinning exactly: a wrong parity or a swapped A[2]/A[3]
 * still looks like a plausible byte, and on hardware it fails as a silent
 * FAULT rather than anything that points back here.
 */

#include "fake_swd_target.h"
#include "swd.h"
#include "test_harness.h"

/** Bind a swd_t to a fake target. */
static void attach(swd_t* s, FakeSwdTarget& t)
{
    swd_io_t io = t.io();
    swd_init(s, &io);
}

/* -----------------------------------------------------------------------
 * Request framing
 * ----------------------------------------------------------------------- */

TEST(swd_request_dp_read_dpidr_is_a5)
{
    ASSERT_EQ(swd_request_byte(false, true, 0x0), 0xA5u);
}

TEST(swd_request_dp_write_abort_is_81)
{
    ASSERT_EQ(swd_request_byte(false, false, 0x0), 0x81u);
}

TEST(swd_request_dp_read_ctrlstat_is_8d)
{
    ASSERT_EQ(swd_request_byte(false, true, 0x4), 0x8Du);
}

TEST(swd_request_dp_write_select_is_b1)
{
    ASSERT_EQ(swd_request_byte(false, false, 0x8), 0xB1u);
}

TEST(swd_request_dp_read_rdbuff_is_bd)
{
    ASSERT_EQ(swd_request_byte(false, true, 0xC), 0xBDu);
}

TEST(swd_request_ap_write_csw_is_a3)
{
    ASSERT_EQ(swd_request_byte(true, false, 0x0), 0xA3u);
}

TEST(swd_request_ap_write_tar_is_8b)
{
    ASSERT_EQ(swd_request_byte(true, false, 0x4), 0x8Bu);
}

TEST(swd_request_ap_read_drw_is_9f)
{
    ASSERT_EQ(swd_request_byte(true, true, 0xC), 0x9Fu);
}

TEST(swd_request_ap_write_drw_is_bb)
{
    ASSERT_EQ(swd_request_byte(true, false, 0xC), 0xBBu);
}

TEST(swd_request_start_stop_park_bits_are_fixed)
{
    /* Start (bit0) and park (bit7) always set, stop (bit6) always clear —
       whatever the address or direction. */
    for (unsigned a = 0; a <= 0xC; a += 4) {
        for (int ap = 0; ap <= 1; ap++) {
            for (int rw = 0; rw <= 1; rw++) {
                uint8_t r = swd_request_byte(ap != 0, rw != 0, (uint8_t)a);
                ASSERT_EQ(r & 0x01u, 0x01u);
                ASSERT_EQ(r & 0x40u, 0x00u);
                ASSERT_EQ(r & 0x80u, 0x80u);
            }
        }
    }
}

TEST(swd_request_parity_makes_four_payload_bits_even)
{
    /* Parity covers APnDP, RnW, A[2], A[3] and nothing else. */
    for (unsigned a = 0; a <= 0xC; a += 4) {
        for (int ap = 0; ap <= 1; ap++) {
            for (int rw = 0; rw <= 1; rw++) {
                uint8_t r = swd_request_byte(ap != 0, rw != 0, (uint8_t)a);
                unsigned payload = r & 0x3Eu; /* bits 1..5: APnDP, RnW, A2, A3, parity */
                ASSERT_EQ(__builtin_parity(payload), 0);
            }
        }
    }
}

/* -----------------------------------------------------------------------
 * Data parity
 * ----------------------------------------------------------------------- */

TEST(swd_data_parity_of_zero_is_zero)
{
    ASSERT_EQ(swd_data_parity(0x00000000u), 0u);
}

TEST(swd_data_parity_of_single_bit_is_one)
{
    ASSERT_EQ(swd_data_parity(0x00000001u), 1u);
    ASSERT_EQ(swd_data_parity(0x80000000u), 1u);
}

/* -----------------------------------------------------------------------
 * Transfers against the fake target
 * ----------------------------------------------------------------------- */

TEST(swd_dp_read_returns_target_dpidr)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    uint32_t id = 0;
    ASSERT_EQ(swd_dp_read(&s, SWD_DP_DPIDR, &id), SWD_OK);
    ASSERT_EQ(id, FAKE_DPIDR);
    ASSERT_EQ(t.protocol_errors(), 0);
    ASSERT_EQ(t.transfers(), 1);
}

TEST(swd_dp_write_reaches_the_target)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    ASSERT_EQ(swd_dp_write(&s, SWD_DP_CTRLSTAT, SWD_CDBGPWRUPREQ | SWD_CSYSPWRUPREQ), SWD_OK);
    uint32_t v = 0;
    ASSERT_EQ(swd_dp_read(&s, SWD_DP_CTRLSTAT, &v), SWD_OK);
    ASSERT_EQ(v & SWD_CDBGPWRUPACK, SWD_CDBGPWRUPACK);
    ASSERT_EQ(t.protocol_errors(), 0);
}

TEST(swd_transfer_drives_idle_clocks_between_transactions)
{
    /* Without trailing idle clocks the target never sees the last data bit
       clocked through. Eight is the spec minimum. */
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    uint32_t v = 0;
    swd_dp_write(&s, SWD_DP_CTRLSTAT, 0);
    swd_dp_read(&s, SWD_DP_DPIDR, &v);
    ASSERT_TRUE(t.idle_before_last_request() >= 8);
    ASSERT_EQ(t.protocol_errors(), 0);
}

TEST(swd_read_retries_through_ack_wait)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);
    t.inject_wait(3);

    uint32_t id = 0;
    ASSERT_EQ(swd_dp_read(&s, SWD_DP_DPIDR, &id), SWD_OK);
    ASSERT_EQ(id, FAKE_DPIDR);
    ASSERT_EQ(t.transfers(), 4); /* three WAITs then the real one */
    ASSERT_EQ(t.protocol_errors(), 0);
}

TEST(swd_read_gives_up_after_the_retry_budget)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);
    t.inject_wait(10000);

    uint32_t id = 0;
    ASSERT_EQ(swd_dp_read(&s, SWD_DP_DPIDR, &id), SWD_ERR_WAIT);
    ASSERT_EQ(t.transfers(), SWD_WAIT_RETRIES + 1);
    ASSERT_EQ(t.protocol_errors(), 0);
}

TEST(swd_write_retries_through_ack_wait)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);
    t.inject_wait(2);

    ASSERT_EQ(swd_dp_write(&s, SWD_DP_CTRLSTAT, SWD_CDBGPWRUPREQ), SWD_OK);
    uint32_t v = 0;
    swd_dp_read(&s, SWD_DP_CTRLSTAT, &v);
    ASSERT_EQ(v & SWD_CDBGPWRUPREQ, SWD_CDBGPWRUPREQ);
    ASSERT_EQ(t.protocol_errors(), 0);
}

TEST(swd_fault_is_reported_to_the_caller)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);
    t.inject_fault(1);

    uint32_t id = 0;
    ASSERT_EQ(swd_dp_read(&s, SWD_DP_DPIDR, &id), SWD_ERR_FAULT);
    ASSERT_EQ(t.protocol_errors(), 0);
}

TEST(swd_fault_clears_the_sticky_error_so_the_link_recovers)
{
    /* A latched STICKYERR faults every subsequent AP access until ABORT clears
       it. If the fault path forgets the ABORT, the link is wedged from here on
       and the next failure looks unrelated. */
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);
    t.inject_fault(1);

    uint32_t v = 0;
    ASSERT_EQ(swd_ap_read(&s, 0, SWD_AP_IDR, &v), SWD_ERR_FAULT);
    /* The very next AP access must go through again. */
    ASSERT_EQ(swd_ap_read(&s, 0, SWD_AP_IDR, &v), SWD_OK);
    ASSERT_EQ(v, FAKE_AHB_AP_IDR);
}

TEST(swd_read_data_parity_error_is_detected)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);
    t.inject_read_parity_error();

    uint32_t id = 0;
    ASSERT_EQ(swd_dp_read(&s, SWD_DP_DPIDR, &id), SWD_ERR_PARITY);
    ASSERT_EQ(t.protocol_errors(), 0);
}

TEST(swd_absent_target_reports_no_ack)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);
    t.set_present(false);

    uint32_t id = 0;
    ASSERT_EQ(swd_dp_read(&s, SWD_DP_DPIDR, &id), SWD_ERR_NO_ACK);
}

/* -----------------------------------------------------------------------
 * Connection sequence
 * ----------------------------------------------------------------------- */

TEST(swd_connect_performs_the_jtag_to_swd_switch)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    uint32_t id = 0;
    ASSERT_EQ(swd_connect(&s, &id), SWD_OK);
    ASSERT_EQ(id, FAKE_DPIDR);
    ASSERT_EQ(t.jtag_to_swd_sequences(), 1);
    /* A line reset on each side of the switch sequence. */
    ASSERT_TRUE(t.line_resets() >= 2);
    ASSERT_EQ(t.protocol_errors(), 0);
}

TEST(swd_connect_fails_cleanly_when_nothing_answers)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);
    t.set_present(false);

    uint32_t id = 0;
    ASSERT_EQ(swd_connect(&s, &id), SWD_ERR_NO_ACK);
}

TEST(swd_power_up_raises_both_domains)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    uint32_t id = 0;
    ASSERT_EQ(swd_connect(&s, &id), SWD_OK);
    ASSERT_EQ(swd_power_up(&s), SWD_OK);
    ASSERT_TRUE(t.debug_powered());
    ASSERT_EQ(t.protocol_errors(), 0);
}

/* -----------------------------------------------------------------------
 * AP access and SELECT banking
 * ----------------------------------------------------------------------- */

TEST(swd_ap_read_returns_the_posted_value_not_the_stale_one)
{
    /* AP reads are posted one transfer behind. Returning the data phase
       directly yields the *previous* read's value — which is the classic way
       this layer silently reads garbage. */
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    ASSERT_EQ(swd_ap_write(&s, 0, SWD_AP_TAR, 0x20001234u), SWD_OK);
    uint32_t v = 0;
    ASSERT_EQ(swd_ap_read(&s, 0, SWD_AP_TAR, &v), SWD_OK);
    ASSERT_EQ(v, 0x20001234u);
    ASSERT_EQ(t.protocol_errors(), 0);
}

TEST(swd_ap_read_of_a_high_bank_register_selects_the_bank)
{
    /* IDR lives at AP offset 0xFC, which needs SELECT.APBANKSEL = 0xF. */
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    uint32_t v = 0;
    ASSERT_EQ(swd_ap_read(&s, 0, SWD_AP_IDR, &v), SWD_OK);
    ASSERT_EQ(v, FAKE_AHB_AP_IDR);
}

TEST(swd_ap_read_of_ctrl_ap_selects_the_second_ap)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    uint32_t v = 0;
    ASSERT_EQ(swd_ap_read(&s, 1, SWD_AP_IDR, &v), SWD_OK);
    ASSERT_EQ(v, FAKE_CTRL_AP_IDR);
}

TEST(swd_select_is_written_once_for_accesses_in_the_same_bank)
{
    /* Rewriting SELECT before every transfer doubles the wire traffic of a
       flash write loop for no benefit. */
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    swd_ap_write(&s, 0, SWD_AP_TAR, 0x20000000u);
    swd_ap_write(&s, 0, SWD_AP_DRW, 0xAABBCCDDu);
    swd_ap_write(&s, 0, SWD_AP_DRW, 0x11223344u);
    ASSERT_EQ(t.select_writes(), 1);
}

TEST(swd_select_is_rewritten_when_the_bank_changes)
{
    FakeSwdTarget t;
    swd_t s;
    attach(&s, t);

    uint32_t v = 0;
    swd_ap_write(&s, 0, SWD_AP_TAR, 0x20000000u); /* bank 0 */
    swd_ap_read(&s, 0, SWD_AP_IDR, &v);           /* bank 0xF */
    swd_ap_write(&s, 0, SWD_AP_TAR, 0x20000004u); /* bank 0 again */
    ASSERT_EQ(t.select_writes(), 3);
}

TEST(swd_data_parity_counts_all_thirtytwo_bits)
{
    ASSERT_EQ(swd_data_parity(0xFFFFFFFFu), 0u); /* 32 set bits */
    ASSERT_EQ(swd_data_parity(0x7FFFFFFFu), 1u); /* 31 set bits */
    /* nRF52840 DPIDR: 14 set bits, so even. */
    ASSERT_EQ(swd_data_parity(0x2BA01477u), 0u);
    /* AHB-AP IDR for the same part: 0x24770011, 10 set bits, so even. */
    ASSERT_EQ(swd_data_parity(0x24770011u), 0u);
    /* One bit off from the DPIDR above: 13 set bits, so odd. */
    ASSERT_EQ(swd_data_parity(0x2BA01475u), 1u);
}
