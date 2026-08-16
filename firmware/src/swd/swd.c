#include "swd.h"

#include <stddef.h>

/* -----------------------------------------------------------------------
 * Framing primitives
 * ----------------------------------------------------------------------- */

uint8_t swd_request_byte(bool ap, bool rnw, uint8_t addr)
{
    uint8_t a2 = (uint8_t)((addr >> 2) & 1u);
    uint8_t a3 = (uint8_t)((addr >> 3) & 1u);
    uint8_t apn = ap ? 1u : 0u;
    uint8_t rw = rnw ? 1u : 0u;
    uint8_t parity = (uint8_t)((apn ^ rw ^ a2 ^ a3) & 1u);

    /* bit0 start, bit6 stop, bit7 park are fixed. */
    return (uint8_t)(0x01u | (uint8_t)(apn << 1) | (uint8_t)(rw << 2) | (uint8_t)(a2 << 3) | (uint8_t)(a3 << 4) |
                     (uint8_t)(parity << 5) | 0x80u);
}

uint8_t swd_data_parity(uint32_t data)
{
    data ^= data >> 16;
    data ^= data >> 8;
    data ^= data >> 4;
    data ^= data >> 2;
    data ^= data >> 1;
    return (uint8_t)(data & 1u);
}

/* -----------------------------------------------------------------------
 * Bit plumbing
 * ----------------------------------------------------------------------- */

static void out_bits(swd_t* s, uint32_t value, unsigned n)
{
    for (unsigned i = 0; i < n; i++) {
        s->io.clock_out(s->io.ctx, ((value >> i) & 1u) != 0);
    }
}

static uint32_t in_bits(swd_t* s, unsigned n)
{
    uint32_t v = 0;
    for (unsigned i = 0; i < n; i++) {
        if (s->io.clock_in(s->io.ctx)) {
            v |= 1u << i;
        }
    }
    return v;
}

static void drive(swd_t* s, bool host_drives)
{
    s->io.set_output(s->io.ctx, host_drives);
}

/** Idle low clocks, driven by the host, to flush the transaction through. */
static void idle(swd_t* s, unsigned n)
{
    drive(s, true);
    out_bits(s, 0, n);
}

void swd_init(swd_t* s, const swd_io_t* io)
{
    s->io = *io;
    s->select = 0;
    s->select_known = false;
}

void swd_line_reset(swd_t* s)
{
    drive(s, true);
    for (unsigned i = 0; i < 56; i++) {
        s->io.clock_out(s->io.ctx, true);
    }
    out_bits(s, 0, 4);
}

/* -----------------------------------------------------------------------
 * One transaction
 * ----------------------------------------------------------------------- */

/**
 * Exactly one request/ACK/data exchange. Reports the raw ACK; retry policy and
 * error recovery belong to the caller.
 */
static swd_status_t transfer_once(swd_t* s, bool ap, bool rnw, uint8_t addr, uint32_t* data, uint32_t* ack_out)
{
    drive(s, true);
    out_bits(s, swd_request_byte(ap, rnw, addr), 8);

    /* Turnaround, then the target drives three ACK bits LSB-first. */
    drive(s, false);
    (void)in_bits(s, 1);
    uint32_t ack = in_bits(s, 3);
    *ack_out = ack;

    if (ack != SWD_ACK_OK) {
        /* No data phase. One turnaround, then the host owns the line again. */
        (void)in_bits(s, 1);
        idle(s, SWD_IDLE_CYCLES);
        if (ack == SWD_ACK_WAIT) {
            return SWD_ERR_WAIT;
        }
        if (ack == SWD_ACK_FAULT) {
            return SWD_ERR_FAULT;
        }
        return SWD_ERR_NO_ACK;
    }

    if (rnw) {
        uint32_t v = in_bits(s, 32);
        uint32_t parity = in_bits(s, 1);
        (void)in_bits(s, 1); /* turnaround back to the host */
        idle(s, SWD_IDLE_CYCLES);
        if (parity != swd_data_parity(v)) {
            return SWD_ERR_PARITY;
        }
        *data = v;
        return SWD_OK;
    }

    (void)in_bits(s, 1); /* turnaround: target released, host takes over */
    drive(s, true);
    out_bits(s, *data, 32);
    out_bits(s, swd_data_parity(*data), 1);
    idle(s, SWD_IDLE_CYCLES);
    return SWD_OK;
}

/**
 * Transfer with the standard recovery policy: ride out WAITs, and on FAULT
 * clear the sticky error before returning so the link is usable again. A FAULT
 * left unacknowledged makes every later AP access fault too, which shows up as
 * an unrelated failure much further along.
 */
static swd_status_t transfer(swd_t* s, bool ap, bool rnw, uint8_t addr, uint32_t* data)
{
    uint32_t ack = 0;
    for (int attempt = 0; attempt <= SWD_WAIT_RETRIES; attempt++) {
        swd_status_t st = transfer_once(s, ap, rnw, addr, data, &ack);
        if (st != SWD_ERR_WAIT) {
            if (st == SWD_ERR_FAULT) {
                swd_clear_errors(s);
            }
            return st;
        }
    }
    return SWD_ERR_WAIT;
}

swd_status_t swd_clear_errors(swd_t* s)
{
    uint32_t v = SWD_STKERRCLR | SWD_STKCMPCLR | SWD_WDERRCLR | SWD_ORUNERRCLR;
    uint32_t ack = 0;
    /* Deliberately the raw form: going through transfer() would recurse on a
       fault, and there is nothing useful to do if the ABORT itself faults. */
    return transfer_once(s, false, false, SWD_DP_ABORT, &v, &ack);
}

/* -----------------------------------------------------------------------
 * DP / AP access
 * ----------------------------------------------------------------------- */

swd_status_t swd_dp_read(swd_t* s, uint8_t addr, uint32_t* out)
{
    if (s == NULL || out == NULL) {
        return SWD_ERR_ARG;
    }
    return transfer(s, false, true, addr, out);
}

swd_status_t swd_dp_write(swd_t* s, uint8_t addr, uint32_t val)
{
    if (s == NULL) {
        return SWD_ERR_ARG;
    }
    return transfer(s, false, false, addr, &val);
}

/** Point SELECT at the AP and register bank this access needs. */
static swd_status_t select_bank(swd_t* s, uint8_t apsel, uint8_t reg)
{
    uint32_t want = ((uint32_t)apsel << 24) | (uint32_t)(reg & 0xF0u);
    if (s->select_known && s->select == want) {
        return SWD_OK;
    }
    swd_status_t st = transfer(s, false, false, SWD_DP_SELECT, &want);
    if (st != SWD_OK) {
        s->select_known = false;
        return st;
    }
    s->select = want;
    s->select_known = true;
    return SWD_OK;
}

swd_status_t swd_ap_read(swd_t* s, uint8_t apsel, uint8_t reg, uint32_t* out)
{
    if (s == NULL || out == NULL) {
        return SWD_ERR_ARG;
    }
    swd_status_t st = select_bank(s, apsel, reg);
    if (st != SWD_OK) {
        return st;
    }

    /* AP reads are posted: this data phase carries the *previous* AP read's
       result. Reading RDBUFF afterwards is what yields this one. */
    uint32_t discard = 0;
    st = transfer(s, true, true, (uint8_t)(reg & 0x0Cu), &discard);
    if (st != SWD_OK) {
        return st;
    }
    return transfer(s, false, true, SWD_DP_RDBUFF, out);
}

swd_status_t swd_ap_write(swd_t* s, uint8_t apsel, uint8_t reg, uint32_t val)
{
    if (s == NULL) {
        return SWD_ERR_ARG;
    }
    swd_status_t st = select_bank(s, apsel, reg);
    if (st != SWD_OK) {
        return st;
    }
    return transfer(s, true, false, (uint8_t)(reg & 0x0Cu), &val);
}

/* -----------------------------------------------------------------------
 * Link bring-up
 * ----------------------------------------------------------------------- */

swd_status_t swd_connect(swd_t* s, uint32_t* idcode_out)
{
    if (s == NULL || idcode_out == NULL) {
        return SWD_ERR_ARG;
    }

    s->select_known = false;

    /* The target may be in JTAG or in an unknown SWD state. Reset the line,
       send the 16-bit switch sequence, reset again, then talk SWD. */
    swd_line_reset(s);
    drive(s, true);
    out_bits(s, 0xE79Eu, 16);
    swd_line_reset(s);
    idle(s, SWD_IDLE_CYCLES);

    /* DPIDR must be read first; the DP answers nothing else until it has. */
    return swd_dp_read(s, SWD_DP_DPIDR, idcode_out);
}

swd_status_t swd_power_up(swd_t* s)
{
    if (s == NULL) {
        return SWD_ERR_ARG;
    }

    swd_status_t st = swd_dp_write(s, SWD_DP_CTRLSTAT, SWD_CDBGPWRUPREQ | SWD_CSYSPWRUPREQ);
    if (st != SWD_OK) {
        return st;
    }

    const uint32_t want = SWD_CDBGPWRUPACK | SWD_CSYSPWRUPACK;
    for (int i = 0; i < SWD_WAIT_RETRIES; i++) {
        uint32_t v = 0;
        st = swd_dp_read(s, SWD_DP_CTRLSTAT, &v);
        if (st != SWD_OK) {
            return st;
        }
        if ((v & want) == want) {
            return SWD_OK;
        }
    }
    return SWD_ERR_PROTOCOL;
}
