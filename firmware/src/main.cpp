/**
 * Nucleo H723ZG Firmware — CCA/CCX Coordinator
 *
 * Entry point: initializes BSP, creates FreeRTOS tasks, starts scheduler.
 *
 * Task priorities:
 *   CCA (CC1101 RX/TX):      3 (highest — time-critical radio)
 *   CCX (Thread NCP stub):    3
 *   Stream (TCP Ethernet):    2
 *   Shell (debug console):    1 (lowest)
 */

#include "bsp.h"
#include "watchdog.h"
#include "flash_store.h"
#include "eth.h"
#include "cca_task.h"
#include "ccx_task.h"
#include "stream.h"
#include "shell.h"

#include "FreeRTOS.h"
#include "task.h"

#include <cstdio>

int main(void)
{
    /* HAL init (SysTick, NVIC priority grouping) */
    HAL_Init();

    /* BSP initialization */
    bsp_clock_init();    /* 548 MHz SYSCLK from HSE PLL */
    bsp_gpio_init();     /* Pin mux: SPI1, USART2/3, ETH, LEDs, GDO0 */
    bsp_spi_init();      /* SPI1 for CC1101 (4 MHz, mode 0) */
    bsp_uart_init();     /* USART2 (nRF52840 NCP), USART3 (shell VCP) */
    bsp_eth_init();      /* Ethernet MAC + LAN8742A PHY, lwIP + DHCP */

    printf("\r\n[main] Nucleo H723ZG — CCA/CCX Coordinator\r\n");
    printf("[main] SYSCLK=%lu MHz\r\n", (unsigned long)(SystemCoreClock / 1000000));

    /* Load persistent settings from flash sector 7 */
    flash_store_init();

    /* Start IWDG (~10s timeout) */
    watchdog_init();

    /* Create application tasks */
    cca_task_start();    /* CC1101 RX/TX (priority 3) */
    ccx_task_start();    /* Thread NCP stub (priority 3) */
    stream_task_start(); /* TCP Ethernet stream (priority 2) */
    shell_task_start();  /* Debug console (priority 1) */

    /* Start FreeRTOS scheduler — does not return */
    vTaskStartScheduler();

    /* Should never reach here */
    while (1) {}
}
