/**
 * lwIP system architecture for FreeRTOS (direct, no CMSIS-OS).
 */
#ifndef LWIP_ARCH_SYS_ARCH_H
#define LWIP_ARCH_SYS_ARCH_H

#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"
#include "semphr.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Mutex */
typedef SemaphoreHandle_t sys_mutex_t;

/* Semaphore */
typedef SemaphoreHandle_t sys_sem_t;

/* Mailbox (queue) */
typedef QueueHandle_t sys_mbox_t;

/* Thread */
typedef TaskHandle_t sys_thread_t;

/* Protection (critical section) */
typedef int sys_prot_t;

/* Do NOT define sys_xxx_valid / sys_xxx_set_invalid as macros here.
 * They are implemented as functions in sys_arch.c.
 * lwIP's sys.h provides the declarations. */

#ifdef __cplusplus
}
#endif

#endif /* LWIP_ARCH_SYS_ARCH_H */
