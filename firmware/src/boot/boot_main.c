/**
 * OTA bootloader (GLAB-106).
 *
 * Runs from flash sector 0. Decides what to do, optionally copies the staged
 * image over the application, and jumps. Deliberately small and dependency-free:
 * no FreeRTOS, no lwIP, no heap, no interrupts enabled.
 *
 * All of the decision logic lives in boot_policy.c and is host-tested; this file
 * is the hardware around it.
 *
 * Recovery contract: the staging slot is the source of truth until a copy
 * completes. If power is lost mid-copy the application region is left invalid,
 * boot_decide() returns BOOT_INSTALL again on the next boot, and the copy
 * restarts from the (still verified) staged image.
 */

#include "boot_policy.h"
#include "boot_request.h"
#include "crc32.h"
#include "ota_flash.h"
#include "ota_image.h"
#include "w25q_spi.h"

#include "stm32h7xx.h"

#include <string.h>

#define APP_BASE 0x08020000u
#define APP_SIZE (768u * 1024u)
#define APP_FIRST_SECTOR 1u
#define APP_NUM_SECTORS 6u

/* Keep the flash map here and in the linker script from drifting apart. */
_Static_assert(APP_BASE == 0x08000000u + APP_FIRST_SECTOR * 128u * 1024u, "app base/sector mismatch");
_Static_assert(APP_SIZE == APP_NUM_SECTORS * 128u * 1024u, "app size/sector mismatch");
_Static_assert(APP_BASE + APP_SIZE == 0x080E0000u, "app region must end where flash storage begins");

/* The staging slot is on the external SPI NOR, so it cannot be dereferenced —
 * every read of it is a transaction that can fail. `ops` is NULL when the part
 * did not answer at all, which is a different thing from a bad image: a wire
 * off the flash must still boot whatever application is already installed. */
static const ota_flash_ops_t* g_slot;

static bool slot_read(uint32_t offset, uint8_t* out, uint32_t len)
{
    return g_slot != NULL && g_slot->read(g_slot->ctx, offset, out, len) == 0;
}

/* -----------------------------------------------------------------------
 * Interrupt handlers
 *
 * The bootloader does not link stm32h7xx_it.c, so it must supply its own.
 * HAL_Init() starts SysTick, and without a handler the first tick lands in the
 * CMSIS Default_Handler, which is an infinite loop — the bootloader would hang
 * before ever reaching the application.
 * ----------------------------------------------------------------------- */

void SysTick_Handler(void)
{
    HAL_IncTick();
}

/* A fault here means the bootloader itself is broken and there is nothing left
 * to hand over to. Reset rather than spin, so a transient fault gets one more
 * chance; a persistent one is visible as a reset loop. */
void HardFault_Handler(void)
{
    NVIC_SystemReset();
}
void MemManage_Handler(void)
{
    NVIC_SystemReset();
}
void BusFault_Handler(void)
{
    NVIC_SystemReset();
}
void UsageFault_Handler(void)
{
    NVIC_SystemReset();
}

/* -----------------------------------------------------------------------
 * Staged image
 * ----------------------------------------------------------------------- */

/** Read the staged header and re-verify the image CRC before trusting it.
 *  The header was written after a verify at upload time, but this costs a few
 *  milliseconds and covers flash that decayed or was disturbed since. */
static bool staged_image_valid(uint32_t* out_len, uint32_t* out_crc)
{
    if (g_slot == NULL) return false;

    ota_image_header_t hdr;
    if (!slot_read(OTA_SLOT_SIZE - OTA_FLASH_WORD, (uint8_t*)&hdr, sizeof(hdr))) return false;

    if (hdr.magic != OTA_IMAGE_MAGIC) return false;
    if (crc32_compute((const uint8_t*)&hdr, offsetof(ota_image_header_t, header_crc32)) != hdr.header_crc32) {
        return false;
    }
    if (hdr.image_len == 0 || hdr.image_len > OTA_SLOT_SIZE - OTA_FLASH_WORD) return false;
    if (hdr.image_len > APP_SIZE) return false;

    /* Streamed, because the slot is no longer memory-mapped and the image does
     * not fit in RAM. Same CRC either way — crc32_compute() is these two
     * wrapped around a single loop. */
    uint32_t crc = CRC32_INIT;
    uint8_t buf[256];
    for (uint32_t off = 0; off < hdr.image_len; off += sizeof(buf)) {
        uint32_t n = hdr.image_len - off;
        if (n > sizeof(buf)) n = sizeof(buf);
        if (!slot_read(off, buf, n)) return false;
        crc = crc32_update(crc, buf, n);
        if ((IWDG1->SR & 0x7u) == 0) IWDG1->KR = 0xAAAAu;
    }
    if (crc32_final(crc) != hdr.image_crc32) return false;

    *out_len = hdr.image_len;
    *out_crc = hdr.image_crc32;
    return true;
}

/* -----------------------------------------------------------------------
 * Application region
 * ----------------------------------------------------------------------- */

static bool app_bootable(void)
{
    const uint32_t* v = (const uint32_t*)(uintptr_t)APP_BASE;
    return boot_vector_plausible(v[0], v[1], APP_BASE, APP_SIZE);
}

/** Erase the application sectors and copy the staged image over them. */
static bool install_staged(uint32_t image_len, uint32_t image_crc)
{
    HAL_FLASH_Unlock();

    FLASH_EraseInitTypeDef erase;
    erase.TypeErase = FLASH_TYPEERASE_SECTORS;
    erase.Banks = FLASH_BANK_1;
    erase.Sector = APP_FIRST_SECTOR;
    erase.NbSectors = APP_NUM_SECTORS;
    erase.VoltageRange = FLASH_VOLTAGE_RANGE_3;

    uint32_t sector_error = 0;
    if (HAL_FLASHEx_Erase(&erase, &sector_error) != HAL_OK) {
        HAL_FLASH_Lock();
        return false;
    }
    SCB_InvalidateDCache_by_Addr((uint32_t*)(uintptr_t)APP_BASE, (int32_t)APP_SIZE);

    /* Copy whole flash words. The final partial word is padded with erase-state
     * so it programs cleanly; bytes past image_len are never executed. */
    for (uint32_t off = 0; off < image_len; off += OTA_FLASH_WORD) {
        uint8_t word[OTA_FLASH_WORD] __attribute__((aligned(4)));
        uint32_t n = image_len - off;
        if (n > OTA_FLASH_WORD) n = OTA_FLASH_WORD;
        memset(word, 0xFF, sizeof(word));
        if (!slot_read(off, word, n)) {
            HAL_FLASH_Lock();
            return false;
        }

        if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_FLASHWORD, APP_BASE + off, (uint32_t)(uintptr_t)word) != HAL_OK) {
            HAL_FLASH_Lock();
            return false;
        }
        /* Refresh the watchdog the application left running, if any. */
        if ((IWDG1->SR & 0x7u) == 0) IWDG1->KR = 0xAAAAu;
    }

    HAL_FLASH_Lock();
    SCB_InvalidateDCache_by_Addr((uint32_t*)(uintptr_t)APP_BASE, (int32_t)APP_SIZE);

    /* Confirm what actually landed rather than assuming the programs took.
     * Compared against the header CRC, which staged_image_valid() has already
     * checked against the slot contents — so this needs no second pass over
     * the SPI part. */
    return crc32_compute((const uint8_t*)(uintptr_t)APP_BASE, image_len) == image_crc;
}

/* -----------------------------------------------------------------------
 * Hand over
 * ----------------------------------------------------------------------- */

static void jump_to_app(void)
{
    uint32_t sp = *(const uint32_t*)(uintptr_t)APP_BASE;
    uint32_t pc = *(const uint32_t*)(uintptr_t)(APP_BASE + 4);

    /* Hand over with as light a touch as possible.
     *
     * Notably NOT HAL_RCC_DeInit(): on the H7 it tears down the clock tree and
     * re-runs HAL_InitTick, which restarts SysTick. A tick that fires after
     * VTOR has moved lands in the application's handler before its .data/.bss
     * or the scheduler exist. Measured symptom was the application coming up
     * with no Ethernet and no console, sitting in xTaskIncrementTick.
     *
     * The bootloader only ran HAL_Init(), so the clock tree is still near its
     * reset state and the application configures it itself. */
    __disable_irq();

    SysTick->CTRL = 0;
    SysTick->LOAD = 0;
    SysTick->VAL = 0;

    for (int i = 0; i < 8; i++) {
        NVIC->ICER[i] = 0xFFFFFFFFu;
        NVIC->ICPR[i] = 0xFFFFFFFFu;
    }

    /* Clean before invalidating: anything we wrote to the application region is
     * still in the write-back cache, and dropping it would discard the copy. */
    SCB_CleanDCache();
    SCB_DisableDCache();
    SCB_InvalidateICache();
    SCB_DisableICache();

    SCB->VTOR = APP_BASE;
    __DSB();
    __ISB();

    /* PRIMASK persists across the branch, and the FreeRTOS port masks with
     * BASEPRI rather than clearing PRIMASK — leaving it set here would hang the
     * application with interrupts off forever. */
    __enable_irq();

    __set_MSP(sp);
    ((void (*)(void))(uintptr_t)pc)();

    for (;;) {} /* not reached */
}

/** Nothing runnable. Sit still rather than looping the reset — a reset loop
 *  makes the board harder to attach to with an ST-LINK. */
static void halt(void)
{
    __disable_irq();
    for (;;) {
        __WFI();
    }
}

int main(void)
{
    HAL_Init();

    boot_request_t* req = boot_request_area();

    /* Bring the external flash up before asking anything about the slot. If it
     * does not answer, g_slot stays NULL, staged_valid is false, and the
     * decision collapses to "run whatever is installed" — a wire off the SPI
     * part must not stop the board booting. */
    g_slot = ota_flash_ops();

    uint32_t staged_len = 0;
    uint32_t staged_crc = 0;
    boot_state_t state;
    state.app_bootable = app_bootable();
    state.staged_valid = staged_image_valid(&staged_len, &staged_crc);
    state.install_requested = boot_request_pending(req);
    state.install_attempts = boot_request_attempts(req);

    switch (boot_decide(&state)) {
    case BOOT_INSTALL:
        /* Count the attempt BEFORE touching flash. If this copy wedges the
         * board, the next boot sees a higher count and eventually stops
         * retrying instead of looping forever. */
        boot_request_bump(req);

        if (install_staged(staged_len, staged_crc)) {
            boot_request_clear(req);
            jump_to_app();
        }
        /* Copy failed. The staged image is still intact, so a reset retries. */
        NVIC_SystemReset();
        break;

    case BOOT_RUN_APP:
        boot_request_clear(req);
        jump_to_app();
        break;

    case BOOT_HALT:
    default:
        halt();
        break;
    }

    halt();
    return 0;
}
