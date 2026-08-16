/**
 * Exclusive access to the SWD pins. See swd_lock.h.
 */

#include "swd_lock.h"

#include "FreeRTOS.h"
#include "semphr.h"

static SemaphoreHandle_t s_lock = NULL;

void swd_lock_init(void)
{
    if (s_lock == NULL) {
        s_lock = xSemaphoreCreateMutex();
    }
}

bool swd_lock_take(uint32_t timeout_ms)
{
    if (s_lock == NULL) {
        /* Nothing to contend with. */
        return true;
    }
    return xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}

void swd_lock_give(void)
{
    if (s_lock != NULL) {
        (void)xSemaphoreGive(s_lock);
    }
}
