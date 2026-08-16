/**
 * OTA staging slot flash backend — see ota_flash.h.
 */

#include "ota_flash.h"
#include "watchdog.h"

#include "stm32h7xx_hal.h"

#include <stdio.h>
#include <string.h>

_Static_assert(OTA_SLOT_SIZE % OTA_FLASH_WORD == 0, "slot must be a whole number of flash words");
_Static_assert(OTA_SLOT_ADDR == 0x08000000u + OTA_SLOT_FIRST_SECTOR * 128u * 1024u,
               "slot address and first sector disagree");
_Static_assert(OTA_SLOT_SIZE == OTA_SLOT_NUM_SECTORS * 128u * 1024u, "slot size and sector count disagree");

static int ota_flash_erase(void* ctx)
{
    (void)ctx;

    /* Erasing 3 x 128 KB takes on the order of a second or two. The H723 is
     * single-bank, so instruction fetch from flash stalls for the duration —
     * flash_store.cpp already erases sector 7 the same way from flash-resident
     * code, so this is a known-good pattern on this part. The IWDG is ~10 s
     * (watchdog.c) which covers it, but feed it either side to keep the margin
     * honest if the sector count ever grows. */
    watchdog_feed();

    HAL_FLASH_Unlock();

    FLASH_EraseInitTypeDef erase;
    erase.TypeErase = FLASH_TYPEERASE_SECTORS;
    erase.Banks = FLASH_BANK_1;
    erase.Sector = OTA_SLOT_FIRST_SECTOR;
    erase.NbSectors = OTA_SLOT_NUM_SECTORS;
    erase.VoltageRange = FLASH_VOLTAGE_RANGE_3; /* 2.7-3.6 V */

    uint32_t sector_error = 0;
    HAL_StatusTypeDef status = HAL_FLASHEx_Erase(&erase, &sector_error);
    HAL_FLASH_Lock();

    /* Flash is memory-mapped and cached, but erasing does not notify the cache.
     * Without this, a read of the slot returns whatever was resident before the
     * erase — which silently defeats the read-back verification in
     * ota_stage_finish() and makes a stale header look like a staged image. */
    SCB_InvalidateDCache_by_Addr((uint32_t*)(uintptr_t)OTA_SLOT_ADDR, (int32_t)OTA_SLOT_SIZE);

    watchdog_feed();

    if (status != HAL_OK) {
        printf("[ota] Erase failed (status=%d sector_error=%lu)\r\n", status, (unsigned long)sector_error);
        return -1;
    }
    return 0;
}

static int ota_flash_program(void* ctx, uint32_t offset, const uint8_t word[OTA_FLASH_WORD])
{
    (void)ctx;
    if (offset % OTA_FLASH_WORD != 0) return -1;
    if (offset + OTA_FLASH_WORD > OTA_SLOT_SIZE) return -1;

    /* HAL_FLASH_Program takes the source by address and reads 32 bytes from it;
     * copy to a local first so an unaligned caller buffer cannot fault. */
    uint8_t aligned[OTA_FLASH_WORD] __attribute__((aligned(4)));
    memcpy(aligned, word, OTA_FLASH_WORD);

    HAL_FLASH_Unlock();
    HAL_StatusTypeDef status =
        HAL_FLASH_Program(FLASH_TYPEPROGRAM_FLASHWORD, OTA_SLOT_ADDR + offset, (uint32_t)(uintptr_t)aligned);
    HAL_FLASH_Lock();

    if (status != HAL_OK) {
        printf("[ota] Program failed at slot offset %lu (status=%d)\r\n", (unsigned long)offset, status);
        return -1;
    }

    /* Same reason as the erase: drop the cache line so the verification read
     * sees flash. The M7 cache line is 32 bytes, the same as a flash word. */
    SCB_InvalidateDCache_by_Addr((uint32_t*)(uintptr_t)(OTA_SLOT_ADDR + offset), (int32_t)OTA_FLASH_WORD);
    return 0;
}

static int ota_flash_read(void* ctx, uint32_t offset, uint8_t* out, uint32_t len)
{
    (void)ctx;
    if (offset + len > OTA_SLOT_SIZE) return -1;
    memcpy(out, (const void*)(uintptr_t)(OTA_SLOT_ADDR + offset), len);
    return 0;
}

static const ota_flash_ops_t OPS = {
    .erase = ota_flash_erase,
    .program = ota_flash_program,
    .read = ota_flash_read,
    .capacity = OTA_SLOT_SIZE,
    .ctx = NULL,
};

const ota_flash_ops_t* ota_flash_ops(void)
{
    return &OPS;
}
