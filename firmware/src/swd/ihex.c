#include "ihex.h"

/* Record types */
#define REC_DATA 0x00
#define REC_EOF 0x01
#define REC_EXT_SEGMENT 0x02
#define REC_START_SEGMENT 0x03
#define REC_EXT_LINEAR 0x04
#define REC_START_LINEAR 0x05

void ihex_init(ihex_t* h)
{
    h->base = 0;
    h->min_addr = 0;
    h->max_addr = 0;
    h->any_data = false;
    h->eof = false;
}

bool ihex_complete(const ihex_t* h)
{
    return h->eof;
}

uint32_t ihex_min_address(const ihex_t* h)
{
    return h->any_data ? h->min_addr : 0u;
}

uint32_t ihex_max_address(const ihex_t* h)
{
    return h->any_data ? h->max_addr : 0u;
}

/** @return 0..15, or -1 if @p c is not a hex digit. */
static int nibble(char c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    return -1;
}

/** @return the byte at hex offset @p i, or -1 if either digit is bad. */
static int byte_at(const char* s, size_t i)
{
    int hi = nibble(s[i]);
    int lo = nibble(s[i + 1]);
    if (hi < 0 || lo < 0) {
        return -1;
    }
    return (hi << 4) | lo;
}

ihex_status_t ihex_parse_line(ihex_t* h, const char* line, size_t len, ihex_data_fn fn, void* ctx)
{
    if (h == NULL || line == NULL) {
        return IHEX_ERR_FORMAT;
    }

    /* Trim any line terminator the caller left on. */
    while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
        len--;
    }
    if (len == 0) {
        return IHEX_OK;
    }

    if (line[0] != ':') {
        return IHEX_ERR_FORMAT;
    }

    /* ':' + count + address + type + checksum = 11 characters minimum. */
    if (len < 11) {
        return IHEX_ERR_FORMAT;
    }

    int count = byte_at(line, 1);
    int addr_hi = byte_at(line, 3);
    int addr_lo = byte_at(line, 5);
    int type = byte_at(line, 7);
    if (count < 0 || addr_hi < 0 || addr_lo < 0 || type < 0) {
        return IHEX_ERR_FORMAT;
    }

    /* The declared byte count has to match the line we were handed exactly. */
    size_t want = 11u + (size_t)count * 2u;
    if (len != want) {
        return IHEX_ERR_FORMAT;
    }

    uint8_t data[IHEX_MAX_DATA];
    uint32_t sum = (uint32_t)count + (uint32_t)addr_hi + (uint32_t)addr_lo + (uint32_t)type;
    for (int i = 0; i < count; i++) {
        int b = byte_at(line, 9u + (size_t)i * 2u);
        if (b < 0) {
            return IHEX_ERR_FORMAT;
        }
        data[i] = (uint8_t)b;
        sum += (uint32_t)b;
    }

    int checksum = byte_at(line, 9u + (size_t)count * 2u);
    if (checksum < 0) {
        return IHEX_ERR_FORMAT;
    }
    /* Two's complement: every byte including the checksum sums to zero. */
    if (((sum + (uint32_t)checksum) & 0xFFu) != 0) {
        return IHEX_ERR_CHECKSUM;
    }

    /* Anything after the EOF record means the stream is not what it claims. */
    if (h->eof) {
        return IHEX_ERR_RECORD;
    }

    uint32_t offset = ((uint32_t)addr_hi << 8) | (uint32_t)addr_lo;

    switch (type) {
    case REC_DATA: {
        uint32_t addr = h->base + offset;
        if (count > 0) {
            if (!h->any_data) {
                h->min_addr = addr;
                h->max_addr = addr;
                h->any_data = true;
            }
            if (addr < h->min_addr) {
                h->min_addr = addr;
            }
            if (addr + (uint32_t)count > h->max_addr) {
                h->max_addr = addr + (uint32_t)count;
            }
            if (fn != NULL && fn(ctx, addr, data, (uint8_t)count) != 0) {
                return IHEX_ERR_SINK;
            }
        }
        return IHEX_OK;
    }

    case REC_EOF:
        h->eof = true;
        return IHEX_OK;

    case REC_EXT_SEGMENT:
        if (count != 2) {
            return IHEX_ERR_RECORD;
        }
        /* Segment value is a paragraph address: shift by 4, not 16. */
        h->base = (((uint32_t)data[0] << 8) | (uint32_t)data[1]) << 4;
        return IHEX_OK;

    case REC_EXT_LINEAR:
        if (count != 2) {
            return IHEX_ERR_RECORD;
        }
        h->base = (((uint32_t)data[0] << 8) | (uint32_t)data[1]) << 16;
        return IHEX_OK;

    case REC_START_SEGMENT:
    case REC_START_LINEAR:
        /* Entry point, not an address base. Leave h->base alone. */
        return IHEX_OK;

    default:
        return IHEX_ERR_RECORD;
    }
}
