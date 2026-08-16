/**
 * Install request record — see boot_request.h.
 */

#include "boot_request.h"

#include <stddef.h>

static uint32_t checkword(const boot_request_t* r)
{
    return r->magic ^ r->install ^ r->attempts ^ BOOT_REQUEST_MAGIC;
}

boot_request_t* boot_request_area(void)
{
    return (boot_request_t*)(uintptr_t)BOOT_REQUEST_ADDR;
}

bool boot_request_valid(const boot_request_t* r)
{
    if (r == NULL) return false;
    if (r->magic != BOOT_REQUEST_MAGIC) return false;
    if (r->install > 1u) return false;
    /* A check word as well as the magic: uninitialised SRAM that happens to
     * contain the magic still has to satisfy this to be believed. */
    return r->check == checkword(r);
}

bool boot_request_pending(const boot_request_t* r)
{
    return boot_request_valid(r) && r->install == 1u;
}

uint32_t boot_request_attempts(const boot_request_t* r)
{
    return boot_request_valid(r) ? r->attempts : 0u;
}

void boot_request_set(boot_request_t* r)
{
    if (r == NULL) return;
    r->magic = BOOT_REQUEST_MAGIC;
    r->install = 1u;
    r->attempts = 0u;
    r->check = checkword(r);
}

void boot_request_bump(boot_request_t* r)
{
    if (r == NULL) return;
    /* Anchor to a known state first: bumping something we cannot read is how a
     * bogus attempt count would sneak in. */
    if (!boot_request_valid(r)) {
        boot_request_set(r);
    }
    r->attempts++;
    r->check = checkword(r);
}

void boot_request_clear(boot_request_t* r)
{
    if (r == NULL) return;
    r->magic = BOOT_REQUEST_MAGIC;
    r->install = 0u;
    r->attempts = 0u;
    r->check = checkword(r);
}
