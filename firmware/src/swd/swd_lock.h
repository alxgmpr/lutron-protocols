#ifndef SWD_LOCK_H
#define SWD_LOCK_H

/**
 * Exclusive access to the SWD pins.
 *
 * Two places bit-bang PD4/PD7: the shell's `swd` command and ccx_task's
 * ncp_recover_via_swd(). Until now both were short, and the overlap was
 * theoretical. `swd flash` runs for tens of seconds, which makes it real — and
 * the failure mode is the NCP watchdog firing mid-program and driving the same
 * two pins into the middle of a page write.
 *
 * The lock is the pins, not the link: whoever holds it owns swd_gpio_init()
 * through swd_gpio_deinit().
 *
 * Created before the scheduler starts, so there is no lazy-init race to lose.
 * Taking a lock that was never created succeeds — a build without FreeRTOS, or
 * a call before swd_lock_init(), is single-threaded by definition.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Create the lock. Call once from main() before vTaskStartScheduler(). */
void swd_lock_init(void);

/**
 * Take the lock, waiting up to @p timeout_ms. Returns false if somebody else
 * still holds it — the caller should say so rather than proceed.
 */
bool swd_lock_take(uint32_t timeout_ms);

/** Release the lock. Only call this if swd_lock_take() returned true. */
void swd_lock_give(void);

#ifdef __cplusplus
}
#endif

#endif /* SWD_LOCK_H */
