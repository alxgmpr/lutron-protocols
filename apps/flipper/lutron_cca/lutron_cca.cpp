// Lutron CCA sniffer for Flipper Zero (step 1: RX + decode).
// Reuses the firmware's N81 / CRC / decoder headers unchanged.
#include <furi.h>
#include <furi_hal.h>
#include <gui/gui.h>
#include <input/input.h>
#include <stdio.h>

#include "../../../firmware/src/cca/cca_decoder.h"

#define RX_PKT_LEN 80
#define ACCUM_TIMEOUT_MS 40
#define ROWS 5

// Register/value pairs, {0,0} terminator (so register 0x00 cannot be used), then 8-byte PA table.
// Values mirror firmware/src/cca/cc1101.c (cc1101_init + cc1101_start_rx).
static const uint8_t cca_rx_preset[] = {
    0x02, 0x06, // IOCFG0: sync detect
    0x03, 0x07, // FIFOTHR
    0x04, 0xAA, // SYNC1  (preamble sync, 15/16 match)
    0x05, 0xAA, // SYNC0
    0x06, RX_PKT_LEN, // PKTLEN
    0x07, 0x00, // PKTCTRL1
    0x08, 0x00, // PKTCTRL0: fixed length
    0x09, 0x00, // ADDR
    0x0A, 0x00, // CHANNR
    0x0B, 0x06, // FSCTRL1
    0x0C, 0x00, // FSCTRL0
    0x10, 0x5B, // MDMCFG4
    0x11, 0x3B, // MDMCFG3  (~62.5 kBd)
    0x12, 0x01, // MDMCFG2: 2-FSK, 15/16 sync
    0x13, 0x00, // MDMCFG1
    0x14, 0x00, // MDMCFG0
    0x15, 0x45, // DEVIATN
    0x17, 0x0F, // MCSM1: stay in RX
    0x18, 0x18, // MCSM0
    0x19, 0x16, // FOCCFG
    0x1A, 0x6C, // BSCFG
    0x1B, 0x43, // AGCCTRL2
    0x1C, 0x40, // AGCCTRL1
    0x1D, 0x91, // AGCCTRL0
    0x21, 0x56, // FREND1
    0x22, 0x10, // FREND0
    0x23, 0xEA, // FSCAL3
    0x24, 0x2A, // FSCAL2
    0x25, 0x00, // FSCAL1
    0x26, 0x1F, // FSCAL0
    0x2C, 0xAC, // TEST2: improved RX sensitivity
    0x00, 0x00, // terminator
    0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // PA table
};
static const uint32_t CCA_FREQ_HZ = 433602844;

static auto* spi = &furi_hal_spi_bus_handle_subghz;

static uint8_t cc_status(uint8_t reg) {
    uint8_t tx[2] = {(uint8_t)(reg | 0xC0), 0}, rx[2] = {0, 0};
    furi_hal_spi_acquire(spi);
    furi_hal_spi_bus_trx(spi, tx, rx, 2, 10);
    furi_hal_spi_release(spi);
    return rx[1];
}

// RXBYTES can misread while bytes arrive; accept two equal reads (as firmware does).
static uint8_t cc_rxbytes() {
    uint8_t a = cc_status(0x3B), b = cc_status(0x3B);
    while(a != b) {
        a = b;
        b = cc_status(0x3B);
    }
    return a;
}

static void cc_read_fifo(uint8_t* out, size_t n) {
    uint8_t tx[RX_PKT_LEN + 1] = {0xFF}, rx[RX_PKT_LEN + 1];
    furi_hal_spi_acquire(spi);
    furi_hal_spi_bus_trx(spi, tx, rx, n + 1, 20);
    furi_hal_spi_release(spi);
    memcpy(out, rx + 1, n);
}

static int8_t cc_rssi_dbm() {
    uint8_t r = cc_status(0x34);
    return (r >= 128) ? (int8_t)((int16_t)(r - 256) / 2 - 74) : (int8_t)(r / 2 - 74);
}

static void radio_start() {
    furi_hal_subghz_reset();
    furi_hal_subghz_idle();
    furi_hal_subghz_load_custom_preset(cca_rx_preset);
    furi_hal_subghz_set_frequency_and_path(CCA_FREQ_HZ);
    furi_hal_subghz_flush_rx();
    furi_hal_subghz_rx();
}

static void radio_restart() {
    furi_hal_subghz_idle();
    furi_hal_subghz_flush_rx();
    furi_hal_subghz_rx();
}

typedef struct {
    char line[ROWS][32];
    uint32_t total, crc_ok, overflow, syncs;
    FuriMutex* mutex;
} State;

static void draw_cb(Canvas* c, void* ctx) {
    State* s = (State*)ctx;
    furi_mutex_acquire(s->mutex, FuriWaitForever);
    canvas_set_font(c, FontSecondary);
    char hdr[40];
    snprintf(hdr, sizeof(hdr), "rx%lu ok%lu ov%lu sy%lu", s->total, s->crc_ok, s->overflow, s->syncs);
    canvas_draw_str(c, 0, 9, hdr);
    for(int i = 0; i < ROWS; i++) canvas_draw_str(c, 0, 21 + i * 10, s->line[i]);
    furi_mutex_release(s->mutex);
}

static void input_cb(InputEvent* e, void* ctx) {
    FuriMessageQueue* q = (FuriMessageQueue*)ctx;
    furi_message_queue_put(q, e, 0);
}

extern "C" int32_t lutron_cca_app(void* p) {
    UNUSED(p);
    State* s = (State*)malloc(sizeof(State));
    memset(s, 0, sizeof(State));
    s->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    FuriMessageQueue* q = furi_message_queue_alloc(4, sizeof(InputEvent));

    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, draw_cb, s);
    view_port_input_callback_set(vp, input_cb, q);
    Gui* gui = (Gui*)furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, vp, GuiLayerFullscreen);

    radio_start();

    uint8_t buf[RX_PKT_LEN + 4];
    size_t len = 0;
    bool active = false;
    int8_t rssi = 0;
    uint32_t t0 = 0;
    bool run = true;

    while(run) {
        InputEvent ev;
        if(furi_message_queue_get(q, &ev, 0) == FuriStatusOk && ev.type == InputTypeShort &&
           ev.key == InputKeyBack)
            break;

        uint8_t rb = cc_rxbytes();
        if(rb & 0x80) { // FIFO overflow
            s->overflow++;
            radio_restart();
            len = 0;
            active = false;
        } else if(rb > 0) {
            if(!active) {
                active = true;
                s->syncs++;
                view_port_update(vp);
                len = 0;
                t0 = furi_get_tick();
                rssi = cc_rssi_dbm();
            }
            size_t n = rb < (sizeof(buf) - len) ? rb : (sizeof(buf) - len);
            if(len + n > RX_PKT_LEN) n = RX_PKT_LEN - len;
            if(n) {
                cc_read_fifo(buf + len, n);
                len += n;
            }
        }

        if(active && len >= RX_PKT_LEN) {
            DecodedPacket pkt;
            pkt.clear();
            if(CcaDecoder::decode(buf, len, pkt) && pkt.valid) {
                furi_mutex_acquire(s->mutex, FuriWaitForever);
                s->total++;
                if(pkt.crc_valid) s->crc_ok++;
                memmove(s->line[1], s->line[0], sizeof(s->line[0]) * (ROWS - 1));
                snprintf(
                    s->line[0], sizeof(s->line[0]), "%02X s%02X %08lX L%02X %c %d",
                    pkt.type_byte, pkt.sequence, (unsigned long)pkt.device_id, pkt.level,
                    pkt.crc_valid ? '+' : '!', rssi);
                furi_mutex_release(s->mutex);
                view_port_update(vp);
            }
            len = 0;
            active = false;
        } else if(active && (furi_get_tick() - t0) > ACCUM_TIMEOUT_MS) {
            radio_restart();
            len = 0;
            active = false;
        }
        furi_delay_ms(2);
    }

    furi_hal_subghz_idle();
    furi_hal_subghz_sleep();
    gui_remove_view_port(gui, vp);
    view_port_free(vp);
    furi_record_close(RECORD_GUI);
    furi_message_queue_free(q);
    furi_mutex_free(s->mutex);
    free(s);
    return 0;
}
