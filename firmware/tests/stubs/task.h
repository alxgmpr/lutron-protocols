/* Minimal FreeRTOS task stub for host-side unit tests */
#pragma once
#include "FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

void vTaskDelay(TickType_t ticks);

#ifdef __cplusplus
}
#endif
