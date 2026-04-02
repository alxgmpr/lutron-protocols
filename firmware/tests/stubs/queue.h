/* Minimal FreeRTOS queue stub for host-side unit tests */
#pragma once
#include "FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

QueueHandle_t xQueueCreate(UBaseType_t length, UBaseType_t item_size);
BaseType_t xQueueSend(QueueHandle_t queue, const void* item, TickType_t ticks_to_wait);

#ifdef __cplusplus
}
#endif
