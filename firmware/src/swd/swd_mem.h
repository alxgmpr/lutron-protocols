#ifndef SWD_MEM_H
#define SWD_MEM_H

/**
 * MEM-AP (AHB-AP) memory access over SWD, plus the handful of Cortex-M core
 * debug operations that flashing needs.
 *
 * Two details here are worth knowing about, because both fail quietly rather
 * than loudly:
 *
 *  - AP reads are posted. The value comes back on the *next* transfer. That is
 *    handled one level down in swd_ap_read().
 *
 *  - CSW auto-increment only increments TAR within a 1 KB window. Past the
 *    boundary the target stops incrementing and every further access hits the
 *    same address. A block transfer that does not retarget TAR at each boundary
 *    reads the same word repeatedly, or writes every remaining word of an image
 *    on top of one address. It produces plausible-looking data, not an error.
 */

#include "swd.h"

#ifdef __cplusplus
extern "C" {
#endif

/** AP indices on the nRF52840. */
#define SWD_AHB_AP 0u
#define SWD_CTRL_AP 1u

/* CSW fields */
#define SWD_CSW_SIZE_MASK 0x00000007u
#define SWD_CSW_SIZE_32 0x00000002u
#define SWD_CSW_ADDRINC_MASK 0x00000030u
#define SWD_CSW_ADDRINC_OFF 0x00000000u
#define SWD_CSW_ADDRINC_SINGLE 0x00000010u
/** DbgSwEnable | HPROT1 — without these the AHB access can be refused. */
#define SWD_CSW_PROT_BITS 0x23000000u

/** The window TAR auto-increments within before it stops. */
#define SWD_TAR_WRAP 0x400u

/* Cortex-M core debug registers */
#define SWD_DHCSR 0xE000EDF0u
#define SWD_DEMCR 0xE000EDFCu
#define SWD_AIRCR 0xE000ED0Cu

#define SWD_DHCSR_DBGKEY 0xA05F0000u
#define SWD_DHCSR_C_DEBUGEN 0x00000001u
#define SWD_DHCSR_C_HALT 0x00000002u
#define SWD_DHCSR_S_HALT 0x00020000u

#define SWD_DEMCR_VC_CORERESET 0x00000001u
#define SWD_AIRCR_VECTKEY 0x05FA0000u
#define SWD_AIRCR_SYSRESETREQ 0x00000004u

typedef struct {
    swd_t* swd;
    uint8_t apsel;
    uint32_t csw;    /* last value written to CSW */
    bool csw_known;  /* false until CSW has been written at least once */
} swd_mem_t;

/** Bind a MEM-AP view to a link. Does not touch the wire. */
void swd_mem_init(swd_mem_t* m, swd_t* s, uint8_t apsel);

/** Read the AP's IDR — 0x24770011 for the nRF52840 AHB-AP. */
swd_status_t swd_mem_read_idr(swd_mem_t* m, uint32_t* out);

/** Read one 32-bit word. @p addr must be word aligned. */
swd_status_t swd_mem_read32(swd_mem_t* m, uint32_t addr, uint32_t* out);

/** Write one 32-bit word. @p addr must be word aligned. */
swd_status_t swd_mem_write32(swd_mem_t* m, uint32_t addr, uint32_t val);

/** Read @p words consecutive words, retargeting TAR at each 1 KB boundary. */
swd_status_t swd_mem_read_block(swd_mem_t* m, uint32_t addr, uint32_t* out, uint32_t words);

/** Write @p words consecutive words, retargeting TAR at each 1 KB boundary. */
swd_status_t swd_mem_write_block(swd_mem_t* m, uint32_t addr, const uint32_t* in, uint32_t words);

/* -----------------------------------------------------------------------
 * Cortex-M core debug
 * ----------------------------------------------------------------------- */

/** Enable debug and halt the core. Required before touching flash. */
swd_status_t swd_core_halt(swd_mem_t* m);

/** Release the core, leaving debug enabled. */
swd_status_t swd_core_resume(swd_mem_t* m);

/** Request a system reset via AIRCR.SYSRESETREQ. */
swd_status_t swd_core_sysreset(swd_mem_t* m);

/** Arm the reset vector catch so the core halts out of reset instead of running. */
swd_status_t swd_core_set_reset_catch(swd_mem_t* m, bool enable);

#ifdef __cplusplus
}
#endif

#endif /* SWD_MEM_H */
