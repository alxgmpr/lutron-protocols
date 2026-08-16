#ifndef BOOT_REQUEST_H
#define BOOT_REQUEST_H

/**
 * Install request — the handshake between the running application and the
 * bootloader, carried in RAM across a warm reset.
 *
 * The application sets the request and resets; the bootloader reads it, does
 * the install, and clears it. Nothing else can trigger an install, which is
 * what keeps a leftover staged image from replacing working firmware.
 *
 * Why RAM and not flash: it needs no erase cycle, and it is deliberately lost
 * on a power cycle. A request that survived a power loss could reinstall at an
 * unexpected moment; one that evaporates is the safer failure.
 *
 * Placement: the first 32 bytes of AXI SRAM. Both linker scripts move
 * ORIGIN(RAM_D1) up by 32 bytes so nothing else is ever allocated there and the
 * area sits outside .bss/.data — startup must not zero it. The two builds agree
 * by construction rather than by matching section order.
 */

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BOOT_REQUEST_ADDR 0x24000000u
#define BOOT_REQUEST_RESERVED 32u
#define BOOT_REQUEST_MAGIC 0x4F544152u /* "OTAR" */

typedef struct {
    uint32_t magic;
    uint32_t install; /* 1 = install the staged image */
    uint32_t attempts;
    uint32_t check; /* magic ^ install ^ attempts ^ BOOT_REQUEST_MAGIC */
} boot_request_t;

/** The live area. Contents are undefined at power-on — always go through the
 *  accessors, which validate before believing anything. */
boot_request_t* boot_request_area(void);

/** True if @p r holds a structurally valid record. Random power-on RAM fails. */
bool boot_request_valid(const boot_request_t* r);

/** True if a valid record is asking for an install. */
bool boot_request_pending(const boot_request_t* r);

/** Attempts recorded against the current request; 0 if none is valid. */
uint32_t boot_request_attempts(const boot_request_t* r);

/** Ask for an install on the next boot, resetting the attempt count. */
void boot_request_set(boot_request_t* r);

/** Record another attempt at the pending install. */
void boot_request_bump(boot_request_t* r);

/** Clear any request. Leaves a valid record so the state is unambiguous. */
void boot_request_clear(boot_request_t* r);

#ifdef __cplusplus
}
#endif

#endif /* BOOT_REQUEST_H */
