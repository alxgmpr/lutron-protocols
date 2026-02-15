#include "bsp.h"

/**
 * Configure STM32H723 clock tree:
 *   HSE (8 MHz from ST-LINK MCO)
 *     -> PLL1 -> 550 MHz SYSCLK
 *     -> PLL1Q -> for potential peripheral clocks
 *
 * Flash latency and voltage scaling set for 550 MHz operation.
 *
 * APB clock dividers:
 *   HCLK  = SYSCLK / 2 = 275 MHz (AHB bus)
 *   APB1  = HCLK / 2   = 137.5 MHz (USART2, USART3, TIM, SPI2/3)
 *   APB2  = HCLK / 2   = 137.5 MHz (SPI1)
 *   APB3  = HCLK / 2   = 137.5 MHz
 *   APB4  = HCLK / 2   = 137.5 MHz
 */
void bsp_clock_init(void)
{
    HAL_StatusTypeDef ret;

    /* Supply configuration: LDO (default for Nucleo) */
    HAL_PWREx_ConfigSupply(PWR_LDO_SUPPLY);

    /* Voltage scaling: VOS0 required for 550 MHz */
    __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE0);
    while (!__HAL_PWR_GET_FLAG(PWR_FLAG_VOSRDY)) {}

    /* Enable HSE (8 MHz bypass from ST-LINK MCO) */
    RCC_OscInitTypeDef osc = {0};
    osc.OscillatorType = RCC_OSCILLATORTYPE_HSE;
    osc.HSEState       = RCC_HSE_BYPASS;
    osc.PLL.PLLState   = RCC_PLL_ON;
    osc.PLL.PLLSource  = RCC_PLLSOURCE_HSE;
    /* PLL1: 8 MHz / 1 * 137 / 2 = 548 MHz (close to 550 MHz limit)
     * Actually: 8 / 1 = 8 MHz VCO input, 8 * 137 = 1096 MHz VCO, / 2 = 548 MHz */
    osc.PLL.PLLM = 1;
    osc.PLL.PLLN = 137;
    osc.PLL.PLLP = 2;  /* SYSCLK = 548 MHz */
    osc.PLL.PLLQ = 4;  /* PLL1Q  = 274 MHz */
    osc.PLL.PLLR = 2;
    osc.PLL.PLLRGE   = RCC_PLL1VCIRANGE_3;   /* 8-16 MHz VCO input */
    osc.PLL.PLLVCOSEL = RCC_PLL1VCOWIDE;      /* Wide VCO range */
    osc.PLL.PLLFRACN  = 0;
    ret = HAL_RCC_OscConfig(&osc);
    if (ret != HAL_OK) { while (1); }

    /* Configure bus clocks */
    RCC_ClkInitTypeDef clk = {0};
    clk.ClockType = RCC_CLOCKTYPE_HCLK   | RCC_CLOCKTYPE_SYSCLK |
                    RCC_CLOCKTYPE_PCLK1  | RCC_CLOCKTYPE_PCLK2  |
                    RCC_CLOCKTYPE_D1PCLK1 | RCC_CLOCKTYPE_D3PCLK1;
    clk.SYSCLKSource   = RCC_SYSCLKSOURCE_PLLCLK;
    clk.SYSCLKDivider  = RCC_SYSCLK_DIV1;
    clk.AHBCLKDivider  = RCC_HCLK_DIV2;
    clk.APB1CLKDivider = RCC_APB1_DIV2;
    clk.APB2CLKDivider = RCC_APB2_DIV2;
    clk.APB3CLKDivider = RCC_APB3_DIV2;
    clk.APB4CLKDivider = RCC_APB4_DIV2;
    /* Flash latency for 275 MHz HCLK, VOS0: 3 wait states */
    ret = HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_3);
    if (ret != HAL_OK) { while (1); }

    /* Enable DWT cycle counter for microsecond delays */
    CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
    DWT->CYCCNT = 0;
    DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}
