/**
 * Minimal newlib stubs for bare-metal STM32.
 *
 * _write() routes stdout/stderr to USART3 (shell VCP) with mutex
 * synchronization.  When an async task (CCA/CCX/ETH/stream) calls
 * printf() while the shell has a partially-typed line, _write()
 * transparently erases the input, prints the message, then redraws
 * the prompt and partial input with the cursor in the right place.
 *
 * USART3 TX uses DMA with a double-buffer (2x512 bytes) to free
 * the CPU during transmission.  Shell save/restore lines use blocking
 * writes (they're just a few bytes).
 */

#include <sys/stat.h>
#include <errno.h>
#include <string.h>
#include "stm32h7xx_hal.h"
#include "FreeRTOS.h"
#include "task.h"
#include "semphr.h"

/* USART3 handle defined in uart.c */
extern UART_HandleTypeDef huart3;

/* -----------------------------------------------------------------------
 * USART3 DMA TX double-buffer
 *
 * Two 512-byte buffers, 32-byte aligned for D-Cache maintenance.
 * A binary semaphore tracks DMA completion: taken before starting DMA,
 * given back in the TX complete callback.
 * ----------------------------------------------------------------------- */
#define DMA_TX_BUF_SIZE 512

static uint8_t           dma_tx_buf[2][DMA_TX_BUF_SIZE] __attribute__((aligned(32)));
static volatile int      dma_buf_idx = 0; /* which buffer _write copies into */
static SemaphoreHandle_t s_dma_tx_sem;    /* binary semaphore: DMA complete */

void HAL_UART_TxCpltCallback(UART_HandleTypeDef* huart)
{
    if (huart->Instance == USART3) {
        BaseType_t woken = pdFALSE;
        xSemaphoreGiveFromISR(s_dma_tx_sem, &woken);
        portYIELD_FROM_ISR(woken);
    }
}

/* Wait for any in-flight DMA to complete.  Safe to call when no DMA
 * is active (semaphore is pre-given after lazy init). */
static void dma_tx_wait(void)
{
    if (s_dma_tx_sem) {
        xSemaphoreTake(s_dma_tx_sem, pdMS_TO_TICKS(100));
        xSemaphoreGive(s_dma_tx_sem);
    }
}

/* Start DMA TX from the given buffer. Caller must have already taken
 * the DMA semaphore (or know no DMA is in flight). */
static void dma_tx_start(const uint8_t* data, uint16_t len)
{
    int      idx = dma_buf_idx;
    uint16_t copy_len = (len > DMA_TX_BUF_SIZE) ? DMA_TX_BUF_SIZE : len;
    memcpy(dma_tx_buf[idx], data, copy_len);
    dma_buf_idx = 1 - idx;

    /* Clean D-Cache so DMA reads committed data (round up to 32-byte boundary) */
    SCB_CleanDCache_by_Addr((uint32_t*)dma_tx_buf[idx], (int32_t)((copy_len + 31) & ~31u));

    /* Take semaphore (marks DMA as in-flight) */
    xSemaphoreTake(s_dma_tx_sem, 0);

    HAL_UART_Transmit_DMA(&huart3, dma_tx_buf[idx], copy_len);
}

/* -----------------------------------------------------------------------
 * Shell input state — registered by shell_readline() on every keystroke
 * so _write() can save/restore the line for async output.
 * ----------------------------------------------------------------------- */
typedef struct {
    TaskHandle_t task;   /* shell task handle (NULL until registered) */
    const char*  buf;    /* current line buffer */
    size_t       len;    /* number of chars in buffer */
    size_t       cursor; /* cursor position within line */
    int          active; /* non-zero when shell is reading input */
} shell_state_t;

static shell_state_t     s_shell;
static SemaphoreHandle_t s_uart3_mutex;

/* -----------------------------------------------------------------------
 * Printf capture — allows UDP text passthrough to collect command output.
 * Only captures output from the task that started the capture.
 * ----------------------------------------------------------------------- */
typedef struct {
    TaskHandle_t task;
    uint8_t*     buf;
    size_t       buf_size;
    size_t       len;
} printf_capture_t;

static volatile printf_capture_t s_capture;

void printf_capture_start(uint8_t* buf, size_t buf_size)
{
    taskENTER_CRITICAL();
    s_capture.task = xTaskGetCurrentTaskHandle();
    s_capture.buf = buf;
    s_capture.buf_size = buf_size;
    s_capture.len = 0;
    taskEXIT_CRITICAL();
}

size_t printf_capture_stop(void)
{
    taskENTER_CRITICAL();
    size_t n = s_capture.len;
    s_capture.task = NULL;
    taskEXIT_CRITICAL();
    return n;
}

/* Raw UART write — blocking, bypasses _write() to avoid reentrancy.
 * Used only for shell save/restore (a few bytes). Must be called
 * when no DMA TX is in flight. */
static void uart3_raw(const char* data, size_t len)
{
    HAL_UART_Transmit(&huart3, (const uint8_t*)data, (uint16_t)len, HAL_MAX_DELAY);
}

/**
 * Called by shell_readline() to keep _write() in sync with the current
 * line editing state.
 */
void shell_register_state(TaskHandle_t task, const char* buf, size_t len, size_t cursor, int active)
{
    taskENTER_CRITICAL();
    s_shell.task = task;
    s_shell.buf = buf;
    s_shell.len = len;
    s_shell.cursor = cursor;
    s_shell.active = active;
    taskEXIT_CRITICAL();
}

/* Erase the current prompt + input line */
static void shell_save_line(void)
{
    /* \r        — return to column 0
     * \033[K    — erase from cursor to end of line */
    uart3_raw("\r\033[K", 4);
}

/* Redraw prompt + input line with correct cursor position */
static void shell_restore_line(void)
{
    shell_state_t snap;
    taskENTER_CRITICAL();
    snap = s_shell;
    taskEXIT_CRITICAL();

    if (!snap.active) return;

    /* Redraw prompt */
    uart3_raw("> ", 2);

    /* Redraw buffer contents */
    if (snap.len > 0) {
        uart3_raw(snap.buf, snap.len);
    }

    /* Reposition cursor: move back from end to cursor position */
    size_t back = snap.len - snap.cursor;
    if (back > 0) {
        /* Use repeated \b — simple and works everywhere */
        for (size_t i = 0; i < back; i++) {
            uart3_raw("\b", 1);
        }
    }
}

/* -----------------------------------------------------------------------
 * _write() — newlib stdout/stderr hook
 * ----------------------------------------------------------------------- */
int _write(int fd, char* buf, int len)
{
    (void)fd;

    /* Pre-scheduler: write directly (boot banner in main.c) */
    if (xTaskGetSchedulerState() != taskSCHEDULER_RUNNING) {
        HAL_UART_Transmit(&huart3, (uint8_t*)buf, len, HAL_MAX_DELAY);
        return len;
    }

    /* Lazy-create mutex and DMA semaphore on first post-scheduler call */
    if (s_uart3_mutex == NULL) {
        s_uart3_mutex = xSemaphoreCreateMutex();
        if (s_uart3_mutex == NULL) {
            HAL_UART_Transmit(&huart3, (uint8_t*)buf, len, HAL_MAX_DELAY);
            return len;
        }
    }
    if (s_dma_tx_sem == NULL) {
        s_dma_tx_sem = xSemaphoreCreateBinary();
        if (s_dma_tx_sem != NULL) {
            xSemaphoreGive(s_dma_tx_sem); /* initially "available" */
        }
    }

    /* 100ms timeout — drop output rather than deadlock */
    if (xSemaphoreTake(s_uart3_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        return len; /* drop silently */
    }

    TaskHandle_t caller = xTaskGetCurrentTaskHandle();

    /* Copy to capture buffer if this is the captured task */
    if (s_capture.task == caller && s_capture.buf != NULL) {
        uint8_t* cap_buf = (uint8_t*)s_capture.buf;
        size_t   cap_len = s_capture.len;
        size_t   cap_size = s_capture.buf_size;
        size_t   avail = cap_size - cap_len;
        size_t   copy = (size_t)len < avail ? (size_t)len : avail;
        if (copy > 0) {
            memcpy(cap_buf + cap_len, buf, copy);
            s_capture.len = cap_len + copy;
        }
    }

    int need_restore = 0;

    if (caller != s_shell.task && s_shell.active) {
        /* Async task printing while shell has input — save line.
         * Must wait for any in-flight DMA before blocking write. */
        dma_tx_wait();
        shell_save_line();
        need_restore = 1;
    }

    /* DMA path: copy to double-buffer, start DMA, return quickly.
     * Falls back to blocking if data too large or DMA sem unavailable. */
    if (s_dma_tx_sem != NULL && len <= DMA_TX_BUF_SIZE) {
        /* Wait for previous DMA to finish */
        xSemaphoreTake(s_dma_tx_sem, pdMS_TO_TICKS(100));
        xSemaphoreGive(s_dma_tx_sem);

        if (need_restore) {
            /* With restore: start DMA, wait for it, then restore */
            dma_tx_start((const uint8_t*)buf, (uint16_t)len);
            dma_tx_wait();
            shell_restore_line();
        }
        else {
            /* No restore: start DMA, return immediately (DMA runs in background) */
            dma_tx_start((const uint8_t*)buf, (uint16_t)len);
        }
    }
    else {
        /* Blocking fallback for large writes or if DMA unavailable */
        dma_tx_wait();
        HAL_UART_Transmit(&huart3, (uint8_t*)buf, len, HAL_MAX_DELAY);
        if (need_restore) {
            shell_restore_line();
        }
    }

    xSemaphoreGive(s_uart3_mutex);
    return len;
}

int _read(int fd, char* buf, int len)
{
    (void)fd;
    (void)buf;
    (void)len;
    errno = EBADF;
    return -1;
}

int _close(int fd)
{
    (void)fd;
    return -1;
}

int _fstat(int fd, struct stat* st)
{
    (void)fd;
    st->st_mode = S_IFCHR;
    return 0;
}

int _isatty(int fd)
{
    (void)fd;
    return 1;
}

int _lseek(int fd, int offset, int whence)
{
    (void)fd;
    (void)offset;
    (void)whence;
    return 0;
}

/* Heap for newlib malloc (minimal — FreeRTOS uses heap_4) */
extern char  end; /* Defined in linker script as _end */
static char* heap_ptr = 0;

void* _sbrk(int incr)
{
    extern char _end;
    extern char _estack;

    if (heap_ptr == 0) {
        heap_ptr = &_end;
    }

    char* prev = heap_ptr;
    if (heap_ptr + incr > &_estack) {
        errno = ENOMEM;
        return (void*)-1;
    }

    heap_ptr += incr;
    return prev;
}

/* FreeRTOS hooks — RED LED + debug output before halt */
void vApplicationMallocFailedHook(void)
{
    /* Can't use printf (it might try to malloc). Write directly. */
    extern UART_HandleTypeDef huart3;
    const char                msg[] = "\r\n*** MALLOC FAILED ***\r\n";
    HAL_UART_Transmit(&huart3, (const uint8_t*)msg, sizeof(msg) - 1, 100);

    /* LED_RED_ON — use register write to avoid HAL dependency */
    GPIOB->BSRR = GPIO_PIN_14;

    while (1);
}

void vApplicationStackOverflowHook(TaskHandle_t xTask, char* pcTaskName)
{
    (void)xTask;

    extern UART_HandleTypeDef huart3;
    const char                prefix[] = "\r\n*** STACK OVERFLOW: ";
    HAL_UART_Transmit(&huart3, (const uint8_t*)prefix, sizeof(prefix) - 1, 100);
    if (pcTaskName) {
        size_t nlen = 0;
        while (pcTaskName[nlen] && nlen < 16) nlen++;
        HAL_UART_Transmit(&huart3, (const uint8_t*)pcTaskName, (uint16_t)nlen, 100);
    }
    const char suffix[] = " ***\r\n";
    HAL_UART_Transmit(&huart3, (const uint8_t*)suffix, sizeof(suffix) - 1, 100);

    GPIOB->BSRR = GPIO_PIN_14;

    while (1);
}
