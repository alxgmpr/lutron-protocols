/* ARM semihosting — printf over SWD debug connection */
#include "bsp.h"
#include <stdarg.h>

/* ARM semihosting syscall via BKPT instruction */
static inline int sh_syscall(int op, void* arg) {
    register int r0 __asm__("r0") = op;
    register void* r1 __asm__("r1") = arg;
    __asm__ volatile (
        "bkpt 0xAB"
        : "+r"(r0)
        : "r"(r1)
        : "memory"
    );
    return r0;
}

/* SYS_WRITE0: write null-terminated string */
#define SH_SYS_WRITE0 0x04
/* SYS_WRITEC: write single character */
#define SH_SYS_WRITEC 0x03

void sh_puts(const char* s) {
    sh_syscall(SH_SYS_WRITE0, (void*)s);
}

static void sh_putc(char c) {
    sh_syscall(SH_SYS_WRITEC, &c);
}

static const char hex_chars[] = "0123456789ABCDEF";

void sh_puthex(const uint8_t* data, size_t len) {
    for (size_t i = 0; i < len; i++) {
        char buf[3];
        buf[0] = hex_chars[data[i] >> 4];
        buf[1] = hex_chars[data[i] & 0xF];
        buf[2] = ' ';
        sh_putc(buf[0]);
        sh_putc(buf[1]);
        if (i < len - 1) sh_putc(buf[2]);
    }
}

/* Minimal printf — supports %s, %u, %lu, %d, %x, %02X, %04X, %08lX */
void sh_printf(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);

    char buf[128];
    int pos = 0;

    while (*fmt && pos < (int)sizeof(buf) - 1) {
        if (*fmt != '%') {
            buf[pos++] = *fmt++;
            continue;
        }
        fmt++; /* skip % */

        /* Parse width/flags */
        int width = 0;
        char pad = ' ';
        bool is_long = false;

        if (*fmt == '0') { pad = '0'; fmt++; }
        while (*fmt >= '0' && *fmt <= '9') {
            width = width * 10 + (*fmt - '0');
            fmt++;
        }
        if (*fmt == 'l') { is_long = true; fmt++; }

        /* Flush buffer before conversion */
        buf[pos] = '\0';
        if (pos > 0) { sh_puts(buf); pos = 0; }

        switch (*fmt) {
        case 's': {
            const char* s = va_arg(ap, const char*);
            sh_puts(s ? s : "(null)");
            break;
        }
        case 'u':
        case 'd': {
            unsigned long val = is_long ? va_arg(ap, unsigned long) : va_arg(ap, unsigned int);
            char nbuf[12];
            int npos = 0;
            if (val == 0) { nbuf[npos++] = '0'; }
            else {
                unsigned long tmp = val;
                while (tmp) { nbuf[npos++] = '0' + (tmp % 10); tmp /= 10; }
            }
            while (npos < width) { sh_putc(pad); npos++; }
            for (int i = npos - 1; i >= 0; i--) sh_putc(nbuf[i]);
            break;
        }
        case 'x':
        case 'X': {
            unsigned long val = is_long ? va_arg(ap, unsigned long) : va_arg(ap, unsigned int);
            char nbuf[8];
            int npos = 0;
            if (val == 0) { nbuf[npos++] = '0'; }
            else {
                unsigned long tmp = val;
                while (tmp) {
                    int d = tmp & 0xF;
                    nbuf[npos++] = d < 10 ? '0' + d : (*fmt == 'X' ? 'A' : 'a') + d - 10;
                    tmp >>= 4;
                }
            }
            while (npos < width) { sh_putc(pad); width--; }
            for (int i = npos - 1; i >= 0; i--) sh_putc(nbuf[i]);
            break;
        }
        case 'c':
            sh_putc((char)va_arg(ap, int));
            break;
        case '%':
            buf[pos++] = '%';
            break;
        default:
            buf[pos++] = '%';
            buf[pos++] = *fmt;
            break;
        }
        fmt++;
    }

    buf[pos] = '\0';
    if (pos > 0) sh_puts(buf);
    va_end(ap);
}
