/* Minimal FreeRTOS stub for host-side unit tests */
#pragma once
#include <stdint.h>
#include <stddef.h>

typedef void* QueueHandle_t;
typedef uint32_t TickType_t;
typedef long BaseType_t;
typedef unsigned long UBaseType_t;

#define pdTRUE  ((BaseType_t)1)
#define pdFALSE ((BaseType_t)0)
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
