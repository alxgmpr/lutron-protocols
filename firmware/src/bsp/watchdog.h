#ifndef WATCHDOG_H
#define WATCHDOG_H

/**
 * Independent Watchdog (IWDG) driver.
 *
 * IWDG is clocked by LSI (~32 KHz). With prescaler /128 and reload 2500,
 * the timeout is approximately 10 seconds. Each task must call
 * watchdog_feed() in its main loop to prevent a reset.
 */

#ifdef __cplusplus
extern "C" {
#endif

/** Initialize and start the IWDG (~10s timeout). */
void watchdog_init(void);

/** Refresh the IWDG countdown. Call from every task's main loop. */
void watchdog_feed(void);

#ifdef __cplusplus
}
#endif

#endif /* WATCHDOG_H */
