/**
 * AHB-AP memory access tests.
 *
 * The interesting behaviour here is not "can it read a word" — it is the two
 * places a MEM-AP quietly does the wrong thing: the posted-read pipeline (see
 * test_swd.cpp) and auto-increment, which stops at every 1 KB boundary. A block
 * transfer that ignores the boundary keeps hammering the same address and the
 * result looks like plausible data, not an error.
 */

#include "fake_swd_target.h"
#include "swd.h"
#include "swd_mem.h"
#include "test_harness.h"

namespace {

struct Rig {
    FakeSwdTarget target;
    swd_t swd;
    swd_mem_t mem;

    Rig()
    {
        swd_io_t io = target.io();
        swd_init(&swd, &io);
        swd_mem_init(&mem, &swd, SWD_AHB_AP);
    }
};

} // namespace

/* -----------------------------------------------------------------------
 * Single-word access
 * ----------------------------------------------------------------------- */

TEST(swd_mem_read32_returns_the_word_at_the_address)
{
    Rig r;
    r.target.poke(0x20000100u, 0xDEADBEEFu);

    uint32_t v = 0;
    ASSERT_EQ(swd_mem_read32(&r.mem, 0x20000100u, &v), SWD_OK);
    ASSERT_EQ(v, 0xDEADBEEFu);
    ASSERT_EQ(r.target.protocol_errors(), 0);
}

TEST(swd_mem_write32_lands_at_the_address)
{
    Rig r;
    ASSERT_EQ(swd_mem_write32(&r.mem, 0x20000200u, 0xCAFEF00Du), SWD_OK);
    ASSERT_EQ(r.target.peek(0x20000200u), 0xCAFEF00Du);
    ASSERT_EQ(r.target.protocol_errors(), 0);
}

TEST(swd_mem_access_configures_csw_for_word_transfers)
{
    Rig r;
    uint32_t v = 0;
    swd_mem_read32(&r.mem, 0x20000000u, &v);

    uint32_t csw = r.target.ap_csw();
    ASSERT_EQ(csw & SWD_CSW_SIZE_MASK, SWD_CSW_SIZE_32);
    ASSERT_EQ(csw & SWD_CSW_ADDRINC_MASK, SWD_CSW_ADDRINC_SINGLE);
    /* Debug master + HPROT1, or the AHB access is refused on some parts. */
    ASSERT_EQ(csw & SWD_CSW_PROT_BITS, SWD_CSW_PROT_BITS);
}

TEST(swd_mem_rejects_an_unaligned_address)
{
    Rig r;
    uint32_t v = 0;
    ASSERT_EQ(swd_mem_read32(&r.mem, 0x20000002u, &v), SWD_ERR_ARG);
    ASSERT_EQ(swd_mem_write32(&r.mem, 0x20000001u, 0), SWD_ERR_ARG);
}

TEST(swd_mem_read_propagates_a_fault)
{
    Rig r;
    r.target.inject_fault(1);

    uint32_t v = 0;
    ASSERT_EQ(swd_mem_read32(&r.mem, 0x20000000u, &v), SWD_ERR_FAULT);
}

TEST(swd_mem_read_survives_ack_wait)
{
    Rig r;
    r.target.poke(0x20000300u, 0x12345678u);
    r.target.inject_wait(5);

    uint32_t v = 0;
    ASSERT_EQ(swd_mem_read32(&r.mem, 0x20000300u, &v), SWD_OK);
    ASSERT_EQ(v, 0x12345678u);
}

/* -----------------------------------------------------------------------
 * Block transfers and the 1 KB auto-increment boundary
 * ----------------------------------------------------------------------- */

TEST(swd_mem_read_block_returns_consecutive_words)
{
    Rig r;
    for (uint32_t i = 0; i < 8; i++) {
        r.target.poke(0x20000000u + i * 4u, 0x1000u + i);
    }

    uint32_t buf[8] = {0};
    ASSERT_EQ(swd_mem_read_block(&r.mem, 0x20000000u, buf, 8), SWD_OK);
    for (uint32_t i = 0; i < 8; i++) {
        ASSERT_EQ(buf[i], 0x1000u + i);
    }
    ASSERT_EQ(r.target.protocol_errors(), 0);
}

TEST(swd_mem_read_block_uses_auto_increment_rather_than_retargeting)
{
    /* One TAR write for the whole run — that is the entire point of AddrInc. */
    Rig r;
    uint32_t buf[16] = {0};
    ASSERT_EQ(swd_mem_read_block(&r.mem, 0x20000000u, buf, 16), SWD_OK);
    ASSERT_EQ(r.target.tar_writes(), 1);
}

TEST(swd_mem_read_block_rewrites_tar_at_the_1k_boundary)
{
    /* AddrInc=single wraps within a 1 KB window. A block that ignores this
       re-reads the last word of the window over and over. */
    Rig r;
    const uint32_t base = 0x200003F8u; /* two words below the 0x...400 boundary */
    for (uint32_t i = 0; i < 4; i++) {
        r.target.poke(base + i * 4u, 0xA0000000u + i);
    }

    uint32_t buf[4] = {0};
    ASSERT_EQ(swd_mem_read_block(&r.mem, base, buf, 4), SWD_OK);
    ASSERT_EQ(buf[0], 0xA0000000u);
    ASSERT_EQ(buf[1], 0xA0000001u);
    ASSERT_EQ(buf[2], 0xA0000002u);
    ASSERT_EQ(buf[3], 0xA0000003u);
    ASSERT_EQ(r.target.tar_writes(), 2);
}

TEST(swd_mem_write_block_rewrites_tar_at_the_1k_boundary)
{
    Rig r;
    const uint32_t base = 0x200007F8u;
    const uint32_t src[4] = {0xB0000000u, 0xB0000001u, 0xB0000002u, 0xB0000003u};

    ASSERT_EQ(swd_mem_write_block(&r.mem, base, src, 4), SWD_OK);
    for (uint32_t i = 0; i < 4; i++) {
        ASSERT_EQ(r.target.peek(base + i * 4u), src[i]);
    }
    ASSERT_EQ(r.target.tar_writes(), 2);
}

TEST(swd_mem_write_block_then_read_block_roundtrips_across_boundaries)
{
    /* A full page-sized round trip — four 1 KB windows. */
    Rig r;
    uint32_t src[1024];
    for (uint32_t i = 0; i < 1024; i++) {
        src[i] = 0xC0000000u ^ (i * 2654435761u);
    }

    ASSERT_EQ(swd_mem_write_block(&r.mem, 0x20001000u, src, 1024), SWD_OK);

    uint32_t back[1024] = {0};
    ASSERT_EQ(swd_mem_read_block(&r.mem, 0x20001000u, back, 1024), SWD_OK);
    ASSERT_MEM_EQ(src, back, sizeof(src));
    ASSERT_EQ(r.target.protocol_errors(), 0);
}

TEST(swd_mem_block_rejects_an_unaligned_base)
{
    Rig r;
    uint32_t buf[2] = {0};
    ASSERT_EQ(swd_mem_read_block(&r.mem, 0x20000002u, buf, 2), SWD_ERR_ARG);
}

TEST(swd_mem_block_of_zero_words_is_a_no_op)
{
    Rig r;
    uint32_t buf[1] = {0};
    ASSERT_EQ(swd_mem_read_block(&r.mem, 0x20000000u, buf, 0), SWD_OK);
    ASSERT_EQ(r.target.transfers(), 0);
}

/* -----------------------------------------------------------------------
 * AP identification
 * ----------------------------------------------------------------------- */

TEST(swd_mem_idr_identifies_the_ahb_ap)
{
    Rig r;
    uint32_t idr = 0;
    ASSERT_EQ(swd_mem_read_idr(&r.mem, &idr), SWD_OK);
    ASSERT_EQ(idr, FAKE_AHB_AP_IDR);
}

/* -----------------------------------------------------------------------
 * Cortex-M core debug
 * ----------------------------------------------------------------------- */

TEST(swd_core_halt_halts_the_target)
{
    Rig r;
    ASSERT_FALSE(r.target.core_halted());
    ASSERT_EQ(swd_core_halt(&r.mem), SWD_OK);
    ASSERT_TRUE(r.target.core_halted());
}

TEST(swd_core_halt_uses_the_debug_key)
{
    /* DHCSR ignores any write whose top half is not 0xA05F. Without the key
       the halt silently does nothing and the core keeps running through the
       flash operation. */
    Rig r;
    swd_core_halt(&r.mem);
    uint32_t dhcsr = 0;
    ASSERT_EQ(swd_mem_read32(&r.mem, SWD_DHCSR, &dhcsr), SWD_OK);
    ASSERT_EQ(dhcsr & SWD_DHCSR_C_DEBUGEN, SWD_DHCSR_C_DEBUGEN);
    ASSERT_EQ(dhcsr & SWD_DHCSR_C_HALT, SWD_DHCSR_C_HALT);
}

TEST(swd_core_resume_releases_the_target)
{
    Rig r;
    swd_core_halt(&r.mem);
    ASSERT_EQ(swd_core_resume(&r.mem), SWD_OK);
    ASSERT_FALSE(r.target.core_halted());
}

TEST(swd_core_sysreset_requests_a_system_reset)
{
    Rig r;
    ASSERT_EQ(r.target.sysresets(), 0);
    ASSERT_EQ(swd_core_sysreset(&r.mem), SWD_OK);
    ASSERT_EQ(r.target.sysresets(), 1);
}
