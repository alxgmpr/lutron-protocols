#ifndef BSP_H
#define BSP_H

#include "stm32h7xx_hal.h"
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* -----------------------------------------------------------------------
 * Pin definitions for Nucleo-H723ZG
 * ----------------------------------------------------------------------- */

/* CC1101 SPI3 (all on CN11) */
#define CC1101_SPI            SPI3
#define CC1101_SCK_PORT       GPIOC
#define CC1101_SCK_PIN        GPIO_PIN_10 /* PC10 SPI3_SCK  (AF6) CN11-1 */
#define CC1101_MISO_PORT      GPIOC
#define CC1101_MISO_PIN       GPIO_PIN_11 /* PC11 SPI3_MISO (AF6) CN11-2 */
#define CC1101_MOSI_PORT      GPIOC
#define CC1101_MOSI_PIN       GPIO_PIN_12 /* PC12 SPI3_MOSI (AF6) CN11-3 */
#define CC1101_CS_PORT        GPIOA
#define CC1101_CS_PIN         GPIO_PIN_4 /* PA4  Software NSS     CN11-16 */
#define CC1101_GDO0_PORT      GPIOA
#define CC1101_GDO0_PIN       GPIO_PIN_0 /* PA0  EXTI0 — sync detect IRQ CN11-12 */
#define CC1101_GDO0_EXTI_IRQn EXTI0_IRQn

/* Optional backup IRQ from CC1101 GDO2. Wire only if needed. */
#define CC1101_GDO2_BACKUP_ENABLE 1
#define CC1101_GDO2_PORT          GPIOB
#define CC1101_GDO2_PIN           GPIO_PIN_1 /* PB1  EXTI1 */
#define CC1101_GDO2_EXTI_IRQn     EXTI1_IRQn

/* nRF52840 NCP USART2 */
#define NRF_USART   USART2
#define NRF_TX_PORT GPIOD
#define NRF_TX_PIN  GPIO_PIN_5 /* PD5  USART2_TX */
#define NRF_RX_PORT GPIOD
#define NRF_RX_PIN  GPIO_PIN_6 /* PD6  USART2_RX */

/* Shell USART3 (ST-LINK VCP) */
#define SHELL_USART   USART3
#define SHELL_TX_PORT GPIOD
#define SHELL_TX_PIN  GPIO_PIN_8 /* PD8  USART3_TX */
#define SHELL_RX_PORT GPIOD
#define SHELL_RX_PIN  GPIO_PIN_9 /* PD9  USART3_RX */

/* User LEDs */
#define LED_GREEN_PORT  GPIOB
#define LED_GREEN_PIN   GPIO_PIN_0 /* PB0  LD1 Green */
#define LED_YELLOW_PORT GPIOE
#define LED_YELLOW_PIN  GPIO_PIN_1 /* PE1  LD2 Yellow */
#define LED_RED_PORT    GPIOB
#define LED_RED_PIN     GPIO_PIN_14 /* PB14 LD3 Red */

/* Ethernet RMII pins (hardwired on Nucleo to LAN8742A PHY) */
#define ETH_REF_CLK_PORT GPIOA
#define ETH_REF_CLK_PIN  GPIO_PIN_1 /* PA1  ETH_RMII_REF_CLK */
#define ETH_MDIO_PORT    GPIOA
#define ETH_MDIO_PIN     GPIO_PIN_2 /* PA2  ETH_RMII_MDIO */
#define ETH_CRS_DV_PORT  GPIOA
#define ETH_CRS_DV_PIN   GPIO_PIN_7 /* PA7  ETH_RMII_CRS_DV */
#define ETH_MDC_PORT     GPIOC
#define ETH_MDC_PIN      GPIO_PIN_1 /* PC1  ETH_RMII_MDC */
#define ETH_RXD0_PORT    GPIOC
#define ETH_RXD0_PIN     GPIO_PIN_4 /* PC4  ETH_RMII_RXD0 */
#define ETH_RXD1_PORT    GPIOC
#define ETH_RXD1_PIN     GPIO_PIN_5 /* PC5  ETH_RMII_RXD1 */
#define ETH_TX_EN_PORT   GPIOG
#define ETH_TX_EN_PIN    GPIO_PIN_11 /* PG11 ETH_RMII_TX_EN */
#define ETH_TXD0_PORT    GPIOG
#define ETH_TXD0_PIN     GPIO_PIN_13 /* PG13 ETH_RMII_TXD0 */
#define ETH_TXD1_PORT    GPIOB
#define ETH_TXD1_PIN     GPIO_PIN_13 /* PB13 ETH_RMII_TXD1 */

/* LAN8742A PHY address (typically 0 on Nucleo) */
#define LAN8742A_PHY_ADDR 0

/* -----------------------------------------------------------------------
 * Peripheral handles (defined in respective .c files)
 * ----------------------------------------------------------------------- */
extern SPI_HandleTypeDef  hspi3;
extern DMA_HandleTypeDef  hdma_spi3_rx;
extern DMA_HandleTypeDef  hdma_spi3_tx;
extern UART_HandleTypeDef huart2;
extern UART_HandleTypeDef huart3;
extern DMA_HandleTypeDef  hdma_usart3_tx;
extern ETH_HandleTypeDef  heth;

/* -----------------------------------------------------------------------
 * BSP init functions
 * ----------------------------------------------------------------------- */
void bsp_clock_init(void);
void bsp_gpio_init(void);
void bsp_spi_init(void);
void bsp_uart_init(void);

/* EXTI telemetry for CC1101 debug */
uint32_t bsp_exti_gdo0_count(void);
uint32_t bsp_exti_gdo2_count(void);
void     bsp_exti_counts_reset(void);

/* -----------------------------------------------------------------------
 * USART2 RX ring buffer (interrupt-driven, for nRF52840 NCP)
 * ----------------------------------------------------------------------- */
/** Return number of bytes available in USART2 RX ring buffer */
size_t bsp_uart2_rx_available(void);

/** Read one byte from USART2 RX ring buffer. Returns false if empty. */
bool bsp_uart2_rx_read(uint8_t* byte);

/** Change USART2 baud rate (for DFU bootloader mode switch). */
void bsp_uart2_set_baud(uint32_t baud);

/* -----------------------------------------------------------------------
 * LED helpers
 * ----------------------------------------------------------------------- */
#define LED_GREEN_ON()     HAL_GPIO_WritePin(LED_GREEN_PORT, LED_GREEN_PIN, GPIO_PIN_SET)
#define LED_GREEN_OFF()    HAL_GPIO_WritePin(LED_GREEN_PORT, LED_GREEN_PIN, GPIO_PIN_RESET)
#define LED_GREEN_TOGGLE() HAL_GPIO_TogglePin(LED_GREEN_PORT, LED_GREEN_PIN)

#define LED_YELLOW_ON()     HAL_GPIO_WritePin(LED_YELLOW_PORT, LED_YELLOW_PIN, GPIO_PIN_SET)
#define LED_YELLOW_OFF()    HAL_GPIO_WritePin(LED_YELLOW_PORT, LED_YELLOW_PIN, GPIO_PIN_RESET)
#define LED_YELLOW_TOGGLE() HAL_GPIO_TogglePin(LED_YELLOW_PORT, LED_YELLOW_PIN)

#define LED_RED_ON()     HAL_GPIO_WritePin(LED_RED_PORT, LED_RED_PIN, GPIO_PIN_SET)
#define LED_RED_OFF()    HAL_GPIO_WritePin(LED_RED_PORT, LED_RED_PIN, GPIO_PIN_RESET)
#define LED_RED_TOGGLE() HAL_GPIO_TogglePin(LED_RED_PORT, LED_RED_PIN)

#ifdef __cplusplus
}
#endif

#endif /* BSP_H */
