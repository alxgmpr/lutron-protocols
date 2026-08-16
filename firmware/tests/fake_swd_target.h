#ifndef FAKE_SWD_TARGET_H
#define FAKE_SWD_TARGET_H

/**
 * A fake nRF52840 SW-DP that speaks the real SWD line protocol, one bit at a
 * time, through the same swd_io_t the GPIO backend implements.
 *
 * It is deliberately not a mock of swd.c's calls. It decodes the bit stream:
 * request framing, start/stop/park, request parity, turnaround placement, ACK
 * bit order, and data parity. A host that gets any of those wrong fails here
 * rather than on the bench, which is the entire point of building it.
 *
 * What it models:
 *   - DP: DPIDR, ABORT (sticky-error clear), CTRL/STAT with the power-up
 *     handshake, SELECT (APSEL/APBANKSEL), RDBUFF, and posted AP reads
 *   - AP0: AHB-AP (CSW/TAR/DRW with auto-increment, IDR)
 *   - AP1: nRF CTRL-AP (RESET, ERASEALL, ERASEALLSTATUS, APPROTECTSTATUS, IDR)
 *   - Memory: flash (erased 0xFF, program only clears bits, gated on NVMC
 *     CONFIG), UICR, RAM, the NVMC peripheral, and the ARM core debug registers
 *   - APPROTECT: when locked, AHB-AP transfers fault and only CTRL-AP answers
 *
 * Fault injection: ACK WAIT runs, ACK FAULT with a real sticky-error latch,
 * corrupted read parity, and a slow NVMC that reports not-ready for N polls.
 */

#include "swd.h"

#include <cstdint>
#include <map>

/* ---- nRF52840 / ADIv5 constants the fake reproduces ---------------------- */
#define FAKE_DPIDR 0x2BA01477u
#define FAKE_AHB_AP_IDR 0x24770011u
#define FAKE_CTRL_AP_IDR 0x02880000u

#define FAKE_FLASH_BASE 0x00000000u
#define FAKE_FLASH_SIZE 0x00100000u /* 1 MB */
#define FAKE_FLASH_PAGE 0x1000u     /* 4 KB */
#define FAKE_UICR_BASE 0x10001000u
#define FAKE_UICR_SIZE 0x00000400u
#define FAKE_RAM_BASE 0x20000000u
#define FAKE_RAM_SIZE 0x00040000u
#define FAKE_NVMC_BASE 0x4001E000u

class FakeSwdTarget {
public:
    FakeSwdTarget() { reset_all(); }

    /** Transport handle to hand to swd_init(). */
    swd_io_t io()
    {
        swd_io_t t;
        t.clock_out = &FakeSwdTarget::s_clock_out;
        t.clock_in = &FakeSwdTarget::s_clock_in;
        t.set_output = &FakeSwdTarget::s_set_output;
        t.ctx = this;
        return t;
    }

    /* ---- fault injection ---- */

    /** Answer the next @p n transfers with ACK WAIT. */
    void inject_wait(int n) { wait_left_ = n; }
    /** Answer the next @p n transfers with ACK FAULT (and latch STICKYERR). */
    void inject_fault(int n) { fault_left_ = n; }
    /** Flip the parity bit of the next read data phase. */
    void inject_read_parity_error() { corrupt_parity_ = true; }
    /** Stop responding entirely — models an absent or unpowered target. */
    void set_present(bool present) { present_ = present; }
    /** APPROTECT: locked means the AHB-AP faults and only CTRL-AP answers. */
    void set_locked(bool locked) { locked_ = locked; }
    /** NVMC READY reads 0 for the next @p n polls. */
    void set_nvmc_busy_polls(int n) { nvmc_busy_ = n; }
    /** ERASEALLSTATUS reads busy for @p n polls after ERASEALL is triggered. */
    void set_eraseall_busy_polls(int n) { eraseall_poll_reload_ = n; }

    /* ---- observation ---- */

    int line_resets() const { return line_resets_; }
    int jtag_to_swd_sequences() const { return jtag_to_swd_; }
    int protocol_errors() const { return protocol_errors_; }
    int transfers() const { return transfers_; }
    /** Idle low clocks the host drove immediately before the last request. */
    int idle_before_last_request() const { return idle_before_request_; }
    /** Writes to flash attempted without NVMC CONFIG=WriteEnable. */
    int nvmc_write_violations() const { return nvmc_write_violations_; }
    /** Page erases attempted without NVMC CONFIG=EraseEnable. */
    int nvmc_erase_violations() const { return nvmc_erase_violations_; }
    int eraseall_count() const { return eraseall_count_; }
    /** DP SELECT writes seen — pins that banking is cached, not rewritten. */
    int select_writes() const { return select_writes_; }
    bool locked() const { return locked_; }
    bool core_halted() const { return (dhcsr_ & 0x2u) != 0; }
    int sysresets() const { return sysresets_; }
    uint32_t ctrl_ap_reset() const { return ctrlap_reset_; }
    bool debug_powered() const { return (ctrl_stat_ & 0xF0000000u) == 0xF0000000u; }

    /** Backdoor read, bypassing the wire — for arranging and asserting state. */
    uint32_t peek(uint32_t addr) const
    {
        auto it = mem_.find(addr & ~3u);
        return it == mem_.end() ? default_word(addr) : it->second;
    }
    /** Backdoor write, bypassing NVMC rules. */
    void poke(uint32_t addr, uint32_t val) { mem_[addr & ~3u] = val; }

    void reset_all()
    {
        mem_.clear();
        phase_ = PH_IDLE;
        host_drives_ = true;
        bit_i_ = 0;
        req_ = 0;
        collecting_ = false;
        suppressed_ = false;
        ones_run_ = 0;
        zeros_run_ = 0;
        idle_before_ = 0;
        idle_before_request_ = 0;
        switch_shift_ = 0;
        shifted_ = 0;
        line_resets_ = 0;
        jtag_to_swd_ = 0;
        protocol_errors_ = 0;
        transfers_ = 0;
        pending_write_ = false;
        wait_left_ = 0;
        fault_left_ = 0;
        corrupt_parity_ = false;
        present_ = true;
        locked_ = false;
        nvmc_busy_ = 0;
        nvmc_write_violations_ = 0;
        nvmc_erase_violations_ = 0;
        eraseall_count_ = 0;
        select_writes_ = 0;
        eraseall_poll_reload_ = 0;
        eraseall_polls_ = 0;
        sysresets_ = 0;
        ctrl_stat_ = 0;
        select_ = 0;
        posted_ = 0;
        ap_csw_ = 0;
        ap_tar_ = 0;
        nvmc_config_ = 0;
        ctrlap_reset_ = 0;
        dhcsr_ = 0;
        demcr_ = 0;
    }

private:
    /* -------------------------------------------------------------------
     * Transport plumbing
     * ------------------------------------------------------------------- */
    static void s_clock_out(void* ctx, bool b) { static_cast<FakeSwdTarget*>(ctx)->clock_out(b); }
    static bool s_clock_in(void* ctx) { return static_cast<FakeSwdTarget*>(ctx)->clock_in(); }
    static void s_set_output(void* ctx, bool o)
    {
        static_cast<FakeSwdTarget*>(ctx)->set_output(o);
    }

    enum Phase {
        PH_IDLE,   /* host drives; watching for a request or a line reset */
        PH_TRN1,   /* one turnaround clock, nobody drives */
        PH_ACK,    /* target drives 3 ACK bits */
        PH_RDATA,  /* target drives 32 data bits + parity */
        PH_TRN2,   /* turnaround back to the host */
        PH_WDATA,  /* host drives 32 data bits + parity */
    };

    void set_output(bool host_drives) { host_drives_ = host_drives; }

    void clock_out(bool bit)
    {
        if (!host_drives_) {
            protocol_errors_++; /* drove the line while released */
            return;
        }
        switch (phase_) {
        case PH_IDLE:
            idle_bit(bit);
            break;
        case PH_WDATA:
            wdata_bit(bit);
            break;
        default:
            protocol_errors_++; /* host drove during a target-driven phase */
            break;
        }
    }

    bool clock_in()
    {
        if (host_drives_) {
            protocol_errors_++; /* sampled the line while still driving it */
            return true;
        }
        switch (phase_) {
        case PH_TRN1:
            phase_ = PH_ACK;
            bit_i_ = 0;
            return true; /* undriven: reads as the bus pull-up */
        case PH_ACK:
            return ack_bit();
        case PH_RDATA:
            return rdata_bit();
        case PH_TRN2:
            if (pending_write_) {
                pending_write_ = false;
                phase_ = PH_WDATA;
                bit_i_ = 0;
                wdata_ = 0;
            } else {
                go_idle();
            }
            return true;
        default:
            /* No transaction in flight — an undriven line reads high. */
            return true;
        }
    }

    /* -------------------------------------------------------------------
     * Idle phase: request framing and connection sequences
     * ------------------------------------------------------------------- */
    void go_idle()
    {
        phase_ = PH_IDLE;
        collecting_ = false;
        suppressed_ = false;
        ones_run_ = 0;
        zeros_run_ = 0;
    }

    void idle_bit(bool bit)
    {
        /* JTAG-to-SWD switch sequence, LSB-first on the wire. */
        switch_shift_ = (uint16_t)((switch_shift_ >> 1) | ((bit ? 1u : 0u) << 15));
        if (switch_shift_ == 0xE79Eu) {
            jtag_to_swd_++;
        }

        if (bit) {
            ones_run_++;
            if (ones_run_ == 50) {
                line_resets_++;
            }
        }

        if (collecting_) {
            req_ |= (uint32_t)(bit ? 1u : 0u) << shifted_;
            shifted_++;
            if (shifted_ == 8) {
                collecting_ = false;
                if (!decode_request((uint8_t)req_)) {
                    /* Not a well-formed request. Ignore bits until the next 0,
                       which is what keeps a 50-cycle line reset from being
                       mistaken for a run of requests. */
                    suppressed_ = true;
                }
            }
        } else if (suppressed_) {
            if (!bit) {
                suppressed_ = false;
            }
        } else if (bit) {
            /* A request starts on the first 1 after a run of idle zeros. */
            collecting_ = true;
            req_ = 1u;
            shifted_ = 1;
            idle_before_ = zeros_run_;
        }

        if (bit) {
            zeros_run_ = 0;
        } else {
            ones_run_ = 0;
            zeros_run_++;
        }
    }

    /** @return true if the byte is a valid request and a transaction started. */
    bool decode_request(uint8_t r)
    {
        if ((r & 0x01u) == 0 || (r & 0x40u) != 0 || (r & 0x80u) == 0) {
            return false; /* start / stop / park */
        }
        if (__builtin_parity((unsigned)(r & 0x3Eu)) != 0) {
            return false; /* request parity */
        }

        req_ap_ = (r & 0x02u) != 0;
        req_rnw_ = (r & 0x04u) != 0;
        req_addr_ = (uint8_t)(((r >> 3) & 1u) << 2 | ((r >> 4) & 1u) << 3);

        if (!present_) {
            /* Nothing drives the line; the host will read 0b111 as the ACK. */
            return false;
        }

        transfers_++;
        idle_before_request_ = idle_before_;
        ack_ = decide_ack();
        if (ack_ == SWD_ACK_OK && req_rnw_) {
            rdata_ = do_read();
        }
        phase_ = PH_TRN1;
        return true;
    }

    uint32_t decide_ack()
    {
        if (wait_left_ > 0) {
            wait_left_--;
            return SWD_ACK_WAIT;
        }
        if (fault_left_ > 0) {
            fault_left_--;
            ctrl_stat_ |= (1u << 5); /* STICKYERR */
            return SWD_ACK_FAULT;
        }
        /* A latched sticky error faults every AP access until ABORT clears it. */
        if (req_ap_ && (ctrl_stat_ & (1u << 5))) {
            return SWD_ACK_FAULT;
        }
        /* With APPROTECT engaged the AHB-AP is not accessible; CTRL-AP is. */
        if (req_ap_ && locked_ && apsel() == 0) {
            ctrl_stat_ |= (1u << 5);
            return SWD_ACK_FAULT;
        }
        return SWD_ACK_OK;
    }

    /* -------------------------------------------------------------------
     * ACK / data phases
     * ------------------------------------------------------------------- */
    bool ack_bit()
    {
        bool b = ((ack_ >> bit_i_) & 1u) != 0;
        bit_i_++;
        if (bit_i_ == 3) {
            if (ack_ == SWD_ACK_OK && req_rnw_) {
                phase_ = PH_RDATA;
                bit_i_ = 0;
            } else {
                /* A write turns the line around after the ACK and the host then
                   drives the data phase. A non-OK ACK has no data phase at all. */
                pending_write_ = (ack_ == SWD_ACK_OK);
                phase_ = PH_TRN2;
            }
        }
        return b;
    }

    bool rdata_bit()
    {
        bool b;
        if (bit_i_ < 32) {
            b = ((rdata_ >> bit_i_) & 1u) != 0;
        } else {
            b = swd_data_parity(rdata_) != 0;
            if (corrupt_parity_) {
                b = !b;
                corrupt_parity_ = false;
            }
        }
        bit_i_++;
        if (bit_i_ == 33) {
            phase_ = PH_TRN2;
        }
        return b;
    }

    void wdata_bit(bool bit)
    {
        if (bit_i_ < 32) {
            wdata_ |= (uint32_t)(bit ? 1u : 0u) << bit_i_;
            bit_i_++;
            return;
        }
        bit_i_++;
        if (swd_data_parity(wdata_) != (bit ? 1u : 0u)) {
            protocol_errors_++; /* host sent bad data parity */
        } else {
            do_write(wdata_);
        }
        go_idle();
    }

    /* -------------------------------------------------------------------
     * Register model
     * ------------------------------------------------------------------- */
    uint8_t apsel() const { return (uint8_t)((select_ >> 24) & 0xFFu); }
    uint8_t ap_reg() const { return (uint8_t)((select_ & 0xF0u) | (req_addr_ & 0x0Cu)); }

    uint32_t do_read()
    {
        if (!req_ap_) {
            switch (req_addr_) {
            case 0x0:
                return FAKE_DPIDR;
            case 0x4:
                return ctrl_stat_read();
            case 0x8:
                return posted_; /* RESEND */
            case 0xC:
                return posted_; /* RDBUFF */
            default:
                return 0;
            }
        }
        /* AP reads are posted: the data phase returns the previous result and
           the value just fetched lands in RDBUFF. */
        uint32_t prev = posted_;
        posted_ = ap_read_value();
        return prev;
    }

    uint32_t ctrl_stat_read()
    {
        uint32_t v = ctrl_stat_;
        /* Power-up handshake: each REQ raises its matching ACK. */
        if (v & (1u << 28)) {
            v |= (1u << 29);
        }
        if (v & (1u << 30)) {
            v |= (1u << 31);
        }
        ctrl_stat_ = v;
        return v;
    }

    uint32_t ap_read_value()
    {
        uint8_t reg = ap_reg();
        if (apsel() == 0) {
            switch (reg) {
            case 0x00:
                return ap_csw_;
            case 0x04:
                return ap_tar_;
            case 0x0C: {
                uint32_t v = mem_load(ap_tar_);
                bump_tar();
                return v;
            }
            case 0xFC:
                return FAKE_AHB_AP_IDR;
            default:
                return 0;
            }
        }
        if (apsel() == 1) {
            switch (reg) {
            case 0x00:
                return ctrlap_reset_;
            case 0x08: /* ERASEALLSTATUS: 1 while erasing */
                if (eraseall_polls_ > 0) {
                    eraseall_polls_--;
                    return 1;
                }
                return 0;
            case 0x0C: /* APPROTECTSTATUS: bit0 set means not protected */
                return locked_ ? 0u : 1u;
            case 0xFC:
                return FAKE_CTRL_AP_IDR;
            default:
                return 0;
            }
        }
        return 0;
    }

    void do_write(uint32_t v)
    {
        if (!req_ap_) {
            switch (req_addr_) {
            case 0x0: /* ABORT */
                if (v & (1u << 2)) {
                    ctrl_stat_ &= ~(1u << 5); /* STKERRCLR */
                }
                if (v & (1u << 4)) {
                    ctrl_stat_ &= ~(1u << 1); /* ORUNERRCLR */
                }
                break;
            case 0x4:
                /* Only the request/enable bits are writable. */
                ctrl_stat_ = (ctrl_stat_ & 0x000000FFu) | (v & 0xF0000000u);
                break;
            case 0x8:
                select_ = v;
                select_writes_++;
                break;
            default:
                break;
            }
            return;
        }

        uint8_t reg = ap_reg();
        if (apsel() == 0) {
            switch (reg) {
            case 0x00:
                ap_csw_ = v;
                break;
            case 0x04:
                ap_tar_ = v;
                break;
            case 0x0C:
                mem_store(ap_tar_, v);
                bump_tar();
                break;
            default:
                break;
            }
            return;
        }
        if (apsel() == 1) {
            switch (reg) {
            case 0x00:
                ctrlap_reset_ = v;
                break;
            case 0x04:
                if (v & 1u) {
                    eraseall_count_++;
                    eraseall_polls_ = eraseall_poll_reload_;
                    erase_range(FAKE_FLASH_BASE, FAKE_FLASH_SIZE);
                    erase_range(FAKE_UICR_BASE, FAKE_UICR_SIZE);
                    locked_ = false;
                    ctrl_stat_ &= ~(1u << 5);
                }
                break;
            default:
                break;
            }
        }
    }

    /** AddrInc=single steps TAR by 4, but never across a 1 KB boundary. */
    void bump_tar()
    {
        if (((ap_csw_ >> 4) & 3u) != 1u) {
            return;
        }
        uint32_t next = ap_tar_ + 4u;
        if ((next & ~0x3FFu) != (ap_tar_ & ~0x3FFu)) {
            return; /* wraps within the 1 KB window on real hardware */
        }
        ap_tar_ = next;
    }

    /* -------------------------------------------------------------------
     * Memory / peripheral model
     * ------------------------------------------------------------------- */
    static bool in_flash(uint32_t a) { return a < FAKE_FLASH_BASE + FAKE_FLASH_SIZE; }
    static bool in_uicr(uint32_t a)
    {
        return a >= FAKE_UICR_BASE && a < FAKE_UICR_BASE + FAKE_UICR_SIZE;
    }
    static bool in_nvmc(uint32_t a) { return a >= FAKE_NVMC_BASE && a < FAKE_NVMC_BASE + 0x1000u; }

    static uint32_t default_word(uint32_t a)
    {
        return (in_flash(a) || in_uicr(a)) ? 0xFFFFFFFFu : 0x00000000u;
    }

    uint32_t mem_load(uint32_t addr)
    {
        addr &= ~3u;
        if (in_nvmc(addr)) {
            switch (addr - FAKE_NVMC_BASE) {
            case 0x400: /* READY */
                if (nvmc_busy_ > 0) {
                    nvmc_busy_--;
                    return 0;
                }
                return 1;
            case 0x408: /* READYNEXT */
                return 1;
            case 0x504:
                return nvmc_config_;
            default:
                return 0;
            }
        }
        if (addr == 0xE000EDF0u) {
            return dhcsr_;
        }
        if (addr == 0xE000EDFCu) {
            return demcr_;
        }
        auto it = mem_.find(addr);
        return it == mem_.end() ? default_word(addr) : it->second;
    }

    void mem_store(uint32_t addr, uint32_t v)
    {
        addr &= ~3u;
        if (in_nvmc(addr)) {
            nvmc_store(addr - FAKE_NVMC_BASE, v);
            return;
        }
        if (addr == 0xE000EDF0u) { /* DHCSR */
            if ((v >> 16) == 0xA05Fu) {
                dhcsr_ = (dhcsr_ & 0xFFFF0000u) | (v & 0xFFFFu);
            }
            return;
        }
        if (addr == 0xE000EDFCu) {
            demcr_ = v;
            return;
        }
        if (addr == 0xE000ED0Cu) { /* AIRCR */
            if ((v >> 16) == 0x05FAu && (v & 0x4u)) {
                sysresets_++;
            }
            return;
        }
        if (in_flash(addr) || in_uicr(addr)) {
            if (nvmc_config_ != 1u) {
                nvmc_write_violations_++;
                return; /* NVMC not in WriteEnable — the write is dropped */
            }
            /* Programming flash can only clear bits. */
            uint32_t old = mem_.count(addr) ? mem_[addr] : 0xFFFFFFFFu;
            mem_[addr] = old & v;
            return;
        }
        mem_[addr] = v;
    }

    void nvmc_store(uint32_t off, uint32_t v)
    {
        switch (off) {
        case 0x504: /* CONFIG */
            nvmc_config_ = v & 3u;
            break;
        case 0x508: /* ERASEPAGE */
            if (nvmc_config_ != 2u) {
                nvmc_erase_violations_++;
                break;
            }
            erase_range(v & ~(FAKE_FLASH_PAGE - 1u), FAKE_FLASH_PAGE);
            break;
        case 0x50C: /* ERASEALL */
            if (v & 1u) {
                if (nvmc_config_ != 2u) {
                    nvmc_erase_violations_++;
                    break;
                }
                erase_range(FAKE_FLASH_BASE, FAKE_FLASH_SIZE);
            }
            break;
        case 0x514: /* ERASEUICR */
            if (v & 1u) {
                if (nvmc_config_ != 2u) {
                    nvmc_erase_violations_++;
                    break;
                }
                erase_range(FAKE_UICR_BASE, FAKE_UICR_SIZE);
            }
            break;
        default:
            break;
        }
    }

    void erase_range(uint32_t base, uint32_t len)
    {
        auto it = mem_.lower_bound(base);
        while (it != mem_.end() && it->first < base + len) {
            it = mem_.erase(it);
        }
    }

    /* -------------------------------------------------------------------
     * State
     * ------------------------------------------------------------------- */
    std::map<uint32_t, uint32_t> mem_;

    Phase phase_;
    bool host_drives_;
    unsigned bit_i_;

    /* idle-phase request assembly */
    uint32_t req_;
    unsigned shifted_;
    bool collecting_;
    bool suppressed_;
    unsigned ones_run_;
    unsigned zeros_run_;
    int idle_before_;
    int idle_before_request_;
    uint16_t switch_shift_;

    /* current transaction */
    bool req_ap_ = false;
    bool req_rnw_ = false;
    uint8_t req_addr_ = 0;
    uint32_t ack_ = SWD_ACK_OK;
    uint32_t rdata_ = 0;
    uint32_t wdata_ = 0;
    bool pending_write_ = false;

    /* DP/AP state */
    uint32_t ctrl_stat_;
    uint32_t select_;
    uint32_t posted_;
    uint32_t ap_csw_;
    uint32_t ap_tar_;
    uint32_t nvmc_config_;
    uint32_t ctrlap_reset_;
    uint32_t dhcsr_;
    uint32_t demcr_;

    /* counters and injection */
    int line_resets_;
    int jtag_to_swd_;
    int protocol_errors_;
    int transfers_;
    int wait_left_;
    int fault_left_;
    bool corrupt_parity_;
    bool present_;
    bool locked_;
    int nvmc_busy_;
    int nvmc_write_violations_;
    int nvmc_erase_violations_;
    int eraseall_count_;
    int select_writes_;
    int eraseall_poll_reload_;
    int eraseall_polls_;
    int sysresets_;
};

#endif /* FAKE_SWD_TARGET_H */
