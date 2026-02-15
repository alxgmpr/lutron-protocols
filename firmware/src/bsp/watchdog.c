#include "watchdog.h"
#include "stm32h7xx_hal.h"
#include <stdio.h>

static IWDG_HandleTypeDef hiwdg;

void watchdog_init(void)
{
    /*
     * LSI ≈ 32 KHz
     * Prescaler /128 → 250 Hz counter
     * Reload 2500 → 2500 / 250 = 10 seconds timeout
     */
    hiwdg.Instance       = IWDG1;
    hiwdg.Init.Prescaler = IWDG_PRESCALER_128;
    hiwdg.Init.Reload    = 2500;
    hiwdg.Init.Window    = IWDG_WINDOW_DISABLE;

    if (HAL_IWDG_Init(&hiwdg) != HAL_OK) {
        printf("[wdg] IWDG init failed!\r\n");
        return;
    }

    printf("[wdg] IWDG started (~10s timeout)\r\n");
}

void watchdog_feed(void)
{
    HAL_IWDG_Refresh(&hiwdg);
}
