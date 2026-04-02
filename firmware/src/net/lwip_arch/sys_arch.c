/**
 * lwIP system abstraction layer for FreeRTOS.
 * Implements the OS primitives that lwIP needs (mutexes, semaphores,
 * mailboxes, threads, time).
 */

#include "lwip/sys.h"
#include "lwip/opt.h"
#include "lwip/stats.h"

#include "FreeRTOS.h"
#include "task.h"
#include "queue.h"
#include "semphr.h"

#include <string.h>

/* -----------------------------------------------------------------------
 * Time
 * ----------------------------------------------------------------------- */
u32_t sys_now(void)
{
    return xTaskGetTickCount() * portTICK_PERIOD_MS;
}

u32_t sys_jiffies(void)
{
    return xTaskGetTickCount();
}

/* -----------------------------------------------------------------------
 * Init
 * ----------------------------------------------------------------------- */
void sys_init(void)
{
    /* Nothing to do — FreeRTOS is already initialized */
}

/* -----------------------------------------------------------------------
 * Semaphores
 * ----------------------------------------------------------------------- */
err_t sys_sem_new(sys_sem_t* sem, u8_t count)
{
    *sem = xSemaphoreCreateCounting(0xFFFF, count);
    if (*sem == NULL) {
        SYS_STATS_INC(sem.err);
        return ERR_MEM;
    }
    SYS_STATS_INC_USED(sem);
    return ERR_OK;
}

void sys_sem_free(sys_sem_t* sem)
{
    SYS_STATS_DEC(sem);
    vSemaphoreDelete(*sem);
    *sem = NULL;
}

void sys_sem_signal(sys_sem_t* sem)
{
    xSemaphoreGive(*sem);
}

u32_t sys_arch_sem_wait(sys_sem_t* sem, u32_t timeout)
{
    TickType_t start = xTaskGetTickCount();
    TickType_t ticks = (timeout == 0) ? portMAX_DELAY : pdMS_TO_TICKS(timeout);

    if (xSemaphoreTake(*sem, ticks) == pdTRUE) {
        u32_t elapsed = (xTaskGetTickCount() - start) * portTICK_PERIOD_MS;
        return elapsed;
    }
    return SYS_ARCH_TIMEOUT;
}

int sys_sem_valid(sys_sem_t* sem)
{
    return (*sem != NULL);
}

void sys_sem_set_invalid(sys_sem_t* sem)
{
    *sem = NULL;
}

/* -----------------------------------------------------------------------
 * Mutexes
 * ----------------------------------------------------------------------- */
err_t sys_mutex_new(sys_mutex_t* mutex)
{
    *mutex = xSemaphoreCreateMutex();
    if (*mutex == NULL) {
        SYS_STATS_INC(mutex.err);
        return ERR_MEM;
    }
    SYS_STATS_INC_USED(mutex);
    return ERR_OK;
}

void sys_mutex_free(sys_mutex_t* mutex)
{
    SYS_STATS_DEC(mutex);
    vSemaphoreDelete(*mutex);
    *mutex = NULL;
}

void sys_mutex_lock(sys_mutex_t* mutex)
{
    xSemaphoreTake(*mutex, portMAX_DELAY);
}

void sys_mutex_unlock(sys_mutex_t* mutex)
{
    xSemaphoreGive(*mutex);
}

int sys_mutex_valid(sys_mutex_t* mutex)
{
    return (*mutex != NULL);
}

void sys_mutex_set_invalid(sys_mutex_t* mutex)
{
    *mutex = NULL;
}

/* -----------------------------------------------------------------------
 * Mailboxes (FreeRTOS queues)
 * ----------------------------------------------------------------------- */
err_t sys_mbox_new(sys_mbox_t* mbox, int size)
{
    *mbox = xQueueCreate((UBaseType_t)size, sizeof(void*));
    if (*mbox == NULL) {
        SYS_STATS_INC(mbox.err);
        return ERR_MEM;
    }
    SYS_STATS_INC_USED(mbox);
    return ERR_OK;
}

void sys_mbox_free(sys_mbox_t* mbox)
{
    SYS_STATS_DEC(mbox);
    vQueueDelete(*mbox);
    *mbox = NULL;
}

void sys_mbox_post(sys_mbox_t* mbox, void* msg)
{
    while (xQueueSend(*mbox, &msg, portMAX_DELAY) != pdTRUE);
}

err_t sys_mbox_trypost(sys_mbox_t* mbox, void* msg)
{
    if (xQueueSend(*mbox, &msg, 0) == pdTRUE) {
        return ERR_OK;
    }
    SYS_STATS_INC(mbox.err);
    return ERR_MEM;
}

err_t sys_mbox_trypost_fromisr(sys_mbox_t* mbox, void* msg)
{
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    if (xQueueSendFromISR(*mbox, &msg, &xHigherPriorityTaskWoken) == pdTRUE) {
        portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
        return ERR_OK;
    }
    SYS_STATS_INC(mbox.err);
    return ERR_MEM;
}

u32_t sys_arch_mbox_fetch(sys_mbox_t* mbox, void** msg, u32_t timeout)
{
    void* dummy;
    if (msg == NULL) msg = &dummy;

    TickType_t start = xTaskGetTickCount();
    TickType_t ticks = (timeout == 0) ? portMAX_DELAY : pdMS_TO_TICKS(timeout);

    if (xQueueReceive(*mbox, msg, ticks) == pdTRUE) {
        u32_t elapsed = (xTaskGetTickCount() - start) * portTICK_PERIOD_MS;
        return elapsed;
    }

    *msg = NULL;
    return SYS_ARCH_TIMEOUT;
}

u32_t sys_arch_mbox_tryfetch(sys_mbox_t* mbox, void** msg)
{
    void* dummy;
    if (msg == NULL) msg = &dummy;

    if (xQueueReceive(*mbox, msg, 0) == pdTRUE) {
        return 0;
    }

    *msg = NULL;
    return SYS_MBOX_EMPTY;
}

int sys_mbox_valid(sys_mbox_t* mbox)
{
    return (*mbox != NULL);
}

void sys_mbox_set_invalid(sys_mbox_t* mbox)
{
    *mbox = NULL;
}

/* -----------------------------------------------------------------------
 * Threads
 * ----------------------------------------------------------------------- */
sys_thread_t sys_thread_new(const char* name, lwip_thread_fn thread, void* arg, int stacksize, int prio)
{
    TaskHandle_t handle;
    BaseType_t ret = xTaskCreate(thread, name, (uint16_t)stacksize, arg, (UBaseType_t)prio, &handle);
    if (ret != pdPASS) {
        return NULL;
    }
    return handle;
}

/* -----------------------------------------------------------------------
 * Critical sections
 * ----------------------------------------------------------------------- */
sys_prot_t sys_arch_protect(void)
{
    taskENTER_CRITICAL();
    return 1;
}

void sys_arch_unprotect(sys_prot_t pval)
{
    (void)pval;
    taskEXIT_CRITICAL();
}
