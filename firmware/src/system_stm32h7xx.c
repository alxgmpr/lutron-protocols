/**
 * System initialization for STM32H723ZGTx.
 *
 * SystemInit() is called by the CMSIS startup code before main().
 * It sets up the FPU, vector table offset, and basic power config.
 * The actual clock tree is configured in bsp_clock_init().
 */

#include "stm32h7xx.h"

/* CMSIS global variables required by the HAL */
uint32_t SystemCoreClock = 64000000UL;  /* Default HSI, updated by bsp_clock_init() */
uint32_t SystemD2Clock   = 64000000UL;  /* D2 domain clock */
const uint8_t D1CorePrescTable[16] = {
    0, 0, 0, 0, 1, 2, 3, 4, 1, 2, 3, 4, 6, 7, 8, 9
};

/**
 * Configure MPU to mark ETH DMA memory (RAM_D2) as non-cacheable.
 *
 * Uses direct CMSIS register writes (no HAL dependency) since this
 * runs in SystemInit before HAL_Init().
 *
 * Region 0: 0x30000000, 32 KB — Normal Non-cacheable
 * TEX=1, C=0, B=0, S=0 → Normal memory, non-cacheable
 */
static void MPU_Config(void)
{
    __DMB();

    /* Disable MPU */
    MPU->CTRL = 0;

    /* Region 0: RAM_D2 (0x30000000, 32 KB) — Non-cacheable */
    MPU->RNR  = 0;                          /* Region number 0 */
    MPU->RBAR = 0x30000000;                 /* Base address */
    MPU->RASR = (0x01 << 28)               /* XN = 1: no execute */
              | (0x03 << 24)               /* AP = 011: full access */
              | (0x01 << 19)               /* TEX = 001 */
              | (0x00 << 17)               /* S = 0 */
              | (0x00 << 16)               /* C = 0 */
              | (0x00 << 15)               /* B = 0: non-cacheable, non-bufferable */
              | (14 << 1)                  /* SIZE = 14 → 2^(14+1) = 32 KB */
              | (0x01 << 0);               /* ENABLE = 1 */

    /* Enable MPU with PRIVDEFENA (default map for regions not covered) */
    MPU->CTRL = MPU_CTRL_ENABLE_Msk | MPU_CTRL_PRIVDEFENA_Msk;

    __DSB();
    __ISB();
}

/**
 * Setup the microcontroller system.
 * Called from startup_stm32h723xx.s before main().
 */
void SystemInit(void)
{
    /* FPU settings: enable CP10 and CP11 (full access) */
#if (__FPU_PRESENT == 1) && (__FPU_USED == 1)
    SCB->CPACR |= ((3UL << 20U) | (3UL << 22U));  /* CP10 + CP11 Full Access */
#endif

    /* Reset the RCC clock configuration to default reset state */
    /* Set HSION bit */
    RCC->CR |= RCC_CR_HSION;

    /* Reset CFGR register */
    RCC->CFGR = 0x00000000;

    /* Reset HSEON, PLL1ON bits */
    RCC->CR &= ~(RCC_CR_HSEON | RCC_CR_PLL1ON);

    /* Reset PLLCFGR register */
    RCC->PLLCFGR = 0x01FF0000;

    /* Reset HSEBYP bit */
    RCC->CR &= ~(RCC_CR_HSEBYP);

    /* Disable all clock interrupts */
    RCC->CIER = 0x00000000;

    /* Set vector table offset (FLASH) */
    SCB->VTOR = FLASH_BANK1_BASE;

    /* Configure MPU before enabling caches */
    MPU_Config();

    /* Enable instruction cache (I-Cache) */
    SCB_EnableICache();

    /* Enable data cache (D-Cache) */
    SCB_EnableDCache();
}
