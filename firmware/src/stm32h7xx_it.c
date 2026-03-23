/**
 * Interrupt Service Routines for STM32H723.
 *
 * FreeRTOS handlers (SVC, PendSV) are mapped via FreeRTOSConfig.h macros.
 * SysTick is handled here, forwarding to both HAL and FreeRTOS.
 */

#include "stm32h7xx_hal.h"
#include "bsp.h"
#include "FreeRTOS.h"
#include "task.h"

/* FreeRTOS SysTick handler — declared in the port header */
extern void xPortSysTickHandler(void);

/* EXTI telemetry counters for CC1101 debug */
static volatile uint32_t s_exti_gdo0_count = 0;
static volatile uint32_t s_exti_gdo2_count = 0;

/* -----------------------------------------------------------------------
 * Cortex-M7 core exception handlers
 * ----------------------------------------------------------------------- */

void NMI_Handler(void)
{
    while (1);
}

void HardFault_Handler(void)
{
    LED_RED_ON();
    while (1);
}

void MemManage_Handler(void)
{
    LED_RED_ON();
    while (1);
}

void BusFault_Handler(void)
{
    LED_RED_ON();
    while (1);
}

void UsageFault_Handler(void)
{
    LED_RED_ON();
    while (1);
}

void DebugMon_Handler(void)
{}

/* -----------------------------------------------------------------------
 * SysTick — shared between HAL (1ms timebase) and FreeRTOS (1kHz tick)
 * ----------------------------------------------------------------------- */
void SysTick_Handler(void)
{
    HAL_IncTick();

    if (xTaskGetSchedulerState() != taskSCHEDULER_NOT_STARTED) {
        xPortSysTickHandler();
    }
}

/* -----------------------------------------------------------------------
 * EXTI0 — CC1101 GDO0 sync word detect (PA0)
 * ----------------------------------------------------------------------- */

/* Weak callback — overridden in cca_task.cpp */
__attribute__((weak)) void cca_gdo0_isr_callback(void)
{}

void EXTI0_IRQHandler(void)
{
    s_exti_gdo0_count++;
    HAL_GPIO_EXTI_IRQHandler(CC1101_GDO0_PIN);
}

#if CC1101_GDO2_BACKUP_ENABLE
void EXTI1_IRQHandler(void)
{
    s_exti_gdo2_count++;
    HAL_GPIO_EXTI_IRQHandler(CC1101_GDO2_PIN);
}
#endif

void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
{
    if (GPIO_Pin == CC1101_GDO0_PIN) {
        cca_gdo0_isr_callback();
        return;
    }
#if CC1101_GDO2_BACKUP_ENABLE
    if (GPIO_Pin == CC1101_GDO2_PIN) {
        cca_gdo0_isr_callback();
        return;
    }
#endif
}

uint32_t bsp_exti_gdo0_count(void)
{
    return s_exti_gdo0_count;
}

uint32_t bsp_exti_gdo2_count(void)
{
    return s_exti_gdo2_count;
}

void bsp_exti_counts_reset(void)
{
    s_exti_gdo0_count = 0;
    s_exti_gdo2_count = 0;
}

/* -----------------------------------------------------------------------
 * USART2 — nRF52840 NCP RX (interrupt-driven ring buffer)
 * ----------------------------------------------------------------------- */
extern void uart2_rx_isr(void);

void USART2_IRQHandler(void)
{
    uart2_rx_isr();
}

/* -----------------------------------------------------------------------
 * SPI3 + DMA (CC1101 burst reads via DMA1 Stream 0/1)
 * ----------------------------------------------------------------------- */
void DMA1_Stream0_IRQHandler(void)
{
    HAL_DMA_IRQHandler(&hdma_spi3_rx);
}

void DMA1_Stream1_IRQHandler(void)
{
    HAL_DMA_IRQHandler(&hdma_spi3_tx);
}

void SPI3_IRQHandler(void)
{
    HAL_SPI_IRQHandler(&hspi3);
}

/* -----------------------------------------------------------------------
 * USART3 + DMA (Shell TX via DMA1 Stream 2)
 * ----------------------------------------------------------------------- */
void DMA1_Stream2_IRQHandler(void)
{
    HAL_DMA_IRQHandler(&hdma_usart3_tx);
}

void USART3_IRQHandler(void)
{
    HAL_UART_IRQHandler(&huart3);
}

/* -----------------------------------------------------------------------
 * Ethernet IRQ
 * ----------------------------------------------------------------------- */
void ETH_IRQHandler(void)
{
    HAL_ETH_IRQHandler(&heth);
}
