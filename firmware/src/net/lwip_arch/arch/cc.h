/**
 * lwIP architecture-specific definitions for ARM Cortex-M7 + GCC.
 */
#ifndef LWIP_ARCH_CC_H
#define LWIP_ARCH_CC_H

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <errno.h>

/* Types based on stdint */
typedef uint8_t   u8_t;
typedef int8_t    s8_t;
typedef uint16_t  u16_t;
typedef int16_t   s16_t;
typedef uint32_t  u32_t;
typedef int32_t   s32_t;
typedef uintptr_t mem_ptr_t;

/* Compiler hints for struct packing */
#define PACK_STRUCT_BEGIN
#define PACK_STRUCT_STRUCT __attribute__((packed))
#define PACK_STRUCT_END
#define PACK_STRUCT_FIELD(x) x

/* Diagnostics */
#define LWIP_PLATFORM_DIAG(x) \
    do {                      \
        printf x;             \
    } while (0)
#define LWIP_PLATFORM_ASSERT(x)         \
    do {                                \
        printf("lwIP ASSERT: %s\n", x); \
        while (1);                      \
    } while (0)

/* Byte order: Cortex-M7 is little-endian */
#ifndef BYTE_ORDER
#define BYTE_ORDER LITTLE_ENDIAN
#endif

/* Random number generator (simple for now) */
#define LWIP_RAND() ((u32_t)rand())

#endif /* LWIP_ARCH_CC_H */
