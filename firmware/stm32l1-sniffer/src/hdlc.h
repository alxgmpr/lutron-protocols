/* HDLC framing — CRC-16/CCITT, escape/unescape, frame decode */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define HDLC_FLAG        0x7E
#define HDLC_ESCAPE      0x7D
#define HDLC_ESCAPE_XOR  0x20
#define HDLC_MAX_FRAME   256

/* HDLC control field types */
#define HDLC_IFRAME(ns, nr, pf) (((nr) << 5) | ((pf) << 4) | ((ns) << 1))
#define HDLC_IS_IFRAME(c)  (((c) & 1) == 0)
#define HDLC_IS_SFRAME(c)  (((c) & 3) == 1)
#define HDLC_IS_UFRAME(c)  (((c) & 3) == 3)

/* U-frame commands (5 high bits + P/F + 11) */
#define HDLC_SABM  0x3F  /* Set Asynchronous Balanced Mode, P=1 */
#define HDLC_UA    0x73  /* Unnumbered Acknowledge, F=1 */
#define HDLC_DISC  0x53  /* Disconnect, P=1 */
#define HDLC_DM    0x1F  /* Disconnected Mode, F=1 */
#define HDLC_UI    0x03  /* Unnumbered Information */

/* S-frame types (bits 2-3) */
#define HDLC_RR   0x01   /* Receive Ready */
#define HDLC_RNR  0x05   /* Receive Not Ready */
#define HDLC_REJ  0x09   /* Reject */

typedef struct {
    uint8_t frame[HDLC_MAX_FRAME];
    uint16_t pos;
    bool in_frame;
    bool escaped;
} hdlc_state_t;

void hdlc_init(hdlc_state_t* s);

/* Feed one byte. Returns:
 *   >0 = complete frame, length is return value (payload without CRC)
 *    0 = need more data
 *   -1 = CRC error */
int hdlc_feed(hdlc_state_t* s, uint8_t byte);

/* CRC-16/CCITT (poly 0x8408, init 0xFFFF, final XOR 0xFFFF) */
uint16_t hdlc_crc16(const uint8_t* data, size_t len);

/* Build and send an HDLC frame on USART1 */
void hdlc_send(const uint8_t* payload, size_t len);

/* Decode and print control field info via semihosting */
void hdlc_decode_ctrl(uint8_t addr, uint8_t ctrl, const uint8_t* info, size_t info_len);
