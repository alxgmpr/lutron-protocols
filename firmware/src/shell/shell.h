#ifndef SHELL_H
#define SHELL_H

#include "FreeRTOS.h"
#include "task.h"
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Start the debug shell FreeRTOS task (USART3 VCP) */
void shell_task_start(void);

/** Execute a shell command line (used by UART shell and UDP text passthrough) */
void shell_execute(const char* line);

/**
 * Reset the board if the command just executed asked for one.
 *
 * Commands that reboot cannot do it themselves. shell_execute() returns before
 * its caller has sent anything: the UART console still has bytes in the FIFO,
 * and the UDP path does not build its datagram until afterwards — so resetting
 * inside the command meant the client never saw the reply. Every caller must
 * invoke this once its output is on the wire.
 */
void shell_reset_if_requested(void);

/** Capture printf output into a buffer (for UDP text response) */
void printf_capture_start(uint8_t* buf, size_t buf_size);
size_t printf_capture_stop(void);

/**
 * Register shell input state so _write() can save/restore the line
 * when async tasks call printf().  Called by shell_readline() on every
 * keystroke.  Defined in syscalls.c.
 */
void shell_register_state(TaskHandle_t task, const char* buf, size_t len, size_t cursor, int active);

#ifdef __cplusplus
}
#endif

#endif /* SHELL_H */
