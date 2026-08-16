#ifndef NRF_SWD_H
#define NRF_SWD_H

/**
 * nRF52840 flash programming over SWD.
 *
 * Layered on swd_mem (AHB-AP) for flash access and on the CTRL-AP for the one
 * thing the AHB-AP cannot do: recovering a part whose APPROTECT is set.
 *
 * Sequencing rules this module enforces, because the hardware does not:
 *
 *  - NVMC CONFIG gates writes and erases. A program with CONFIG at ReadOnly is
 *    discarded silently; the word simply stays erased. CONFIG is set for the
 *    operation and returned to ReadOnly afterwards, so a later stray write
 *    cannot erase a page.
 *
 *  - Flash programming only clears bits. Writing over a word that was not
 *    erased first gives old AND new. nrf_swd_verify() is the check for that.
 *
 *  - Recovery holds the core in reset over the erase and releases it after. A
 *    reset left asserted looks identical to the dead dongle being fixed.
 */

#include "swd.h"
#include "swd_mem.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Memory map */
#define NRF_FLASH_BASE 0x00000000u
#define NRF_FLASH_SIZE 0x00100000u /* 1 MB */
#define NRF_FLASH_PAGE 0x00001000u /* 4 KB */
#define NRF_UICR_BASE 0x10001000u
#define NRF_UICR_SIZE 0x00000400u

/* NVMC */
#define NRF_NVMC_BASE 0x4001E000u
#define NRF_NVMC_READY (NRF_NVMC_BASE + 0x400u)
#define NRF_NVMC_CONFIG (NRF_NVMC_BASE + 0x504u)
#define NRF_NVMC_ERASEPAGE (NRF_NVMC_BASE + 0x508u)
#define NRF_NVMC_ERASEALL (NRF_NVMC_BASE + 0x50Cu)
#define NRF_NVMC_ERASEUICR (NRF_NVMC_BASE + 0x514u)

#define NRF_NVMC_CONFIG_REN 0u /* read only */
#define NRF_NVMC_CONFIG_WEN 1u /* write enable */
#define NRF_NVMC_CONFIG_EEN 2u /* erase enable */

/* CTRL-AP (AP index 1) register offsets */
#define NRF_CTRLAP_RESET 0x000u
#define NRF_CTRLAP_ERASEALL 0x004u
#define NRF_CTRLAP_ERASEALLSTATUS 0x008u
#define NRF_CTRLAP_APPROTECTSTATUS 0x00Cu
#define NRF_CTRLAP_IDR 0x0FCu

#define NRF_CTRLAP_IDR_EXPECTED 0x02880000u
#define NRF_AHB_AP_IDR_EXPECTED 0x24770011u

/** Poll budget for NVMC READY and ERASEALLSTATUS. */
#define NRF_POLL_LIMIT 10000

typedef struct {
    swd_t* swd;
    swd_mem_t mem; /* AHB-AP view of the target */
} nrf_swd_t;

/** Bind to a link. Does not touch the wire. */
void nrf_swd_init(nrf_swd_t* n, swd_t* s);

/**
 * Line reset, JTAG-to-SWD switch, power-up, then confirm the AHB-AP answers.
 * Returns SWD_ERR_LOCKED if APPROTECT is set — the caller wants
 * nrf_swd_recover() in that case, not a wiring hunt.
 */
swd_status_t nrf_swd_connect(nrf_swd_t* n);

/** Read CTRL-AP APPROTECTSTATUS. Works even when the AHB-AP does not. */
swd_status_t nrf_swd_is_locked(nrf_swd_t* n, bool* locked);

/**
 * Unlock a protected part via CTRL-AP ERASEALL. This erases flash and UICR
 * completely — it is the only way back from APPROTECT, and it is destructive
 * by design. Holds the core in reset across the erase and releases it after.
 */
swd_status_t nrf_swd_recover(nrf_swd_t* n);

/**
 * Pulse CTRL-AP RESET — the equivalent of a pin reset.
 *
 * This is the recovery lever for a dongle stuck in its bootloader. The
 * nRF52840 engages APPROTECT in hardware at every reset and relies on firmware
 * to clear it; the OpenThread application does, the factory USB bootloader
 * does not. So while the part sits in DFU the AHB-AP is unreachable and CTRL-AP
 * is the only port that still answers — which is exactly what it is for.
 *
 * Does NOT clear GPREGRET: that survives a pin reset, so a part put into DFU
 * by the 0xB1 DFU magic will re-enter DFU. Only a power cycle clears it.
 *
 * Note the part takes appreciably longer than a few hundred milliseconds to
 * come back; probe it again after a generous settle, not immediately.
 */
swd_status_t nrf_swd_pin_reset(nrf_swd_t* n);

/** Somewhere for the caller to sleep. Left to the caller because the shell,
 *  the CCX task and the host tests all wait differently. */
typedef void (*swd_delay_fn)(void* ctx, uint32_t ms);

/**
 * Poll until the AHB-AP answers, or the attempt budget runs out.
 *
 * This is the step after a CTRL-AP reset. The nRF52840 engages APPROTECT at
 * every reset and relies on firmware to clear it, so AP0 stays blocked from the
 * release of reset until the application's startup gets around to it — and the
 * gap is not small. A single early re-probe reports a reset that worked as a
 * failure, which is exactly what happened during GLAB-111 at 250 ms.
 *
 * Each attempt re-runs the full bring-up — line reset, JTAG-to-SWD, power-up —
 * rather than re-reading the AP through a link that may have gone out from
 * under it. It costs one line reset per poll and removes the question.
 *
 * Returns SWD_ERR_LOCKED if the budget is spent with AP0 still blocked.
 * @p delay may be NULL.
 */
swd_status_t nrf_swd_wait_ap_ready(nrf_swd_t* n, swd_delay_fn delay, void* ctx, uint32_t attempts,
                                   uint32_t interval_ms);

/** Halt the core. Do this before erasing or programming. */
swd_status_t nrf_swd_halt(nrf_swd_t* n);

/** Release the core and let it run. */
swd_status_t nrf_swd_run(nrf_swd_t* n);

/** Erase the 4 KB page containing @p addr. @p addr must be page aligned. */
swd_status_t nrf_swd_erase_page(nrf_swd_t* n, uint32_t addr);

/** Erase all of flash via NVMC (not a lock recovery — see nrf_swd_recover). */
swd_status_t nrf_swd_erase_all(nrf_swd_t* n);

/** Program @p count words at @p addr. The region must already be erased. */
swd_status_t nrf_swd_write(nrf_swd_t* n, uint32_t addr, const uint32_t* words, uint32_t count);

/** Read @p count words from @p addr. */
swd_status_t nrf_swd_read(nrf_swd_t* n, uint32_t addr, uint32_t* out, uint32_t count);

/** Read back and compare. SWD_ERR_VERIFY on the first mismatching word. */
swd_status_t nrf_swd_verify(nrf_swd_t* n, uint32_t addr, const uint32_t* words, uint32_t count);

#ifdef __cplusplus
}
#endif

#endif /* NRF_SWD_H */
