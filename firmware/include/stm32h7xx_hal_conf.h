#ifndef STM32H7XX_HAL_CONF_H
#define STM32H7XX_HAL_CONF_H

#ifdef __cplusplus
extern "C" {
#endif

/* -----------------------------------------------------------------------
 * Module selection — only enable what we use
 * ----------------------------------------------------------------------- */
#define HAL_MODULE_ENABLED
#define HAL_CORTEX_MODULE_ENABLED
#define HAL_DMA_MODULE_ENABLED
#define HAL_ETH_MODULE_ENABLED
#define HAL_EXTI_MODULE_ENABLED
#define HAL_FLASH_MODULE_ENABLED
#define HAL_GPIO_MODULE_ENABLED
#define HAL_PWR_MODULE_ENABLED
#define HAL_RCC_MODULE_ENABLED
#define HAL_SPI_MODULE_ENABLED
#define HAL_TIM_MODULE_ENABLED
#define HAL_IWDG_MODULE_ENABLED
#define HAL_UART_MODULE_ENABLED

/* -----------------------------------------------------------------------
 * Oscillator values
 * Nucleo-H723ZG: 8 MHz HSE from ST-LINK MCO output
 * ----------------------------------------------------------------------- */
#if !defined(HSE_VALUE)
#define HSE_VALUE    ((uint32_t)8000000U)
#endif

#if !defined(HSE_STARTUP_TIMEOUT)
#define HSE_STARTUP_TIMEOUT    ((uint32_t)100U)
#endif

#if !defined(CSI_VALUE)
#define CSI_VALUE    ((uint32_t)4000000U)
#endif

#if !defined(HSI_VALUE)
#define HSI_VALUE    ((uint32_t)64000000U)
#endif

#if !defined(LSE_VALUE)
#define LSE_VALUE    ((uint32_t)32768U)
#endif

#if !defined(LSE_STARTUP_TIMEOUT)
#define LSE_STARTUP_TIMEOUT    ((uint32_t)5000U)
#endif

#if !defined(LSI_VALUE)
#define LSI_VALUE    ((uint32_t)32000U)
#endif

#if !defined(EXTERNAL_CLOCK_VALUE)
#define EXTERNAL_CLOCK_VALUE    ((uint32_t)12288000U)
#endif

/* -----------------------------------------------------------------------
 * System configuration
 * ----------------------------------------------------------------------- */
#define VDD_VALUE                    ((uint32_t)3300U)
#define TICK_INT_PRIORITY            ((uint32_t)15U)
#define USE_RTOS                     0U
#define PREFETCH_ENABLE              1U
#define ART_ACCELERATOR_ENABLE       1U

/* -----------------------------------------------------------------------
 * Ethernet configuration
 * ----------------------------------------------------------------------- */
#define ETH_TX_DESC_CNT              4U
#define ETH_RX_DESC_CNT              4U
#define ETH_MAC_ADDR0                ((uint8_t)0x02)
#define ETH_MAC_ADDR1                ((uint8_t)0x00)
#define ETH_MAC_ADDR2                ((uint8_t)0x00)
#define ETH_MAC_ADDR3                ((uint8_t)0x00)
#define ETH_MAC_ADDR4                ((uint8_t)0x00)
#define ETH_MAC_ADDR5                ((uint8_t)0x01)

/* -----------------------------------------------------------------------
 * HAL driver includes
 * ----------------------------------------------------------------------- */
#ifdef HAL_RCC_MODULE_ENABLED
  #include "stm32h7xx_hal_rcc.h"
  #include "stm32h7xx_hal_rcc_ex.h"
#endif

#ifdef HAL_GPIO_MODULE_ENABLED
  #include "stm32h7xx_hal_gpio.h"
  #include "stm32h7xx_hal_gpio_ex.h"
#endif

#ifdef HAL_DMA_MODULE_ENABLED
  #include "stm32h7xx_hal_dma.h"
  #include "stm32h7xx_hal_dma_ex.h"
#endif

#ifdef HAL_CORTEX_MODULE_ENABLED
  #include "stm32h7xx_hal_cortex.h"
#endif

#ifdef HAL_ETH_MODULE_ENABLED
  #include "stm32h7xx_hal_eth.h"
  #include "stm32h7xx_hal_eth_ex.h"
#endif

#ifdef HAL_EXTI_MODULE_ENABLED
  #include "stm32h7xx_hal_exti.h"
#endif

#ifdef HAL_FLASH_MODULE_ENABLED
  #include "stm32h7xx_hal_flash.h"
  #include "stm32h7xx_hal_flash_ex.h"
#endif

#ifdef HAL_PWR_MODULE_ENABLED
  #include "stm32h7xx_hal_pwr.h"
  #include "stm32h7xx_hal_pwr_ex.h"
#endif

#ifdef HAL_SPI_MODULE_ENABLED
  #include "stm32h7xx_hal_spi.h"
  #include "stm32h7xx_hal_spi_ex.h"
#endif

#ifdef HAL_TIM_MODULE_ENABLED
  #include "stm32h7xx_hal_tim.h"
  #include "stm32h7xx_hal_tim_ex.h"
#endif

#ifdef HAL_IWDG_MODULE_ENABLED
  #include "stm32h7xx_hal_iwdg.h"
#endif

#ifdef HAL_UART_MODULE_ENABLED
  #include "stm32h7xx_hal_uart.h"
  #include "stm32h7xx_hal_uart_ex.h"
#endif

/* -----------------------------------------------------------------------
 * Assert macro
 * ----------------------------------------------------------------------- */
#ifdef USE_FULL_ASSERT
  #define assert_param(expr) ((expr) ? (void)0U : assert_failed((uint8_t *)__FILE__, __LINE__))
  void assert_failed(uint8_t *file, uint32_t line);
#else
  #define assert_param(expr) ((void)0U)
#endif

#ifdef __cplusplus
}
#endif

#endif /* STM32H7XX_HAL_CONF_H */
