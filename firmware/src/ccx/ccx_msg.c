#include "ccx_msg.h"
#include "ccx_cbor.h"
#include <string.h>

/* -----------------------------------------------------------------------
 * Encoder helpers — append to buffer, advance pointer
 * ----------------------------------------------------------------------- */

#define EMIT(fn, ...)                                      \
    do {                                                   \
        size_t _n = fn(p, (size_t)(end - p), __VA_ARGS__); \
        if (_n == 0) return 0;                             \
        p += _n;                                           \
    } while (0)

size_t ccx_encode_level_control(uint8_t* buf, size_t buf_size, uint16_t zone_id, uint16_t level, uint8_t fade,
                                uint8_t sequence)
{
    /*
     * Target CBOR structure (matches encoder.ts):
     *   [0, { 0: {0: level, 3: fade}, 1: [16, zone_id], 5: sequence }]
     *
     * Known-good hex for ON zone=961 seq=92:
     *   82 00 a3 00 a2 00 19feff 03 01 01 82 10 1903c1 05 185c
     */
    uint8_t* p = buf;
    const uint8_t* end = buf + buf_size;

    /* Outer array(2) */
    EMIT(cbor_encode_array, 2);

    /* msg_type = 0 (LEVEL_CONTROL) */
    EMIT(cbor_encode_uint, CCX_MSG_LEVEL_CONTROL);

    /* Body map(3): keys 0, 1, 5 */
    EMIT(cbor_encode_map, 3);

    /* Key 0: COMMAND → map(2) { 0: level, 3: fade } */
    EMIT(cbor_encode_uint, CCX_KEY_COMMAND);
    EMIT(cbor_encode_map, 2);
    EMIT(cbor_encode_uint, 0);     /* key 0 */
    EMIT(cbor_encode_uint, level); /* value: level */
    EMIT(cbor_encode_uint, 3);     /* key 3 (fade) */
    EMIT(cbor_encode_uint, fade);  /* value: fade */

    /* Key 1: ZONE → array(2) [zone_type, zone_id] */
    EMIT(cbor_encode_uint, CCX_KEY_ZONE);
    EMIT(cbor_encode_array, 2);
    EMIT(cbor_encode_uint, CCX_ZONE_TYPE_DIMMER);
    EMIT(cbor_encode_uint, zone_id);

    /* Key 5: SEQUENCE → uint */
    EMIT(cbor_encode_uint, CCX_KEY_SEQUENCE);
    EMIT(cbor_encode_uint, sequence);

    return (size_t)(p - buf);
}

size_t ccx_encode_scene_recall(uint8_t* buf, size_t buf_size, uint16_t scene_id, uint8_t sequence)
{
    /*
     * Target CBOR structure (matches encoder.ts):
     *   [36, { 0: {0: [4]}, 1: [0], 3: {0: scene_id}, 5: sequence }]
     */
    uint8_t* p = buf;
    const uint8_t* end = buf + buf_size;

    /* Outer array(2) */
    EMIT(cbor_encode_array, 2);

    /* msg_type = 36 (SCENE_RECALL) */
    EMIT(cbor_encode_uint, CCX_MSG_SCENE_RECALL);

    /* Body map(4): keys 0, 1, 3, 5 */
    EMIT(cbor_encode_map, 4);

    /* Key 0: COMMAND → map(1) { 0: [4] } */
    EMIT(cbor_encode_uint, CCX_KEY_COMMAND);
    EMIT(cbor_encode_map, 1);
    EMIT(cbor_encode_uint, 0);
    EMIT(cbor_encode_array, 1);
    EMIT(cbor_encode_uint, 4);

    /* Key 1: ZONE → array(1) [0] */
    EMIT(cbor_encode_uint, CCX_KEY_ZONE);
    EMIT(cbor_encode_array, 1);
    EMIT(cbor_encode_uint, 0);

    /* Key 3: EXTRA → map(1) { 0: scene_id } */
    EMIT(cbor_encode_uint, CCX_KEY_EXTRA);
    EMIT(cbor_encode_map, 1);
    EMIT(cbor_encode_uint, 0);
    EMIT(cbor_encode_uint, scene_id);

    /* Key 5: SEQUENCE → uint */
    EMIT(cbor_encode_uint, CCX_KEY_SEQUENCE);
    EMIT(cbor_encode_uint, sequence);

    return (size_t)(p - buf);
}

#undef EMIT

uint16_t ccx_percent_to_level(uint8_t percent)
{
    if (percent == 0) return CCX_LEVEL_OFF;
    if (percent >= 100) return CCX_LEVEL_FULL_ON;
    return (uint16_t)(((uint32_t)percent * CCX_LEVEL_FULL_ON) / 100);
}

/* -----------------------------------------------------------------------
 * Decoder — minimal pull-style CBOR parser
 *
 * CCX messages are: [msg_type, body_map]
 * We walk the CBOR structure extracting known fields.
 * ----------------------------------------------------------------------- */

/* Advance past one complete CBOR item (recursively skips containers) */
static size_t cbor_skip_item(const uint8_t* buf, size_t len)
{
    cbor_item_t item;
    if (!cbor_decode_item(buf, len, &item)) return 0;

    size_t pos = item.header_len;

    switch (item.major) {
    case CBOR_MAJOR_UINT:
    case CBOR_MAJOR_NINT:
        return pos;

    case CBOR_MAJOR_BSTR:
    case CBOR_MAJOR_TSTR:
        return pos + item.value;

    case CBOR_MAJOR_ARRAY:
        for (uint32_t i = 0; i < item.value; i++) {
            size_t skip = cbor_skip_item(buf + pos, len - pos);
            if (skip == 0) return 0;
            pos += skip;
        }
        return pos;

    case CBOR_MAJOR_MAP:
        for (uint32_t i = 0; i < item.value; i++) {
            /* key */
            size_t skip = cbor_skip_item(buf + pos, len - pos);
            if (skip == 0) return 0;
            pos += skip;
            /* value */
            skip = cbor_skip_item(buf + pos, len - pos);
            if (skip == 0) return 0;
            pos += skip;
        }
        return pos;

    default:
        return 0;
    }
}

/* Read a uint from current position, advance pos */
static bool read_uint(const uint8_t* buf, size_t len, size_t* pos, uint32_t* val)
{
    size_t consumed;
    if (!cbor_decode_uint(buf + *pos, len - *pos, val, &consumed)) return false;
    *pos += consumed;
    return true;
}

/* Decode the inner COMMAND map for LEVEL_CONTROL: {0: level, 3: fade} */
static void decode_level_command(const uint8_t* buf, size_t len, ccx_decoded_msg_t* out)
{
    cbor_item_t item;
    size_t pos = 0;

    if (!cbor_decode_item(buf + pos, len - pos, &item)) return;
    if (item.major != CBOR_MAJOR_MAP) return;
    pos += item.header_len;
    uint32_t count = item.value;

    for (uint32_t i = 0; i < count; i++) {
        uint32_t key;
        if (!read_uint(buf, len, &pos, &key)) return;

        uint32_t val;
        if (!read_uint(buf, len, &pos, &val)) return;

        if (key == 0)
            out->level = (uint16_t)val;
        else if (key == 3)
            out->fade = (uint8_t)val;
        else if (key == 4)
            out->delay = (uint8_t)val;
    }
}

/* Decode ZONE array: [zone_type, zone_id] */
static void decode_zone(const uint8_t* buf, size_t len, ccx_decoded_msg_t* out)
{
    cbor_item_t item;
    size_t pos = 0;

    if (!cbor_decode_item(buf + pos, len - pos, &item)) return;
    if (item.major != CBOR_MAJOR_ARRAY) return;
    pos += item.header_len;

    uint32_t val;
    if (item.value >= 1 && read_uint(buf, len, &pos, &val)) out->zone_type = (uint8_t)val;
    if (item.value >= 2 && read_uint(buf, len, &pos, &val)) out->zone_id = (uint16_t)val;
}

/* Decode DEVICE array: [device_type, device_serial] */
static void decode_device(const uint8_t* buf, size_t len, ccx_decoded_msg_t* out)
{
    cbor_item_t item;
    size_t pos = 0;

    if (!cbor_decode_item(buf + pos, len - pos, &item)) return;
    if (item.major != CBOR_MAJOR_ARRAY) return;
    pos += item.header_len;

    uint32_t val;
    if (item.value >= 1) {
        /* skip device_type */
        size_t skip = cbor_skip_item(buf + pos, len - pos);
        if (skip == 0) return;
        pos += skip;
    }
    if (item.value >= 2 && read_uint(buf, len, &pos, &val)) out->device_serial = val;
}

/* Decode EXTRA map: {0: scene_id/group_id, 1: group_id, 2: [type, value]} */
static void decode_extra(const uint8_t* buf, size_t len, ccx_decoded_msg_t* out)
{
    cbor_item_t item;
    size_t pos = 0;

    if (!cbor_decode_item(buf + pos, len - pos, &item)) return;
    if (item.major != CBOR_MAJOR_MAP) return;
    pos += item.header_len;
    uint32_t count = item.value;

    for (uint32_t i = 0; i < count; i++) {
        uint32_t key;
        if (!read_uint(buf, len, &pos, &key)) return;

        if (key == 0) {
            uint32_t val;
            if (!read_uint(buf, len, &pos, &val)) return;
            out->scene_id = (uint16_t)val;
        }
        else if (key == 1) {
            uint32_t val;
            if (!read_uint(buf, len, &pos, &val)) return;
            out->group_id = (uint16_t)val;
        }
        else if (key == 2) {
            /* Array [component_type, component_value] */
            cbor_item_t arr;
            if (!cbor_decode_item(buf + pos, len - pos, &arr)) return;
            if (arr.major == CBOR_MAJOR_ARRAY) {
                pos += arr.header_len;
                uint32_t val;
                if (arr.value >= 1 && read_uint(buf, len, &pos, &val)) out->component_type = (uint16_t)val;
                if (arr.value >= 2 && read_uint(buf, len, &pos, &val)) out->component_value = (uint16_t)val;
                for (uint32_t k = 2; k < arr.value; k++) {
                    size_t skip = cbor_skip_item(buf + pos, len - pos);
                    if (skip == 0) return;
                    pos += skip;
                }
            }
            else {
                size_t skip = cbor_skip_item(buf + pos, len - pos);
                if (skip == 0) return;
                pos += skip;
            }
        }
        else {
            size_t skip = cbor_skip_item(buf + pos, len - pos);
            if (skip == 0) return;
            pos += skip;
        }
    }
}

/* Decode COMMAND for BUTTON_PRESS/DIM: {0: bstr(device_id), ...} */
static void decode_button_command(const uint8_t* buf, size_t len, ccx_decoded_msg_t* out)
{
    cbor_item_t item;
    size_t pos = 0;

    if (!cbor_decode_item(buf + pos, len - pos, &item)) return;
    if (item.major != CBOR_MAJOR_MAP) return;
    pos += item.header_len;
    uint32_t count = item.value;

    for (uint32_t i = 0; i < count; i++) {
        uint32_t key;
        if (!read_uint(buf, len, &pos, &key)) return;

        if (key == 0) {
            /* Value is a byte string (device ID) */
            cbor_item_t val_item;
            if (!cbor_decode_item(buf + pos, len - pos, &val_item)) return;
            pos += val_item.header_len;
            if (val_item.major == CBOR_MAJOR_BSTR && val_item.value <= 4) {
                memcpy(out->device_id, buf + pos, val_item.value);
                pos += val_item.value;
            }
            else {
                /* skip value */
                size_t skip = cbor_skip_item(buf + pos - val_item.header_len, len - pos + val_item.header_len);
                if (skip == 0) return;
                pos = pos - val_item.header_len + skip;
            }
        }
        else if (key == 1) {
            uint32_t val;
            if (!read_uint(buf, len, &pos, &val)) return;
            out->action = (uint8_t)val;
        }
        else if (key == 2) {
            uint32_t val;
            if (!read_uint(buf, len, &pos, &val)) return;
            out->step_value = (uint16_t)val;
        }
        else {
            /* skip value */
            size_t skip = cbor_skip_item(buf + pos, len - pos);
            if (skip == 0) return;
            pos += skip;
        }
    }
}

/* Decode COMMAND for ACK: {1: {0: bstr(response)}} */
static void decode_ack_command(const uint8_t* buf, size_t len, ccx_decoded_msg_t* out)
{
    cbor_item_t item;
    size_t pos = 0;

    if (!cbor_decode_item(buf + pos, len - pos, &item)) return;
    if (item.major != CBOR_MAJOR_MAP) return;
    pos += item.header_len;
    uint32_t count = item.value;

    for (uint32_t i = 0; i < count; i++) {
        uint32_t key;
        if (!read_uint(buf, len, &pos, &key)) return;

        if (key == 1) {
            /* Inner map: {0: bstr(response)} */
            cbor_item_t inner;
            if (!cbor_decode_item(buf + pos, len - pos, &inner)) return;
            if (inner.major != CBOR_MAJOR_MAP) {
                size_t skip = cbor_skip_item(buf + pos, len - pos);
                if (skip == 0) return;
                pos += skip;
                continue;
            }
            pos += inner.header_len;
            uint32_t inner_count = inner.value;

            for (uint32_t j = 0; j < inner_count; j++) {
                uint32_t inner_key;
                if (!read_uint(buf, len, &pos, &inner_key)) return;

                if (inner_key == 0) {
                    cbor_item_t bstr;
                    if (!cbor_decode_item(buf + pos, len - pos, &bstr)) return;
                    pos += bstr.header_len;
                    if (bstr.major == CBOR_MAJOR_BSTR && bstr.value <= sizeof(out->response)) {
                        memcpy(out->response, buf + pos, bstr.value);
                        out->response_len = (uint8_t)bstr.value;
                        pos += bstr.value;
                    }
                    else {
                        pos -= bstr.header_len;
                        size_t skip = cbor_skip_item(buf + pos, len - pos);
                        if (skip == 0) return;
                        pos += skip;
                    }
                }
                else {
                    size_t skip = cbor_skip_item(buf + pos, len - pos);
                    if (skip == 0) return;
                    pos += skip;
                }
            }
        }
        else {
            size_t skip = cbor_skip_item(buf + pos, len - pos);
            if (skip == 0) return;
            pos += skip;
        }
    }
}

bool ccx_decode_message(const uint8_t* cbor, size_t len, ccx_decoded_msg_t* out)
{
    memset(out, 0, sizeof(*out));

    size_t pos = 0;
    cbor_item_t item;

    /* Outer array(2): [msg_type, body_map] */
    if (!cbor_decode_item(cbor + pos, len - pos, &item)) return false;
    if (item.major != CBOR_MAJOR_ARRAY || item.value < 2) return false;
    pos += item.header_len;

    /* msg_type */
    uint32_t msg_type;
    if (!read_uint(cbor, len, &pos, &msg_type)) return false;
    out->msg_type = (uint16_t)msg_type;

    /* body map */
    if (!cbor_decode_item(cbor + pos, len - pos, &item)) return false;
    if (item.major != CBOR_MAJOR_MAP) return false;
    pos += item.header_len;
    uint32_t body_count = item.value;

    for (uint32_t i = 0; i < body_count; i++) {
        uint32_t key;
        if (!read_uint(cbor, len, &pos, &key)) return false;

        /* Record start of value so sub-decoders can parse it */
        size_t val_start = pos;
        size_t val_size = cbor_skip_item(cbor + pos, len - pos);
        if (val_size == 0) return false;
        pos += val_size;

        switch (key) {
        case CCX_KEY_COMMAND:
            if (out->msg_type == CCX_MSG_LEVEL_CONTROL) {
                decode_level_command(cbor + val_start, val_size, out);
            }
            else if (out->msg_type == CCX_MSG_BUTTON_PRESS || out->msg_type == CCX_MSG_DIM_HOLD ||
                     out->msg_type == CCX_MSG_DIM_STEP) {
                decode_button_command(cbor + val_start, val_size, out);
            }
            else if (out->msg_type == CCX_MSG_ACK) {
                decode_ack_command(cbor + val_start, val_size, out);
            }
            /* STATUS/COMPONENT_CMD: COMMAND is variable, skip */
            break;

        case CCX_KEY_ZONE:
            decode_zone(cbor + val_start, val_size, out);
            break;

        case CCX_KEY_DEVICE:
            decode_device(cbor + val_start, val_size, out);
            break;

        case CCX_KEY_EXTRA:
            if (out->msg_type == CCX_MSG_SCENE_RECALL || out->msg_type == CCX_MSG_COMPONENT_CMD ||
                out->msg_type == CCX_MSG_DEVICE_REPORT) {
                decode_extra(cbor + val_start, val_size, out);
            }
            break;

        case CCX_KEY_STATUS: {
            uint32_t val;
            size_t dummy;
            if (cbor_decode_uint(cbor + val_start, val_size, &val, &dummy)) {
                out->status_value = (uint8_t)val;
            }
            break;
        }

        case CCX_KEY_SEQUENCE: {
            uint32_t seq;
            size_t dummy;
            if (cbor_decode_uint(cbor + val_start, val_size, &seq, &dummy)) {
                out->sequence = (uint8_t)seq;
            }
            break;
        }

        default:
            break;
        }
    }

    return true;
}

const char* ccx_msg_type_name(uint16_t msg_type)
{
    switch (msg_type) {
    case CCX_MSG_LEVEL_CONTROL:
        return "LEVEL_CONTROL";
    case CCX_MSG_BUTTON_PRESS:
        return "BUTTON_PRESS";
    case CCX_MSG_DIM_HOLD:
        return "DIM_HOLD";
    case CCX_MSG_DIM_STEP:
        return "DIM_STEP";
    case CCX_MSG_ACK:
        return "ACK";
    case CCX_MSG_DEVICE_REPORT:
        return "DEVICE_REPORT";
    case CCX_MSG_SCENE_RECALL:
        return "SCENE_RECALL";
    case CCX_MSG_COMPONENT_CMD:
        return "COMPONENT_CMD";
    case CCX_MSG_STATUS:
        return "STATUS";
    case CCX_MSG_PRESENCE:
        return "PRESENCE";
    default:
        return "UNKNOWN";
    }
}
