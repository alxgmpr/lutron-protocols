/**
 * OTA staging slot on the external SPI NOR — see ota_flash.h.
 *
 * Thin adapter behind ota_flash_ops_t. All the interesting logic is in
 * ota_image.c, which is host-tested against a RAM fake; keep this boring.
 */

#include "ota_flash.h"

#include "w25q_spi.h"

#include "stm32h7xx.h"

#include <string.h>

_Static_assert(OTA_SLOT_SIZE % OTA_FLASH_WORD == 0, "slot must be a whole number of flash words");
_Static_assert(OTA_SLOT_SIZE % OTA_SLOT_ERASE_BLOCK == 0, "slot must be a whole number of erase blocks");
_Static_assert(OTA_SLOT_ADDR % OTA_SLOT_ERASE_BLOCK == 0, "slot must start on an erase block");

/** Refresh the watchdog the application left running, if any. Erasing a
 *  megabyte takes seconds and this file is linked into the bootloader too,
 *  where there is no task loop feeding it. */
static void feed_watchdog(void)
{
    if ((IWDG1->SR & 0x7u) == 0) {
        IWDG1->KR = 0xAAAAu;
    }
}

static int ota_flash_erase(void* ctx)
{
    w25q_t* f = (w25q_t*)ctx;

    /* 64 KB at a time: sixteen commands rather than the 256 a sector erase
       would need for the same span. */
    for (uint32_t off = 0; off < OTA_SLOT_SIZE; off += OTA_SLOT_ERASE_BLOCK) {
        feed_watchdog();
        if (w25q_erase_block(f, OTA_SLOT_ADDR + off) != W25Q_OK) {
            return -1;
        }
    }
    feed_watchdog();
    return 0;
}

static int ota_flash_program(void* ctx, uint32_t offset, const uint8_t word[OTA_FLASH_WORD])
{
    w25q_t* f = (w25q_t*)ctx;
    if (offset % OTA_FLASH_WORD != 0) return -1;
    if (offset + OTA_FLASH_WORD > OTA_SLOT_SIZE) return -1;

    /* OTA_FLASH_WORD is 32 and a page is 256, so this never straddles a page —
       but w25q_program() splits anyway, so the caller does not depend on it. */
    return w25q_program(f, OTA_SLOT_ADDR + offset, word, OTA_FLASH_WORD) == W25Q_OK ? 0 : -1;
}

static int ota_flash_read(void* ctx, uint32_t offset, uint8_t* out, uint32_t len)
{
    w25q_t* f = (w25q_t*)ctx;
    if (offset + len > OTA_SLOT_SIZE) return -1;
    return w25q_read(f, OTA_SLOT_ADDR + offset, out, len) == W25Q_OK ? 0 : -1;
}

static ota_flash_ops_t OPS = {
    .erase = ota_flash_erase,
    .program = ota_flash_program,
    .read = ota_flash_read,
    .capacity = OTA_SLOT_SIZE,
    .ctx = NULL,
};

const ota_flash_ops_t* ota_flash_ops(void)
{
    /* NULL rather than ops that fail one call at a time. The part is on four
       flying leads; "the flash is not there" is a different answer from "the
       staged image is bad", and the callers act on it differently. */
    if (w25q_spi_start() != W25Q_OK) {
        return NULL;
    }
    w25q_t* f = w25q_device();
    if (w25q_capacity(f) < OTA_SLOT_ADDR + OTA_SLOT_SIZE) {
        return NULL;
    }

    OPS.ctx = f;
    return &OPS;
}
