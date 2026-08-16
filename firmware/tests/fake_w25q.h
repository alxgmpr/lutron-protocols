#ifndef FAKE_W25Q_H
#define FAKE_W25Q_H

/**
 * A fake Winbond W25Q SPI NOR that decodes the real command stream, one
 * transfer at a time, through the same w25q_io_t the SPI backend implements.
 *
 * Like fake_swd_target, it is deliberately not a mock of the driver's calls.
 * It decodes bytes: opcode, 24-bit address, and the data phase, with CS framing
 * deciding where one command ends and the next begins. A driver that sends the
 * address big-endian, forgets the write-enable, or lets a page program run off
 * the end of its page fails here rather than on the bench.
 *
 * What it models:
 *   - 9Fh JEDEC ID, 05h status, 06h write enable, 04h write disable
 *   - 03h read (address auto-increments across the whole device)
 *   - 02h page program, with the 256-byte wrap real silicon performs
 *   - 20h sector erase (4 KB)
 *   - WEL: set by 06h, cleared by any completed program or erase
 *   - BUSY: reads set for a configurable number of polls after program/erase
 *   - NOR semantics: erased is 0xFF, programming only clears bits
 *
 * Violations are counted rather than thrown, so a test can assert on the exact
 * rule that was broken.
 */

#include "w25q.h"

#include <cstdint>
#include <cstring>
#include <map>
#include <vector>

#define FAKE_W25Q_MFR_WINBOND 0xEF
#define FAKE_W25Q_TYPE 0x40
#define FAKE_W25Q_CAPACITY_CODE 0x18 /* 2^24 = 16 MB (W25Q128) */
#define FAKE_W25Q_PAGE 256u
#define FAKE_W25Q_SECTOR 4096u

class FakeW25Q {
  public:
    FakeW25Q() { reset_all(); }

    w25q_io_t io()
    {
        w25q_io_t t;
        t.xfer = &FakeW25Q::s_xfer;
        t.cs = &FakeW25Q::s_cs;
        t.ctx = this;
        return t;
    }

    /* ---- fault / behaviour injection ---- */

    /** Report BUSY for @p n status reads after each program or erase. */
    void set_busy_polls(int n) { busy_reload_ = n; }
    /** Stop answering — models an absent part (MISO floats high). */
    void set_present(bool p) { present_ = p; }
    /** Override the JEDEC ID, for the miswired and garbled-read cases. */
    void set_id(uint8_t mfr, uint8_t type, uint8_t capacity)
    {
        id_mfr_ = mfr;
        id_type_ = type;
        id_cap_ = capacity;
    }
    /** Refuse to clear the bits in @p mask at @p addr: a marginal cell. */
    void set_stuck_bits(uint32_t addr, uint8_t mask)
    {
        stuck_addr_ = addr;
        stuck_mask_ = mask;
    }

    /* ---- observation ---- */

    /** Programs or erases attempted without a preceding write enable. */
    int wel_violations() const { return wel_violations_; }
    /** Commands issued while the part was still BUSY. */
    int busy_violations() const { return busy_violations_; }
    /** Page programs whose data ran past the end of a 256-byte page. */
    int page_wraps() const { return page_wraps_; }
    /** Data bytes clocked while CS was not asserted. */
    int cs_violations() const { return cs_violations_; }
    int erases() const { return erases_; }
    int programs() const { return programs_; }
    bool wel() const { return wel_; }

    uint8_t peek(uint32_t addr) const
    {
        auto it = mem_.find(addr);
        return it == mem_.end() ? 0xFF : it->second;
    }
    void poke(uint32_t addr, uint8_t v) { mem_[addr] = v; }

    void reset_all()
    {
        mem_.clear();
        cs_ = false;
        phase_ = 0;
        cmd_ = 0;
        addr_ = 0;
        wel_ = false;
        busy_ = 0;
        busy_reload_ = 0;
        wel_violations_ = 0;
        busy_violations_ = 0;
        page_wraps_ = 0;
        cs_violations_ = 0;
        erases_ = 0;
        programs_ = 0;
        present_ = true;
        stuck_addr_ = 0xFFFFFFFFu;
        stuck_mask_ = 0;
        prog_page_base_ = 0;
        id_mfr_ = FAKE_W25Q_MFR_WINBOND;
        id_type_ = FAKE_W25Q_TYPE;
        id_cap_ = FAKE_W25Q_CAPACITY_CODE;
    }

  private:
    static void s_xfer(void* ctx, const uint8_t* tx, uint8_t* rx, size_t len)
    {
        static_cast<FakeW25Q*>(ctx)->xfer(tx, rx, len);
    }
    static void s_cs(void* ctx, bool assert) { static_cast<FakeW25Q*>(ctx)->cs(assert); }

    void cs(bool assert)
    {
        if (assert && !cs_) {
            /* A new command begins on every falling edge of CS. */
            phase_ = 0;
            cmd_ = 0;
            addr_ = 0;
        }
        else if (!assert&& cs_) {
            /* And completes on the rising edge. WEL clears and BUSY starts
               when the *operation* finishes, not per byte — a page program
               holds its write enable for all 256 bytes. */
            bool programmed = (cmd_ == W25Q_CMD_PAGE_PROGRAM && phase_ > 4);
            bool erased = (cmd_ == W25Q_CMD_SECTOR_ERASE && phase_ >= 4);
            if ((programmed || erased) && wel_) {
                wel_ = false;
                busy_ = busy_reload_;
            }
        }
        cs_ = assert;
    }

    void xfer(const uint8_t* tx, uint8_t* rx, size_t len)
    {
        for (size_t i = 0; i < len; i++) {
            uint8_t out = 0xFF;
            uint8_t in = tx ? tx[i] : 0xFF;
            if (!cs_) {
                cs_violations_++;
            }
            else if (present_) {
                out = byte(in);
            }
            if (rx) {
                rx[i] = out;
            }
        }
    }

    /** One byte of a command. Returns what the part drives on MISO. */
    uint8_t byte(uint8_t in)
    {
        if (phase_ == 0) {
            cmd_ = in;
            phase_++;
            start_command();
            return 0xFF;
        }

        switch (cmd_) {
        case W25Q_CMD_JEDEC_ID: {
            uint8_t id[3] = {id_mfr_, id_type_, id_cap_};
            uint8_t v = (phase_ - 1 < 3) ? id[phase_ - 1] : 0xFF;
            phase_++;
            return v;
        }
        case W25Q_CMD_READ_STATUS1: {
            phase_++;
            uint8_t st = 0;
            if (busy_ > 0) {
                busy_--;
                st |= 0x01; /* BUSY */
            }
            if (wel_) {
                st |= 0x02; /* WEL */
            }
            return st;
        }
        case W25Q_CMD_READ_DATA:
            if (phase_ <= 3) {
                addr_ = (addr_ << 8) | in; /* 24-bit, MSB first */
                phase_++;
                return 0xFF;
            }
            phase_++;
            return peek(addr_++);
        case W25Q_CMD_PAGE_PROGRAM:
            if (phase_ <= 3) {
                addr_ = (addr_ << 8) | in;
                phase_++;
                if (phase_ == 4) {
                    prog_page_base_ = addr_ & ~(FAKE_W25Q_PAGE - 1u);
                }
                return 0xFF;
            }
            program_byte(in);
            phase_++;
            return 0xFF;
        case W25Q_CMD_SECTOR_ERASE:
            addr_ = (addr_ << 8) | in;
            phase_++;
            if (phase_ == 4) {
                do_erase();
            }
            return 0xFF;
        default:
            phase_++;
            return 0xFF;
        }
    }

    void start_command()
    {
        bool mutating = (cmd_ == W25Q_CMD_PAGE_PROGRAM || cmd_ == W25Q_CMD_SECTOR_ERASE);
        if (busy_ > 0 && cmd_ != W25Q_CMD_READ_STATUS1) {
            /* Real silicon ignores everything but a status read while busy. */
            busy_violations_++;
        }
        if (cmd_ == W25Q_CMD_WRITE_ENABLE) {
            wel_ = true;
        }
        else if (cmd_ == W25Q_CMD_WRITE_DISABLE) {
            wel_ = false;
        }
        else if (mutating && !wel_) {
            wel_violations_++;
        }
    }

    void program_byte(uint8_t v)
    {
        if (!wel_) {
            return; /* dropped, already counted */
        }
        /* A page program that runs past the end of its 256-byte page wraps to
           the start of that same page and overwrites what it already wrote —
           silently, which is what makes it worth catching here. */
        if (addr_ > prog_page_base_ + FAKE_W25Q_PAGE - 1u) {
            page_wraps_++;
            addr_ = prog_page_base_;
        }
        uint8_t old = peek(addr_);
        uint8_t stuck = (addr_ == stuck_addr_) ? stuck_mask_ : 0;
        mem_[addr_] = (uint8_t)(old & (v | stuck));
        addr_++;
        programs_++;
        /* WEL and BUSY are settled on the CS rising edge, in cs(), because
           that is where the operation actually completes. Clearing WEL here
           would end the write enable after the first byte and drop the rest of
           the page. */
    }

    void do_erase()
    {
        if (!wel_) {
            return;
        }
        uint32_t base = addr_ & ~(FAKE_W25Q_SECTOR - 1u);
        for (uint32_t a = base; a < base + FAKE_W25Q_SECTOR; a++) {
            mem_.erase(a);
        }
        erases_++;
    }

    std::map<uint32_t, uint8_t> mem_;
    bool cs_;
    unsigned phase_;
    uint8_t cmd_;
    uint32_t addr_;
    uint32_t prog_page_base_;
    bool wel_;
    int busy_;
    int busy_reload_;
    int wel_violations_;
    int busy_violations_;
    int page_wraps_;
    int cs_violations_;
    int erases_;
    int programs_;
    bool present_;
    uint32_t stuck_addr_;
    uint8_t stuck_mask_;
    uint8_t id_mfr_;
    uint8_t id_type_;
    uint8_t id_cap_;
};

#endif /* FAKE_W25Q_H */
