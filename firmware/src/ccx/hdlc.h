#ifndef HDLC_H
#define HDLC_H

/**
 * HDLC-Lite framing (as used by OpenThread Spinel over UART).
 *
 * Wire format: 0x7E <escaped payload> <escaped CRC-16 LE> 0x7E
 * Escape: 0x7E and 0x7D become 0x7D followed by (byte ^ 0x20).
 * CRC: CRC-16/CCITT (reflected, poly 0x8408, init 0xFFFF, xorout 0xFFFF).
 *
 * Encoder is one-shot (buffer in → buffer out).
 * Decoder is streaming: feed one byte at a time; returns FRAME when complete.
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define HDLC_FLAG 0x7E
#define HDLC_ESCAPE 0x7D
#define HDLC_ESCAPE_XOR 0x20

/** CRC-16/CCITT (reflected) as used by HDLC-Lite. */
uint16_t hdlc_crc16(const uint8_t* data, size_t len);

/**
 * Encode a payload into a complete HDLC frame.
 * Writes: flag + escape(payload) + escape(crc_lo, crc_hi) + flag.
 *
 * Worst case output size: 2*len + 6 (every byte escaped + 2 flags + 4 CRC bytes).
 *
 * @return bytes written, or 0 on overflow.
 */
size_t hdlc_encode_frame(uint8_t* out, size_t out_size, const uint8_t* data, size_t len);

typedef enum {
    HDLC_DECODE_MORE = 0,  /**< byte accepted, no complete frame yet */
    HDLC_DECODE_FRAME = 1, /**< complete frame available in out buffer */
    HDLC_DECODE_ERROR = 2, /**< CRC mismatch or overflow — decoder reset */
} hdlc_decode_result_t;

typedef struct {
    bool in_frame;
    bool escaped;
    size_t pos;
} hdlc_decoder_t;

void hdlc_decoder_reset(hdlc_decoder_t* state);

/**
 * Push one byte into the streaming decoder.
 *
 * @param state    decoder state (zeroed by hdlc_decoder_reset)
 * @param byte     next wire byte
 * @param out      buffer accumulating unescaped frame bytes
 * @param out_size capacity of out
 * @param out_len  [out] on HDLC_DECODE_FRAME: length of unescaped payload (CRC stripped)
 */
hdlc_decode_result_t hdlc_decoder_push(hdlc_decoder_t* state, uint8_t byte, uint8_t* out, size_t out_size,
                                       size_t* out_len);

#ifdef __cplusplus
}
#endif

#endif /* HDLC_H */
