#include "ncp_watchdog.h"

/**
 * Wrap-safe elapsed time.
 *
 * Unsigned subtraction gives the correct interval across the 32-bit rollover,
 * which comparing `now >= then + timeout` does not. At 49.7 days the naive
 * form stops being true and the watchdog never fires again.
 */
static inline uint32_t elapsed(uint32_t now, uint32_t then)
{
    return now - then;
}

void ncp_wd_default_cfg(ncp_wd_cfg_t* cfg)
{
    cfg->liveness_timeout_ms = 30000u;  /* 30 s without a Spinel answer */
    cfg->retry_interval_ms = 15000u;    /* 15 s between the first attempts */
    cfg->backoff_interval_ms = 300000u; /* then every 5 minutes, forever */
    cfg->max_fast_attempts = 3u;
}

void ncp_wd_init(ncp_wd_t* wd, const ncp_wd_cfg_t* cfg, uint32_t now_ms)
{
    wd->cfg = *cfg;
    wd->last_alive_ms = now_ms;
    wd->last_attempt_ms = now_ms;
    wd->attempts = 0;
    wd->recoveries = 0;
    wd->attempted = false;
}

void ncp_wd_alive(ncp_wd_t* wd, uint32_t now_ms)
{
    wd->last_alive_ms = now_ms;
    wd->attempts = 0;
    wd->attempted = false;
}

bool ncp_wd_should_recover(ncp_wd_t* wd, uint32_t now_ms)
{
    if (elapsed(now_ms, wd->last_alive_ms) < wd->cfg.liveness_timeout_ms) {
        return false;
    }

    /* Unresponsive. The first attempt goes immediately; later ones wait out
       the interval, which widens once the fast attempts are spent. */
    if (!wd->attempted) {
        return true;
    }

    uint32_t interval =
        (wd->attempts >= wd->cfg.max_fast_attempts) ? wd->cfg.backoff_interval_ms : wd->cfg.retry_interval_ms;
    return elapsed(now_ms, wd->last_attempt_ms) >= interval;
}

void ncp_wd_recovery_done(ncp_wd_t* wd, bool alive, uint32_t now_ms)
{
    wd->last_attempt_ms = now_ms;
    wd->attempted = true;

    if (alive) {
        wd->recoveries++;
        ncp_wd_alive(wd, now_ms);
        return;
    }
    wd->attempts++;
}

ncp_wd_state_t ncp_wd_state(const ncp_wd_t* wd)
{
    if (wd->attempts == 0 && !wd->attempted) {
        return NCP_WD_HEALTHY;
    }
    if (wd->attempts >= wd->cfg.max_fast_attempts) {
        return NCP_WD_BACKOFF;
    }
    return NCP_WD_RECOVERING;
}

uint32_t ncp_wd_attempts(const ncp_wd_t* wd)
{
    return wd->attempts;
}

uint32_t ncp_wd_recoveries(const ncp_wd_t* wd)
{
    return wd->recoveries;
}
