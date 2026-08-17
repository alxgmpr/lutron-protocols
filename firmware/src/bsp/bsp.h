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
 *
 * Connector references are ST Zio (the inner female sockets), per UM2407
 * tables 18-21. Both external modules are wired to one connector each, so a
 * harness can be built and unplugged as a unit:
 *
 *   CC1101   -> CN8, entirely (I/O on the even column, power on the odd)
 *   nRF52840 -> CN9, entirely (even column pins 2..12)
 *
 * CN7/CN8 are on one side of the board and CN9/CN10 on the other, which also
 * keeps the 433 MHz module away from the 2.4 GHz dongle.
 * ----------------------------------------------------------------------- */

/* CC1101 SPI3 — all on CN8.
 *
 * CN8's even column is eight consecutive free I/O (PC8, PC9, PC10, PC11,
 * PC12, PD2, PG2, PG3) and its odd column carries 3V3 (pin 7) and GND (pins
 * 11 and 13), so the module needs nothing from any other connector.
 *
 * The three SPI pins are unchanged from the previous wiring — PC10/11/12 are
 * on CN8 as well as CN11, so moving to the Zio side costs no peripheral or
 * alternate-function change. */
#define CC1101_SPI SPI3
#define CC1101_SCK_PORT GPIOC
#define CC1101_SCK_PIN GPIO_PIN_10 /* PC10 SPI3_SCK  (AF6)  CN8-6 */
#define CC1101_MISO_PORT GPIOC
#define CC1101_MISO_PIN GPIO_PIN_11 /* PC11 SPI3_MISO (AF6)  CN8-8 */
#define CC1101_MOSI_PORT GPIOC
#define CC1101_MOSI_PIN GPIO_PIN_12 /* PC12 SPI3_MOSI (AF6)  CN8-10 */
#define CC1101_CS_PORT GPIOC
#define CC1101_CS_PIN GPIO_PIN_9 /* PC9  Software NSS     CN8-4 */

/* GDO0 is the sync-word detect line and the timing-critical one, so it gets a
 * dedicated EXTI vector rather than one of the shared groups. */
#define CC1101_GDO0_PORT GPIOD
#define CC1101_GDO0_PIN GPIO_PIN_2 /* PD2  EXTI2 — sync detect IRQ  CN8-12 */
#define CC1101_GDO0_EXTI_IRQn EXTI2_IRQn

/* Optional backup IRQ from CC1101 GDO2. Wire only if needed.
 * EXTI8 lands in the shared EXTI9_5 group; harmless, as nothing else uses it. */
#define CC1101_GDO2_BACKUP_ENABLE 1
#define CC1101_GDO2_PORT GPIOC
#define CC1101_GDO2_PIN GPIO_PIN_8 /* PC8  EXTI8            CN8-2 */
#define CC1101_GDO2_EXTI_IRQn EXTI9_5_IRQn

/* nRF52840 NCP — all on CN9, even column pins 2..12.
 *
 * PD5/PD6 are USART2 and already sit on CN9-6/CN9-4, so the NCP link needs no
 * peripheral change. Their neighbours PD7, PD4 and PD3 are USART2's unused
 * SCLK/RTS/CTS pins, which makes five consecutive sockets available for the
 * whole dongle with GND immediately below at CN9-12. */
#define NRF_USART USART2
#define NRF_TX_PORT GPIOD
#define NRF_TX_PIN GPIO_PIN_5 /* PD5  USART2_TX -> dongle P0.24  CN9-6 */
#define NRF_RX_PORT GPIOD
#define NRF_RX_PIN GPIO_PIN_6 /* PD6  USART2_RX <- dongle P0.20  CN9-4 */

/* nRF52840 NCP SWD programming lines.
 *
 * NOT WIRED YET — see swd_gpio.c, the only untested-on-hardware piece.
 * These go to the two large round pads on the PCA10059 top side near the USB
 * end. No reset wire is needed; CTRL-AP RESET does it over SWD.
 *
 * Both lines are parked as high-impedance inputs whenever SWD is idle — see
 * swd_gpio_deinit(). If the dongle's supply is ever switched, a driven SWDIO
 * or SWDCLK backfeeds it through the pin's ESD diode and it never actually
 * powers down, which is the same trap the UART pins present. */
#define NRF_SWDIO_PORT GPIOD
#define NRF_SWDIO_PIN GPIO_PIN_4 /* PD4  -> SWDIO pad   CN9-8 */
#define NRF_SWCLK_PORT GPIOD
#define NRF_SWCLK_PIN GPIO_PIN_7 /* PD7  -> SWDCLK pad  CN9-2 */

/* Reserved for the high-side switch on the dongle's 3V3 (GLAB-111 phase 1).
 * Defined so the socket stays claimed in the harness; nothing drives it yet. */
#define NRF_PWR_EN_PORT GPIOD
#define NRF_PWR_EN_PIN GPIO_PIN_3 /* PD3  -> MOSFET gate  CN9-10 (not wired) */

/* Winbond W25Q SPI NOR (SOIC-8) — SPI1 on CN7, 3V3 from CN11-16.
 *
 * ST's own Zio naming puts most of this on one connector already: CN7-10, -12
 * and -16 are labelled SPI_A_SCK, SPI_A_MISO and SPI_A_CS, and SPI_A is SPI1.
 *
 * MOSI is the one deviation. The natural SPI_A_MOSI is D11 at CN7-14, but on
 * this board that pin is PA7 — RMII_CRS_DV, already spoken for by the Ethernet
 * PHY through SB31. PB5 is the alternate SPI_A_MOSI that solder bridges
 * SB33/SB35 select between, and it has a pin of its own at CN7-13, so it is
 * taken there and no bridge is touched.
 *
 * Power: CN7 has GND at pin 8 but no 3V3 at all — pin 6 is VREFP, the ADC
 * reference, and must never be used as a supply (UM2407 carries a caution
 * about R37 for exactly that). The board has precisely two 3V3 pins, CN8-7 and
 * CN11-16 (UM2407 §7.4.5); CN8-7 feeds the CC1101, so this takes CN11-16.
 *
 * Two pins on CN7 are off-limits and neither is used here: pin 5 (PB13,
 * RMII_TXD1 via JP6) and pin 14 (PA7, above).
 *
 * PA5 is also LD1's alternate location. The default SB39/SB47 setting keeps
 * the green LED on PB0 — see LED_GREEN_PIN below — which is what leaves PA5
 * free. Moving those bridges would land the LED on top of SCK.
 *
 * WP# and HOLD# are tied to VCC at the package through 10k and take no board
 * pin. Leaving either floating makes the part refuse writes or stall
 * mid-transfer, which reads as a flaky driver rather than as a wiring fault. */
#define W25Q_SPI SPI1
#define W25Q_SCK_PORT GPIOA
#define W25Q_SCK_PIN GPIO_PIN_5 /* PA5  SPI1_SCK  (AF5)  CN7-10 (D13) */
#define W25Q_MISO_PORT GPIOA
#define W25Q_MISO_PIN GPIO_PIN_6 /* PA6  SPI1_MISO (AF5)  CN7-12 (D12) */
#define W25Q_MOSI_PORT GPIOB
#define W25Q_MOSI_PIN GPIO_PIN_5 /* PB5  SPI1_MOSI (AF5)  CN7-13 (D22) */
#define W25Q_CS_PORT GPIOD
#define W25Q_CS_PIN GPIO_PIN_14 /* PD14 Software NSS     CN7-16 (D10) */
#define W25Q_SPI_AF GPIO_AF5_SPI1

/* Shell USART3 (ST-LINK VCP) */
#define SHELL_USART USART3
#define SHELL_TX_PORT GPIOD
#define SHELL_TX_PIN GPIO_PIN_8 /* PD8  USART3_TX */
#define SHELL_RX_PORT GPIOD
#define SHELL_RX_PIN GPIO_PIN_9 /* PD9  USART3_RX */

/* User LEDs */
#define LED_GREEN_PORT GPIOB
#define LED_GREEN_PIN GPIO_PIN_0 /* PB0  LD1 Green */
#define LED_YELLOW_PORT GPIOE
#define LED_YELLOW_PIN GPIO_PIN_1 /* PE1  LD2 Yellow */
#define LED_RED_PORT GPIOB
#define LED_RED_PIN GPIO_PIN_14 /* PB14 LD3 Red */

/* Ethernet RMII pins (hardwired on Nucleo to LAN8742A PHY) */
#define ETH_REF_CLK_PORT GPIOA
#define ETH_REF_CLK_PIN GPIO_PIN_1 /* PA1  ETH_RMII_REF_CLK */
#define ETH_MDIO_PORT GPIOA
#define ETH_MDIO_PIN GPIO_PIN_2 /* PA2  ETH_RMII_MDIO */
#define ETH_CRS_DV_PORT GPIOA
#define ETH_CRS_DV_PIN GPIO_PIN_7 /* PA7  ETH_RMII_CRS_DV */
#define ETH_MDC_PORT GPIOC
#define ETH_MDC_PIN GPIO_PIN_1 /* PC1  ETH_RMII_MDC */
#define ETH_RXD0_PORT GPIOC
#define ETH_RXD0_PIN GPIO_PIN_4 /* PC4  ETH_RMII_RXD0 */
#define ETH_RXD1_PORT GPIOC
#define ETH_RXD1_PIN GPIO_PIN_5 /* PC5  ETH_RMII_RXD1 */
#define ETH_TX_EN_PORT GPIOG
#define ETH_TX_EN_PIN GPIO_PIN_11 /* PG11 ETH_RMII_TX_EN */
#define ETH_TXD0_PORT GPIOG
#define ETH_TXD0_PIN GPIO_PIN_13 /* PG13 ETH_RMII_TXD0 */
#define ETH_TXD1_PORT GPIOB
#define ETH_TXD1_PIN GPIO_PIN_13 /* PB13 ETH_RMII_TXD1 */

/* LAN8742A PHY address (typically 0 on Nucleo) */
#define LAN8742A_PHY_ADDR 0

/* -----------------------------------------------------------------------
 * Peripheral handles (defined in respective .c files)
 * ----------------------------------------------------------------------- */
extern SPI_HandleTypeDef hspi3;
extern DMA_HandleTypeDef hdma_spi3_rx;
extern DMA_HandleTypeDef hdma_spi3_tx;
extern UART_HandleTypeDef huart2;
extern UART_HandleTypeDef huart3;
extern DMA_HandleTypeDef hdma_usart3_tx;
extern ETH_HandleTypeDef heth;

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
void bsp_exti_counts_reset(void);

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
#define LED_GREEN_ON() HAL_GPIO_WritePin(LED_GREEN_PORT, LED_GREEN_PIN, GPIO_PIN_SET)
#define LED_GREEN_OFF() HAL_GPIO_WritePin(LED_GREEN_PORT, LED_GREEN_PIN, GPIO_PIN_RESET)
#define LED_GREEN_TOGGLE() HAL_GPIO_TogglePin(LED_GREEN_PORT, LED_GREEN_PIN)

#define LED_YELLOW_ON() HAL_GPIO_WritePin(LED_YELLOW_PORT, LED_YELLOW_PIN, GPIO_PIN_SET)
#define LED_YELLOW_OFF() HAL_GPIO_WritePin(LED_YELLOW_PORT, LED_YELLOW_PIN, GPIO_PIN_RESET)
#define LED_YELLOW_TOGGLE() HAL_GPIO_TogglePin(LED_YELLOW_PORT, LED_YELLOW_PIN)

#define LED_RED_ON() HAL_GPIO_WritePin(LED_RED_PORT, LED_RED_PIN, GPIO_PIN_SET)
#define LED_RED_OFF() HAL_GPIO_WritePin(LED_RED_PORT, LED_RED_PIN, GPIO_PIN_RESET)
#define LED_RED_TOGGLE() HAL_GPIO_TogglePin(LED_RED_PORT, LED_RED_PIN)

#ifdef __cplusplus
}
#endif

#endif /* BSP_H */
