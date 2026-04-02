/* Minimal BSP stub for host-side unit tests */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t HAL_GetTick(void);

void bsp_clock_init(void);
void bsp_gpio_init(void);
void bsp_spi_init(void);
void bsp_uart_init(void);
uint32_t bsp_exti_gdo0_count(void);
uint32_t bsp_exti_gdo2_count(void);
void bsp_exti_counts_reset(void);

#ifdef __cplusplus
}
#endif
