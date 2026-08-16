#ifndef SWD_GPIO_H
#define SWD_GPIO_H

/**
 * GPIO bit-bang backend for swd.c — the ONLY part of the SWD stack that has
 * not been exercised, because it is the only part that needs wires.
 *
 * ============================================================================
 * UNTESTED ON HARDWARE. No SWD wires exist between the Nucleo and the NCP yet.
 * Everything above this file (swd.c, swd_mem.c, nrf_swd.c, ihex.c) is covered
 * by host tests against a fake target that decodes the real line protocol.
 * This file is where a bug will actually be, so suspect it first.
 * ============================================================================
 *
 * What is unverified here, specifically:
 *   - the clock rate that survives flying leads to the dongle's pads
 *   - setup and hold either side of the SWCLK edges at 550 MHz core clock
 *   - whether the target needs a pull-up on SWDIO stronger than the internal one
 *
 * Timing model: the host changes SWDIO while SWCLK is low and the target
 * samples it on the rising edge; when the target drives, the host samples
 * during the low phase, just before raising the clock.
 */

#include "swd.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Target SWCLK frequency. The nRF52840 will accept far more than this, but the
 * link runs over hand-soldered flying leads to pads on a dongle, so start slow
 * and only raise it with a scope on the line.
 */
#define SWD_GPIO_CLK_HZ 1000000u

/** Configure SWDIO/SWCLK and drive the line idle. */
void swd_gpio_init(void);

/**
 * Release both lines to high-impedance inputs.
 *
 * Call this whenever SWD is not in use. A driven SWDIO or SWDCLK feeds the
 * nRF through its pin ESD diode, so leaving them driven keeps the part
 * partially powered even if its supply is cut.
 */
void swd_gpio_deinit(void);

/** Transport handle to hand to swd_init(). Valid after swd_gpio_init(). */
swd_io_t swd_gpio_io(void);

#ifdef __cplusplus
}
#endif

#endif /* SWD_GPIO_H */
