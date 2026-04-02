#ifndef CCA_TIMER_H
#define CCA_TIMER_H

/**
 * CCA TDMA hardware timer — TIM2 free-running at 100 kHz (10 µs resolution).
 *
 * Provides precise timing for CCA TDMA slot scheduling:
 *   - 1 tick = 10 µs
 *   - 1250 ticks = 12.5 ms = one TDMA slot
 *   - 7500 ticks = 75 ms = one frame (6 × 12.5 ms)
 *
 * TIM2 is a 32-bit timer, wraps at ~11.9 hours.
 *
 * Clock: APB1 timer clock = 275 MHz
 * Prescaler: 2750 → 100 kHz tick
 */

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Timing constants in ticks (1 tick = 10 µs) */
#define CCA_TICK_US      10   /* microseconds per tick */
#define CCA_SLOT_TICKS   1250 /* 12.5 ms */
#define CCA_FRAME_TICKS  7500 /* 75 ms = 6 slots */
#define CCA_TICKS_PER_MS 100  /* 1 ms */

/** Initialize TIM2 as free-running 100 kHz counter. Call once at startup. */
void cca_timer_init(void);

/** Get current tick count (10 µs resolution, 32-bit, wraps at ~11.9 hrs). */
uint32_t cca_timer_ticks(void);

/** Convert ticks to milliseconds. */
static inline uint32_t cca_ticks_to_ms(uint32_t ticks)
{
    return ticks / CCA_TICKS_PER_MS;
}

/** Convert milliseconds to ticks. */
static inline uint32_t cca_ms_to_ticks(uint32_t ms)
{
    return ms * CCA_TICKS_PER_MS;
}

/** Spin-wait until the specified tick count is reached. Tight loop, no yield. */
void cca_timer_wait_until(uint32_t target_tick);

/**
 * Schedule a one-shot callback at a specific tick via TIM2 compare channel.
 * The callback fires from ISR context — keep it short.
 * Only one pending schedule at a time; new call replaces previous.
 */
typedef void (*cca_timer_callback_t)(void);
void cca_timer_schedule(uint32_t fire_tick, cca_timer_callback_t callback);

/** Cancel any pending scheduled callback. */
void cca_timer_cancel(void);

#ifdef __cplusplus
}
#endif

#endif /* CCA_TIMER_H */
