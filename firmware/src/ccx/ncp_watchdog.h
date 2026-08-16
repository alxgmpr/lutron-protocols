#ifndef NCP_WATCHDOG_H
#define NCP_WATCHDOG_H

/**
 * Liveness policy for the nRF52840 NCP.
 *
 * Decides *when* to attempt a recovery; it never touches hardware. The caller
 * supplies evidence of life and performs the actual reset, which keeps the
 * fiddly parts — backoff, attempt counting, tick wraparound — host-testable.
 *
 * Why this exists: ccx_task probed the NCP exactly once at startup. If that
 * probe failed, the task slept forever and the board sat dead until somebody
 * noticed. Now that a CTRL-AP reset over SWD can recover a dongle stuck in its
 * bootloader, the failure is worth detecting and acting on automatically.
 *
 * Known limitation: a CTRL-AP reset is a pin-reset equivalent, so it does not
 * clear GPREGRET. If the dongle entered DFU via the 0xB1 DFU magic it will
 * re-enter DFU on every reset, and only a true power cycle clears it. That
 * case is what the backoff exists for — keep trying, but quietly.
 *
 * All times are milliseconds from a free-running counter (HAL_GetTick()).
 * Wraparound at 49.7 days is handled; see the tests.
 */

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    NCP_WD_HEALTHY = 0, /* seen alive within the liveness timeout */
    NCP_WD_RECOVERING,  /* unresponsive, working through the fast attempts */
    NCP_WD_BACKOFF      /* fast attempts spent; retrying slowly, forever */
} ncp_wd_state_t;

typedef struct {
    uint32_t liveness_timeout_ms; /* no evidence of life for this long => act */
    uint32_t retry_interval_ms;   /* gap between the first few attempts */
    uint32_t backoff_interval_ms; /* gap once max_fast_attempts is spent */
    uint32_t max_fast_attempts;
} ncp_wd_cfg_t;

typedef struct {
    ncp_wd_cfg_t cfg;
    uint32_t last_alive_ms;
    uint32_t last_attempt_ms;
    uint32_t attempts;   /* consecutive failed attempts since last alive */
    uint32_t recoveries; /* successful recoveries over the board's lifetime */
    bool attempted;      /* an attempt has been made since last alive */
} ncp_wd_t;

/** Sensible defaults for the NCP: 30 s liveness, 15 s retry, 5 min backoff. */
void ncp_wd_default_cfg(ncp_wd_cfg_t* cfg);

void ncp_wd_init(ncp_wd_t* wd, const ncp_wd_cfg_t* cfg, uint32_t now_ms);

/** Record that the NCP proved it is alive (a Spinel response, say). */
void ncp_wd_alive(ncp_wd_t* wd, uint32_t now_ms);

/** True when a recovery should be attempted right now. */
bool ncp_wd_should_recover(ncp_wd_t* wd, uint32_t now_ms);

/** Report the outcome of an attempt. @p alive is the result of the re-probe. */
void ncp_wd_recovery_done(ncp_wd_t* wd, bool alive, uint32_t now_ms);

ncp_wd_state_t ncp_wd_state(const ncp_wd_t* wd);
uint32_t ncp_wd_attempts(const ncp_wd_t* wd);
uint32_t ncp_wd_recoveries(const ncp_wd_t* wd);

#ifdef __cplusplus
}
#endif

#endif /* NCP_WATCHDOG_H */
