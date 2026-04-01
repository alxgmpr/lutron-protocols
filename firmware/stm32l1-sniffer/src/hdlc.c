/* HDLC framing — ported from firmware/src/ccx/ccx_task.cpp */
#include "hdlc.h"
#include "bsp.h"

uint16_t hdlc_crc16(const uint8_t* data, size_t len) {
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

void hdlc_init(hdlc_state_t* s) {
    s->pos = 0;
    s->in_frame = false;
    s->escaped = false;
}

int hdlc_feed(hdlc_state_t* s, uint8_t byte) {
    if (byte == HDLC_FLAG) {
        if (s->in_frame && s->pos > 0) {
            /* End of frame — check CRC */
            if (s->pos < 2) {
                s->pos = 0;
                return -1;
            }
            uint16_t rx_crc = (uint16_t)s->frame[s->pos - 2] |
                              ((uint16_t)s->frame[s->pos - 1] << 8);
            uint16_t calc_crc = hdlc_crc16(s->frame, s->pos - 2);
            int len = s->pos - 2;
            s->pos = 0;
            s->in_frame = true;
            s->escaped = false;
            return (rx_crc == calc_crc) ? len : -1;
        }
        /* Start of frame */
        s->in_frame = true;
        s->pos = 0;
        s->escaped = false;
        return 0;
    }

    if (!s->in_frame) return 0;

    if (byte == HDLC_ESCAPE) {
        s->escaped = true;
        return 0;
    }

    if (s->escaped) {
        byte ^= HDLC_ESCAPE_XOR;
        s->escaped = false;
    }

    if (s->pos < HDLC_MAX_FRAME) {
        s->frame[s->pos++] = byte;
    }
    return 0;
}

void hdlc_send(const uint8_t* payload, size_t len) {
    usart1_tx_byte(HDLC_FLAG);

    for (size_t i = 0; i < len; i++) {
        uint8_t b = payload[i];
        if (b == HDLC_FLAG || b == HDLC_ESCAPE) {
            usart1_tx_byte(HDLC_ESCAPE);
            usart1_tx_byte(b ^ HDLC_ESCAPE_XOR);
        } else {
            usart1_tx_byte(b);
        }
    }

    uint16_t crc = hdlc_crc16(payload, len);
    uint8_t crc_lo = (uint8_t)(crc & 0xFF);
    uint8_t crc_hi = (uint8_t)(crc >> 8);

    /* Escape CRC bytes too */
    if (crc_lo == HDLC_FLAG || crc_lo == HDLC_ESCAPE) {
        usart1_tx_byte(HDLC_ESCAPE);
        usart1_tx_byte(crc_lo ^ HDLC_ESCAPE_XOR);
    } else {
        usart1_tx_byte(crc_lo);
    }
    if (crc_hi == HDLC_FLAG || crc_hi == HDLC_ESCAPE) {
        usart1_tx_byte(HDLC_ESCAPE);
        usart1_tx_byte(crc_hi ^ HDLC_ESCAPE_XOR);
    } else {
        usart1_tx_byte(crc_hi);
    }

    usart1_tx_byte(HDLC_FLAG);
}

void hdlc_decode_ctrl(uint8_t addr, uint8_t ctrl, const uint8_t* info, size_t info_len) {
    sh_printf("  addr=0x%02X ctrl=0x%02X ", addr, ctrl);

    if (HDLC_IS_UFRAME(ctrl)) {
        /* U-frame */
        switch (ctrl & 0xEF) { /* mask P/F bit */
        case (HDLC_SABM & 0xEF): sh_puts("U:SABM"); break;
        case (HDLC_UA & 0xEF):   sh_puts("U:UA"); break;
        case (HDLC_DISC & 0xEF): sh_puts("U:DISC"); break;
        case (HDLC_DM & 0xEF):   sh_puts("U:DM"); break;
        case (HDLC_UI & 0xEF):   sh_puts("U:UI"); break;
        default: sh_printf("U:0x%02X", ctrl); break;
        }
    } else if (HDLC_IS_SFRAME(ctrl)) {
        /* S-frame */
        uint8_t type = (ctrl >> 2) & 3;
        uint8_t nr = (ctrl >> 5) & 7;
        const char* names[] = {"RR", "RNR", "REJ", "SREJ"};
        sh_printf("S:%s N(R)=%u", names[type], nr);
    } else {
        /* I-frame */
        uint8_t ns = (ctrl >> 1) & 7;
        uint8_t nr = (ctrl >> 5) & 7;
        uint8_t pf = (ctrl >> 4) & 1;
        sh_printf("I:N(S)=%u N(R)=%u P=%u", ns, nr, pf);
        if (info_len >= 2) {
            uint16_t cmd = ((uint16_t)info[0] << 8) | info[1];
            sh_printf(" CLAP=0x%04X", cmd);
            if (info_len > 2) {
                sh_puts(" data=");
                sh_puthex(info + 2, info_len - 2 > 32 ? 32 : info_len - 2);
            }
        }
    }
}
