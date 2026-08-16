#ifndef FLASH_STORE_H
#define FLASH_STORE_H

/**
 * Persistent settings in on-chip flash (sector 7).
 *
 * STM32H723 has 8 × 128 KB sectors. Firmware uses sectors 0-6 (~896 KB).
 * Sector 7 (0x080E0000) is reserved for settings. The struct is padded
 * to 256 bytes (multiple of the 32-byte flash word size).
 *
 * On init, validates magic + version + CRC-32. If invalid (first boot or
 * corruption), loads defaults and does NOT auto-save (user must `save`).
 *
 * Version history:
 *   1 — original. Checksummed with a hand-transcribed table that was not
 *       actually CRC-32 (114 of 256 entries wrong).
 *   2 — same layout, but checksummed with real CRC-32 (crc32.h). The
 *       layout did not change; the version bump exists so that v1 records
 *       are dropped as an explicit format change rather than surfacing as
 *       a CRC mismatch that looks like flash corruption. Settings revert
 *       to defaults once on upgrade and must be re-saved.
 */

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FLASH_STORE_MAGIC 0x4C555421 /* "LUT!" */
#define FLASH_STORE_VERSION 2
#define FLASH_STORE_ADDR 0x080E0000
#define FLASH_STORE_SECTOR 7

#define FLASH_STORE_MAX_DEVICES 16

struct FlashSettings {
    /* Header (8 bytes) */
    uint32_t magic;   /* 0x4C555421 */
    uint16_t version; /* FLASH_STORE_VERSION */
    uint16_t _pad0;

    /* Known CCA devices (68 bytes) */
    uint32_t known_devices[FLASH_STORE_MAX_DEVICES];
    uint8_t known_count;
    uint8_t _pad1[3];

    /* Thread network params (28 bytes) */
    uint8_t thread_channel; /* default 25 */
    uint8_t _pad2;
    uint16_t thread_panid; /* default 0x0000 */
    uint8_t thread_network_key[16];
    uint8_t thread_xpanid[8];

    /* Reserved — pad to 256 bytes total (256 - 8 - 68 - 28 - 4 = 148) */
    uint8_t _reserved[148];

    /* CRC-32 over bytes [0..251] — last 4 bytes */
    uint32_t crc32;
};

/* Compile-time size check */
#ifdef __cplusplus
static_assert(sizeof(FlashSettings) == 256, "FlashSettings must be exactly 256 bytes");
#else
_Static_assert(sizeof(struct FlashSettings) == 256, "FlashSettings must be exactly 256 bytes");
#endif

/**
 * Initialize flash store: read sector 7, validate, load defaults if invalid.
 * Call once from main() before tasks start.
 */
void flash_store_init(void);

/**
 * Save current settings to flash sector 7.
 * Erases the sector, then programs the struct. Returns true on success.
 */
bool flash_store_save(void);

/**
 * Get pointer to the current in-RAM settings (read-only access).
 */
const struct FlashSettings* flash_store_get(void);

/**
 * Get mutable pointer (for shell commands to modify before saving).
 */
struct FlashSettings* flash_store_get_mut(void);

/**
 * Print current settings to printf.
 */
void flash_store_print(void);

#ifdef __cplusplus
}
#endif

#endif /* FLASH_STORE_H */
