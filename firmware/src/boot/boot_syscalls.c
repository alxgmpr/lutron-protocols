/**
 * Minimal newlib syscall stubs for the bootloader.
 *
 * The application routes _write() to USART3 through the shell (src/syscalls.c),
 * which drags in the UART, the line editor and FreeRTOS mutexes — none of which
 * belong here. The bootloader has no console at all.
 *
 * They still have to exist. Something in the C runtime references _close_r,
 * _lseek_r, _read_r and _write_r, and without definitions the linker pulls the
 * newlib defaults and emits "not implemented and will always fail" for each.
 * That is only a warning, but firmware/check-build-warnings.sh treats warnings
 * as errors, so the build goes red on four messages about functions that were
 * never going to be called.
 *
 * Failing quietly is the correct behaviour: a bootloader with nowhere to print
 * has nothing useful to do with a write.
 */

#include <errno.h>
#include <stddef.h>
#include <sys/stat.h>
#include <sys/types.h>

int _close(int file)
{
    (void)file;
    return -1;
}

off_t _lseek(int file, off_t ptr, int dir)
{
    (void)file;
    (void)ptr;
    (void)dir;
    return 0;
}

int _read(int file, char* ptr, int len)
{
    (void)file;
    (void)ptr;
    (void)len;
    return 0;
}

int _write(int file, const char* ptr, int len)
{
    (void)file;
    (void)ptr;
    /* Report the bytes as accepted. Returning -1 makes newlib retry forever. */
    return len;
}

int _fstat(int file, struct stat* st)
{
    (void)file;
    st->st_mode = S_IFCHR;
    return 0;
}

int _isatty(int file)
{
    (void)file;
    return 1;
}

/** No heap. Anything reaching for one here is a bug worth failing on. */
void* _sbrk(ptrdiff_t incr)
{
    (void)incr;
    errno = ENOMEM;
    return (void*)-1;
}
