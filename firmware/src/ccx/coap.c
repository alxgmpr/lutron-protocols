#include "coap.h"
#include <string.h>

/**
 * Encode one CoAP option.
 * Returns bytes written, 0 on overflow.
 */
static size_t coap_encode_option(uint8_t* buf, size_t buf_size, uint16_t delta, const uint8_t* value, size_t value_len)
{
    size_t  pos = 0;
    uint8_t delta_nibble, len_nibble;
    uint8_t delta_ext = 0, len_ext = 0;
    size_t  header_size = 1;

    /* Delta encoding */
    if (delta < 13) {
        delta_nibble = (uint8_t)delta;
    }
    else if (delta < 269) {
        delta_nibble = 13;
        delta_ext = 1;
        header_size++;
    }
    else {
        delta_nibble = 14;
        delta_ext = 2;
        header_size += 2;
    }

    /* Length encoding */
    if (value_len < 13) {
        len_nibble = (uint8_t)value_len;
    }
    else if (value_len < 269) {
        len_nibble = 13;
        len_ext = 1;
        header_size++;
    }
    else {
        len_nibble = 14;
        len_ext = 2;
        header_size += 2;
    }

    if (header_size + value_len > buf_size) return 0;

    /* First byte: delta|length */
    buf[pos++] = (uint8_t)((delta_nibble << 4) | len_nibble);

    /* Extended delta */
    if (delta_ext == 1) {
        buf[pos++] = (uint8_t)(delta - 13);
    }
    else if (delta_ext == 2) {
        uint16_t d = (uint16_t)(delta - 269);
        buf[pos++] = (uint8_t)(d >> 8);
        buf[pos++] = (uint8_t)(d & 0xFF);
    }

    /* Extended length */
    if (len_ext == 1) {
        buf[pos++] = (uint8_t)(value_len - 13);
    }
    else if (len_ext == 2) {
        uint16_t l = (uint16_t)(value_len - 269);
        buf[pos++] = (uint8_t)(l >> 8);
        buf[pos++] = (uint8_t)(l & 0xFF);
    }

    /* Value */
    memcpy(buf + pos, value, value_len);
    pos += value_len;

    return pos;
}

size_t coap_build_request(uint8_t* buf, size_t buf_size, uint16_t msg_id, uint8_t token, uint8_t code,
                          const char* uri_path, const uint8_t* payload, size_t payload_len)
{
    if (buf_size < 5) return 0; /* header(4) + token(1) minimum */

    size_t pos = 0;

    /* CoAP header: Ver=1, Type=CON, TKL=1 */
    buf[pos++] = 0x41; /* 01 00 0001 */
    buf[pos++] = code;
    buf[pos++] = (uint8_t)(msg_id >> 8);
    buf[pos++] = (uint8_t)(msg_id & 0xFF);

    /* Token (1 byte) */
    buf[pos++] = token;

    /* URI-Path options (option 11) — split path on '/' */
    if (uri_path) {
        uint16_t    prev_option = 0;
        const char* p = uri_path;
        if (*p == '/') p++; /* skip leading slash */

        while (*p) {
            const char* seg_start = p;
            while (*p && *p != '/') p++;
            size_t seg_len = (size_t)(p - seg_start);
            if (seg_len > 0) {
                uint16_t delta = COAP_OPT_URI_PATH - prev_option;
                size_t   n = coap_encode_option(buf + pos, buf_size - pos, delta, (const uint8_t*)seg_start, seg_len);
                if (n == 0) return 0;
                pos += n;
                prev_option = COAP_OPT_URI_PATH;
            }
            if (*p == '/') p++;
        }
    }

    /* Payload (no Content-Format option — matches working TS tool behavior;
     * Lutron devices reject requests with Content-Format present) */
    if (payload && payload_len > 0) {
        if (pos + 1 + payload_len > buf_size) return 0;
        buf[pos++] = 0xFF; /* payload marker */
        memcpy(buf + pos, payload, payload_len);
        pos += payload_len;
    }

    return pos;
}

size_t coap_build_observe_request(uint8_t* buf, size_t buf_size, uint16_t msg_id, uint8_t token, const char* uri_path,
                                  uint8_t observe_val)
{
    if (buf_size < 5) return 0;

    size_t pos = 0;

    /* CoAP header: Ver=1, Type=CON, TKL=1, Code=GET (0.01) */
    buf[pos++] = 0x41;
    buf[pos++] = COAP_CODE_GET;
    buf[pos++] = (uint8_t)(msg_id >> 8);
    buf[pos++] = (uint8_t)(msg_id & 0xFF);
    buf[pos++] = token;

    /* Observe option (6): 1-byte value */
    uint16_t prev_option = 0;
    size_t   n = coap_encode_option(buf + pos, buf_size - pos, COAP_OPT_OBSERVE - prev_option, &observe_val, 1);
    if (n == 0) return 0;
    pos += n;
    prev_option = COAP_OPT_OBSERVE;

    /* URI-Path options (option 11) */
    if (uri_path) {
        const char* p = uri_path;
        if (*p == '/') p++;
        while (*p) {
            const char* seg_start = p;
            while (*p && *p != '/') p++;
            size_t seg_len = (size_t)(p - seg_start);
            if (seg_len > 0) {
                uint16_t delta = COAP_OPT_URI_PATH - prev_option;
                n = coap_encode_option(buf + pos, buf_size - pos, delta, (const uint8_t*)seg_start, seg_len);
                if (n == 0) return 0;
                pos += n;
                prev_option = COAP_OPT_URI_PATH;
            }
            if (*p == '/') p++;
        }
    }

    return pos;
}

size_t coap_build_ack(uint8_t* buf, size_t buf_size, uint16_t msg_id)
{
    if (buf_size < 4) return 0;
    buf[0] = 0x60; /* Ver=1, Type=ACK, TKL=0 */
    buf[1] = 0x00; /* Empty */
    buf[2] = (uint8_t)(msg_id >> 8);
    buf[3] = (uint8_t)(msg_id & 0xFF);
    return 4;
}

size_t coap_build_non_request(uint8_t* buf, size_t buf_size, uint16_t msg_id, uint8_t token, uint8_t code,
                              const char* uri_path, const uint8_t* payload, size_t payload_len)
{
    /* Build using same logic as coap_build_request, then patch Type to NON */
    size_t len = coap_build_request(buf, buf_size, msg_id, token, code, uri_path, payload, payload_len);
    if (len > 0) {
        /* Change Type from CON (00) to NON (01) in byte 0 */
        buf[0] = (buf[0] & 0xCF) | (COAP_TYPE_NON << 4);
    }
    return len;
}

bool coap_parse_response(const uint8_t* buf, size_t len, uint8_t* type, uint8_t* code, uint16_t* msg_id)
{
    if (len < 4) return false;
    uint8_t ver = buf[0] >> 6;
    if (ver != 1) return false;
    uint8_t tkl = buf[0] & 0x0F;
    if (tkl > 8 || len < (size_t)(4 + tkl)) return false;

    *type = (buf[0] >> 4) & 0x03;
    *code = buf[1];
    *msg_id = ((uint16_t)buf[2] << 8) | buf[3];
    return true;
}
