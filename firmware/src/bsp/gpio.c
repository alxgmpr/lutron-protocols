#include "bsp.h"

/**
 * Initialize GPIO pin multiplexing for all peripherals.
 *
 * Enables clocks for used GPIO ports and configures:
 * - SPI3 pins (PC10 SCK, PC11 MISO, PC12 MOSI, PA4 CS)
 * - CC1101 GDO0 interrupt (PA0 EXTI0)
 * - USART2 pins (PD5 TX, PD6 RX) for nRF52840 NCP
 * - USART3 pins (PD8 TX, PD9 RX) for shell VCP
 * - Ethernet RMII pins
 * - User LEDs (PB0, PE1, PB14)
 */
void bsp_gpio_init(void)
{
    GPIO_InitTypeDef gpio = {0};

    /* Needed for GPIO->EXTI line mapping registers (EXTICR). */
    __HAL_RCC_SYSCFG_CLK_ENABLE();

    /* Enable GPIO port clocks */
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_GPIOC_CLK_ENABLE();
    __HAL_RCC_GPIOD_CLK_ENABLE();
    __HAL_RCC_GPIOE_CLK_ENABLE();
    __HAL_RCC_GPIOG_CLK_ENABLE();

    /* --- User LEDs (push-pull output) --- */
    gpio.Mode = GPIO_MODE_OUTPUT_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_LOW;

    gpio.Pin = LED_GREEN_PIN;
    HAL_GPIO_Init(LED_GREEN_PORT, &gpio);

    gpio.Pin = LED_YELLOW_PIN;
    HAL_GPIO_Init(LED_YELLOW_PORT, &gpio);

    gpio.Pin = LED_RED_PIN;
    HAL_GPIO_Init(LED_RED_PORT, &gpio);

    /* All LEDs off */
    LED_GREEN_OFF();
    LED_YELLOW_OFF();
    LED_RED_OFF();

    /* --- CC1101 CS (software NSS, push-pull, start HIGH) --- */
    HAL_GPIO_WritePin(CC1101_CS_PORT, CC1101_CS_PIN, GPIO_PIN_SET);
    gpio.Pin = CC1101_CS_PIN;
    gpio.Mode = GPIO_MODE_OUTPUT_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(CC1101_CS_PORT, &gpio);

    /* --- CC1101 GDO0 (EXTI both edges)
     * IOCFG0 modes used for tuning can assert/deassert differently depending
     * on infinite-length RX framing. Catch both transitions to avoid starving
     * task notifications when one polarity is sparse. */
    gpio.Pin = CC1101_GDO0_PIN;
    gpio.Mode = GPIO_MODE_IT_RISING_FALLING;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(CC1101_GDO0_PORT, &gpio);

    /* EXTI interrupt — priority below FreeRTOS ceiling */
    HAL_NVIC_SetPriority(CC1101_GDO0_EXTI_IRQn, 6, 0);
    HAL_NVIC_EnableIRQ(CC1101_GDO0_EXTI_IRQn);

#if CC1101_GDO2_BACKUP_ENABLE
    /* Optional backup IRQ line (GDO2) */
    gpio.Pin = CC1101_GDO2_PIN;
    gpio.Mode = GPIO_MODE_IT_RISING_FALLING;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(CC1101_GDO2_PORT, &gpio);

    HAL_NVIC_SetPriority(CC1101_GDO2_EXTI_IRQn, 6, 0);
    HAL_NVIC_EnableIRQ(CC1101_GDO2_EXTI_IRQn);
#endif

    /* --- SPI3 pins: PC10 SCK, PC11 MISO, PC12 MOSI (AF6) --- */
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF6_SPI3;

    gpio.Pin = CC1101_SCK_PIN;
    HAL_GPIO_Init(CC1101_SCK_PORT, &gpio);

    gpio.Pin = CC1101_MISO_PIN;
    HAL_GPIO_Init(CC1101_MISO_PORT, &gpio);

    gpio.Pin = CC1101_MOSI_PIN;
    HAL_GPIO_Init(CC1101_MOSI_PORT, &gpio);

    /* --- USART2 pins: PD5 TX, PD6 RX (AF7) --- */
    gpio.Alternate = GPIO_AF7_USART2;

    gpio.Pin = NRF_TX_PIN;
    HAL_GPIO_Init(NRF_TX_PORT, &gpio);

    gpio.Pin = NRF_RX_PIN;
    HAL_GPIO_Init(NRF_RX_PORT, &gpio);

    /* --- USART3 pins: PD8 TX, PD9 RX (AF7) --- */
    gpio.Alternate = GPIO_AF7_USART3;

    gpio.Pin = SHELL_TX_PIN;
    HAL_GPIO_Init(SHELL_TX_PORT, &gpio);

    gpio.Pin = SHELL_RX_PIN;
    HAL_GPIO_Init(SHELL_RX_PORT, &gpio);

    /* --- Ethernet RMII pins --- */
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = GPIO_AF11_ETH;

    /* PA1 REF_CLK, PA2 MDIO, PA7 CRS_DV */
    gpio.Pin = ETH_REF_CLK_PIN;
    HAL_GPIO_Init(ETH_REF_CLK_PORT, &gpio);

    gpio.Pin = ETH_MDIO_PIN;
    HAL_GPIO_Init(ETH_MDIO_PORT, &gpio);

    gpio.Pin = ETH_CRS_DV_PIN;
    HAL_GPIO_Init(ETH_CRS_DV_PORT, &gpio);

    /* PC1 MDC, PC4 RXD0, PC5 RXD1 */
    gpio.Pin = ETH_MDC_PIN;
    HAL_GPIO_Init(ETH_MDC_PORT, &gpio);

    gpio.Pin = ETH_RXD0_PIN;
    HAL_GPIO_Init(ETH_RXD0_PORT, &gpio);

    gpio.Pin = ETH_RXD1_PIN;
    HAL_GPIO_Init(ETH_RXD1_PORT, &gpio);

    /* PG11 TX_EN, PG13 TXD0 */
    gpio.Pin = ETH_TX_EN_PIN;
    HAL_GPIO_Init(ETH_TX_EN_PORT, &gpio);

    gpio.Pin = ETH_TXD0_PIN;
    HAL_GPIO_Init(ETH_TXD0_PORT, &gpio);

    /* PB13 TXD1 */
    gpio.Pin = ETH_TXD1_PIN;
    HAL_GPIO_Init(ETH_TXD1_PORT, &gpio);
}
