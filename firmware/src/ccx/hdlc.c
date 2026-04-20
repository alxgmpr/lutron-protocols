#include "hdlc.h"

uint16_t hdlc_crc16(const uint8_t* data, size_t len)
{
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= (uint16_t)data[i];
        for (int j = 0; j < 8; j++) {
            if (crc & 1)
                crc = (crc >> 1) ^ 0x8408;
            else
                crc >>= 1;
        }
    }
    return crc ^ 0xFFFF;
}

static size_t append_escaped(uint8_t* out, size_t out_size, size_t pos, uint8_t b)
{
    if (b == HDLC_FLAG || b == HDLC_ESCAPE) {
        if (pos + 2 > out_size) return 0;
        out[pos++] = HDLC_ESCAPE;
        out[pos++] = (uint8_t)(b ^ HDLC_ESCAPE_XOR);
    }
    else {
        if (pos + 1 > out_size) return 0;
        out[pos++] = b;
    }
    return pos;
}

size_t hdlc_encode_frame(uint8_t* out, size_t out_size, const uint8_t* data, size_t len)
{
    if (out_size < 2) return 0;
    size_t pos = 0;
    out[pos++] = HDLC_FLAG;

    for (size_t i = 0; i < len; i++) {
        size_t next = append_escaped(out, out_size, pos, data[i]);
        if (next == 0) return 0;
        pos = next;
    }

    uint16_t crc = hdlc_crc16(data, len);
    size_t next = append_escaped(out, out_size, pos, (uint8_t)(crc & 0xFF));
    if (next == 0) return 0;
    pos = next;
    next = append_escaped(out, out_size, pos, (uint8_t)(crc >> 8));
    if (next == 0) return 0;
    pos = next;

    if (pos + 1 > out_size) return 0;
    out[pos++] = HDLC_FLAG;
    return pos;
}

void hdlc_decoder_reset(hdlc_decoder_t* state)
{
    state->in_frame = false;
    state->escaped = false;
    state->pos = 0;
}

hdlc_decode_result_t hdlc_decoder_push(hdlc_decoder_t* state, uint8_t byte, uint8_t* out, size_t out_size,
                                       size_t* out_len)
{
    if (byte == HDLC_FLAG) {
        if (state->in_frame && state->pos > 0) {
            /* End of frame — verify CRC (last 2 bytes, LE) */
            if (state->pos < 2) {
                hdlc_decoder_reset(state);
                return HDLC_DECODE_ERROR;
            }
            uint16_t rx_crc = (uint16_t)out[state->pos - 2] | ((uint16_t)out[state->pos - 1] << 8);
            uint16_t calc_crc = hdlc_crc16(out, state->pos - 2);
            bool ok = (rx_crc == calc_crc);
            if (ok && out_len) *out_len = state->pos - 2;
            hdlc_decoder_reset(state);
            return ok ? HDLC_DECODE_FRAME : HDLC_DECODE_ERROR;
        }
        /* Start of new frame (or back-to-back flag) */
        state->in_frame = true;
        state->pos = 0;
        state->escaped = false;
        return HDLC_DECODE_MORE;
    }

    if (!state->in_frame) return HDLC_DECODE_MORE;

    if (byte == HDLC_ESCAPE) {
        state->escaped = true;
        return HDLC_DECODE_MORE;
    }

    if (state->escaped) {
        byte ^= HDLC_ESCAPE_XOR;
        state->escaped = false;
    }

    if (state->pos >= out_size) {
        hdlc_decoder_reset(state);
        return HDLC_DECODE_ERROR;
    }
    out[state->pos++] = byte;
    return HDLC_DECODE_MORE;
}
