#ifndef BOOT_POLICY_H
#define BOOT_POLICY_H

/**
 * Bootloader decision logic — what to do on reset. Pure, no HAL, host-tested.
 *
 * The bootloader itself does the flash and register work; everything that
 * decides *whether* to overwrite the application lives here, because that is
 * the part where a mistake costs an ST-LINK recovery trip.
 *
 * Update model is copy-on-boot (overwrite), not A/B boot-in-place:
 *   - one link variant, so there is no way to upload the wrong one
 *   - an interrupted copy is safe, because the staging slot still holds the
 *     verified image and the copy simply retries on the next boot
 *   - NO version rollback. A 1 MB part has no room for a third slot, and the
 *     staging slot holds the new image, so there is nothing to fall back to.
 *     The protection is that the image is CRC-verified end to end before a
 *     single byte is copied.
 *
 * An install never happens by surprise: it requires an explicit request from
 * the running application (see boot_request.h). The one exception is recovery,
 * when the application region holds nothing runnable.
 */

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    BOOT_RUN_APP = 0, /* jump to the application as it stands */
    BOOT_INSTALL,     /* copy staging -> application, then jump */
    BOOT_HALT,        /* nothing safe to run */
} boot_action_t;

/**
 * Give up after this many attempts at the same install. Without a ceiling, an
 * image that passes CRC but hangs before clearing the request would reinstall
 * on every boot forever.
 */
#define BOOT_MAX_INSTALL_ATTEMPTS 3u

typedef struct {
    bool app_bootable;         /* application region holds something runnable */
    bool staged_valid;         /* staging slot holds a CRC-verified image */
    bool install_requested;    /* the application asked for an install */
    uint32_t install_attempts; /* attempts already made at this install */
} boot_state_t;

/** Decide what this boot should do. */
boot_action_t boot_decide(const boot_state_t* s);

/* -----------------------------------------------------------------------
 * Vector-table sanity check
 *
 * Lets an application flashed by ST-LINK — which carries no OTA header — still
 * be recognised as bootable. Without this the bootloader would treat a
 * perfectly good `make flash` image as missing and overwrite it.
 * ----------------------------------------------------------------------- */

/* On-chip RAM regions that an initial stack pointer may legitimately point
 * into. Must match firmware/linker/STM32H723ZGTx_FLASH.ld. */
#define BOOT_DTCM_BASE 0x20000000u
#define BOOT_DTCM_SIZE (128u * 1024u)
#define BOOT_AXI_BASE 0x24000000u
#define BOOT_AXI_SIZE (320u * 1024u)
#define BOOT_D2_BASE 0x30000000u
#define BOOT_D2_SIZE (32u * 1024u)
#define BOOT_D3_BASE 0x38000000u
#define BOOT_D3_SIZE (16u * 1024u)

/**
 * True if the first two vector-table words look like a real Cortex-M image:
 * an initial SP inside RAM, and a reset vector inside the application region
 * with the Thumb bit set. Erased flash (0xFFFFFFFF) fails both.
 */
bool boot_vector_plausible(uint32_t initial_sp, uint32_t reset_pc, uint32_t app_base, uint32_t app_size);

#ifdef __cplusplus
}
#endif

#endif /* BOOT_POLICY_H */
