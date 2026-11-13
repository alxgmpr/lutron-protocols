// Lutron CCA sniffer/transmitter for Flipper Zero.
// RX: decoded packets go to a scrollable history list and to the log (CLI `log`).
//     Up/Down scroll, OK opens the packet detail view, Back exits.
// TX: OK in the detail view replays that packet; /ext/cca_tx.txt is a host-driven TX queue
//     (see send_tx_file).
// Closed-loop check against openlutron: tools/flipper/cca-loopback.ts.
// Reuses the firmware's N81 / CRC / decoder headers unchanged.
#include <furi.h>
#include <furi_hal.h>
#include <gui/gui.h>
#include <gui/elements.h>
#include <notification/notification_messages.h>
#include <input/input.h>
#include <stdio.h>
#include <stdarg.h>
#include <storage/storage.h>

#include "../../../firmware/src/cca/cca_decoder.h"
#include "cca_describe.h"

#define RX_PKT_LEN 80
#define ACCUM_TIMEOUT_MS 40
#define ROWS 5 // list rows on screen
#define DROWS 4 // detail lines on screen
#define HIST 64 // scrollback depth
#define REPEAT_MS 2000 // copies of a packet heard within this window collapse into one row

// Register/value pairs, {0,0} terminator (so register 0x00 cannot be used), then 8-byte PA table.
// Values mirror firmware/src/cca/cc1101.c (cc1101_init + cc1101_start_rx).
static const uint8_t cca_rx_preset[] = {
    0x02, 0x06, // IOCFG0: sync detect
    0x03, 0x07, // FIFOTHR
    0x04, 0xAA, // SYNC1  (preamble sync, 16/16 match)
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
    0x12, 0x02, // MDMCFG2: 2-FSK, 16/16 sync (15/16 fires on noise ~8x/s)
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

static uint8_t cc_rd(uint8_t reg) {
    uint8_t tx[2] = {(uint8_t)(reg | 0x80), 0}, rx[2] = {0, 0};
    furi_hal_spi_acquire(spi);
    furi_hal_spi_bus_trx(spi, tx, rx, 2, 10);
    furi_hal_spi_release(spi);
    return rx[1];
}

// Log a line; read it over USB with the CLI `log` command.
static void diag(const char* fmt, ...) {
    char buf[200];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    FURI_LOG_I("CCA", "%s", buf);
}

static void hex(char* out, const uint8_t* d, size_t n) {
    for(size_t i = 0; i < n; i++) snprintf(out + i * 2, 3, "%02X", d[i]);
    out[n * 2] = 0;
}

static void cc_wr(uint8_t reg, uint8_t val) {
    uint8_t tx[2] = {reg, val};
    furi_hal_spi_acquire(spi);
    furi_hal_spi_bus_tx(spi, tx, 2, 10);
    furi_hal_spi_release(spi);
}

static void cc_write_txfifo(const uint8_t* d, size_t n) {
    uint8_t tx[65] = {0x7F}; // TXFIFO burst write
    memcpy(tx + 1, d, n);
    furi_hal_spi_acquire(spi);
    furi_hal_spi_bus_tx(spi, tx, n + 1, 20);
    furi_hal_spi_release(spi);
}

static bool cc_wait_state(uint8_t want, uint32_t timeout_ms) {
    uint32_t t = furi_get_tick();
    while((cc_status(0x35) & 0x1F) != want) {
        if(furi_get_tick() - t > timeout_ms) return false;
        furi_delay_us(100);
    }
    return true;
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

// Send one N81-encoded packet, then return to RX. Mirrors cc1101_transmit_raw_fast.
// ponytail: fixed-length path only (<=64 encoded bytes = 24-byte packets, i.e. Pico/dimmer
// traffic); 53-byte packets need the infinite-length FIFO refill from cc1101.c.
static bool cca_transmit(const uint8_t* encoded, size_t len) {
    if(len > 64) return false;
    furi_hal_subghz_idle();
    cc_wait_state(0x01, 10);
    // Save the RX values instead of hardcoding them again, so cca_rx_preset stays the only source.
    uint8_t rx_mcsm1 = cc_rd(0x17), rx_mdmcfg2 = cc_rd(0x12), rx_pktctrl0 = cc_rd(0x08),
            rx_pktlen = cc_rd(0x06);
    cc_wr(0x17, 0x0C); // MCSM1: TXOFF=idle
    cc_wr(0x12, 0x00); // MDMCFG2: no hw sync, N81 encoder supplies preamble+sync
    cc_wr(0x08, 0x00); // PKTCTRL0: fixed length
    cc_wr(0x06, (uint8_t)len);
    furi_hal_subghz_flush_tx();
    cc_write_txfifo(encoded, len);
    bool ok = furi_hal_subghz_tx();
    // ~6 ms for a 40-byte packet (0.9 ms cal + 5.1 ms on air); MCSM1 TXOFF lands it in IDLE.
    bool idle = cc_wait_state(0x01, 20);
    ok = ok && idle;
    // restore RX config
    furi_hal_subghz_idle();
    cc_wr(0x17, rx_mcsm1);
    cc_wr(0x12, rx_mdmcfg2);
    cc_wr(0x08, rx_pktctrl0);
    cc_wr(0x06, rx_pktlen);
    furi_hal_subghz_flush_tx();
    furi_hal_subghz_flush_rx();
    furi_hal_subghz_rx();
    return ok;
}

typedef struct {
    DecodedPacket pkt; // latest copy
    uint32_t tick; // when it was last heard
    uint16_t count; // copies heard
    int8_t rssi, freqest;
} Entry;

typedef struct {
    Entry hist[HIST]; // newest first
    int n, sel, top; // entries used, selected entry, first entry on screen
    bool detail; // detail view open
    Entry d; // snapshot shown in the detail view, so new packets can't shift it
    char dlines[CCA_DETAIL_MAX][CCA_LINE_LEN];
    int dn, dtop;
    uint32_t ok, bad;
    char txr; // last replay result: ' ' none yet, '+' radio returned to idle, 'x' it did not
    FuriMutex* mutex;
} State;

static int clampi(int v, int lo, int hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

// Keep the selection valid and on screen.
static void clamp_view(State* s) {
    s->sel = clampi(s->sel, 0, s->n ? s->n - 1 : 0);
    s->top = clampi(s->top, s->sel - (ROWS - 1), s->sel);
    s->top = clampi(s->top, 0, s->n > ROWS ? s->n - ROWS : 0);
}

// Call with the mutex held.
static void hist_add(State* s, const DecodedPacket* p, int8_t rssi, int8_t freqest) {
    uint32_t now = furi_get_tick();
    Entry* e = NULL;
    // Bursts from two devices interleave, so look a few rows back for the repeat.
    for(int i = 0; i < s->n && i < 4 && !e; i++)
        if(now - s->hist[i].tick < REPEAT_MS && cca_same_packet(s->hist[i].pkt, *p)) e = &s->hist[i];
    if(e) {
        e->count++;
    } else {
        memmove(&s->hist[1], &s->hist[0], sizeof(Entry) * (HIST - 1));
        e = &s->hist[0];
        e->count = 1;
        if(s->n < HIST) s->n++;
        // Scrolled away from the newest row: stay on the same packet instead of sliding off it.
        if(s->sel > 0) s->sel++, s->top++;
        clamp_view(s);
    }
    e->pkt = *p;
    e->tick = now;
    e->rssi = rssi;
    e->freqest = freqest;
}

static void draw_cb(Canvas* c, void* ctx) {
    State* s = (State*)ctx;
    furi_mutex_acquire(s->mutex, FuriWaitForever);
    canvas_set_font(c, FontSecondary);
    char t[48];
    if(s->detail) {
        cca_describe_row(s->d.pkt, t, sizeof(t));
        canvas_draw_str(c, 0, 8, t);
        canvas_draw_line(c, 0, 10, 127, 10);
        for(int i = 0; i < DROWS && s->dtop + i < s->dn; i++)
            canvas_draw_str(c, 0, 20 + i * 10, s->dlines[s->dtop + i]);
        if(s->dn > DROWS) elements_scrollbar_pos(c, 127, 12, 40, s->dtop, s->dn - DROWS + 1);
        if(cca_replayable(s->d.pkt))
            elements_button_center(c, s->txr == '+' ? "Sent" : s->txr == 'x' ? "TX fail" : "Send");
    } else {
        snprintf(t, sizeof(t), "CCA 433.6  %lu ok  %lu bad", s->ok, s->bad);
        canvas_draw_str(c, 0, 8, t);
        canvas_draw_line(c, 0, 10, 127, 10);
        if(!s->n) {
            canvas_draw_str_aligned(c, 64, 30, AlignCenter, AlignCenter, "Listening...");
            canvas_draw_str_aligned(c, 64, 42, AlignCenter, AlignCenter, "Press a Pico or dimmer");
        }
        for(int i = 0; i < ROWS && s->top + i < s->n; i++) {
            const Entry* e = &s->hist[s->top + i];
            int y = 20 + i * 10;
            bool sel = s->top + i == s->sel;
            Color fg = sel ? ColorWhite : ColorBlack, bg = sel ? ColorBlack : ColorWhite;
            if(sel) canvas_draw_box(c, 0, y - 8, 123, 10);
            canvas_set_color(c, fg);
            cca_describe_row(e->pkt, t, sizeof(t));
            canvas_draw_str(c, 2, y, t);
            if(e->count > 1) { // repeat count, right-aligned over the end of a long row
                snprintf(t, sizeof(t), "x%u", e->count);
                int w = canvas_string_width(c, t);
                canvas_set_color(c, bg);
                canvas_draw_box(c, 120 - w - 2, y - 8, w + 3, 10);
                canvas_set_color(c, fg);
                canvas_draw_str(c, 120 - w, y, t);
            }
            canvas_set_color(c, ColorBlack);
        }
        if(s->n > ROWS) elements_scrollbar_pos(c, 127, 12, 52, s->top, s->n - ROWS + 1);
    }
    furi_mutex_release(s->mutex);
}

// Test hook: each line of /ext/cca_tx.txt is a hex packet WITHOUT CRC. Send each once, then delete
// the file. Lets a host script drive TX over the USB CLI (`storage write`).
static void send_tx_file() {
    Storage* st = (Storage*)furi_record_open(RECORD_STORAGE);
    File* f = storage_file_alloc(st);
    static char txt[4096];
    size_t n = 0;
    if(storage_file_open(f, "/ext/cca_tx.txt", FSAM_READ, FSOM_OPEN_EXISTING))
        n = storage_file_read(f, txt, sizeof(txt) - 1);
    storage_file_close(f);
    storage_file_free(f);
    if(n) storage_simply_remove(st, "/ext/cca_tx.txt");
    furi_record_close(RECORD_STORAGE);
    txt[n] = 0;
    uint8_t pl[CCA_MAX_PACKET_LEN];
    size_t plen = 0;
    int nib = -1;
    for(size_t i = 0; i <= n; i++) {
        char c = txt[i];
        if(c == 'T' && !plen && nib < 0) { // "T<signed int>": FSCTRL0 freq trim, units 26M/2^14 = 1587 Hz
            int sign = 1, t = 0;
            if(txt[i + 1] == '-') sign = -1, i++;
            while(txt[i + 1] >= '0' && txt[i + 1] <= '9') t = t * 10 + (txt[++i] - '0');
            furi_hal_subghz_idle();
            cc_wr(0x0C, (uint8_t)(int8_t)(sign * t));
            furi_hal_subghz_rx();
            diag("trim FSCTRL0=%d", sign * t);
            continue;
        }
        int v = (c >= '0' && c <= '9') ? c - '0' : (c >= 'A' && c <= 'F') ? c - 'A' + 10 :
                (c >= 'a' && c <= 'f') ? c - 'a' + 10 : -1;
        if(v >= 0) {
            if(nib < 0) nib = v;
            else if(plen < CCA_MAX_PACKET_LEN) pl[plen++] = (uint8_t)(nib << 4 | v), nib = -1;
            continue;
        }
        if((c != '\n' && c != 0) || !plen) continue;
        uint8_t withcrc[CCA_MAX_PACKET_LEN + 2], enc[64];
        cca_append_crc(pl, plen, withcrc);
        size_t e = n81_encode_packet(withcrc, plen + 2, enc, sizeof(enc));
        bool ok = e && cca_transmit(enc, e);
        char h[CCA_MAX_PACKET_LEN * 2 + 5];
        hex(h, withcrc, plen + 2);
        diag("TX %s ok=%d", h, ok);
        plen = 0;
        nib = -1;
        furi_delay_ms(20);
    }
}

static void input_cb(InputEvent* e, void* ctx) {
    FuriMessageQueue* q = (FuriMessageQueue*)ctx;
    furi_message_queue_put(q, e, 0);
}

extern "C" int32_t lutron_cca_app(void* p) {
    UNUSED(p);
    State* s = (State*)malloc(sizeof(State));
    memset(s, 0, sizeof(State));
    s->txr = ' ';
    s->mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    FuriMessageQueue* q = furi_message_queue_alloc(4, sizeof(InputEvent));

    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, draw_cb, s);
    view_port_input_callback_set(vp, input_cb, q);
    Gui* gui = (Gui*)furi_record_open(RECORD_GUI);
    gui_add_view_port(gui, vp, GuiLayerFullscreen);

    NotificationApp* notif = (NotificationApp*)furi_record_open(RECORD_NOTIFICATION);

    furi_hal_power_suppress_charge_enter(); // the charger is a noise source on 433 MHz
    radio_start();

    uint8_t buf[RX_PKT_LEN + 4];
    size_t len = 0; // bytes accumulated; > 0 means a packet is in progress (t0/rssi valid)
    int8_t rssi = 0, freqest = 0;
    uint32_t t0 = 0, last_poll = 0, last_blink = 0;
    bool running = true;

    while(running) {
        InputEvent ev;
        while(furi_message_queue_get(q, &ev, 0) == FuriStatusOk) {
            int step = ev.key == InputKeyDown ? 1 : ev.key == InputKeyUp ? -1 : 0;
            // Holding Up/Down scrolls; everything else acts on a short press only.
            if(ev.type != InputTypeShort && !(ev.type == InputTypeRepeat && step)) continue;
            bool send = false;
            furi_mutex_acquire(s->mutex, FuriWaitForever);
            if(s->detail) {
                if(ev.key == InputKeyBack) s->detail = false;
                s->dtop = clampi(s->dtop + step, 0, s->dn > DROWS ? s->dn - DROWS : 0);
                send = ev.key == InputKeyOk && cca_replayable(s->d.pkt);
            } else {
                if(ev.key == InputKeyBack) running = false;
                s->sel += step;
                clamp_view(s);
                if(ev.key == InputKeyOk && s->n) {
                    s->d = s->hist[s->sel];
                    s->dn = cca_detail_lines(
                        s->d.pkt, s->d.rssi, s->d.freqest, s->d.count, s->dlines, CCA_DETAIL_MAX);
                    s->dtop = 0;
                    s->txr = ' ';
                    s->detail = true;
                }
            }
            furi_mutex_release(s->mutex);
            if(send) {
                // Replay with fresh sequence numbers (+8 keeps the TDMA slot in the low 3 bits,
                // like firmware) so the target doesn't dedupe it. s->d only changes on this thread.
                const uint8_t* raw = s->d.pkt.raw;
                size_t plen = s->d.pkt.raw_len - 2; // strip CRC, recomputed per send
                bool ok = true;
                for(int i = 0; i < 3; i++) {
                    uint8_t pl[CCA_MAX_PACKET_LEN], withcrc[CCA_MAX_PACKET_LEN + 2], enc[64];
                    memcpy(pl, raw, plen);
                    pl[1] = (uint8_t)(raw[1] + 8 * (i + 1));
                    cca_append_crc(pl, plen, withcrc);
                    size_t n = n81_encode_packet(withcrc, plen + 2, enc, sizeof(enc));
                    if(!n || !cca_transmit(enc, n)) ok = false;
                    furi_delay_ms(75);
                }
                s->txr = ok ? '+' : 'x';
                notification_message(notif, ok ? &sequence_blink_magenta_10 : &sequence_blink_red_10);
                len = 0;
            }
            view_port_update(vp);
        }

        if(len == 0 && furi_get_tick() - last_poll > 200) {
            last_poll = furi_get_tick();
            send_tx_file();
        }

        uint8_t rb = cc_rxbytes();
        if(rb & 0x80) { // FIFO overflow
            diag("RX fifo overflow");
            radio_restart();
            len = 0;
        } else if(rb > 0) {
            if(len == 0) {
                t0 = furi_get_tick();
                rssi = cc_rssi_dbm();
                freqest = (int8_t)cc_status(0x32);
            }
            size_t n = rb < (sizeof(buf) - len) ? rb : (sizeof(buf) - len);
            if(len + n > RX_PKT_LEN) n = RX_PKT_LEN - len;
            if(n) {
                cc_read_fifo(buf + len, n);
                len += n;
            }
        }

        if(len >= RX_PKT_LEN) {
            DecodedPacket pkt;
            pkt.clear();
            if(CcaDecoder::decode(buf, len, pkt) && pkt.valid) {
                furi_mutex_acquire(s->mutex, FuriWaitForever);
                if(pkt.crc_valid) {
                    s->ok++;
                    hist_add(s, &pkt, rssi, freqest);
                    // One blink per burst is enough; repeats arrive faster than a blink lasts.
                    if(furi_get_tick() - last_blink > 150) {
                        last_blink = furi_get_tick();
                        notification_message(notif, &sequence_blink_green_10);
                    }
                } else {
                    s->bad++; // counted in the header and logged; values can't be trusted on screen
                }
                furi_mutex_release(s->mutex);
                view_port_update(vp);
                char h[CCA_MAX_PACKET_LEN * 2 + 1];
                hex(h, pkt.raw, pkt.raw_len);
                diag("RX %s crc=%d rssi=%d fe=%d", h, pkt.crc_valid, rssi, freqest);
            }
            len = 0;
        } else if(len > 0 && (furi_get_tick() - t0) > ACCUM_TIMEOUT_MS) {
            radio_restart();
            len = 0;
        }
        furi_delay_ms(2);
    }

    furi_hal_subghz_idle();
    furi_hal_subghz_sleep();
    furi_hal_power_suppress_charge_exit();
    furi_record_close(RECORD_NOTIFICATION);
    gui_remove_view_port(gui, vp);
    view_port_free(vp);
    furi_record_close(RECORD_GUI);
    furi_message_queue_free(q);
    furi_mutex_free(s->mutex);
    free(s);
    return 0;
}
