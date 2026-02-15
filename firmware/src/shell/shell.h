#ifndef SHELL_H
#define SHELL_H

#include "FreeRTOS.h"
#include "task.h"
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Start the debug shell FreeRTOS task (USART3 VCP) */
void shell_task_start(void);

/**
 * Register shell input state so _write() can save/restore the line
 * when async tasks call printf().  Called by shell_readline() on every
 * keystroke.  Defined in syscalls.c.
 */
void shell_register_state(TaskHandle_t task, const char *buf,
                          size_t len, size_t cursor, int active);

#ifdef __cplusplus
}
#endif

#endif /* SHELL_H */
