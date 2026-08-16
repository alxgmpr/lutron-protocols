#include "nrf_swd.h"

#include <stddef.h>

void nrf_swd_init(nrf_swd_t* n, swd_t* s)
{
    n->swd = s;
    swd_mem_init(&n->mem, s, SWD_AHB_AP);
}

/* -----------------------------------------------------------------------
 * CTRL-AP
 * ----------------------------------------------------------------------- */

swd_status_t nrf_swd_is_locked(nrf_swd_t* n, bool* locked)
{
    if (n == NULL || locked == NULL) {
        return SWD_ERR_ARG;
    }
    uint32_t v = 0;
    swd_status_t st = swd_ap_read(n->swd, SWD_CTRL_AP, NRF_CTRLAP_APPROTECTSTATUS, &v);
    if (st != SWD_OK) {
        return st;
    }
    /* Bit 0 set means *not* protected. */
    *locked = (v & 1u) == 0;
    return SWD_OK;
}

swd_status_t nrf_swd_recover(nrf_swd_t* n)
{
    if (n == NULL) {
        return SWD_ERR_ARG;
    }

    /* The link may be in any state — a locked part faults AHB-AP accesses and
       leaves a sticky error behind. Start from a known one. */
    uint32_t idcode = 0;
    swd_status_t st = swd_connect(n->swd, &idcode);
    if (st != SWD_OK) {
        return st;
    }
    st = swd_power_up(n->swd);
    if (st != SWD_OK) {
        return st;
    }

    /* Hold the core in reset so it cannot run while the flash disappears. */
    st = swd_ap_write(n->swd, SWD_CTRL_AP, NRF_CTRLAP_RESET, 1u);
    if (st != SWD_OK) {
        return st;
    }

    st = swd_ap_write(n->swd, SWD_CTRL_AP, NRF_CTRLAP_ERASEALL, 1u);
    if (st != SWD_OK) {
        return st;
    }

    swd_status_t poll = SWD_ERR_TIMEOUT;
    for (int i = 0; i < NRF_POLL_LIMIT; i++) {
        uint32_t status = 0;
        st = swd_ap_read(n->swd, SWD_CTRL_AP, NRF_CTRLAP_ERASEALLSTATUS, &status);
        if (st != SWD_OK) {
            return st;
        }
        if ((status & 1u) == 0) {
            poll = SWD_OK;
            break;
        }
    }

    /* Clear the trigger and release reset even if the poll timed out, so a
       failure here does not also leave the part held down. */
    (void)swd_ap_write(n->swd, SWD_CTRL_AP, NRF_CTRLAP_ERASEALL, 0u);
    st = swd_ap_write(n->swd, SWD_CTRL_AP, NRF_CTRLAP_RESET, 0u);

    if (poll != SWD_OK) {
        return poll;
    }
    return st;
}

/* -----------------------------------------------------------------------
 * Bring-up
 * ----------------------------------------------------------------------- */

swd_status_t nrf_swd_connect(nrf_swd_t* n)
{
    if (n == NULL) {
        return SWD_ERR_ARG;
    }

    uint32_t idcode = 0;
    swd_status_t st = swd_connect(n->swd, &idcode);
    if (st != SWD_OK) {
        return st;
    }
    st = swd_power_up(n->swd);
    if (st != SWD_OK) {
        return st;
    }

    /* Ask CTRL-AP first. On a locked part the AHB-AP faults, and reporting
       that as a fault sends the caller looking at wiring instead of at
       APPROTECT. */
    bool locked = false;
    st = nrf_swd_is_locked(n, &locked);
    if (st != SWD_OK) {
        return st;
    }
    if (locked) {
        return SWD_ERR_LOCKED;
    }

    uint32_t idr = 0;
    st = swd_mem_read_idr(&n->mem, &idr);
    if (st != SWD_OK) {
        return st;
    }
    if (idr != NRF_AHB_AP_IDR_EXPECTED) {
        return SWD_ERR_PROTOCOL;
    }
    return SWD_OK;
}

swd_status_t nrf_swd_halt(nrf_swd_t* n)
{
    return n == NULL ? SWD_ERR_ARG : swd_core_halt(&n->mem);
}

swd_status_t nrf_swd_run(nrf_swd_t* n)
{
    return n == NULL ? SWD_ERR_ARG : swd_core_resume(&n->mem);
}

/* -----------------------------------------------------------------------
 * NVMC
 * ----------------------------------------------------------------------- */

static swd_status_t nvmc_wait_ready(nrf_swd_t* n)
{
    for (int i = 0; i < NRF_POLL_LIMIT; i++) {
        uint32_t ready = 0;
        swd_status_t st = swd_mem_read32(&n->mem, NRF_NVMC_READY, &ready);
        if (st != SWD_OK) {
            return st;
        }
        if (ready & 1u) {
            return SWD_OK;
        }
    }
    return SWD_ERR_TIMEOUT;
}

static swd_status_t nvmc_set_config(nrf_swd_t* n, uint32_t mode)
{
    swd_status_t st = swd_mem_write32(&n->mem, NRF_NVMC_CONFIG, mode);
    if (st != SWD_OK) {
        return st;
    }
    return nvmc_wait_ready(n);
}

/** Restore ReadOnly, preserving whatever error brought us here. */
static swd_status_t nvmc_finish(nrf_swd_t* n, swd_status_t st)
{
    swd_status_t back = nvmc_set_config(n, NRF_NVMC_CONFIG_REN);
    return st != SWD_OK ? st : back;
}

static bool flash_range_ok(uint32_t addr, uint32_t words)
{
    if ((addr & 3u) != 0) {
        return false;
    }
    if (addr < NRF_FLASH_BASE || addr >= NRF_FLASH_BASE + NRF_FLASH_SIZE) {
        return false;
    }
    uint32_t bytes = words * 4u;
    if (words > NRF_FLASH_SIZE / 4u) {
        return false;
    }
    return addr + bytes <= NRF_FLASH_BASE + NRF_FLASH_SIZE;
}

swd_status_t nrf_swd_erase_page(nrf_swd_t* n, uint32_t addr)
{
    if (n == NULL || (addr & (NRF_FLASH_PAGE - 1u)) != 0) {
        return SWD_ERR_ARG;
    }
    if (addr >= NRF_FLASH_BASE + NRF_FLASH_SIZE) {
        return SWD_ERR_ARG;
    }

    swd_status_t st = nvmc_set_config(n, NRF_NVMC_CONFIG_EEN);
    if (st != SWD_OK) {
        return nvmc_finish(n, st);
    }
    st = swd_mem_write32(&n->mem, NRF_NVMC_ERASEPAGE, addr);
    if (st != SWD_OK) {
        return nvmc_finish(n, st);
    }
    st = nvmc_wait_ready(n);
    return nvmc_finish(n, st);
}

swd_status_t nrf_swd_erase_all(nrf_swd_t* n)
{
    if (n == NULL) {
        return SWD_ERR_ARG;
    }

    swd_status_t st = nvmc_set_config(n, NRF_NVMC_CONFIG_EEN);
    if (st != SWD_OK) {
        return nvmc_finish(n, st);
    }
    st = swd_mem_write32(&n->mem, NRF_NVMC_ERASEALL, 1u);
    if (st != SWD_OK) {
        return nvmc_finish(n, st);
    }
    st = nvmc_wait_ready(n);
    return nvmc_finish(n, st);
}

swd_status_t nrf_swd_write(nrf_swd_t* n, uint32_t addr, const uint32_t* words, uint32_t count)
{
    if (n == NULL || words == NULL || !flash_range_ok(addr, count)) {
        return SWD_ERR_ARG;
    }
    if (count == 0) {
        return SWD_OK;
    }

    swd_status_t st = nvmc_set_config(n, NRF_NVMC_CONFIG_WEN);
    if (st != SWD_OK) {
        return nvmc_finish(n, st);
    }
    st = swd_mem_write_block(&n->mem, addr, words, count);
    if (st != SWD_OK) {
        return nvmc_finish(n, st);
    }
    st = nvmc_wait_ready(n);
    return nvmc_finish(n, st);
}

swd_status_t nrf_swd_read(nrf_swd_t* n, uint32_t addr, uint32_t* out, uint32_t count)
{
    if (n == NULL || out == NULL) {
        return SWD_ERR_ARG;
    }
    return swd_mem_read_block(&n->mem, addr, out, count);
}

swd_status_t nrf_swd_verify(nrf_swd_t* n, uint32_t addr, const uint32_t* words, uint32_t count)
{
    if (n == NULL || words == NULL || (addr & 3u) != 0) {
        return SWD_ERR_ARG;
    }

    /* Read back in chunks so verifying a whole image needs no big buffer. */
    uint32_t buf[64];
    uint32_t done = 0;
    while (done < count) {
        uint32_t chunk = count - done;
        if (chunk > (uint32_t)(sizeof(buf) / sizeof(buf[0]))) {
            chunk = (uint32_t)(sizeof(buf) / sizeof(buf[0]));
        }
        swd_status_t st = swd_mem_read_block(&n->mem, addr + done * 4u, buf, chunk);
        if (st != SWD_OK) {
            return st;
        }
        for (uint32_t i = 0; i < chunk; i++) {
            if (buf[i] != words[done + i]) {
                return SWD_ERR_VERIFY;
            }
        }
        done += chunk;
    }
    return SWD_OK;
}
