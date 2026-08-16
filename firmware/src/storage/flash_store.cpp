/**
 * Persistent flash storage — sector 7 (0x080E0000, 128 KB).
 *
 * Uses HAL flash driver to erase/program. STM32H7 programs in 32-byte
 * "flash words" (FLASH_TYPEPROGRAM_FLASHWORD), so the settings struct
 * is padded to 256 bytes (8 flash words).
 *
 * Record integrity is a real CRC-32 (see crc32.h).
 */

#include "flash_store.h"
#include "crc32.h"
#include "spinel_props.h"
#include "stm32h7xx_hal.h"

#include <cstdio>
#include <cstring>

/* -----------------------------------------------------------------------
 * In-RAM copy of settings
 * ----------------------------------------------------------------------- */
static FlashSettings settings;

static void load_defaults(void)
{
    memset(&settings, 0, sizeof(settings));
    settings.magic = FLASH_STORE_MAGIC;
    settings.version = FLASH_STORE_VERSION;

    settings.known_count = 0;

    settings.thread_channel = LUTRON_THREAD_CHANNEL;
    settings.thread_panid = LUTRON_THREAD_PANID;
    memcpy(settings.thread_network_key, LUTRON_THREAD_MASTER_KEY, 16);
    memcpy(settings.thread_xpanid, LUTRON_THREAD_XPANID, 8);
}

/* -----------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

void flash_store_init(void)
{
    /* Read settings from flash */
    const FlashSettings* stored = (const FlashSettings*)FLASH_STORE_ADDR;

    /* Three distinct reasons to fall back to defaults. Keep them
     * distinguishable in the log: a version bump is an expected,
     * deliberate invalidation, whereas a CRC mismatch means the record
     * on flash is actually damaged. */
    if (stored->magic != FLASH_STORE_MAGIC) {
        if (stored->magic == 0xFFFFFFFFUL) {
            printf("[flash] No settings stored (sector erased) — loading defaults, run `save` to write them\r\n");
        }
        else {
            printf("[flash] No settings stored (bad magic=0x%08lX) — loading defaults, run `save` to write them\r\n",
                   (unsigned long)stored->magic);
        }
        load_defaults();
        return;
    }

    if (stored->version != FLASH_STORE_VERSION) {
        printf("[flash] Settings dropped for VERSION CHANGE: on-flash v%u, firmware expects v%u. "
               "This is a deliberate format/checksum change, not corruption. "
               "Loading defaults — run `save` to rewrite in the new format.\r\n",
               stored->version, (unsigned)FLASH_STORE_VERSION);
        load_defaults();
        return;
    }

    /* Verify CRC-32 over first 252 bytes */
    uint32_t computed = crc32_compute(stored, sizeof(FlashSettings) - sizeof(uint32_t));
    if (computed != stored->crc32) {
        printf("[flash] Settings dropped for CRC MISMATCH: stored=0x%08lX computed=0x%08lX. "
               "The stored record is damaged. Loading defaults.\r\n",
               (unsigned long)stored->crc32, (unsigned long)computed);
        load_defaults();
        return;
    }

    /* Valid — copy to RAM */
    memcpy(&settings, stored, sizeof(FlashSettings));
    printf("[flash] Settings loaded (ch=%u panid=0x%04X devices=%u)\r\n", settings.thread_channel,
           settings.thread_panid, settings.known_count);
}

bool flash_store_save(void)
{
    /* Update CRC before writing */
    settings.crc32 = crc32_compute(&settings, sizeof(FlashSettings) - sizeof(uint32_t));

    /* Unlock flash */
    HAL_FLASH_Unlock();

    /* Erase sector 7 */
    FLASH_EraseInitTypeDef erase;
    erase.TypeErase = FLASH_TYPEERASE_SECTORS;
    erase.Banks = FLASH_BANK_1;
    erase.Sector = FLASH_STORE_SECTOR;
    erase.NbSectors = 1;
    erase.VoltageRange = FLASH_VOLTAGE_RANGE_3; /* 2.7-3.6V */

    uint32_t sector_error = 0;
    HAL_StatusTypeDef status = HAL_FLASHEx_Erase(&erase, &sector_error);
    if (status != HAL_OK) {
        printf("[flash] Erase failed (status=%d sector_error=%lu)\r\n", status, (unsigned long)sector_error);
        HAL_FLASH_Lock();
        return false;
    }

    /* Program in 32-byte flash words.
     * sizeof(FlashSettings) = 256 = 8 flash words. */
    const uint8_t* src = (const uint8_t*)&settings;
    uint32_t addr = FLASH_STORE_ADDR;

    for (size_t offset = 0; offset < sizeof(FlashSettings); offset += 32) {
        status = HAL_FLASH_Program(FLASH_TYPEPROGRAM_FLASHWORD, addr + offset, (uint32_t)(uintptr_t)(src + offset));
        if (status != HAL_OK) {
            printf("[flash] Program failed at offset %u (status=%d)\r\n", (unsigned)offset, status);
            HAL_FLASH_Lock();
            return false;
        }
    }

    HAL_FLASH_Lock();

    /* Verify readback */
    if (memcmp((const void*)FLASH_STORE_ADDR, &settings, sizeof(FlashSettings)) != 0) {
        printf("[flash] Verify failed!\r\n");
        return false;
    }

    printf("[flash] Settings saved OK\r\n");
    return true;
}

const FlashSettings* flash_store_get(void)
{
    return &settings;
}

FlashSettings* flash_store_get_mut(void)
{
    return &settings;
}

void flash_store_print(void)
{
    printf("--- Stored Settings ---\r\n");
    printf("Thread channel: %u\r\n", settings.thread_channel);
    printf("Thread PAN ID:  0x%04X\r\n", settings.thread_panid);

    printf("Thread key:     ");
    for (int i = 0; i < 16; i++) printf("%02X", settings.thread_network_key[i]);
    printf("\r\n");

    printf("Thread XPANID:  ");
    for (int i = 0; i < 8; i++) printf("%02X", settings.thread_xpanid[i]);
    printf("\r\n");

    printf("Known devices:  %u\r\n", settings.known_count);
    for (uint8_t i = 0; i < settings.known_count && i < FLASH_STORE_MAX_DEVICES; i++) {
        printf("  [%u] %08lX\r\n", i, (unsigned long)settings.known_devices[i]);
    }
}
