/**
 * Bootloader decision logic — see boot_policy.h.
 */

#include "boot_policy.h"

#include <stddef.h>

boot_action_t boot_decide(const boot_state_t* s)
{
    if (s == NULL) return BOOT_HALT;

    /* Installing is only ever considered with a CRC-verified image in hand. */
    if (s->staged_valid && s->install_attempts < BOOT_MAX_INSTALL_ATTEMPTS) {
        /* Explicit request from the application, or recovery because there is
         * nothing runnable to protect. A staged image never displaces a working
         * application on its own. */
        if (s->install_requested || !s->app_bootable) {
            return BOOT_INSTALL;
        }
    }

    if (s->app_bootable) return BOOT_RUN_APP;
    return BOOT_HALT;
}

static bool sp_in_ram(uint32_t sp)
{
    /* The hardware pops an 8-byte aligned frame; anything else is not an SP. */
    if ((sp & 7u) != 0) return false;

    struct {
        uint32_t base, size;
    } const regions[] = {
        {BOOT_DTCM_BASE, BOOT_DTCM_SIZE},
        {BOOT_AXI_BASE, BOOT_AXI_SIZE},
        {BOOT_D2_BASE, BOOT_D2_SIZE},
        {BOOT_D3_BASE, BOOT_D3_SIZE},
    };

    for (unsigned i = 0; i < sizeof(regions) / sizeof(regions[0]); i++) {
        /* The initial SP is the top of the stack, so base+size is a legal value
         * (full-descending stack) — hence <= rather than <. */
        if (sp > regions[i].base && sp <= regions[i].base + regions[i].size) return true;
    }
    return false;
}

bool boot_vector_plausible(uint32_t initial_sp, uint32_t reset_pc, uint32_t app_base, uint32_t app_size)
{
    if (!sp_in_ram(initial_sp)) return false;

    /* Thumb bit must be set — branching to an even address faults immediately. */
    if ((reset_pc & 1u) == 0) return false;

    uint32_t pc = reset_pc & ~1u;
    if (pc < app_base) return false;
    if (pc >= app_base + app_size) return false;

    return true;
}
