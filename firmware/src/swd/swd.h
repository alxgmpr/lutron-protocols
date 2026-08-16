#ifndef SWD_H
#define SWD_H

/**
 * Serial Wire Debug (ADIv5) host implementation.
 *
 * This drives a target's SW-DP over a bit-level transport that the caller
 * injects (swd_io_t), the same way ota_image.c takes its flash backend. Every
 * byte of framing, turnaround, ACK handling and parity lives here, so the whole
 * protocol is exercised on the host against a fake target and only the four
 * GPIO primitives need real hardware.
 *
 * Wire format of one transfer (ADIv5 §4.3), SWDIO is LSB-first throughout:
 *
 *   host drives   [ 8-bit request ]
 *   turnaround    [ 1 clk, line undriven ]
 *   target drives [ 3-bit ACK ]
 *   read:         [ 32 data bits ][ parity ] then turnaround
 *   write:        turnaround then [ 32 data bits ][ parity ]
 *   host drives   [ >=8 idle clocks low ]
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* -----------------------------------------------------------------------
 * Result codes. Negative values are failures.
 * ----------------------------------------------------------------------- */
typedef enum {
    SWD_OK = 0,
    SWD_ERR_ARG = -1,     /* null pointer or unaligned//out-of-range argument */
    SWD_ERR_WAIT = -2,    /* target answered WAIT more than swd_t::max_retries times */
    SWD_ERR_FAULT = -3,   /* target answered FAULT; sticky error was cleared via ABORT */
    SWD_ERR_NO_ACK = -4,  /* no valid ACK — target absent, unpowered, or line dead */
    SWD_ERR_PARITY = -5,  /* read data parity did not check */
    SWD_ERR_PROTOCOL = -6 /* target reported something the sequence cannot continue from */
} swd_status_t;

/* ACK values as they appear on the wire (3 bits, LSB first). */
#define SWD_ACK_OK 0x1u
#define SWD_ACK_WAIT 0x2u
#define SWD_ACK_FAULT 0x4u

/* -----------------------------------------------------------------------
 * Bit-level transport
 * ----------------------------------------------------------------------- */

/**
 * The four primitives a bit-bang backend must provide. Each of clock_out and
 * clock_in is exactly one SWCLK cycle.
 *
 * Deliberately bit-level rather than transfer-level: it keeps every framing
 * decision (turnaround placement, ACK bit order, parity) inside swd.c where the
 * host tests can see it, and leaves the backend with nothing but pin wiggling.
 */
typedef struct {
    /** Drive @p bit on SWDIO and issue one clock. Only valid while output. */
    void (*clock_out)(void* ctx, bool bit);
    /** Issue one clock and sample SWDIO. Only valid while input. */
    bool (*clock_in)(void* ctx);
    /** Set SWDIO direction: true = host drives, false = host releases. */
    void (*set_output)(void* ctx, bool host_drives);
    void* ctx;
} swd_io_t;

/* -----------------------------------------------------------------------
 * DP registers (address = A[3:2] on the wire)
 * ----------------------------------------------------------------------- */
#define SWD_DP_DPIDR 0x0u    /* read */
#define SWD_DP_ABORT 0x0u    /* write */
#define SWD_DP_CTRLSTAT 0x4u /* read/write, DPBANKSEL must be 0 */
#define SWD_DP_RESEND 0x8u   /* read */
#define SWD_DP_SELECT 0x8u   /* write */
#define SWD_DP_RDBUFF 0xCu   /* read */

/* CTRL/STAT bits */
#define SWD_CDBGPWRUPREQ (1u << 28)
#define SWD_CDBGPWRUPACK (1u << 29)
#define SWD_CSYSPWRUPREQ (1u << 30)
#define SWD_CSYSPWRUPACK (1u << 31)
#define SWD_STICKYERR (1u << 5)

/* ABORT bits */
#define SWD_DAPABORT (1u << 0)
#define SWD_STKCMPCLR (1u << 1)
#define SWD_STKERRCLR (1u << 2)
#define SWD_WDERRCLR (1u << 3)
#define SWD_ORUNERRCLR (1u << 4)

/* -----------------------------------------------------------------------
 * MEM-AP / AP register offsets (full 8-bit offset; banking is handled here)
 * ----------------------------------------------------------------------- */
#define SWD_AP_CSW 0x00u
#define SWD_AP_TAR 0x04u
#define SWD_AP_DRW 0x0Cu
#define SWD_AP_BASE 0xF8u
#define SWD_AP_IDR 0xFCu

/** How many ACK WAITs to ride out before giving up on a transfer. */
#define SWD_WAIT_RETRIES 64

/** Idle clocks driven low after each transfer, per ADIv5. */
#define SWD_IDLE_CYCLES 8

/* -----------------------------------------------------------------------
 * Driver state
 * ----------------------------------------------------------------------- */
typedef struct {
    swd_io_t io;
    uint32_t select;  /* last value written to DP SELECT */
    bool select_known; /* false until SELECT has been written at least once */
} swd_t;

/** Bind a driver to a transport. Does not touch the wire. */
void swd_init(swd_t* s, const swd_io_t* io);

/* -----------------------------------------------------------------------
 * Transfers
 * ----------------------------------------------------------------------- */

/** Read a DP register. @p addr is one of SWD_DP_*. */
swd_status_t swd_dp_read(swd_t* s, uint8_t addr, uint32_t* out);

/** Write a DP register. */
swd_status_t swd_dp_write(swd_t* s, uint8_t addr, uint32_t val);

/**
 * Read an AP register, handling both SELECT banking and the posted-read
 * pipeline — the returned value is the register's actual contents, fetched via
 * RDBUFF, not the stale value the data phase carries.
 *
 * @param apsel AP index (0 = AHB-AP, 1 = nRF CTRL-AP).
 * @param reg   full 8-bit AP register offset, e.g. SWD_AP_CSW.
 */
swd_status_t swd_ap_read(swd_t* s, uint8_t apsel, uint8_t reg, uint32_t* out);

/** Write an AP register, handling SELECT banking. */
swd_status_t swd_ap_write(swd_t* s, uint8_t apsel, uint8_t reg, uint32_t val);

/* -----------------------------------------------------------------------
 * Link management
 * ----------------------------------------------------------------------- */

/** >=50 clocks with SWDIO high, then two idle lows. Costs nothing to repeat. */
void swd_line_reset(swd_t* s);

/**
 * Bring the link up from unknown state: line reset, JTAG-to-SWD switch, line
 * reset, then read DPIDR. Leaves SELECT invalidated so the next AP access
 * rewrites it.
 */
swd_status_t swd_connect(swd_t* s, uint32_t* idcode_out);

/** Raise CDBGPWRUPREQ/CSYSPWRUPREQ and wait for both ACKs. */
swd_status_t swd_power_up(swd_t* s);

/** Clear the sticky error latch via ABORT. */
swd_status_t swd_clear_errors(swd_t* s);

/* -----------------------------------------------------------------------
 * Framing primitives (pure, no transport)
 * ----------------------------------------------------------------------- */

/**
 * Build the 8-bit request packet.
 *
 * @param ap    true for an AP access, false for DP.
 * @param rnw   true for read, false for write.
 * @param addr  register address; only bits [3:2] are used.
 */
uint8_t swd_request_byte(bool ap, bool rnw, uint8_t addr);

/** Even parity over all 32 data bits — the bit that follows the payload. */
uint8_t swd_data_parity(uint32_t data);

#ifdef __cplusplus
}
#endif

#endif /* SWD_H */
