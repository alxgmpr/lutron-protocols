#ifndef OTA_FLASH_H
#define OTA_FLASH_H

/**
 * OTA staging slot, on the external SPI NOR.
 *
 * It used to be three internal flash sectors (0x08080000, 384 KB). Moving it
 * off-chip gave that back to the application region, which had reached 82% of
 * its 384 KB with two feature branches merged. The application now has 768 KB
 * and the slot has a megabyte of a part with eight.
 *
 * Both sides of an update read this: the application stages into it, and the
 * bootloader reads it back to install. That is why the backend lives behind
 * ota_flash_ops_t and why w25q_spi.c initialises its own pins — the bootloader
 * links almost nothing else.
 *
 * The failure this introduces, and which the bootloader must survive, is the
 * flash not answering at all. It is on four flying leads; a wire can come off.
 * ota_flash_ops() returns NULL in that case rather than a set of ops that fail
 * one call at a time.
 */

#include "ota_image.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Where the staging slot lives on the external part, and how big it is. */
#define OTA_SLOT_ADDR 0x000000u
#define OTA_SLOT_SIZE (1024u * 1024u)

/** 64 KB block erase, so clearing the slot is 16 commands and not 256. */
#define OTA_SLOT_ERASE_BLOCK (64u * 1024u)

/**
 * The application region the bootloader installs into — the real ceiling on a
 * staged image, and smaller than the slot that holds it.
 *
 * Without this the two limits disagree: the slot would accept just under a
 * megabyte, stage it, and verify its CRC, and then the bootloader would reject
 * anything over 768 KB and quietly boot the old application instead. The upload
 * has to fail at `ota_service_start()`, where there is still a reply to fail in.
 *
 * boot_main.c asserts its own APP_SIZE against this.
 */
#define OTA_APP_REGION_SIZE (768u * 1024u)

/**
 * Flash ops bound to the staging slot, or NULL if the part did not answer.
 * Brings SPI1 up on first call.
 */
const ota_flash_ops_t* ota_flash_ops(void);

#ifdef __cplusplus
}
#endif

#endif /* OTA_FLASH_H */
