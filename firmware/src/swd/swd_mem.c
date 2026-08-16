#include "swd_mem.h"

#include <stddef.h>

void swd_mem_init(swd_mem_t* m, swd_t* s, uint8_t apsel)
{
    m->swd = s;
    m->apsel = apsel;
    m->csw = 0;
    m->csw_known = false;
}

/** Set CSW only when it actually needs to change. */
static swd_status_t set_csw(swd_mem_t* m, uint32_t addrinc)
{
    uint32_t want = SWD_CSW_PROT_BITS | SWD_CSW_SIZE_32 | addrinc;
    if (m->csw_known && m->csw == want) {
        return SWD_OK;
    }
    swd_status_t st = swd_ap_write(m->swd, m->apsel, SWD_AP_CSW, want);
    if (st != SWD_OK) {
        m->csw_known = false;
        return st;
    }
    m->csw = want;
    m->csw_known = true;
    return SWD_OK;
}

swd_status_t swd_mem_read_idr(swd_mem_t* m, uint32_t* out)
{
    if (m == NULL || out == NULL) {
        return SWD_ERR_ARG;
    }
    return swd_ap_read(m->swd, m->apsel, SWD_AP_IDR, out);
}

swd_status_t swd_mem_read32(swd_mem_t* m, uint32_t addr, uint32_t* out)
{
    if (m == NULL || out == NULL || (addr & 3u) != 0) {
        return SWD_ERR_ARG;
    }
    swd_status_t st = set_csw(m, SWD_CSW_ADDRINC_SINGLE);
    if (st != SWD_OK) {
        return st;
    }
    st = swd_ap_write(m->swd, m->apsel, SWD_AP_TAR, addr);
    if (st != SWD_OK) {
        return st;
    }
    return swd_ap_read(m->swd, m->apsel, SWD_AP_DRW, out);
}

swd_status_t swd_mem_write32(swd_mem_t* m, uint32_t addr, uint32_t val)
{
    if (m == NULL || (addr & 3u) != 0) {
        return SWD_ERR_ARG;
    }
    swd_status_t st = set_csw(m, SWD_CSW_ADDRINC_SINGLE);
    if (st != SWD_OK) {
        return st;
    }
    st = swd_ap_write(m->swd, m->apsel, SWD_AP_TAR, addr);
    if (st != SWD_OK) {
        return st;
    }
    return swd_ap_write(m->swd, m->apsel, SWD_AP_DRW, val);
}

/** Words left in the auto-increment window that @p addr sits in. */
static uint32_t words_to_boundary(uint32_t addr)
{
    return (SWD_TAR_WRAP - (addr & (SWD_TAR_WRAP - 1u))) / 4u;
}

swd_status_t swd_mem_read_block(swd_mem_t* m, uint32_t addr, uint32_t* out, uint32_t words)
{
    if (m == NULL || (out == NULL && words > 0) || (addr & 3u) != 0) {
        return SWD_ERR_ARG;
    }
    if (words == 0) {
        return SWD_OK;
    }

    swd_status_t st = set_csw(m, SWD_CSW_ADDRINC_SINGLE);
    if (st != SWD_OK) {
        return st;
    }

    uint32_t done = 0;
    while (done < words) {
        /* TAR stops incrementing at the 1 KB boundary, so retarget at each one. */
        uint32_t chunk = words_to_boundary(addr);
        if (chunk > words - done) {
            chunk = words - done;
        }
        st = swd_ap_write(m->swd, m->apsel, SWD_AP_TAR, addr);
        if (st != SWD_OK) {
            return st;
        }
        for (uint32_t i = 0; i < chunk; i++) {
            st = swd_ap_read(m->swd, m->apsel, SWD_AP_DRW, &out[done + i]);
            if (st != SWD_OK) {
                return st;
            }
        }
        addr += chunk * 4u;
        done += chunk;
    }
    return SWD_OK;
}

swd_status_t swd_mem_write_block(swd_mem_t* m, uint32_t addr, const uint32_t* in, uint32_t words)
{
    if (m == NULL || (in == NULL && words > 0) || (addr & 3u) != 0) {
        return SWD_ERR_ARG;
    }
    if (words == 0) {
        return SWD_OK;
    }

    swd_status_t st = set_csw(m, SWD_CSW_ADDRINC_SINGLE);
    if (st != SWD_OK) {
        return st;
    }

    uint32_t done = 0;
    while (done < words) {
        uint32_t chunk = words_to_boundary(addr);
        if (chunk > words - done) {
            chunk = words - done;
        }
        st = swd_ap_write(m->swd, m->apsel, SWD_AP_TAR, addr);
        if (st != SWD_OK) {
            return st;
        }
        for (uint32_t i = 0; i < chunk; i++) {
            st = swd_ap_write(m->swd, m->apsel, SWD_AP_DRW, in[done + i]);
            if (st != SWD_OK) {
                return st;
            }
        }
        addr += chunk * 4u;
        done += chunk;
    }
    return SWD_OK;
}

/* -----------------------------------------------------------------------
 * Cortex-M core debug
 * ----------------------------------------------------------------------- */

swd_status_t swd_core_halt(swd_mem_t* m)
{
    /* DHCSR discards any write whose top half is not the debug key. */
    return swd_mem_write32(m, SWD_DHCSR,
                           SWD_DHCSR_DBGKEY | SWD_DHCSR_C_DEBUGEN | SWD_DHCSR_C_HALT);
}

swd_status_t swd_core_resume(swd_mem_t* m)
{
    return swd_mem_write32(m, SWD_DHCSR, SWD_DHCSR_DBGKEY | SWD_DHCSR_C_DEBUGEN);
}

swd_status_t swd_core_sysreset(swd_mem_t* m)
{
    return swd_mem_write32(m, SWD_AIRCR, SWD_AIRCR_VECTKEY | SWD_AIRCR_SYSRESETREQ);
}

swd_status_t swd_core_set_reset_catch(swd_mem_t* m, bool enable)
{
    uint32_t demcr = 0;
    swd_status_t st = swd_mem_read32(m, SWD_DEMCR, &demcr);
    if (st != SWD_OK) {
        return st;
    }
    if (enable) {
        demcr |= SWD_DEMCR_VC_CORERESET;
    } else {
        demcr &= ~SWD_DEMCR_VC_CORERESET;
    }
    return swd_mem_write32(m, SWD_DEMCR, demcr);
}
