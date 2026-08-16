#ifndef OTA_FLASH_H
#define OTA_FLASH_H

/**
 * Real flash backend for the OTA staging slot (sectors 4-6).
 *
 * Thin HAL adapter behind ota_flash_ops_t — all the interesting logic lives in
 * ota_image.c, which is host-tested. Keep this file boring.
 *
 * Layout comes from firmware/linker/STM32H723ZGTx_FLASH.ld; the static asserts
 * in ota_flash.c are what keep the two from drifting apart.
 */

#include "ota_image.h"

#ifdef __cplusplus
extern "C" {
#endif

#define OTA_SLOT_ADDR 0x08080000u
#define OTA_SLOT_SIZE (384u * 1024u)
#define OTA_SLOT_FIRST_SECTOR 4u
#define OTA_SLOT_NUM_SECTORS 3u

/** Flash ops bound to the staging slot. Never NULL. */
const ota_flash_ops_t* ota_flash_ops(void);

#ifdef __cplusplus
}
#endif

#endif /* OTA_FLASH_H */
