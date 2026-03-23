#ifndef FREERTOS_CONFIG_H
#define FREERTOS_CONFIG_H

/* -----------------------------------------------------------------------
 * Hardware / compiler
 * ----------------------------------------------------------------------- */
#define configENABLE_FPU                         1
#define configENABLE_MPU                         0
#define configENABLE_TRUSTZONE                   0

/* -----------------------------------------------------------------------
 * Core settings
 * ----------------------------------------------------------------------- */
#define configUSE_PREEMPTION                     1
#define configUSE_PORT_OPTIMISED_TASK_SELECTION  1
#define configUSE_TICKLESS_IDLE                  0
#define configCPU_CLOCK_HZ                       ((uint32_t)550000000)
#define configTICK_RATE_HZ                       ((TickType_t)1000)
#define configMAX_PRIORITIES                     8
#define configMINIMAL_STACK_SIZE                 ((uint16_t)256)
#define configMAX_TASK_NAME_LEN                  16
#define configUSE_16_BIT_TICKS                   0
#define configIDLE_SHOULD_YIELD                  1
#define configUSE_TASK_NOTIFICATIONS             1
#define configTASK_NOTIFICATION_ARRAY_ENTRIES    3

/* -----------------------------------------------------------------------
 * Memory allocation
 * 64 KB heap via heap_4.c in AXI SRAM (RAM_D1)
 * ----------------------------------------------------------------------- */
#define configSUPPORT_STATIC_ALLOCATION          0
#define configSUPPORT_DYNAMIC_ALLOCATION         1
#define configTOTAL_HEAP_SIZE                    ((size_t)(64 * 1024))
#define configAPPLICATION_ALLOCATED_HEAP         0

/* -----------------------------------------------------------------------
 * Synchronization primitives
 * ----------------------------------------------------------------------- */
#define configUSE_MUTEXES                        1
#define configUSE_RECURSIVE_MUTEXES              1
#define configUSE_COUNTING_SEMAPHORES            1
#define configQUEUE_REGISTRY_SIZE                8

/* -----------------------------------------------------------------------
 * Software timers
 * ----------------------------------------------------------------------- */
#define configUSE_TIMERS                         1
#define configTIMER_TASK_PRIORITY                2
#define configTIMER_QUEUE_LENGTH                 10
#define configTIMER_TASK_STACK_DEPTH             (configMINIMAL_STACK_SIZE * 2)

/* -----------------------------------------------------------------------
 * Hook functions
 * ----------------------------------------------------------------------- */
#define configUSE_IDLE_HOOK                      0
#define configUSE_TICK_HOOK                      0
#define configUSE_MALLOC_FAILED_HOOK             1
#define configCHECK_FOR_STACK_OVERFLOW           2

/* -----------------------------------------------------------------------
 * Runtime stats (disabled for now)
 * ----------------------------------------------------------------------- */
#define configGENERATE_RUN_TIME_STATS            0
#define configUSE_TRACE_FACILITY                 1
#define configUSE_STATS_FORMATTING_FUNCTIONS     1

/* -----------------------------------------------------------------------
 * Co-routines (unused)
 * ----------------------------------------------------------------------- */
#define configUSE_CO_ROUTINES                    0

/* -----------------------------------------------------------------------
 * Interrupt nesting
 * Cortex-M7: 4 priority bits (16 levels, 0=highest).
 * FreeRTOS manages ISRs at priorities 5-15 (numerically >= 5).
 * ISRs at 0-4 are "above FreeRTOS" and cannot call FreeRTOS API.
 * ----------------------------------------------------------------------- */
#ifdef __NVIC_PRIO_BITS
  #define configPRIO_BITS __NVIC_PRIO_BITS
#else
  #define configPRIO_BITS 4
#endif

#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY         15
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY    5
#define configKERNEL_INTERRUPT_PRIORITY          (configLIBRARY_LOWEST_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))
#define configMAX_SYSCALL_INTERRUPT_PRIORITY     (configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))

/* -----------------------------------------------------------------------
 * API includes
 * ----------------------------------------------------------------------- */
#define INCLUDE_vTaskPrioritySet                 1
#define INCLUDE_uxTaskPriorityGet                1
#define INCLUDE_vTaskDelete                      1
#define INCLUDE_vTaskSuspend                     1
#define INCLUDE_xResumeFromISR                   1
#define INCLUDE_vTaskDelayUntil                  1
#define INCLUDE_vTaskDelay                       1
#define INCLUDE_xTaskGetSchedulerState           1
#define INCLUDE_xTaskGetCurrentTaskHandle        1
#define INCLUDE_uxTaskGetStackHighWaterMark      1
#define INCLUDE_xTaskGetIdleTaskHandle           1
#define INCLUDE_eTaskGetState                    1

/* -----------------------------------------------------------------------
 * Cortex-M handler names mapped to FreeRTOS ports
 * ----------------------------------------------------------------------- */
#define xPortPendSVHandler   PendSV_Handler
#define vPortSVCHandler      SVC_Handler
/* Note: SysTick_Handler is in stm32h7xx_it.c, calls xPortSysTickHandler() */

#endif /* FREERTOS_CONFIG_H */
