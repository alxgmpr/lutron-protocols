/**
 * Debug shell — command-line interface over USART3 (ST-LINK VCP).
 *
 * Features:
 *   - Full line editing: left/right arrows, insert, backspace, delete
 *   - Command history (8 entries, up/down arrows)
 *   - Ctrl shortcuts: A, E, K, U, C, L
 *   - Async-safe: registers state with _write() so background printf()
 *     from CCA/CCX/ETH/stream tasks doesn't stomp the prompt
 *
 * Commands:
 *   status   — CC1101 state, RSSI, packet counts, FreeRTOS heap
 *   rx on    — enable CCA RX (start receiving)
 *   rx off   — disable CCA RX
 *   tx <hex> — transmit raw CCA packet (hex bytes, no spaces)
 *   ccx      — CCX Thread control
 *   eth      — Ethernet PHY debug
 *   reboot   — NVIC_SystemReset
 *   help     — list commands
 */

#include "shell.h"
#include "bsp.h"
#include "watchdog.h"
#include "cc1101.h"
#include "cca_task.h"
#include "cca_commands.h"
#include "cca_tdma.h"
#include "cca_types.h"
#include "ccx_task.h"
#include "ccx_msg.h"
#include "coap.h"
#include "stream.h"
#include "eth.h"
#include "flash_store.h"

#include "FreeRTOS.h"
#include "task.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>

#define SHELL_TASK_STACK_SIZE 1024
#define SHELL_TASK_PRIORITY   1
#define CMD_BUF_SIZE          128

#define HISTORY_SIZE 8
#define HISTORY_LEN  CMD_BUF_SIZE

/* -----------------------------------------------------------------------
 * Raw UART helpers — bypass printf/_write to avoid reentrancy
 * ----------------------------------------------------------------------- */
static void uart_write(const char* data, size_t len)
{
    HAL_UART_Transmit(&huart3, (const uint8_t*)data, (uint16_t)len, 10);
}

static void uart_putc(char c)
{
    uart_write(&c, 1);
}

static void uart_puts(const char* s)
{
    uart_write(s, strlen(s));
}

/* -----------------------------------------------------------------------
 * VT100 helpers
 * ----------------------------------------------------------------------- */
static void vt100_erase_line(void)
{
    /* CR + erase to end of line */
    uart_puts("\r\033[K");
}

static void vt100_cursor_back(size_t n)
{
    for (size_t i = 0; i < n; i++) uart_putc('\b');
}

static void vt100_cursor_forward(size_t n)
{
    for (size_t i = 0; i < n; i++) uart_puts("\033[C");
}

/* -----------------------------------------------------------------------
 * Command history ring buffer
 * ----------------------------------------------------------------------- */
static char hist_buf[HISTORY_SIZE][HISTORY_LEN];
static int  hist_count = 0; /* total entries stored */
static int  hist_write = 0; /* next write slot */
static int  hist_nav = 0;   /* navigation index during up/down */

static void hist_add(const char* line)
{
    if (line[0] == '\0') return;

    /* Skip duplicate of most recent entry */
    if (hist_count > 0) {
        int prev = (hist_write + HISTORY_SIZE - 1) % HISTORY_SIZE;
        if (strcmp(hist_buf[prev], line) == 0) return;
    }

    strncpy(hist_buf[hist_write], line, HISTORY_LEN - 1);
    hist_buf[hist_write][HISTORY_LEN - 1] = '\0';
    hist_write = (hist_write + 1) % HISTORY_SIZE;
    if (hist_count < HISTORY_SIZE) hist_count++;
}

/* Get history entry by offset from most recent (0 = newest) */
static const char* hist_get(int offset)
{
    if (offset < 0 || offset >= hist_count) return nullptr;
    int idx = (hist_write - 1 - offset + HISTORY_SIZE * 2) % HISTORY_SIZE;
    return hist_buf[idx];
}

/* -----------------------------------------------------------------------
 * Escape sequence state machine
 * ----------------------------------------------------------------------- */
enum esc_state { ESC_NONE, ESC_GOT_ESC, ESC_GOT_CSI };

/* -----------------------------------------------------------------------
 * Line editor — full readline with history and cursor movement
 * ----------------------------------------------------------------------- */
static size_t shell_readline(char* buf, size_t max_len)
{
    size_t         len = 0;    /* chars in buffer */
    size_t         cursor = 0; /* cursor position */
    enum esc_state esc = ESC_NONE;
    char           saved_line[CMD_BUF_SIZE] = {0}; /* saved line when navigating history */
    int            saved_valid = 0;

    TaskHandle_t me = xTaskGetCurrentTaskHandle();

    /* Drain any pending UART noise (common after reboot) */
    uint8_t junk;
    while (HAL_UART_Receive(&huart3, &junk, 1, 2) == HAL_OK) {}

    /* Register active state FIRST, then print prompt.
     * This eliminates the race where async printf() slips in between
     * the prompt and readline setting active=1. */
    shell_register_state(me, buf, 0, 0, 1);
    uart_puts("> ");

    auto sync = [&]() { shell_register_state(me, buf, len, cursor, 1); };

    /* Redraw the entire line from scratch (after replace, clear, etc.) */
    auto redraw_line = [&]() {
        vt100_erase_line();
        uart_puts("> ");
        if (len > 0) uart_write(buf, len);
        /* Move cursor back if not at end */
        vt100_cursor_back(len - cursor);
    };

    /* Replace entire line with new content */
    auto replace_line = [&](const char* newline) {
        len = strlen(newline);
        if (len >= max_len) len = max_len - 1;
        memcpy(buf, newline, len);
        buf[len] = '\0';
        cursor = len;
        redraw_line();
        sync();
    };

    for (;;) {
        uint8_t ch;
        /* Use 2s timeout so the shell task can feed the watchdog periodically.
         * Without this, HAL_MAX_DELAY would block indefinitely and trigger
         * IWDG reset when the user isn't typing. */
        if (HAL_UART_Receive(&huart3, &ch, 1, 2000) != HAL_OK) {
            watchdog_feed();
            continue;
        }

        /* Ignore null bytes — common UART noise during boot/reset */
        if (ch == 0x00) continue;

        /* Escape sequence parsing */
        if (esc == ESC_GOT_ESC) {
            if (ch == '[') {
                esc = ESC_GOT_CSI;
                continue;
            }
            /* Not a CSI sequence — ignore the ESC + this byte */
            esc = ESC_NONE;
            continue;
        }
        if (esc == ESC_GOT_CSI) {
            esc = ESC_NONE;
            switch (ch) {
            case 'A': /* Up arrow — history older */
                if (hist_nav < hist_count) {
                    if (hist_nav == 0) {
                        /* Save current line before navigating */
                        memcpy(saved_line, buf, len);
                        saved_line[len] = '\0';
                        saved_valid = 1;
                    }
                    const char* h = hist_get(hist_nav);
                    if (h) {
                        hist_nav++;
                        replace_line(h);
                    }
                }
                continue;
            case 'B': /* Down arrow — history newer */
                if (hist_nav > 0) {
                    hist_nav--;
                    if (hist_nav == 0 && saved_valid) {
                        replace_line(saved_line);
                    }
                    else {
                        const char* h = hist_get(hist_nav - 1);
                        if (h) replace_line(h);
                    }
                }
                continue;
            case 'C': /* Right arrow */
                if (cursor < len) {
                    vt100_cursor_forward(1);
                    cursor++;
                    sync();
                }
                continue;
            case 'D': /* Left arrow */
                if (cursor > 0) {
                    uart_putc('\b');
                    cursor--;
                    sync();
                }
                continue;
            case 'H': /* Home */
                vt100_cursor_back(cursor);
                cursor = 0;
                sync();
                continue;
            case 'F': /* End */
                vt100_cursor_forward(len - cursor);
                cursor = len;
                sync();
                continue;
            case '3': {
                /* Delete key: ESC [ 3 ~ */
                uint8_t tilde;
                if (HAL_UART_Receive(&huart3, &tilde, 1, 50) == HAL_OK && tilde == '~') {
                    if (cursor < len) {
                        memmove(&buf[cursor], &buf[cursor + 1], len - cursor - 1);
                        len--;
                        buf[len] = '\0';
                        /* Redraw from cursor to end, then erase leftover */
                        uart_write(&buf[cursor], len - cursor);
                        uart_putc(' ');
                        vt100_cursor_back(len - cursor + 1);
                        sync();
                    }
                }
                continue;
            }
            default:
                continue;
            }
        }

        /* Normal character handling */
        if (ch == 0x1B) { /* ESC */
            esc = ESC_GOT_ESC;
            continue;
        }

        if (ch == '\r' || ch == '\n') {
            if (len == 0) {
                /* Empty Enter — just redraw prompt, don't return.
                 * Prevents prompt flood from UART noise during boot. */
                uart_puts("\r\n> ");
                hist_nav = 0;
                saved_valid = 0;
                continue;
            }
            /* Mark inactive before printing newline */
            shell_register_state(me, buf, len, cursor, 0);
            uart_puts("\r\n");
            break;
        }

        if (ch == '\b' || ch == 0x7F) { /* Backspace */
            if (cursor > 0) {
                cursor--;
                memmove(&buf[cursor], &buf[cursor + 1], len - cursor - 1);
                len--;
                buf[len] = '\0';
                uart_putc('\b');
                uart_write(&buf[cursor], len - cursor);
                uart_putc(' ');
                vt100_cursor_back(len - cursor + 1);
                sync();
            }
            continue;
        }

        if (ch == 0x01) { /* Ctrl-A: Home */
            vt100_cursor_back(cursor);
            cursor = 0;
            sync();
            continue;
        }

        if (ch == 0x05) { /* Ctrl-E: End */
            vt100_cursor_forward(len - cursor);
            cursor = len;
            sync();
            continue;
        }

        if (ch == 0x0B) { /* Ctrl-K: Kill to end of line */
            /* Erase from cursor to end on screen */
            uart_puts("\033[K");
            len = cursor;
            buf[len] = '\0';
            sync();
            continue;
        }

        if (ch == 0x15) { /* Ctrl-U: Kill entire line */
            vt100_erase_line();
            uart_puts("> ");
            len = 0;
            cursor = 0;
            buf[0] = '\0';
            sync();
            continue;
        }

        if (ch == 0x03) { /* Ctrl-C: Cancel line */
            shell_register_state(me, buf, len, cursor, 0);
            uart_puts("^C\r\n");
            buf[0] = '\0';
            return 0;
        }

        if (ch == 0x0C) { /* Ctrl-L: Clear screen, redraw */
            uart_puts("\033[2J\033[H");
            redraw_line();
            sync();
            continue;
        }

        /* Printable character — insert at cursor */
        if (ch >= 0x20 && ch < 0x7F && len < max_len - 1) {
            if (cursor < len) {
                memmove(&buf[cursor + 1], &buf[cursor], len - cursor);
            }
            buf[cursor] = (char)ch;
            len++;
            buf[len] = '\0';
            /* Print from cursor to end, then reposition */
            uart_write(&buf[cursor], len - cursor);
            cursor++;
            vt100_cursor_back(len - cursor);
            sync();

            /* Reset history navigation on any edit */
            hist_nav = 0;
            saved_valid = 0;
        }
    }

    buf[len] = '\0';
    return len;
}

/* -----------------------------------------------------------------------
 * Parse hex string to bytes
 * ----------------------------------------------------------------------- */
static size_t hex_to_bytes(const char* hex, uint8_t* out, size_t max_len)
{
    size_t slen = strlen(hex);
    if (slen % 2 != 0) return 0;

    size_t count = 0;
    for (size_t i = 0; i < slen && count < max_len; i += 2) {
        char byte_str[3] = {hex[i], hex[i + 1], '\0'};
        out[count++] = (uint8_t)strtoul(byte_str, NULL, 16);
    }
    return count;
}

/* -----------------------------------------------------------------------
 * Command handlers
 * ----------------------------------------------------------------------- */
static void cmd_status(void)
{
    printf("--- Nucleo Firmware Status ---\r\n");

    /* CCA (ISM) — CC1101 sub-GHz radio */
    if (cc1101_is_initialized()) {
        uint8_t state = cc1101_get_state();
        printf("CCA (ISM): %s  RX=%lu TX=%lu\r\n", cc1101_is_rx_active() ? "RX" : (state == 0x01 ? "IDLE" : "INIT"),
               (unsigned long)cca_rx_count(), (unsigned long)cca_tx_count());
        printf("  drops=%lu crc_fail=%lu n81_err=%lu ack=%lu crc_optional=%lu\r\n", (unsigned long)cca_drop_count(),
               (unsigned long)cca_crc_fail_count(), (unsigned long)cca_n81_err_count(), (unsigned long)cca_ack_count(),
               (unsigned long)cca_crc_optional_count());
        printf("  overflows=%lu runts=%lu short=%lu irq=%lu\r\n", (unsigned long)cc1101_overflow_count(),
               (unsigned long)cc1101_runt_count(), (unsigned long)cc1101_short_packet_count(),
               (unsigned long)cca_irq_count());
        printf("  gpio: gdo0=%u gdo2=%u\r\n", (unsigned)HAL_GPIO_ReadPin(CC1101_GDO0_PORT, CC1101_GDO0_PIN),
#if CC1101_GDO2_BACKUP_ENABLE
               (unsigned)HAL_GPIO_ReadPin(CC1101_GDO2_PORT, CC1101_GDO2_PIN)
#else
               0u
#endif
        );
        printf("  exti: gdo0=%lu gdo2=%lu\r\n", (unsigned long)bsp_exti_gdo0_count(),
               (unsigned long)bsp_exti_gdo2_count());
        printf("  restart: timeout=%lu overflow=%lu manual=%lu packet=%lu\r\n",
               (unsigned long)cc1101_rx_restart_timeout_count(), (unsigned long)cc1101_rx_restart_overflow_count(),
               (unsigned long)cc1101_rx_restart_manual_count(), (unsigned long)cc1101_rx_restart_packet_count());
        printf("  sync: hit=%lu miss=%lu  ring: now=%lu max=%lu in=%lu drop=%lu\r\n",
               (unsigned long)cc1101_sync_peek_hit_count(), (unsigned long)cc1101_sync_peek_miss_count(),
               (unsigned long)cc1101_ring_current_occupancy(), (unsigned long)cc1101_ring_max_occupancy(),
               (unsigned long)cc1101_ring_bytes_in_count(), (unsigned long)cc1101_ring_bytes_dropped_count());
        printf("  isr_latency_us: min=%lu p95=%lu max=%lu n=%lu\r\n", (unsigned long)cca_isr_latency_min_us(),
               (unsigned long)cca_isr_latency_p95_us(), (unsigned long)cca_isr_latency_max_us(),
               (unsigned long)cca_isr_latency_samples());
    }
    else {
        printf("CCA (ISM): NOT INITIALIZED\r\n");
    }

    /* Ethernet */
    printf("Ethernet: %s IP=%s\r\n", eth_link_is_up() ? "UP" : "DOWN", eth_get_ip_str());
    printf("  UDP clients: %d/%d  sent=%lu fail=%lu qdrop=%lu\r\n", stream_num_clients(), MAX_STREAM_CLIENTS,
           (unsigned long)stream_udp_sent_count(), (unsigned long)stream_udp_fail_count(),
           (unsigned long)stream_tx_drop_count());

    /* CCX */
    if (ccx_is_running()) {
        if (ccx_thread_joined()) {
            printf("CCX (Thread): %s  RX=%lu TX=%lu\r\n", ccx_thread_role_str(), (unsigned long)ccx_rx_count(),
                   (unsigned long)ccx_tx_count());
        }
        else {
            printf("CCX (Thread): DETACHED (joining...)\r\n");
        }
    }
    else {
        printf("CCX (Thread): NOT STARTED\r\n");
    }

    /* FreeRTOS heap */
    printf("FreeRTOS heap: %lu free of %lu\r\n", (unsigned long)xPortGetFreeHeapSize(),
           (unsigned long)configTOTAL_HEAP_SIZE);
}

/* -----------------------------------------------------------------------
 * Parse button name to code
 * ----------------------------------------------------------------------- */
static int parse_button_name(const char* name)
{
    if (strcmp(name, "on") == 0) return BTN_ON;
    if (strcmp(name, "off") == 0) return BTN_OFF;
    if (strcmp(name, "fav") == 0) return BTN_FAVORITE;
    if (strcmp(name, "raise") == 0) return BTN_RAISE;
    if (strcmp(name, "lower") == 0) return BTN_LOWER;
    if (strcmp(name, "scene1") == 0) return BTN_SCENE1;
    if (strcmp(name, "scene2") == 0) return BTN_SCENE2;
    if (strcmp(name, "scene3") == 0) return BTN_SCENE3;
    if (strcmp(name, "scene4") == 0) return BTN_SCENE4;
    return -1;
}

static void cmd_tx(const char* hex)
{
    uint8_t pkt[64];
    size_t  len = hex_to_bytes(hex, pkt, sizeof(pkt));
    if (len == 0) {
        printf("Usage: tx <hex bytes>\r\n");
        printf("Example: tx 88014E10A2C703020001\r\n");
        return;
    }

    printf("TX %u bytes:", (unsigned)len);
    for (size_t i = 0; i < len; i++) printf(" %02X", pkt[i]);
    printf("\r\n");

    if (cca_tx_enqueue(pkt, len)) {
        printf("Queued for TX\r\n");
    }
    else {
        printf("TX queue full!\r\n");
    }
}

struct CcaTuneSnapshot {
    uint32_t tick_ms;
    uint32_t rx;
    uint32_t drop;
    uint32_t crc_fail;
    uint32_t n81_err;
    uint32_t ack;
    uint32_t overflows;
    uint32_t restart_timeout;
    uint32_t restart_overflow;
    uint32_t restart_packet;
    uint32_t sync_hit;
    uint32_t sync_miss;
    uint32_t ring_drop;
    uint32_t irq;
};

static struct {
    bool            valid;
    CcaTuneSnapshot snap;
} g_cca_tune_baseline = {false, {}};

static void cca_tune_snapshot(CcaTuneSnapshot* out)
{
    if (out == nullptr) return;
    out->tick_ms = HAL_GetTick();
    out->rx = cca_rx_count();
    out->drop = cca_drop_count();
    out->crc_fail = cca_crc_fail_count();
    out->n81_err = cca_n81_err_count();
    out->ack = cca_ack_count();
    out->overflows = cc1101_overflow_count();
    out->restart_timeout = cc1101_rx_restart_timeout_count();
    out->restart_overflow = cc1101_rx_restart_overflow_count();
    out->restart_packet = cc1101_rx_restart_packet_count();
    out->sync_hit = cc1101_sync_peek_hit_count();
    out->sync_miss = cc1101_sync_peek_miss_count();
    out->ring_drop = cc1101_ring_bytes_dropped_count();
    out->irq = cca_irq_count();
}

static uint32_t delta32(uint32_t now, uint32_t then)
{
    return now - then;
}

static bool next_token(const char** cursor, char* out, size_t out_len)
{
    if (cursor == nullptr || *cursor == nullptr || out == nullptr || out_len == 0) return false;

    while (**cursor == ' ') (*cursor)++;
    if (**cursor == '\0') {
        out[0] = '\0';
        return false;
    }

    size_t n = 0;
    while (**cursor != '\0' && **cursor != ' ') {
        if (n + 1 < out_len) out[n++] = **cursor;
        (*cursor)++;
    }
    out[n] = '\0';
    while (**cursor == ' ') (*cursor)++;
    return true;
}

static bool parse_u32_token(const char* token, uint32_t* out)
{
    if (token == nullptr || out == nullptr || token[0] == '\0') return false;
    char*         endptr = nullptr;
    unsigned long v = strtoul(token, &endptr, 0);
    if (endptr == token || *endptr != '\0') return false;
    *out = (uint32_t)v;
    return true;
}

static void cmd_cca_tune_print_usage(void)
{
    printf("Usage: cca tune <cmd>\r\n");
    printf("  cca tune show                             — show active profile, params, key regs\r\n");
    printf("  cca tune freq <MHz>                       — retune CC1101 center frequency\r\n");
    printf("  cca tune lutron <channel>                 — set Lutron CCA channel (freq = 431.0 + 0.1*ch MHz)\r\n");
    printf("  cca tune profile <default|burst|noisy>   — apply built-in RX profile\r\n");
    printf("  cca tune reg get <addr>                  — read CC1101 reg/status (hex or dec)\r\n");
    printf("  cca tune reg set <addr> <value>          — write CC1101 config reg\r\n");
    printf("  cca tune param show                       — show runtime extractor params\r\n");
    printf("  cca tune param set <name> <value>        — set param live\r\n");
    printf("     names: drain_passes max_packets miss_streak miss_ring timeout_ms fifothr\r\n");
    printf("  cca tune score                            — score deltas since last score reset\r\n");
    printf("  cca tune score reset                      — reset score baseline window\r\n");
    printf("  cca tune stats reset                      — reset CCA/CC1101 telemetry counters\r\n");
}

static void cmd_cca_tune_show(void)
{
    cc1101_runtime_tuning_t tuning = {};
    cc1101_get_runtime_tuning(&tuning);
    uint32_t freq_word = ((uint32_t)cc1101_read_register(CC1101_FREQ2) << 16) |
                         ((uint32_t)cc1101_read_register(CC1101_FREQ1) << 8) | (uint32_t)cc1101_read_register(CC1101_FREQ0);
    double   freq_mhz = ((double)freq_word * 26.0) / 65536.0;

    printf("CCA tune profile: %s\r\n", cc1101_tune_profile_name(cc1101_get_tune_profile()));
    printf("  params: drain_passes=%u max_packets=%u miss_streak=%u miss_ring=%u timeout_ms=%u fifothr=0x%02X\r\n",
           tuning.fifo_drain_passes, tuning.max_packets_per_check, tuning.sync_miss_bail_streak,
           tuning.sync_miss_bail_ring, tuning.stale_timeout_ms, tuning.fifothr);
    printf("  rf: center=%.6f MHz  freq_word=0x%06lX  channr=%u\r\n", freq_mhz, (unsigned long)freq_word,
           (unsigned)cc1101_read_register(CC1101_CHANNR));

    struct RegDef {
        uint8_t     reg;
        const char* name;
    };
    static const RegDef cfg_regs[] = {
        {CC1101_IOCFG0, "IOCFG0"},   {CC1101_FIFOTHR, "FIFOTHR"}, {CC1101_SYNC1, "SYNC1"},
        {CC1101_SYNC0, "SYNC0"},     {CC1101_FSCTRL1, "FSCTRL1"}, {CC1101_MDMCFG4, "MDMCFG4"},
        {CC1101_MDMCFG3, "MDMCFG3"}, {CC1101_MDMCFG2, "MDMCFG2"}, {CC1101_DEVIATN, "DEVIATN"},
        {CC1101_MCSM1, "MCSM1"},     {CC1101_MCSM0, "MCSM0"},     {CC1101_FOCCFG, "FOCCFG"},
        {CC1101_BSCFG, "BSCFG"},     {CC1101_AGCCTRL2, "AGC2"},   {CC1101_AGCCTRL1, "AGC1"},
        {CC1101_AGCCTRL0, "AGC0"},
    };
    static const RegDef st_regs[] = {
        {CC1101_MARCSTATE, "MARCSTATE"}, {CC1101_PKTSTATUS, "PKTSTATUS"}, {CC1101_RXBYTES, "RXBYTES"},
        {CC1101_RSSI_REG, "RSSI"},       {CC1101_LQI_REG, "LQI"},
    };

    printf("  cfg regs:\r\n");
    for (size_t i = 0; i < sizeof(cfg_regs) / sizeof(cfg_regs[0]); i++) {
        uint8_t val = cc1101_read_register(cfg_regs[i].reg);
        printf("    0x%02X %-9s = 0x%02X\r\n", cfg_regs[i].reg, cfg_regs[i].name, val);
    }

    printf("  status regs:\r\n");
    for (size_t i = 0; i < sizeof(st_regs) / sizeof(st_regs[0]); i++) {
        uint8_t val = cc1101_read_status_register(st_regs[i].reg);
        if (st_regs[i].reg == CC1101_MARCSTATE) val &= 0x1F;
        if (st_regs[i].reg == CC1101_RXBYTES) val &= 0x7F;
        printf("    0x%02X %-9s = 0x%02X\r\n", st_regs[i].reg, st_regs[i].name, val);
    }
}

static void cmd_cca_tune_profile(const char* profile_name)
{
    cc1101_tune_profile_t profile = CC1101_TUNE_PROFILE_DEFAULT;
    if (strcmp(profile_name, "default") == 0) {
        profile = CC1101_TUNE_PROFILE_DEFAULT;
    }
    else if (strcmp(profile_name, "burst") == 0) {
        profile = CC1101_TUNE_PROFILE_BURST;
    }
    else if (strcmp(profile_name, "noisy") == 0) {
        profile = CC1101_TUNE_PROFILE_NOISY;
    }
    else {
        printf("Unknown profile '%s' (use default|burst|noisy)\r\n", profile_name);
        return;
    }

    if (!cc1101_apply_tune_profile(profile)) {
        printf("Failed to apply profile '%s'\r\n", profile_name);
        return;
    }

    printf("Applied CCA tune profile: %s\r\n", cc1101_tune_profile_name(profile));
    cmd_cca_tune_show();
}

static bool cc1101_write_center_freq_word(uint32_t freq_word)
{
    if (freq_word > 0xFFFFFFu) return false;

    bool was_rx = cc1101_is_rx_active();
    if (was_rx) cc1101_stop_rx();

    cc1101_write_register(CC1101_CHANNR, 0x00);
    cc1101_write_register(CC1101_FREQ2, (uint8_t)((freq_word >> 16) & 0xFFu));
    cc1101_write_register(CC1101_FREQ1, (uint8_t)((freq_word >> 8) & 0xFFu));
    cc1101_write_register(CC1101_FREQ0, (uint8_t)(freq_word & 0xFFu));

    if (was_rx) {
        cc1101_start_rx();
    }
    else {
        cc1101_strobe(CC1101_SCAL);
    }
    return true;
}

static void cmd_cca_tune_freq(const char* mhz_tok)
{
    if (mhz_tok == nullptr || mhz_tok[0] == '\0') {
        printf("Usage: cca tune freq <MHz>\r\n");
        return;
    }

    char*  endptr = nullptr;
    double mhz = strtod(mhz_tok, &endptr);
    if (endptr == mhz_tok || *endptr != '\0' || mhz < 300.0 || mhz > 1000.0) {
        printf("Usage: cca tune freq <MHz>\r\n");
        return;
    }

    double reg_f = (mhz * 65536.0) / 26.0;
    if (reg_f < 0.0 || reg_f > 16777215.0) {
        printf("Frequency out of range: %.6f MHz\r\n", mhz);
        return;
    }

    uint32_t freq_word = (uint32_t)(reg_f + 0.5);
    if (!cc1101_write_center_freq_word(freq_word)) {
        printf("Failed to set frequency\r\n");
        return;
    }

    double actual_mhz = ((double)freq_word * 26.0) / 65536.0;
    printf("CCA center frequency set to %.6f MHz (freq_word=0x%06lX)\r\n", actual_mhz, (unsigned long)freq_word);
}

static void cmd_cca_tune_reg_get(const char* addr_tok)
{
    uint32_t reg32 = 0;
    if (!parse_u32_token(addr_tok, &reg32) || reg32 > 0x3F) {
        printf("Usage: cca tune reg get <addr>\r\n");
        return;
    }
    uint8_t reg = (uint8_t)reg32;

    if (reg == CC1101_RXFIFO || reg == CC1101_TXFIFO) {
        printf("0x%02X is FIFO; use status/cfg registers only\r\n", reg);
        return;
    }

    if (reg <= 0x2E || reg == CC1101_PATABLE) {
        uint8_t val = cc1101_read_register(reg);
        printf("CC1101 reg[0x%02X] = 0x%02X\r\n", reg, val);
        return;
    }

    if (reg >= 0x30 && reg <= 0x3D) {
        uint8_t val = cc1101_read_status_register(reg);
        if (reg == CC1101_MARCSTATE) val &= 0x1F;
        if (reg == CC1101_RXBYTES || reg == CC1101_TXBYTES) val &= 0x7F;
        printf("CC1101 status[0x%02X] = 0x%02X\r\n", reg, val);
        return;
    }

    printf("Unsupported register 0x%02X\r\n", reg);
}

static void cmd_cca_tune_reg_set(const char* addr_tok, const char* value_tok)
{
    uint32_t reg32 = 0;
    uint32_t value32 = 0;
    if (!parse_u32_token(addr_tok, &reg32) || !parse_u32_token(value_tok, &value32) || reg32 > 0x3F || value32 > 0xFF) {
        printf("Usage: cca tune reg set <addr> <value>\r\n");
        return;
    }

    uint8_t reg = (uint8_t)reg32;
    uint8_t value = (uint8_t)value32;

    if (!(reg <= 0x2E || reg == CC1101_PATABLE)) {
        printf("Write only supports config regs 0x00..0x2E and 0x3E\r\n");
        return;
    }
    if (reg == CC1101_RXFIFO || reg == CC1101_TXFIFO) {
        printf("Cannot write FIFO using this command\r\n");
        return;
    }

    bool was_rx = cc1101_is_rx_active();
    if (was_rx) cc1101_stop_rx();
    cc1101_write_register(reg, value);
    bool mirrored = false;
    if (reg == CC1101_IOCFG0) {
        cc1101_write_register(CC1101_IOCFG2, value);
        mirrored = true;
    }
    else if (reg == CC1101_IOCFG2) {
        cc1101_write_register(CC1101_IOCFG0, value);
        mirrored = true;
    }
    if (was_rx) cc1101_start_rx();

    cc1101_apply_tune_profile(CC1101_TUNE_PROFILE_CUSTOM);
    if (mirrored) {
        printf("CC1101 reg[0x%02X] <= 0x%02X (mirrored IOCFG0/2)\r\n", reg, value);
    }
    else {
        printf("CC1101 reg[0x%02X] <= 0x%02X\r\n", reg, value);
    }
}

static void cmd_cca_tune_param_show(void)
{
    cc1101_runtime_tuning_t tuning = {};
    cc1101_get_runtime_tuning(&tuning);
    printf(
        "CCA tune params: drain_passes=%u max_packets=%u miss_streak=%u miss_ring=%u timeout_ms=%u fifothr=0x%02X\r\n",
        tuning.fifo_drain_passes, tuning.max_packets_per_check, tuning.sync_miss_bail_streak,
        tuning.sync_miss_bail_ring, tuning.stale_timeout_ms, tuning.fifothr);
}

static void cmd_cca_tune_param_set(const char* name, const char* value_tok)
{
    uint32_t value32 = 0;
    if (!parse_u32_token(value_tok, &value32)) {
        printf("Usage: cca tune param set <name> <value>\r\n");
        return;
    }
    if (value32 > 0xFF) {
        printf("Value out of range (0..255): %lu\r\n", (unsigned long)value32);
        return;
    }

    cc1101_runtime_tuning_t tuning = {};
    cc1101_get_runtime_tuning(&tuning);

    if (strcmp(name, "drain_passes") == 0) {
        tuning.fifo_drain_passes = (uint8_t)value32;
    }
    else if (strcmp(name, "max_packets") == 0) {
        tuning.max_packets_per_check = (uint8_t)value32;
    }
    else if (strcmp(name, "miss_streak") == 0) {
        tuning.sync_miss_bail_streak = (uint8_t)value32;
    }
    else if (strcmp(name, "miss_ring") == 0) {
        tuning.sync_miss_bail_ring = (uint8_t)value32;
    }
    else if (strcmp(name, "timeout_ms") == 0) {
        tuning.stale_timeout_ms = (uint8_t)value32;
    }
    else if (strcmp(name, "fifothr") == 0) {
        tuning.fifothr = (uint8_t)value32;
    }
    else {
        printf("Unknown param '%s'\r\n", name);
        printf("Known params: drain_passes max_packets miss_streak miss_ring timeout_ms fifothr\r\n");
        return;
    }

    if (!cc1101_set_runtime_tuning(&tuning)) {
        printf("Rejected value for '%s' (out of range)\r\n", name);
        return;
    }
    printf("Set %s=%lu\r\n", name, (unsigned long)value32);
    cmd_cca_tune_param_show();
}

static void cmd_cca_tune_stats_reset(void)
{
    cc1101_reset_counters();
    cca_reset_stats();
    bsp_exti_counts_reset();
    g_cca_tune_baseline.valid = false;
    printf("CCA tune telemetry counters reset\r\n");
}

static void cmd_cca_tune_score_reset(void)
{
    cca_tune_snapshot(&g_cca_tune_baseline.snap);
    g_cca_tune_baseline.valid = true;
    printf("CCA tune score baseline reset (t=%lu ms)\r\n", (unsigned long)g_cca_tune_baseline.snap.tick_ms);
}

static void cmd_cca_tune_score_show(void)
{
    CcaTuneSnapshot now = {};
    cca_tune_snapshot(&now);

    if (!g_cca_tune_baseline.valid) {
        g_cca_tune_baseline.snap = now;
        g_cca_tune_baseline.valid = true;
        printf("CCA tune score baseline initialized. Run again after traffic.\r\n");
        return;
    }

    const CcaTuneSnapshot& base = g_cca_tune_baseline.snap;
    uint32_t               dt_ms = delta32(now.tick_ms, base.tick_ms);
    uint32_t               d_rx = delta32(now.rx, base.rx);
    uint32_t               d_drop = delta32(now.drop, base.drop);
    uint32_t               d_crc = delta32(now.crc_fail, base.crc_fail);
    uint32_t               d_n81 = delta32(now.n81_err, base.n81_err);
    uint32_t               d_ack = delta32(now.ack, base.ack);
    uint32_t               d_over = delta32(now.overflows, base.overflows);
    uint32_t               d_restart_timeout = delta32(now.restart_timeout, base.restart_timeout);
    uint32_t               d_restart_overflow = delta32(now.restart_overflow, base.restart_overflow);
    uint32_t               d_restart_packet = delta32(now.restart_packet, base.restart_packet);
    uint32_t               d_sync_hit = delta32(now.sync_hit, base.sync_hit);
    uint32_t               d_sync_miss = delta32(now.sync_miss, base.sync_miss);
    uint32_t               d_ring_drop = delta32(now.ring_drop, base.ring_drop);
    uint32_t               d_irq = delta32(now.irq, base.irq);

    uint32_t sync_total = d_sync_hit + d_sync_miss;
    uint32_t sync_hit_permille = 0;
    if (sync_total > 0) {
        sync_hit_permille = (uint32_t)(((uint64_t)d_sync_hit * 1000ULL + sync_total / 2ULL) / sync_total);
    }

    uint64_t good = (uint64_t)d_rx * 100ULL + (uint64_t)d_ack * 15ULL;
    uint64_t bad = (uint64_t)d_drop * 120ULL + (uint64_t)d_over * 180ULL + (uint64_t)d_restart_overflow * 120ULL +
                   (uint64_t)d_restart_packet * 60ULL + (uint64_t)d_restart_timeout * 40ULL + (uint64_t)d_crc * 35ULL +
                   (uint64_t)d_n81 * 25ULL + (uint64_t)d_ring_drop * 220ULL;
    uint32_t quality_pct = 100;
    if ((good + bad) > 0) {
        quality_pct = (uint32_t)((good * 100ULL) / (good + bad));
    }
    int32_t net_score = (good >= bad) ? (int32_t)(good - bad) : -(int32_t)(bad - good);

    uint32_t rx_per_min = 0;
    if (dt_ms > 0) {
        rx_per_min = (uint32_t)(((uint64_t)d_rx * 60000ULL) / dt_ms);
    }
    uint32_t irq_per_rx_percent = 0;
    if (d_rx > 0) {
        irq_per_rx_percent = (uint32_t)(((uint64_t)d_irq * 100ULL) / d_rx);
    }

    printf("CCA tune score window: %lu ms\r\n", (unsigned long)dt_ms);
    printf("  delta: rx=%lu ack=%lu drop=%lu crc_fail=%lu n81=%lu\r\n", (unsigned long)d_rx, (unsigned long)d_ack,
           (unsigned long)d_drop, (unsigned long)d_crc, (unsigned long)d_n81);
    printf("  radio: overflows=%lu restart(timeout=%lu overflow=%lu packet=%lu) ring_drop=%lu\r\n",
           (unsigned long)d_over, (unsigned long)d_restart_timeout, (unsigned long)d_restart_overflow,
           (unsigned long)d_restart_packet, (unsigned long)d_ring_drop);
    printf("  sync: hit=%lu miss=%lu hit_rate=%lu.%lu%%  irq=%lu (%lu%% of rx) rx_rate=%lu/min\r\n",
           (unsigned long)d_sync_hit, (unsigned long)d_sync_miss, (unsigned long)(sync_hit_permille / 10),
           (unsigned long)(sync_hit_permille % 10), (unsigned long)d_irq, (unsigned long)irq_per_rx_percent,
           (unsigned long)rx_per_min);
    printf("  quality: %lu%%  net_score=%ld\r\n", (unsigned long)quality_pct, (long)net_score);
}

static void cmd_cca_tune(const char* arg)
{
    const char* cursor = arg;
    char        t0[24];
    if (!next_token(&cursor, t0, sizeof(t0))) {
        cmd_cca_tune_print_usage();
        return;
    }

    if (strcmp(t0, "show") == 0) {
        cmd_cca_tune_show();
        return;
    }

    if (strcmp(t0, "freq") == 0) {
        char mhz_tok[24];
        if (!next_token(&cursor, mhz_tok, sizeof(mhz_tok))) {
            printf("Usage: cca tune freq <MHz>\r\n");
            return;
        }
        cmd_cca_tune_freq(mhz_tok);
        return;
    }

    if (strcmp(t0, "lutron") == 0) {
        char ch_tok[24];
        if (!next_token(&cursor, ch_tok, sizeof(ch_tok))) {
            printf("Usage: cca tune lutron <channel>\r\n");
            printf("Known Lutron channels: 5 14 17 20 23 26 29 32 38 41 44 47 50 53 56\r\n");
            return;
        }
        uint32_t channel = 0;
        if (!parse_u32_token(ch_tok, &channel) || channel > 63u) {
            printf("Usage: cca tune lutron <channel>\r\n");
            printf("Known Lutron channels: 5 14 17 20 23 26 29 32 38 41 44 47 50 53 56\r\n");
            return;
        }
        double mhz = 431.0 + ((double)channel * 0.1);
        char   mhz_tok[24];
        snprintf(mhz_tok, sizeof(mhz_tok), "%.1f", mhz);
        cmd_cca_tune_freq(mhz_tok);
        return;
    }

    if (strcmp(t0, "profile") == 0) {
        char name[24];
        if (!next_token(&cursor, name, sizeof(name))) {
            printf("Usage: cca tune profile <default|burst|noisy>\r\n");
            return;
        }
        cmd_cca_tune_profile(name);
        return;
    }

    if (strcmp(t0, "reg") == 0) {
        char op[16];
        char a0[24];
        char a1[24];
        if (!next_token(&cursor, op, sizeof(op)) || !next_token(&cursor, a0, sizeof(a0))) {
            printf("Usage: cca tune reg get <addr>\r\n");
            printf("       cca tune reg set <addr> <value>\r\n");
            return;
        }
        if (strcmp(op, "get") == 0) {
            cmd_cca_tune_reg_get(a0);
            return;
        }
        if (strcmp(op, "set") == 0) {
            if (!next_token(&cursor, a1, sizeof(a1))) {
                printf("Usage: cca tune reg set <addr> <value>\r\n");
                return;
            }
            cmd_cca_tune_reg_set(a0, a1);
            return;
        }
        printf("Usage: cca tune reg get|set ...\r\n");
        return;
    }

    if (strcmp(t0, "param") == 0) {
        char op[16];
        if (!next_token(&cursor, op, sizeof(op))) {
            printf("Usage: cca tune param show|set ...\r\n");
            return;
        }
        if (strcmp(op, "show") == 0) {
            cmd_cca_tune_param_show();
            return;
        }
        if (strcmp(op, "set") == 0) {
            char name[24];
            char value[24];
            if (!next_token(&cursor, name, sizeof(name)) || !next_token(&cursor, value, sizeof(value))) {
                printf("Usage: cca tune param set <name> <value>\r\n");
                return;
            }
            cmd_cca_tune_param_set(name, value);
            return;
        }
        printf("Usage: cca tune param show|set ...\r\n");
        return;
    }

    if (strcmp(t0, "score") == 0) {
        char maybe[16];
        if (next_token(&cursor, maybe, sizeof(maybe))) {
            if (strcmp(maybe, "reset") == 0) {
                cmd_cca_tune_score_reset();
                return;
            }
            printf("Usage: cca tune score [reset]\r\n");
            return;
        }
        cmd_cca_tune_score_show();
        return;
    }

    if (strcmp(t0, "stats") == 0) {
        char op[16];
        if (next_token(&cursor, op, sizeof(op)) && strcmp(op, "reset") == 0) {
            cmd_cca_tune_stats_reset();
            return;
        }
        printf("Usage: cca tune stats reset\r\n");
        return;
    }

    cmd_cca_tune_print_usage();
}

/* -----------------------------------------------------------------------
 * TDMA commands
 * ----------------------------------------------------------------------- */
static void cmd_tdma(const char* arg)
{
    if (strcmp(arg, "status") == 0 || arg[0] == '\0') {
        CcaTdmaFrameState st;
        cca_tdma_get_state(&st);
        printf("TDMA Frame Sync\r\n");
        printf("  anchor:     %lu ms\r\n", (unsigned long)st.anchor_ms);
        printf("  period:     %lu ms (%u slots, mask=0x%02X)\r\n",
               (unsigned long)st.period_ms, st.slot_count, st.slot_mask);
        printf("  confidence: %u%%\r\n", st.confidence);
        printf("  our slot:   %u\r\n", st.our_slot);
        printf("  occupied:   %u/%u slots\r\n", st.occupied_count, st.slot_count);
        printf("  devices:    %lu tracked\r\n", (unsigned long)st.total_devices);
        printf("  jobs:       %u active\r\n", st.active_jobs);
        printf("  paused:     %s\r\n", cca_tdma_is_paused() ? "yes" : "no");
    }
    else if (strcmp(arg, "slots") == 0) {
        CcaTdmaDeviceInfo devs[32];
        size_t count = cca_tdma_get_devices(devs, 32);
        if (count == 0) {
            printf("No tracked devices\r\n");
            return;
        }
        printf("%-10s %-4s %-6s %-8s %-6s %-8s\r\n",
               "DeviceID", "Slot", "Stride", "Conf", "Samp", "Age(ms)");
        uint32_t now = HAL_GetTick();
        for (size_t i = 0; i < count; i++) {
            CcaTdmaDeviceInfo& d = devs[i];
            char dev_id[9];
            snprintf(dev_id, sizeof(dev_id), "%08lX", (unsigned long)d.device_id);
            uint32_t age = now - d.last_rx_ms;
            printf("%-10s %-4u %-6u %-7u%% %-6u %-8lu\r\n",
                   dev_id, d.slot, d.dominant_stride, d.confidence, d.samples,
                   (unsigned long)age);
        }
    }
    else if (strcmp(arg, "reset") == 0) {
        cca_tdma_reset();
        printf("TDMA state reset\r\n");
    }
    else {
        printf("Usage: tdma [status|slots|reset]\r\n");
    }
}

static void cmd_cca(const char* arg)
{
    if (strncmp(arg, "tune", 4) == 0 && (arg[4] == '\0' || arg[4] == ' ')) {
        cmd_cca_tune(arg[4] == ' ' ? arg + 5 : "");
        return;
    }

    if (strcmp(arg, "log") == 0) {
        printf("CCA RX UART log: %s\r\n", cca_uart_log_enabled() ? "ON" : "OFF");
        return;
    }
    if (strcmp(arg, "log on") == 0) {
        cca_set_uart_log_enabled(true);
        printf("CCA RX UART log enabled\r\n");
        return;
    }
    if (strcmp(arg, "log off") == 0) {
        cca_set_uart_log_enabled(false);
        printf("CCA RX UART log disabled\r\n");
        return;
    }

    /* cca button <device_id> <button_name> */
    if (strncmp(arg, "button ", 7) == 0) {
        char*    endptr;
        uint32_t dev_id = (uint32_t)strtoul(arg + 7, &endptr, 16);
        if (*endptr != ' ') {
            printf("Usage: cca button <device_id_hex> <on|off|fav|raise|lower|scene1-4>\r\n");
            return;
        }
        while (*endptr == ' ') endptr++;
        int btn = parse_button_name(endptr);
        if (btn < 0) {
            printf("Unknown button: %s\r\n", endptr);
            printf("  on off fav raise lower scene1 scene2 scene3 scene4\r\n");
            return;
        }
        CcaCmdItem item = {};
        item.cmd = CCA_CMD_BUTTON;
        item.device_id = dev_id;
        item.button = (uint8_t)btn;
        if (cca_cmd_enqueue(&item)) {
            printf("Button command queued\r\n");
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca level <zone_id> <target_id> <0-100> [fade_qs] */
    if (strncmp(arg, "level ", 6) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 6, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca level <zone_id_hex> <target_id_hex> <0-100> [fade_qs]\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca level <zone_id_hex> <target_id_hex> <0-100> [fade_qs]\r\n");
            return;
        }
        uint8_t pct = (uint8_t)strtoul(p + 1, &p, 10);
        uint8_t fade = 4; /* default 1 second */
        if (*p == ' ') fade = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_BRIDGE_LEVEL;
        item.device_id = zone_id;
        item.target_id = target_id;
        item.level_pct = pct;
        item.fade_qs = fade;
        if (cca_cmd_enqueue(&item)) {
            printf("Bridge level command queued\r\n");
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca broadcast <zone_id> <0-100> [fade_qs] — broadcast level to all devices */
    if (strncmp(arg, "broadcast ", 10) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 10, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca broadcast <zone_id_hex> <0-100> [fade_qs]\r\n");
            return;
        }
        uint8_t pct = (uint8_t)strtoul(p + 1, &p, 10);
        uint8_t fade = 4; /* default 1 second */
        if (*p == ' ') fade = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_BROADCAST_LEVEL;
        item.device_id = zone_id;
        item.level_pct = pct;
        item.fade_qs = fade;
        if (cca_cmd_enqueue(&item)) {
            printf("Broadcast level queued (zone=%08X %u%% fade=%u)\r\n",
                   (unsigned)zone_id, pct, fade);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca pico-level <device_id> <0-100> */
    if (strncmp(arg, "pico-level ", 11) == 0) {
        char*    p;
        uint32_t dev_id = (uint32_t)strtoul(arg + 11, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca pico-level <device_id_hex> <0-100>\r\n");
            return;
        }
        uint8_t pct = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_PICO_LEVEL;
        item.device_id = dev_id;
        item.level_pct = pct;
        if (cca_cmd_enqueue(&item)) {
            printf("Pico level command queued\r\n");
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca state <device_id> <0-100> */
    if (strncmp(arg, "state ", 6) == 0) {
        char*    p;
        uint32_t dev_id = (uint32_t)strtoul(arg + 6, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca state <device_id_hex> <0-100>\r\n");
            return;
        }
        uint8_t pct = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_STATE_REPORT;
        item.device_id = dev_id;
        item.level_pct = pct;
        if (cca_cmd_enqueue(&item)) {
            printf("State report command queued\r\n");
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca beacon <device_id> [duration] */
    if (strncmp(arg, "beacon ", 7) == 0) {
        char*    p;
        uint32_t dev_id = (uint32_t)strtoul(arg + 7, &p, 16);
        uint8_t  dur = 5;
        if (*p == ' ') dur = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_BEACON;
        item.device_id = dev_id;
        item.duration_sec = dur;
        if (cca_cmd_enqueue(&item)) {
            printf("Beacon command queued (%us)\r\n", dur);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca unpair <zone_id> <target_id> */
    if (strncmp(arg, "unpair ", 7) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 7, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca unpair <zone_id_hex> <target_id_hex>\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, NULL, 16);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_UNPAIR;
        item.device_id = zone_id;
        item.target_id = target_id;
        if (cca_cmd_enqueue(&item)) {
            printf("Unpair command queued\r\n");
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca led <zone_id> <target_id> <0-3> */
    if (strncmp(arg, "led ", 4) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 4, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca led <zone_id_hex> <target_id_hex> <0-3>\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca led <zone_id_hex> <target_id_hex> <0-3>\r\n");
            return;
        }
        uint8_t mode = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_LED_CONFIG;
        item.device_id = zone_id;
        item.target_id = target_id;
        item.led_mode = mode;
        if (cca_cmd_enqueue(&item)) {
            printf("LED config command queued (mode=%u)\r\n", mode);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca fade <zone_id> <target_id> <on_qs> <off_qs> */
    if (strncmp(arg, "fade ", 5) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 5, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca fade <zone_id_hex> <target_id_hex> <on_qs> <off_qs>\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca fade <zone_id_hex> <target_id_hex> <on_qs> <off_qs>\r\n");
            return;
        }
        uint16_t on_qs = (uint16_t)strtoul(p + 1, &p, 10);
        if (*p != ' ') {
            printf("Usage: cca fade <zone_id_hex> <target_id_hex> <on_qs> <off_qs>\r\n");
            return;
        }
        uint16_t off_qs = (uint16_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_FADE_CONFIG;
        item.device_id = zone_id;
        item.target_id = target_id;
        item.fade_on_qs = on_qs;
        item.fade_off_qs = off_qs;
        if (cca_cmd_enqueue(&item)) {
            printf("Fade config command queued (on=%uqs off=%uqs)\r\n", on_qs, off_qs);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca trim <zone_id> <target_id> <high%> <low%> */
    if (strncmp(arg, "trim ", 5) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 5, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca trim <zone_id_hex> <target_id_hex> <high%%> <low%%>\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca trim <zone_id_hex> <target_id_hex> <high%%> <low%%>\r\n");
            return;
        }
        uint8_t high = (uint8_t)strtoul(p + 1, &p, 10);
        if (*p != ' ') {
            printf("Usage: cca trim <zone_id_hex> <target_id_hex> <high%%> <low%%>\r\n");
            return;
        }
        uint8_t low = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_TRIM_CONFIG;
        item.device_id = zone_id;
        item.target_id = target_id;
        item.high_trim = high;
        item.low_trim = low;
        if (cca_cmd_enqueue(&item)) {
            printf("Trim config command queued (high=%u%% low=%u%%)\r\n", high, low);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca phase <zone_id> <target_id> <byte_hex> */
    if (strncmp(arg, "phase ", 6) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 6, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca phase <zone_id_hex> <target_id_hex> <byte_hex>\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca phase <zone_id_hex> <target_id_hex> <byte_hex>\r\n");
            return;
        }
        uint8_t phase = (uint8_t)strtoul(p + 1, NULL, 16);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_PHASE_CONFIG;
        item.device_id = zone_id;
        item.target_id = target_id;
        item.phase_byte = phase;
        if (cca_cmd_enqueue(&item)) {
            printf("Phase config command queued (0x%02X)\r\n", phase);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca save-fav <device_id> */
    if (strncmp(arg, "save-fav ", 9) == 0) {
        char*    endptr;
        uint32_t dev_id = (uint32_t)strtoul(arg + 9, &endptr, 16);
        if (*endptr != '\0' && *endptr != ' ') {
            printf("Usage: cca save-fav <device_id_hex>\r\n");
            return;
        }
        CcaCmdItem item = {};
        item.cmd = CCA_CMD_SAVE_FAV;
        item.device_id = dev_id;
        if (cca_cmd_enqueue(&item)) {
            printf("Save-fav command queued\r\n");
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca vive-level <hub_id> <zone_hex> <0-100> [fade_qs] */
    if (strncmp(arg, "vive-level ", 11) == 0) {
        char*    p;
        uint32_t hub_id = (uint32_t)strtoul(arg + 11, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca vive-level <hub_id_hex> <zone_hex> <0-100> [fade_qs]\r\n");
            return;
        }
        uint8_t zone = (uint8_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca vive-level <hub_id_hex> <zone_hex> <0-100> [fade_qs]\r\n");
            return;
        }
        uint8_t pct = (uint8_t)strtoul(p + 1, &p, 10);
        uint8_t fade = 4; /* default 1 second */
        if (*p == ' ') fade = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_VIVE_LEVEL;
        item.device_id = hub_id;
        item.zone_byte = zone;
        item.level_pct = pct;
        item.fade_qs = fade;
        if (cca_cmd_enqueue(&item)) {
            printf("Vive level command queued\r\n");
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca vive-raise <hub_id> <zone_hex> */
    if (strncmp(arg, "vive-raise ", 11) == 0) {
        char*    p;
        uint32_t hub_id = (uint32_t)strtoul(arg + 11, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca vive-raise <hub_id_hex> <zone_hex>\r\n");
            return;
        }
        uint8_t zone = (uint8_t)strtoul(p + 1, NULL, 16);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_VIVE_DIM;
        item.device_id = hub_id;
        item.zone_byte = zone;
        item.direction = 0x03; /* raise */
        if (cca_cmd_enqueue(&item)) {
            printf("Vive raise command queued\r\n");
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca vive-lower <hub_id> <zone_hex> */
    if (strncmp(arg, "vive-lower ", 11) == 0) {
        char*    p;
        uint32_t hub_id = (uint32_t)strtoul(arg + 11, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca vive-lower <hub_id_hex> <zone_hex>\r\n");
            return;
        }
        uint8_t zone = (uint8_t)strtoul(p + 1, NULL, 16);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_VIVE_DIM;
        item.device_id = hub_id;
        item.zone_byte = zone;
        item.direction = 0x02; /* lower */
        if (cca_cmd_enqueue(&item)) {
            printf("Vive lower command queued\r\n");
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca vive-pair <hub_id> <zone_hex> [duration] */
    if (strncmp(arg, "vive-pair ", 10) == 0) {
        char*    p;
        uint32_t hub_id = (uint32_t)strtoul(arg + 10, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca vive-pair <hub_id_hex> <zone_hex> [duration_sec]\r\n");
            return;
        }
        uint8_t zone = (uint8_t)strtoul(p + 1, &p, 16);
        uint8_t dur = 30;
        if (*p == ' ') dur = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_VIVE_PAIR;
        item.device_id = hub_id;
        item.zone_byte = zone;
        item.duration_sec = dur;
        if (cca_cmd_enqueue(&item)) {
            printf("Vive pair command queued (zone=0x%02X dur=%us)\r\n", zone, dur);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca pair pico <device_id> [5btn|2btn|4btn-rl|4btn-scene] [duration] */
    if (strncmp(arg, "pair pico ", 10) == 0) {
        char*    p;
        uint32_t dev_id = (uint32_t)strtoul(arg + 10, &p, 16);
        uint8_t  pico_type = 0; /* default 5-button */
        uint8_t  dur = 10;

        if (*p == ' ') {
            p++;
            if (strncmp(p, "5btn", 4) == 0) {
                pico_type = 0;
                p += 4;
            }
            else if (strncmp(p, "2btn", 4) == 0) {
                pico_type = 1;
                p += 4;
            }
            else if (strncmp(p, "4btn-rl", 7) == 0) {
                pico_type = 2;
                p += 7;
            }
            else if (strncmp(p, "4btn-scene", 10) == 0) {
                pico_type = 3;
                p += 10;
            }

            if (*p == ' ') dur = (uint8_t)strtoul(p + 1, NULL, 10);
        }

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_PICO_PAIR;
        item.device_id = dev_id;
        item.pico_type = pico_type;
        item.duration_sec = dur;
        if (cca_cmd_enqueue(&item)) {
            printf("Pico pair command queued (type=%u dur=%us)\r\n", pico_type, dur);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca pair bridge <bridge_id> <target_id> <zone_hex> [beacon_sec] */
    if (strncmp(arg, "pair bridge ", 12) == 0) {
        char*    p;
        uint32_t bridge_id = (uint32_t)strtoul(arg + 12, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca pair bridge <bridge_id_hex> <target_id_hex> <zone_hex> [beacon_sec]\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, &p, 16);
        uint8_t  zone = 0;
        uint8_t  dur = 5;
        if (*p == ' ') {
            zone = (uint8_t)strtoul(p + 1, &p, 16);
            if (*p == ' ') dur = (uint8_t)strtoul(p + 1, NULL, 10);
        }

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_BRIDGE_PAIR;
        item.device_id = bridge_id;
        item.target_id = target_id;
        item.zone_byte = zone;
        item.duration_sec = dur;
        if (cca_cmd_enqueue(&item)) {
            printf("Bridge pair command queued (zone=0x%02X beacon=%us)\r\n", zone, dur);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca announce <serial_hex> <class_hex_4byte> <subnet_hex> [duration_sec]
     * Emits spoofed B0 device announce packets with the given serial and class. */
    if (strncmp(arg, "announce ", 8) == 0) {
        char*    p;
        uint32_t serial = (uint32_t)strtoul(arg + 8, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca announce <serial_hex> <class_hex> <subnet_hex> [duration_sec]\r\n");
            return;
        }
        uint32_t dev_class = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca announce <serial_hex> <class_hex> <subnet_hex> [duration_sec]\r\n");
            return;
        }
        uint16_t subnet = (uint16_t)strtoul(p + 1, &p, 16);
        uint8_t  dur = 15;
        if (*p == ' ') dur = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_ANNOUNCE;
        item.device_id = serial;
        item.target_id = dev_class;
        item.raw_payload[0] = (subnet >> 8) & 0xFF;
        item.raw_payload[1] = subnet & 0xFF;
        item.duration_sec = dur;
        if (cca_cmd_enqueue(&item)) {
            printf("Announce queued (serial=%08X class=%08X subnet=%04X dur=%us)\r\n",
                   (unsigned)serial, (unsigned)dev_class, subnet, dur);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca hybrid-pair <bridge_id_hex> <class_hex_4byte> <subnet_hex> <zone_hex> [duration]
     * Vive B9 beacon to wake PowPaks, then pair with RA3 bridge ID + B0 announce. */
    if (strncmp(arg, "hybrid-pair ", 12) == 0) {
        char*    p;
        uint32_t bridge_id = (uint32_t)strtoul(arg + 12, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca hybrid-pair <bridge_id> <class> <subnet> <zone> [dur]\r\n");
            return;
        }
        uint32_t dev_class = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca hybrid-pair <bridge_id> <class> <subnet> <zone> [dur]\r\n");
            return;
        }
        uint16_t subnet = (uint16_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca hybrid-pair <bridge_id> <class> <subnet> <zone> [dur]\r\n");
            return;
        }
        uint8_t zone = (uint8_t)strtoul(p + 1, &p, 16);
        uint8_t dur = 30;
        if (*p == ' ') dur = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_HYBRID_PAIR;
        item.device_id = bridge_id;
        item.target_id = dev_class;
        item.raw_payload[0] = (subnet >> 8) & 0xFF;
        item.raw_payload[1] = subnet & 0xFF;
        item.zone_byte = zone;
        item.duration_sec = dur;
        if (cca_cmd_enqueue(&item)) {
            printf("Hybrid pair queued (bridge=%08X class=%08X subnet=%04X zone=0x%02X dur=%us)\r\n",
                   (unsigned)bridge_id, (unsigned)dev_class, subnet, zone, dur);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca raw <zone_hex> <target_hex> <format_hex> <payload_hex_bytes...>
     * Payload starts at byte 13 (first byte is typically addr_mode: FE/EF/FF).
     * Bytes 0-12 are auto-built: [type][seq][zone:4 LE][0x21][fmt][0x00][target:4 BE] */
    if (strncmp(arg, "raw ", 4) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 4, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca raw <zone> <target> <fmt> <payload_bytes...>\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca raw <zone> <target> <fmt> <payload_bytes...>\r\n");
            return;
        }
        uint8_t format = (uint8_t)strtoul(p + 1, &p, 16);

        /* All remaining args are payload hex bytes (space-separated) */
        uint8_t payload[40];
        uint8_t payload_len = 0;
        while (*p == ' ' && payload_len < sizeof(payload)) {
            payload[payload_len++] = (uint8_t)strtoul(p + 1, &p, 16);
        }

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_RAW;
        item.device_id = zone_id;
        item.target_id = target_id;
        item.raw_format = format;
        item.raw_repeat = 12;
        item.raw_payload_len = payload_len;
        if (payload_len > 0) memcpy(item.raw_payload, payload, payload_len);
        if (cca_cmd_enqueue(&item)) {
            printf("Raw command queued (fmt=0x%02X payload=%u bytes)\r\n",
                   format, payload_len);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca scene <zone_id> <target_id> <level%> [fade_qs] */
    if (strncmp(arg, "scene ", 6) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 6, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca scene <zone_hex> <target_hex> <level%%> [fade_qs]\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca scene <zone_hex> <target_hex> <level%%> [fade_qs]\r\n");
            return;
        }
        uint8_t pct = (uint8_t)strtoul(p + 1, &p, 10);
        uint8_t fade = 4;  /* default 1 second */
        if (*p == ' ') fade = (uint8_t)strtoul(p + 1, NULL, 10);

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_SCENE_EXEC;
        item.device_id = zone_id;
        item.target_id = target_id;
        item.level_pct = pct;
        item.fade_qs = fade;
        if (cca_cmd_enqueue(&item)) {
            printf("Scene command queued (%u%% fade=%uqs)\r\n", pct, fade);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca dim-config <zone_id> <target_id> <hex_bytes...> */
    if (strncmp(arg, "dim-config ", 11) == 0) {
        char*    p;
        uint32_t zone_id = (uint32_t)strtoul(arg + 11, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca dim-config <zone_hex> <target_hex> <hex_bytes...>\r\n");
            return;
        }
        uint32_t target_id = (uint32_t)strtoul(p + 1, &p, 16);
        if (*p != ' ') {
            printf("Usage: cca dim-config <zone_hex> <target_hex> <hex_bytes...>\r\n");
            return;
        }

        uint8_t config[40];
        uint8_t config_len = 0;
        while (*p == ' ' && config_len < sizeof(config)) {
            config[config_len++] = (uint8_t)strtoul(p + 1, &p, 16);
        }

        if (config_len == 0) {
            printf("Usage: cca dim-config <zone_hex> <target_hex> <hex_bytes...>\r\n");
            return;
        }

        CcaCmdItem item = {};
        item.cmd = CCA_CMD_DIM_CONFIG;
        item.device_id = zone_id;
        item.target_id = target_id;
        item.raw_payload_len = config_len;
        memcpy(item.raw_payload, config, config_len);
        if (cca_cmd_enqueue(&item)) {
            printf("Dim-config command queued (%u config bytes)\r\n", config_len);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca identify <target_id> — QS Link identify (flash LED) */
    if (strncmp(arg, "identify ", 9) == 0) {
        uint32_t target_id = (uint32_t)strtoul(arg + 9, NULL, 16);
        CcaCmdItem item = {};
        item.cmd = CCA_CMD_IDENTIFY;
        item.target_id = target_id;
        if (cca_cmd_enqueue(&item)) {
            printf("Identify command queued (target=%08X)\r\n", (unsigned)target_id);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    /* cca query <target_id> — QS Link component query */
    if (strncmp(arg, "query ", 6) == 0) {
        uint32_t target_id = (uint32_t)strtoul(arg + 6, NULL, 16);
        CcaCmdItem item = {};
        item.cmd = CCA_CMD_QUERY;
        item.target_id = target_id;
        if (cca_cmd_enqueue(&item)) {
            printf("Query command queued (target=%08X)\r\n", (unsigned)target_id);
        }
        else {
            printf("Command queue full!\r\n");
        }
        return;
    }

    printf("Usage: cca <command> ...\r\n");
    printf("  cca button <dev_id> <name>            — button press\r\n");
    printf("  cca level <zone> <target> <%%> [fade]  — bridge level\r\n");
    printf("  cca broadcast <zone> <%%> [fade]      — broadcast level (all devices)\r\n");
    printf("  cca pico-level <dev_id> <%%>           — pico level\r\n");
    printf("  cca state <dev_id> <%%>                — state report\r\n");
    printf("  cca beacon <dev_id> [dur]             — discovery beacon\r\n");
    printf("  cca unpair <zone> <target>            — unpair device\r\n");
    printf("  cca led <zone> <target> <0-3>         — LED config\r\n");
    printf("  cca fade <zone> <target> <on> <off>   — fade config (qs)\r\n");
    printf("  cca trim <zone> <target> <hi%%> <lo%%>  — trim config\r\n");
    printf("  cca phase <zone> <target> <hex>       — phase config\r\n");
    printf("  cca save-fav <dev_id>                 — save favorite level\r\n");
    printf("  cca raw <zone> <target> <fmt> <payload...> — raw packet\r\n");
    printf("  cca scene <zone> <target> <%%> [fade]  — scene execute\r\n");
    printf("  cca dim-config <zone> <target> <hex...> — dimming config\r\n");
    printf("  cca vive-level <hub> <zone> <%%> [fade] — Vive set-level\r\n");
    printf("  cca vive-raise <hub> <zone>           — Vive raise\r\n");
    printf("  cca vive-lower <hub> <zone>           — Vive lower\r\n");
    printf("  cca vive-pair <hub> <zone> [dur]      — Vive pairing\r\n");
    printf("  cca pair pico <dev> [type] [dur]      — pico pairing\r\n");
    printf("  cca pair bridge <id> <target> <zone> [dur] — bridge pairing\r\n");
    printf("  cca announce <serial> <class> <subnet> [dur] — spoofed B0 announce\r\n");
    printf("  cca hybrid-pair <bridge> <class> <subnet> <zone> [dur] — Vive→RA3 pair\r\n");
    printf("  cca identify <target>                 — flash device LED (QS identify)\r\n");
    printf("  cca query <target>                    — query device component info\r\n");
    printf("  cca tune ...                          — CC1101 tuning/debug tools\r\n");
    printf("  cca log [on|off]                      — CCA RX UART log toggle\r\n");
}

static void cmd_rx(const char* arg)
{
    if (strcmp(arg, "on") == 0) {
        if (!cc1101_is_rx_active()) {
            cc1101_start_rx();
            printf("RX enabled\r\n");
        }
        else {
            printf("RX already active\r\n");
        }
    }
    else if (strcmp(arg, "off") == 0) {
        cc1101_stop_rx();
        printf("RX disabled\r\n");
    }
    else {
        printf("Usage: rx on|off\r\n");
    }
}

static void cmd_eth(void)
{
    extern ETH_HandleTypeDef heth;
    uint32_t                 reg;

    printf("--- ETH PHY Debug ---\r\n");

    /* Read PHY Basic Control Register (0x00) */
    if (HAL_ETH_ReadPHYRegister(&heth, LAN8742A_PHY_ADDR, 0x00, &reg) == HAL_OK) {
        printf("PHY BCR  (0x00) = 0x%04lX\r\n", (unsigned long)reg);
    }
    else {
        printf("PHY BCR  read FAILED\r\n");
    }

    /* Read PHY Basic Status Register (0x01) */
    if (HAL_ETH_ReadPHYRegister(&heth, LAN8742A_PHY_ADDR, 0x01, &reg) == HAL_OK) {
        printf("PHY BSR  (0x01) = 0x%04lX  link=%s\r\n", (unsigned long)reg, (reg & (1 << 2)) ? "UP" : "DOWN");
    }
    else {
        printf("PHY BSR  read FAILED\r\n");
    }

    /* PHY Identifier (0x02, 0x03) */
    if (HAL_ETH_ReadPHYRegister(&heth, LAN8742A_PHY_ADDR, 0x02, &reg) == HAL_OK) {
        printf("PHY ID1  (0x02) = 0x%04lX\r\n", (unsigned long)reg);
    }
    if (HAL_ETH_ReadPHYRegister(&heth, LAN8742A_PHY_ADDR, 0x03, &reg) == HAL_OK) {
        printf("PHY ID2  (0x03) = 0x%04lX\r\n", (unsigned long)reg);
    }

    /* PHY Special Status (0x1F) — link speed/duplex on LAN8742A */
    if (HAL_ETH_ReadPHYRegister(&heth, LAN8742A_PHY_ADDR, 0x1F, &reg) == HAL_OK) {
        printf("PHY SCSR (0x1F) = 0x%04lX\r\n", (unsigned long)reg);
    }

    /* ETH TX/RX counters */
    printf("TX ok=%lu fail=%lu  RX frames=%lu\r\n", (unsigned long)eth_get_tx_ok(), (unsigned long)eth_get_tx_fail(),
           (unsigned long)eth_get_rx_frames());

    /* Force a link poll */
    eth_poll_link();
    printf("eth_link_is_up() = %s\r\n", eth_link_is_up() ? "true" : "false");
}

static void cmd_stream(const char* arg)
{
    (void)arg;
    printf("UDP stream on port %d\r\n", STREAM_UDP_PORT);
    printf("  clients: %d/%d\r\n", stream_num_clients(), MAX_STREAM_CLIENTS);
    printf("  sent=%lu fail=%lu qdrop=%lu\r\n", (unsigned long)stream_udp_sent_count(),
           (unsigned long)stream_udp_fail_count(), (unsigned long)stream_tx_drop_count());
}

/**
 * Parse a hex string into bytes. Returns number of bytes parsed.
 * Supports both "AABB" and "AA:BB" formats.
 */
static size_t parse_hex_bytes(const char* hex, uint8_t* out, size_t max_len)
{
    size_t pos = 0;
    while (*hex && pos < max_len) {
        if (*hex == ':') { hex++; continue; }
        char hi = *hex++;
        if (!*hex) break;
        char lo = *hex++;

        uint8_t val = 0;
        if (hi >= '0' && hi <= '9') val = (uint8_t)((hi - '0') << 4);
        else if (hi >= 'a' && hi <= 'f') val = (uint8_t)((hi - 'a' + 10) << 4);
        else if (hi >= 'A' && hi <= 'F') val = (uint8_t)((hi - 'A' + 10) << 4);
        else return pos;

        if (lo >= '0' && lo <= '9') val |= (uint8_t)(lo - '0');
        else if (lo >= 'a' && lo <= 'f') val |= (uint8_t)(lo - 'a' + 10);
        else if (lo >= 'A' && lo <= 'F') val |= (uint8_t)(lo - 'A' + 10);
        else return pos;

        out[pos++] = val;
    }
    return pos;
}

/**
 * Parse an IPv6 address from colon-hex notation (no :: shorthand).
 * Returns true on success.
 */
static bool parse_ipv6_addr(const char* str, uint8_t out[16])
{
    /* Try compact hex first (32 hex chars, no colons) */
    size_t len = strlen(str);
    if (len == 32) {
        return parse_hex_bytes(str, out, 16) == 16;
    }

    /* Colon-separated 16-bit groups: fe80:0000:0000:0000:220e:fb79:b4ce:f76f */
    memset(out, 0, 16);
    int group = 0;
    const char* p = str;
    while (*p && group < 8) {
        char* end;
        unsigned long val = strtoul(p, &end, 16);
        if (end == p || val > 0xFFFF) return false;
        out[group * 2] = (uint8_t)(val >> 8);
        out[group * 2 + 1] = (uint8_t)(val & 0xFF);
        group++;
        if (*end == ':') end++;
        else if (*end != '\0') return false;
        p = end;
    }
    return group == 8;
}

/**
 * Build CBOR preset payload for CoAP POST to /cg/db/pr/c/<key>.
 * Format: {bstr(4, device_id<<16|0xEF20): [preset_id, {0: level16, 3: fade_qs}]}
 */
static size_t build_preset_cbor(uint8_t* buf, size_t buf_size,
                                uint16_t device_id, uint8_t preset_id,
                                uint16_t level, uint8_t fade_qs)
{
    if (buf_size < 32) return 0;
    uint8_t* p = buf;
    uint8_t* end = buf + buf_size;

    /* Map(1) */
    if (p >= end) return 0;
    *p++ = 0xA1;

    /* Key: bstr(4) = device_id BE16 | 0xEF20 */
    if (p + 5 > end) return 0;
    *p++ = 0x44; /* bstr length 4 */
    *p++ = (uint8_t)(device_id >> 8);
    *p++ = (uint8_t)(device_id & 0xFF);
    *p++ = 0xEF;
    *p++ = 0x20;

    /* Value: array(2) [preset_id, map(2){0:level, 3:fade}] */
    if (p >= end) return 0;
    *p++ = 0x82; /* array(2) */

    /* preset_id (uint) */
    if (preset_id < 24) {
        if (p >= end) return 0;
        *p++ = preset_id;
    } else {
        if (p + 2 > end) return 0;
        *p++ = 0x18;
        *p++ = preset_id;
    }

    /* map(2) {0: level, 3: fade} */
    if (p >= end) return 0;
    *p++ = 0xA2;

    /* key 0, value level (uint16) */
    if (p >= end) return 0;
    *p++ = 0x00;
    if (level < 24) {
        if (p >= end) return 0;
        *p++ = (uint8_t)level;
    } else if (level < 256) {
        if (p + 2 > end) return 0;
        *p++ = 0x18;
        *p++ = (uint8_t)level;
    } else {
        if (p + 3 > end) return 0;
        *p++ = 0x19;
        *p++ = (uint8_t)(level >> 8);
        *p++ = (uint8_t)(level & 0xFF);
    }

    /* key 3, value fade */
    if (p >= end) return 0;
    *p++ = 0x03;
    if (fade_qs < 24) {
        if (p >= end) return 0;
        *p++ = fade_qs;
    } else {
        if (p + 2 > end) return 0;
        *p++ = 0x18;
        *p++ = fade_qs;
    }

    return (size_t)(p - buf);
}

/**
 * Try to resolve an address argument to a 16-byte IPv6 address.
 * Supports:
 *   - "rloc:XXXX"  — build RLOC IPv6 from hex RLOC16
 *   - "serial:NNN" — look up RLOC from peer table by serial number
 *   - Full IPv6 colon notation or 32-char hex
 * Returns true on success.
 */
static bool resolve_ccx_addr(const char* str, uint8_t out[16])
{
    if (strncmp(str, "rloc:", 5) == 0) {
        uint16_t rloc16 = (uint16_t)strtoul(str + 5, NULL, 16);
        if (rloc16 == 0) {
            printf("Invalid RLOC16\r\n");
            return false;
        }
        if (!ccx_build_rloc_addr(rloc16, out)) {
            printf("Mesh-local prefix not yet known\r\n");
            return false;
        }
        return true;
    }

    if (strncmp(str, "serial:", 7) == 0) {
        uint32_t serial = strtoul(str + 7, NULL, 10);
        uint16_t rloc16;
        if (!ccx_peer_find_by_serial(serial, &rloc16)) {
            printf("Serial %lu not in peer table (press buttons or wait for traffic)\r\n",
                   (unsigned long)serial);
            return false;
        }
        if (!ccx_build_rloc_addr(rloc16, out)) {
            printf("Mesh-local prefix not yet known\r\n");
            return false;
        }
        printf("Resolved serial %lu → rloc:0x%04X\r\n", (unsigned long)serial, rloc16);
        return true;
    }

    return parse_ipv6_addr(str, out);
}

static void cmd_ccx_coap(const char* arg)
{
    if (strncmp(arg, "preset ", 7) == 0) {
        /* ccx coap preset <ipv6_addr> <device_id> <preset_id> <level%> [fade_s] */
        const char* p = arg + 7;
        char addr_str[64];
        const char* space = strchr(p, ' ');
        if (!space) goto coap_usage;
        size_t alen = (size_t)(space - p);
        if (alen >= sizeof(addr_str)) goto coap_usage;
        memcpy(addr_str, p, alen);
        addr_str[alen] = '\0';

        uint8_t dst[16];
        if (!resolve_ccx_addr(addr_str, dst)) {
            printf("Invalid address (use IPv6, rloc:XXXX, or serial:NNN)\r\n");
            return;
        }

        char* endptr;
        p = space + 1;
        uint16_t dev_id = (uint16_t)strtoul(p, &endptr, 0);
        if (*endptr != ' ') goto coap_usage;

        p = endptr + 1;
        uint8_t preset_id = (uint8_t)strtoul(p, &endptr, 0);
        if (*endptr != ' ') goto coap_usage;

        p = endptr + 1;
        uint8_t pct = (uint8_t)strtoul(p, &endptr, 10);
        uint16_t level = ccx_percent_to_level(pct);

        uint8_t fade_qs = 1; /* default instant */
        if (*endptr == ' ') {
            float fade_s = strtof(endptr + 1, NULL);
            fade_qs = (uint8_t)(fade_s * 4);
            if (fade_qs == 0) fade_qs = 1;
        }

        /* Build the CBOR preset payload */
        uint8_t cbor[64];
        size_t cbor_len = build_preset_cbor(cbor, sizeof(cbor), dev_id, preset_id, level, fade_qs);
        if (cbor_len == 0) {
            printf("CBOR encode failed\r\n");
            return;
        }

        /* Build URI path: /cg/db/pr/c/<key_hex> */
        char uri[64];
        snprintf(uri, sizeof(uri), "/cg/db/pr/c/%04X", dev_id);

        if (ccx_send_coap(dst, COAP_CODE_POST, uri, cbor, cbor_len)) {
            printf("CoAP POST preset dev=0x%04X id=%u level=%u%% (0x%04X) fade=%u queued\r\n",
                   dev_id, preset_id, pct, level, fade_qs);
        } else {
            printf("CoAP TX failed (not joined?)\r\n");
        }
        return;
    }

    if (strncmp(arg, "led ", 4) == 0) {
        /* ccx coap led <ipv6_addr> <active_0-255> <inactive_0-255>
         * Programs keypad status LED brightness via AHA bucket (0x0070).
         * CBOR: [108, {4: active, 5: inactive}] */
        const char* p = arg + 4;
        char addr_str[64];
        const char* space = strchr(p, ' ');
        if (!space) goto coap_usage;
        size_t alen = (size_t)(space - p);
        if (alen >= sizeof(addr_str)) goto coap_usage;
        memcpy(addr_str, p, alen);
        addr_str[alen] = '\0';

        uint8_t dst[16];
        if (!resolve_ccx_addr(addr_str, dst)) {
            printf("Invalid address (use IPv6, rloc:XXXX, or serial:NNN)\r\n");
            return;
        }

        char* endptr;
        p = space + 1;
        uint8_t active = (uint8_t)strtoul(p, &endptr, 10);
        if (*endptr != ' ') goto coap_usage;
        uint8_t inactive = (uint8_t)strtoul(endptr + 1, NULL, 10);

        /* Build CBOR: [108, {4: active, 5: inactive}] */
        uint8_t cbor[16];
        size_t ci = 0;
        cbor[ci++] = 0x82;       /* array(2) */
        cbor[ci++] = 0x18;       /* uint8 follows */
        cbor[ci++] = 108;        /* opcode 108 */
        cbor[ci++] = 0xA2;       /* map(2) */
        cbor[ci++] = 0x04;       /* key 4 (activated) */
        if (active < 24) { cbor[ci++] = active; }
        else { cbor[ci++] = 0x18; cbor[ci++] = active; }
        cbor[ci++] = 0x05;       /* key 5 (deactivated) */
        if (inactive < 24) { cbor[ci++] = inactive; }
        else { cbor[ci++] = 0x18; cbor[ci++] = inactive; }

        if (ccx_send_coap(dst, COAP_CODE_PUT, "/cg/db/ct/c/AHA", cbor, ci)) {
            printf("CoAP PUT LED active=%u inactive=%u queued\r\n", active, inactive);
        } else {
            printf("CoAP TX failed (not joined?)\r\n");
        }
        return;
    }

    if (strncmp(arg, "trim ", 5) == 0) {
        /* ccx coap trim <ipv6_addr> <high%> <low%>
         * Programs dimmer trim via AAI bucket (0x0002).
         * CBOR: [3, {2: high_raw, 3: low_raw, 8: 5}]
         * Encoding: raw = percent * 0x0100 - 0x0100 (approx percent * 655.35) */
        const char* p = arg + 5;
        char addr_str[64];
        const char* space = strchr(p, ' ');
        if (!space) goto coap_usage;
        size_t alen = (size_t)(space - p);
        if (alen >= sizeof(addr_str)) goto coap_usage;
        memcpy(addr_str, p, alen);
        addr_str[alen] = '\0';

        uint8_t dst[16];
        if (!resolve_ccx_addr(addr_str, dst)) {
            printf("Invalid address (use IPv6, rloc:XXXX, or serial:NNN)\r\n");
            return;
        }

        char* endptr;
        p = space + 1;
        float high_pct = strtof(p, &endptr);
        if (*endptr != ' ') goto coap_usage;
        float low_pct = strtof(endptr + 1, NULL);

        /* Convert percent to raw: raw = percent * 256 - 256 */
        uint16_t high_raw = (uint16_t)(high_pct * 256.0f - 256.0f);
        uint16_t low_raw = (uint16_t)(low_pct * 256.0f - 256.0f);

        /* Build CBOR: [3, {2: high_raw, 3: low_raw, 8: 5}] */
        uint8_t cbor[32];
        size_t ci = 0;
        cbor[ci++] = 0x82;       /* array(2) */
        cbor[ci++] = 0x03;       /* opcode 3 */
        cbor[ci++] = 0xA3;       /* map(3) */
        cbor[ci++] = 0x02;       /* key 2 (high trim) */
        cbor[ci++] = 0x19;       /* uint16 */
        cbor[ci++] = (uint8_t)(high_raw >> 8);
        cbor[ci++] = (uint8_t)(high_raw & 0xFF);
        cbor[ci++] = 0x03;       /* key 3 (low trim) */
        cbor[ci++] = 0x19;       /* uint16 */
        cbor[ci++] = (uint8_t)(low_raw >> 8);
        cbor[ci++] = (uint8_t)(low_raw & 0xFF);
        cbor[ci++] = 0x08;       /* key 8 (profile) */
        cbor[ci++] = 0x05;       /* profile = 5 (dimmer) */

        if (ccx_send_coap(dst, COAP_CODE_PUT, "/cg/db/ct/c/AAI", cbor, ci)) {
            printf("CoAP PUT trim high=%.1f%% (%u) low=%.1f%% (%u) queued\r\n",
                   (double)high_pct, high_raw, (double)low_pct, low_raw);
        } else {
            printf("CoAP TX failed (not joined?)\r\n");
        }
        return;
    }

    if (strncmp(arg, "get ", 4) == 0) {
        /* ccx coap get <ipv6_addr> <uri_path> [port] */
        const char* p = arg + 4;
        char addr_str[64];
        const char* space = strchr(p, ' ');
        if (!space) goto coap_usage;
        size_t alen = (size_t)(space - p);
        if (alen >= sizeof(addr_str)) goto coap_usage;
        memcpy(addr_str, p, alen);
        addr_str[alen] = '\0';

        uint8_t dst[16];
        if (!resolve_ccx_addr(addr_str, dst)) {
            printf("Invalid address (use IPv6, rloc:XXXX, or serial:NNN)\r\n");
            return;
        }

        /* Parse URI path and optional port */
        const char* uri = space + 1;
        uint16_t port = 0; /* 0 = default 5683 */
        const char* port_space = strchr(uri, ' ');
        char uri_buf[64];
        if (port_space) {
            size_t ulen = (size_t)(port_space - uri);
            if (ulen >= sizeof(uri_buf)) goto coap_usage;
            memcpy(uri_buf, uri, ulen);
            uri_buf[ulen] = '\0';
            uri = uri_buf;
            port = (uint16_t)strtoul(port_space + 1, NULL, 10);
        }

        ccx_coap_response_arm();
        if (!ccx_send_coap_port(dst, COAP_CODE_GET, uri, NULL, 0, port)) {
            printf("CoAP TX failed (not joined?)\r\n");
            return;
        }
        printf("CoAP GET %s → waiting...\r\n", space + 1);
        for (int i = 0; i < 50; i++) { /* 5 seconds */
            vTaskDelay(pdMS_TO_TICKS(100));
            ccx_coap_response_t resp;
            if (ccx_coap_response_get(&resp)) {
                printf("CoAP response code=%u.%02u mid=0x%04X from ",
                       resp.code >> 5, resp.code & 0x1F, resp.msg_id);
                for (int j = 0; j < 16; j += 2) {
                    if (j > 0) printf(":");
                    printf("%02x%02x", resp.src_addr[j], resp.src_addr[j + 1]);
                }
                printf("\r\n");
                if (resp.payload_len > 0) {
                    printf("Payload (%u bytes):", (unsigned)resp.payload_len);
                    for (size_t k = 0; k < resp.payload_len; k++) printf(" %02X", resp.payload[k]);
                    printf("\r\n");
                } else {
                    printf("(no payload)\r\n");
                }
                return;
            }
        }
        printf("No CoAP response (timeout 5s)\r\n");
        return;
    }

    if (strncmp(arg, "observe ", 8) == 0) {
        /* ccx coap observe <ipv6_addr> <uri_path> [dereg] */
        const char* p = arg + 8;
        char addr_str[64];
        const char* space = strchr(p, ' ');
        if (!space) goto coap_usage;
        size_t alen = (size_t)(space - p);
        if (alen >= sizeof(addr_str)) goto coap_usage;
        memcpy(addr_str, p, alen);
        addr_str[alen] = '\0';

        uint8_t dst[16];
        if (!resolve_ccx_addr(addr_str, dst)) {
            printf("Invalid address\r\n");
            return;
        }

        /* Check for optional "dereg" after path */
        const char* uri = space + 1;
        uint8_t observe_val = 0; /* 0 = register */
        const char* dereg = strstr(uri, " dereg");
        char uri_buf[64];
        if (dereg) {
            size_t ulen = (size_t)(dereg - uri);
            if (ulen >= sizeof(uri_buf)) goto coap_usage;
            memcpy(uri_buf, uri, ulen);
            uri_buf[ulen] = '\0';
            uri = uri_buf;
            observe_val = 1;
        }

        ccx_coap_response_arm();
        if (!ccx_send_coap_observe(dst, uri, observe_val)) {
            printf("CoAP TX failed (not joined?)\r\n");
            return;
        }
        printf("CoAP Observe %s %s → waiting...\r\n",
               observe_val == 0 ? "REGISTER" : "DEREGISTER", uri);
        /* Wait up to 5s for initial response */
        for (int i = 0; i < 50; i++) {
            vTaskDelay(pdMS_TO_TICKS(100));
            ccx_coap_response_t resp;
            if (ccx_coap_response_get(&resp)) {
                printf("CoAP response code=%u.%02u mid=0x%04X\r\n",
                       resp.code >> 5, resp.code & 0x1F, resp.msg_id);
                if (resp.payload_len > 0) {
                    printf("Payload (%u bytes):", (unsigned)resp.payload_len);
                    for (size_t k = 0; k < resp.payload_len; k++) printf(" %02X", resp.payload[k]);
                    printf("\r\n");
                }
                return;
            }
        }
        printf("No initial response (timeout 5s)\r\n");
        printf("If registered, notifications will appear as [coap] broadcasts\r\n");
        return;
    }

    if (strncmp(arg, "probe ", 6) == 0) {
        /* ccx coap probe <ipv6_addr> <uri_path> — fire-and-forget GET (no wait) */
        const char* p = arg + 6;
        char addr_str[64];
        const char* space = strchr(p, ' ');
        if (!space) goto coap_usage;
        size_t alen = (size_t)(space - p);
        if (alen >= sizeof(addr_str)) goto coap_usage;
        memcpy(addr_str, p, alen);
        addr_str[alen] = '\0';

        uint8_t dst[16];
        if (!resolve_ccx_addr(addr_str, dst)) {
            printf("Invalid address\r\n");
            return;
        }

        if (ccx_send_coap(dst, COAP_CODE_GET, space + 1, NULL, 0)) {
            printf("OK\r\n");
        } else {
            printf("FAIL\r\n");
        }
        return;
    }

    if (strncmp(arg, "delete ", 7) == 0) {
        /* ccx coap delete <ipv6_addr> <uri_path> */
        const char* p = arg + 7;
        char addr_str[64];
        const char* space = strchr(p, ' ');
        if (!space) goto coap_usage;
        size_t alen = (size_t)(space - p);
        if (alen >= sizeof(addr_str)) goto coap_usage;
        memcpy(addr_str, p, alen);
        addr_str[alen] = '\0';

        uint8_t dst[16];
        if (!resolve_ccx_addr(addr_str, dst)) {
            printf("Invalid address (use IPv6, rloc:XXXX, or serial:NNN)\r\n");
            return;
        }

        if (ccx_send_coap(dst, COAP_CODE_DELETE, space + 1, NULL, 0)) {
            printf("CoAP DELETE %s queued\r\n", space + 1);
        } else {
            printf("CoAP TX failed (not joined?)\r\n");
        }
        return;
    }

    if (strncmp(arg, "put ", 4) == 0 || strncmp(arg, "post ", 5) == 0) {
        /* ccx coap put/post <ipv6_addr> <uri_path> <payload_hex> */
        bool is_put = (arg[1] == 'u');
        const char* p = arg + (is_put ? 4 : 5);

        /* Parse addr */
        char addr_str[64];
        const char* space = strchr(p, ' ');
        if (!space) goto coap_usage;
        size_t alen = (size_t)(space - p);
        if (alen >= sizeof(addr_str)) goto coap_usage;
        memcpy(addr_str, p, alen);
        addr_str[alen] = '\0';

        uint8_t dst[16];
        if (!resolve_ccx_addr(addr_str, dst)) {
            printf("Invalid address (use IPv6, rloc:XXXX, or serial:NNN)\r\n");
            return;
        }

        /* Parse URI path */
        p = space + 1;
        space = strchr(p, ' ');
        if (!space) goto coap_usage;
        char uri[64];
        size_t ulen = (size_t)(space - p);
        if (ulen >= sizeof(uri)) goto coap_usage;
        memcpy(uri, p, ulen);
        uri[ulen] = '\0';

        /* Parse hex payload */
        uint8_t payload[128];
        size_t plen = parse_hex_bytes(space + 1, payload, sizeof(payload));
        if (plen == 0) {
            printf("Invalid hex payload\r\n");
            return;
        }

        uint8_t code = is_put ? COAP_CODE_PUT : COAP_CODE_POST;
        ccx_coap_response_arm();
        if (!ccx_send_coap(dst, code, uri, payload, plen)) {
            printf("CoAP TX failed (not joined?)\r\n");
            return;
        }
        printf("CoAP %s %s (%u bytes) → waiting...\r\n", is_put ? "PUT" : "POST", uri, (unsigned)plen);
        for (int i = 0; i < 50; i++) {
            vTaskDelay(pdMS_TO_TICKS(100));
            ccx_coap_response_t resp;
            if (ccx_coap_response_get(&resp)) {
                printf("CoAP response code=%u.%02u mid=0x%04X\r\n",
                       resp.code >> 5, resp.code & 0x1F, resp.msg_id);
                if (resp.payload_len > 0) {
                    printf("Payload (%u bytes):", (unsigned)resp.payload_len);
                    for (size_t k = 0; k < resp.payload_len; k++) printf(" %02X", resp.payload[k]);
                    printf("\r\n");
                }
                return;
            }
        }
        printf("No CoAP response (timeout 5s)\r\n");
        return;
    }

coap_usage:
    printf("Usage: ccx coap <command> ...\r\n");
    printf("  ccx coap led <addr> <active_0-255> <inactive_0-255>\r\n");
    printf("    Set keypad LED brightness (AHA bucket)\r\n");
    printf("    Example: ccx coap led fe80:... 229 25\r\n");
    printf("  ccx coap trim <addr> <high%%> <low%%>\r\n");
    printf("    Set dimmer trim (AAI bucket)\r\n");
    printf("    Example: ccx coap trim fe80:... 90.0 1.0\r\n");
    printf("  ccx coap preset <addr> <dev_id> <preset_id> <level%%> [fade_s]\r\n");
    printf("    Program a preset level on a device\r\n");
    printf("    Example: ccx coap preset fe80:... 0x07FE 72 75 1.0\r\n");
    printf("  ccx coap get <addr> <uri_path>\r\n");
    printf("    Read a CoAP resource\r\n");
    printf("  ccx coap delete <addr> <uri_path>\r\n");
    printf("    Delete a CoAP resource\r\n");
    printf("  ccx coap put <addr> <uri_path> <payload_hex>\r\n");
    printf("    Write raw CBOR to a CoAP resource (PUT)\r\n");
    printf("  ccx coap post <addr> <uri_path> <payload_hex>\r\n");
    printf("    Write raw CBOR to a CoAP resource (POST)\r\n");
    printf("  addr: IPv6, rloc:XXXX (hex), or serial:NNN (decimal)\r\n");
}

static void cmd_ccx(const char* arg)
{
    if (strlen(arg) == 0) {
        /* ccx — status */
        if (!ccx_is_running()) {
            printf("CCX task not running\r\n");
            return;
        }
        printf("Thread role: %s\r\n", ccx_thread_role_str());
        printf("RX: %lu  TX: %lu  RAW: %lu\r\n", (unsigned long)ccx_rx_count(), (unsigned long)ccx_tx_count(), (unsigned long)ccx_raw_rx_count());
        printf("RX log: %s\r\n", ccx_rx_log_enabled() ? "ON" : "OFF");
        printf("Promiscuous: %s\r\n", ccx_promiscuous_enabled() ? "ON" : "OFF");
        return;
    }

    if (strcmp(arg, "promisc on") == 0 || strcmp(arg, "promisc") == 0) {
        if (ccx_set_promiscuous(true)) {
            printf("Promiscuous mode enabled (raw frames → stream)\r\n");
        } else {
            printf("Failed to enable promiscuous mode\r\n");
        }
        return;
    }

    if (strcmp(arg, "promisc off") == 0) {
        if (ccx_set_promiscuous(false)) {
            printf("Promiscuous mode disabled\r\n");
        } else {
            printf("Failed to disable promiscuous mode\r\n");
        }
        return;
    }

    if (strcmp(arg, "log") == 0) {
        printf("CCX RX log: %s\r\n", ccx_rx_log_enabled() ? "ON" : "OFF");
        return;
    }

    if (strcmp(arg, "log on") == 0) {
        ccx_set_rx_log_enabled(true);
        printf("CCX RX log enabled\r\n");
        return;
    }

    if (strcmp(arg, "log off") == 0) {
        ccx_set_rx_log_enabled(false);
        printf("CCX RX log disabled\r\n");
        return;
    }

    if (strncmp(arg, "on ", 3) == 0) {
        uint16_t zone = (uint16_t)strtoul(arg + 3, NULL, 10);
        if (zone == 0) {
            printf("Usage: ccx on <zone>\r\n");
            return;
        }
        if (ccx_send_on(zone, 0)) {
            printf("CCX ON zone=%u queued\r\n", zone);
        }
        else {
            printf("CCX TX failed (not joined?)\r\n");
        }
    }
    else if (strncmp(arg, "off ", 4) == 0) {
        uint16_t zone = (uint16_t)strtoul(arg + 4, NULL, 10);
        if (zone == 0) {
            printf("Usage: ccx off <zone>\r\n");
            return;
        }
        if (ccx_send_off(zone, 0)) {
            printf("CCX OFF zone=%u queued\r\n", zone);
        }
        else {
            printf("CCX TX failed (not joined?)\r\n");
        }
    }
    else if (strncmp(arg, "level ", 6) == 0) {
        /* ccx level <zone> <0-100> */
        char*    endptr;
        uint16_t zone = (uint16_t)strtoul(arg + 6, &endptr, 10);
        if (zone == 0 || *endptr != ' ') {
            printf("Usage: ccx level <zone> <0-100>\r\n");
            return;
        }
        uint8_t  pct = (uint8_t)strtoul(endptr + 1, NULL, 10);
        uint16_t level = ccx_percent_to_level(pct);
        if (ccx_send_level(zone, level, 1, 0)) {
            printf("CCX LEVEL zone=%u %u%% (0x%04X) queued\r\n", zone, pct, level);
        }
        else {
            printf("CCX TX failed (not joined?)\r\n");
        }
    }
    else if (strncmp(arg, "scene ", 6) == 0) {
        uint16_t scene = (uint16_t)strtoul(arg + 6, NULL, 10);
        if (scene == 0) {
            printf("Usage: ccx scene <id>\r\n");
            return;
        }
        if (ccx_send_scene(scene, 0)) {
            printf("CCX SCENE %u queued\r\n", scene);
        }
        else {
            printf("CCX TX failed (not joined?)\r\n");
        }
    }
    else if (strcmp(arg, "peers") == 0) {
        size_t count = ccx_peer_count();
        if (count == 0) {
            printf("No peers seen yet (enable RX log and wait for traffic)\r\n");
            return;
        }
        printf("%-8s %-12s %-12s %-16s %s\r\n", "RLOC16", "Serial", "DeviceID", "LastMsg", "Age");
        for (size_t i = 0; i < count; i++) {
            uint16_t rloc16;
            uint32_t serial;
            uint8_t  dev_id[4];
            uint16_t last_msg;
            uint32_t age_ms;
            if (!ccx_peer_get(i, &rloc16, &serial, dev_id, &last_msg, &age_ms)) continue;

            char serial_str[16] = "-";
            if (serial != 0) snprintf(serial_str, sizeof(serial_str), "%lu", (unsigned long)serial);

            char devid_str[16] = "-";
            if (dev_id[0] || dev_id[1] || dev_id[2] || dev_id[3]) {
                snprintf(devid_str, sizeof(devid_str), "%02X%02X%02X%02X",
                         dev_id[0], dev_id[1], dev_id[2], dev_id[3]);
            }

            const char* msg_name = ccx_msg_type_name(last_msg);

            uint32_t age_s = age_ms / 1000;
            char age_str[16];
            if (age_s < 60) snprintf(age_str, sizeof(age_str), "%lus", (unsigned long)age_s);
            else if (age_s < 3600) snprintf(age_str, sizeof(age_str), "%lum", (unsigned long)(age_s / 60));
            else snprintf(age_str, sizeof(age_str), "%luh", (unsigned long)(age_s / 3600));

            printf("0x%04X   %-12s %-12s %-16s %s\r\n", rloc16, serial_str, devid_str, msg_name, age_str);
        }
    }
    else if (strcmp(arg, "coap") == 0) {
        cmd_ccx_coap("");
    }
    else if (strncmp(arg, "coap ", 5) == 0) {
        cmd_ccx_coap(arg + 5);
    }
    else if (strncmp(arg, "discover ", 9) == 0) {
        /* ccx discover <secondary-ml-eid> — TMF Address Query */
        uint8_t addr[16];
        if (!parse_ipv6_addr(arg + 9, addr)) {
            printf("Usage: ccx discover <secondary-ml-eid-ipv6>\r\n");
            printf("  e.g. ccx discover fd00:0000:0000:0000:3c2e:f5ff:fef9:73f9\r\n");
            return;
        }
        if (!ccx_send_address_query(addr)) {
            printf("Failed to enqueue address query (not joined?)\r\n");
            return;
        }
        /* Wait up to 3 seconds for response */
        printf("Waiting for Address Notification...\r\n");
        for (int i = 0; i < 30; i++) {
            vTaskDelay(pdMS_TO_TICKS(100));
            ccx_address_result_t result;
            if (ccx_get_address_result(&result)) {
                printf("Primary ML-EID IID: ");
                for (int j = 0; j < 8; j += 2) {
                    if (j > 0) printf(":");
                    printf("%02x%02x", result.ml_eid[j], result.ml_eid[j + 1]);
                }
                printf("\r\nRLOC16: 0x%04X\r\n", result.rloc16);
                return;
            }
        }
        printf("No response (device may be offline or address not in mesh)\r\n");
    }
    else {
        printf("Usage: ccx [log|on|off|level|scene|coap|peers|discover] ...\r\n");
        printf("  ccx             — Thread status\r\n");
        printf("  ccx log         — show CCX RX log state\r\n");
        printf("  ccx log on|off  — enable/disable CCX RX UART logs\r\n");
        printf("  ccx on <zone>   — send ON to zone\r\n");
        printf("  ccx off <zone>  — send OFF to zone\r\n");
        printf("  ccx level <zone> <0-100> — set level %%\r\n");
        printf("  ccx scene <id>  — recall scene\r\n");
        printf("  ccx peers       — list known Thread peers (RLOC → serial)\r\n");
        printf("  ccx coap ...    — CoAP device programming\r\n");
        printf("  ccx discover <addr> — TMF Address Query (secondary → primary ML-EID)\r\n");
    }
}

/* -----------------------------------------------------------------------
 * ot — Human-readable OpenThread CLI-like commands
 * ----------------------------------------------------------------------- */
static const char* ot_role_name(uint8_t role)
{
    switch (role) {
    case 0:
        return "detached";
    case 1:
        return "child";
    case 2:
        return "router";
    case 3:
        return "leader";
    default:
        return "unknown";
    }
}

static void cmd_ot(const char* arg)
{
    if (!ccx_is_running()) {
        printf("CCX task not running\r\n");
        return;
    }

    ccx_spinel_request_t  req;
    ccx_spinel_response_t resp;
    memset(&req, 0, sizeof(req));

    /* ot (no args) — summary: role + channel + panid */
    if (strlen(arg) == 0) {
        /* Role */
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = 0x43;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len >= 1) {
            printf("Role: %s\r\n", ot_role_name(resp.data[0]));
        }
        else {
            printf("Role: (error)\r\n");
        }

        /* Channel */
        req.prop_id = 0x21;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len >= 1) {
            printf("Channel: %u\r\n", resp.data[0]);
        }
        else {
            printf("Channel: (error)\r\n");
        }

        /* PAN ID */
        req.prop_id = 0x36;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len >= 2) {
            uint16_t panid = (uint16_t)resp.data[0] | ((uint16_t)resp.data[1] << 8);
            printf("PAN ID: 0x%04X\r\n", panid);
        }
        else {
            printf("PAN ID: (error)\r\n");
        }
        return;
    }

    /* ot channel / ot channel <n> */
    if (strcmp(arg, "channel") == 0) {
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = 0x21;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len >= 1) {
            printf("Channel: %u\r\n", resp.data[0]);
        }
        else {
            printf("Error reading channel\r\n");
        }
        return;
    }
    if (strncmp(arg, "channel ", 8) == 0) {
        uint8_t chan = (uint8_t)strtoul(arg + 8, NULL, 10);
        req.cmd_type = CCX_SPINEL_PROP_SET;
        req.prop_id = 0x21;
        req.value[0] = chan;
        req.value_len = 1;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success) {
            printf("Channel set to %u\r\n", chan);
        }
        else {
            printf("Error setting channel\r\n");
        }
        return;
    }

    /* ot panid / ot panid <hex> */
    if (strcmp(arg, "panid") == 0) {
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = 0x36;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len >= 2) {
            uint16_t panid = (uint16_t)resp.data[0] | ((uint16_t)resp.data[1] << 8);
            printf("PAN ID: 0x%04X\r\n", panid);
        }
        else {
            printf("Error reading PAN ID\r\n");
        }
        return;
    }
    if (strncmp(arg, "panid ", 6) == 0) {
        uint16_t panid = (uint16_t)strtoul(arg + 6, NULL, 16);
        req.cmd_type = CCX_SPINEL_PROP_SET;
        req.prop_id = 0x36;
        req.value[0] = (uint8_t)(panid & 0xFF);
        req.value[1] = (uint8_t)(panid >> 8);
        req.value_len = 2;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success) {
            printf("PAN ID set to 0x%04X\r\n", panid);
        }
        else {
            printf("Error setting PAN ID\r\n");
        }
        return;
    }

    /* ot role */
    if (strcmp(arg, "role") == 0) {
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = 0x43;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len >= 1) {
            printf("%s\r\n", ot_role_name(resp.data[0]));
        }
        else {
            printf("Error reading role\r\n");
        }
        return;
    }

    /* ot networkname */
    if (strcmp(arg, "networkname") == 0) {
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = 0x44;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len > 0) {
            /* Null-terminate the string */
            size_t slen = resp.data_len;
            if (slen >= sizeof(resp.data)) slen = sizeof(resp.data) - 1;
            resp.data[slen] = '\0';
            printf("%s\r\n", (char*)resp.data);
        }
        else {
            printf("Error reading network name\r\n");
        }
        return;
    }

    /* ot extpanid */
    if (strcmp(arg, "extpanid") == 0) {
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = 0x45;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len >= 8) {
            for (size_t i = 0; i < 8; i++) {
                printf("%02x", resp.data[i]);
            }
            printf("\r\n");
        }
        else {
            printf("Error reading extended PAN ID\r\n");
        }
        return;
    }

    /* ot networkkey */
    if (strcmp(arg, "networkkey") == 0) {
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = 0x46;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len >= 16) {
            for (size_t i = 0; i < 16; i++) {
                printf("%02x", resp.data[i]);
            }
            printf("\r\n");
        }
        else {
            printf("Error reading network key\r\n");
        }
        return;
    }

    /* ot eui64 */
    if (strcmp(arg, "eui64") == 0) {
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = 0x08;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len >= 8) {
            for (size_t i = 0; i < 8; i++) {
                if (i > 0) printf(":");
                printf("%02x", resp.data[i]);
            }
            printf("\r\n");
        }
        else {
            printf("Error reading EUI-64\r\n");
        }
        return;
    }

    /* ot ipaddr */
    if (strcmp(arg, "ipaddr") == 0) {
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = 0x63;
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success && resp.data_len > 0) {
            printf("IPv6 address table (%u bytes):\r\n", (unsigned)resp.data_len);
            /* Each entry: struct { IPv6[16], prefix_len[1], preferred_lifetime[4],
             *                      valid_lifetime[4], flags[1] } = 26 bytes,
             * but Spinel wraps each in a 't(...)' with a 2-byte length prefix. */
            size_t offset = 0;
            while (offset + 2 < resp.data_len) {
                uint16_t entry_len = (uint16_t)resp.data[offset] | ((uint16_t)resp.data[offset + 1] << 8);
                offset += 2;
                if (entry_len >= 16 && offset + entry_len <= resp.data_len) {
                    const uint8_t* a = &resp.data[offset];
                    printf("  %02x%02x:%02x%02x:%02x%02x:%02x%02x:"
                           "%02x%02x:%02x%02x:%02x%02x:%02x%02x\r\n",
                           a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], a[12], a[13],
                           a[14], a[15]);
                }
                offset += entry_len;
            }
        }
        else {
            printf("Error reading IPv6 addresses\r\n");
        }
        return;
    }

    /* ot ifconfig up|down */
    if (strncmp(arg, "ifconfig ", 9) == 0) {
        const char* subcmd = arg + 9;
        req.cmd_type = CCX_SPINEL_PROP_SET;
        req.prop_id = 0x41;
        req.value_len = 1;
        if (strcmp(subcmd, "up") == 0) {
            req.value[0] = 1;
        }
        else if (strcmp(subcmd, "down") == 0) {
            req.value[0] = 0;
        }
        else {
            printf("Usage: ot ifconfig up|down\r\n");
            return;
        }
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success) {
            printf("Interface %s\r\n", req.value[0] ? "up" : "down");
        }
        else {
            printf("Error setting interface state\r\n");
        }
        return;
    }

    /* ot thread start|stop */
    if (strncmp(arg, "thread ", 7) == 0) {
        const char* subcmd = arg + 7;
        req.cmd_type = CCX_SPINEL_PROP_SET;
        req.prop_id = 0x42;
        req.value_len = 1;
        if (strcmp(subcmd, "start") == 0) {
            req.value[0] = 1;
        }
        else if (strcmp(subcmd, "stop") == 0) {
            req.value[0] = 0;
        }
        else {
            printf("Usage: ot thread start|stop\r\n");
            return;
        }
        if (ccx_spinel_command(&req, &resp, 5000) && resp.success) {
            printf("Thread %s\r\n", req.value[0] ? "started" : "stopped");
        }
        else {
            printf("Error setting Thread stack state\r\n");
        }
        return;
    }

    printf("Usage: ot [channel|panid|role|networkname|extpanid|networkkey|\r\n"
           "          eui64|ipaddr|ifconfig|thread]\r\n");
}

/* -----------------------------------------------------------------------
 * spinel — Raw Spinel property access for low-level debugging
 * ----------------------------------------------------------------------- */
static size_t hex_to_bytes_spaced(const char* hex, uint8_t* out, size_t max_len)
{
    /* Parse hex bytes separated by spaces or concatenated pairs.
     * Accepts: "7E 02 21" or "7E0221" */
    size_t count = 0;
    while (*hex && count < max_len) {
        while (*hex == ' ') hex++;
        if (*hex == '\0') break;
        char byte_str[3] = {0};
        byte_str[0] = *hex++;
        if (*hex == '\0') break; /* incomplete nibble */
        byte_str[1] = *hex++;
        out[count++] = (uint8_t)strtoul(byte_str, NULL, 16);
    }
    return count;
}

static void cmd_spinel(const char* arg)
{
    if (!ccx_is_running()) {
        printf("CCX task not running\r\n");
        return;
    }

    ccx_spinel_request_t  req;
    ccx_spinel_response_t resp;
    memset(&req, 0, sizeof(req));

    /* spinel get <prop_hex> */
    if (strncmp(arg, "get ", 4) == 0) {
        req.cmd_type = CCX_SPINEL_PROP_GET;
        req.prop_id = (uint8_t)strtoul(arg + 4, NULL, 16);
        if (ccx_spinel_command(&req, &resp, 5000)) {
            if (resp.success) {
                printf("PROP 0x%02X (%u bytes):", req.prop_id, (unsigned)resp.data_len);
                for (size_t i = 0; i < resp.data_len; i++) {
                    printf(" %02X", resp.data[i]);
                }
                printf("\r\n");
            }
            else {
                printf("PROP_GET 0x%02X failed\r\n", req.prop_id);
            }
        }
        else {
            printf("Timeout\r\n");
        }
        return;
    }

    /* spinel set <prop_hex> <value_hex> */
    if (strncmp(arg, "set ", 4) == 0) {
        char* endptr;
        req.cmd_type = CCX_SPINEL_PROP_SET;
        req.prop_id = (uint8_t)strtoul(arg + 4, &endptr, 16);
        while (*endptr == ' ') endptr++;
        req.value_len = hex_to_bytes_spaced(endptr, req.value, sizeof(req.value));
        if (req.value_len == 0) {
            printf("Usage: spinel set <prop_hex> <value_hex>\r\n");
            return;
        }
        if (ccx_spinel_command(&req, &resp, 5000)) {
            printf("PROP_SET 0x%02X: %s\r\n", req.prop_id, resp.success ? "OK" : "FAILED");
        }
        else {
            printf("Timeout\r\n");
        }
        return;
    }

    /* spinel insert <prop_hex> <value_hex> */
    if (strncmp(arg, "insert ", 7) == 0) {
        char* endptr;
        req.cmd_type = CCX_SPINEL_PROP_INSERT;
        req.prop_id = (uint8_t)strtoul(arg + 7, &endptr, 16);
        while (*endptr == ' ') endptr++;
        req.value_len = hex_to_bytes_spaced(endptr, req.value, sizeof(req.value));
        if (req.value_len == 0) {
            printf("Usage: spinel insert <prop_hex> <value_hex>\r\n");
            return;
        }
        if (ccx_spinel_command(&req, &resp, 5000)) {
            printf("PROP_INSERT 0x%02X: %s\r\n", req.prop_id, resp.success ? "OK" : "FAILED");
        }
        else {
            printf("Timeout\r\n");
        }
        return;
    }

    /* spinel raw <frame_hex> */
    if (strncmp(arg, "raw ", 4) == 0) {
        req.cmd_type = CCX_SPINEL_RAW;
        req.value_len = hex_to_bytes_spaced(arg + 4, req.value, sizeof(req.value));
        if (req.value_len == 0) {
            printf("Usage: spinel raw <frame_hex>\r\n");
            return;
        }
        if (ccx_spinel_command(&req, &resp, 5000)) {
            if (resp.success) {
                printf("Response (%u bytes):", (unsigned)resp.data_len);
                for (size_t i = 0; i < resp.data_len; i++) {
                    printf(" %02X", resp.data[i]);
                }
                printf("\r\n");
            }
            else {
                printf("No response\r\n");
            }
        }
        else {
            printf("Timeout\r\n");
        }
        return;
    }

    printf("Usage: spinel get|set|insert|reset|raw ...\r\n");
    printf("  spinel get <prop>           — GET property (hex ID)\r\n");
    printf("  spinel set <prop> <val>     — SET property\r\n");
    printf("  spinel insert <prop> <val>  — INSERT property\r\n");
    printf("  spinel reset                — send NCP RESET\r\n");
    printf("  spinel raw <frame>          — send raw HDLC frame\r\n");
}

static void cmd_help(void)
{
    printf("Commands:\r\n");
    printf("  status       — system status\r\n");
    printf("  rx on|off    — enable/disable CCA RX\r\n");
    printf("  tx <hex>     — transmit raw CCA packet\r\n");
    printf("  cca [cmd]    — CCA commands (button, tune, level, etc.)\r\n");
    printf("  ccx [cmd]    — CCX Thread control\r\n");
    printf("  stream [cmd] — packet stream/log transport\r\n");
    printf("  ot [cmd]     — OpenThread NCP query/control\r\n");
    printf("  spinel [cmd] — raw Spinel property access\r\n");
    printf("  eth          — Ethernet PHY debug\r\n");
    printf("  config       — show stored settings\r\n");
    printf("  save         — save settings to flash\r\n");
    printf("  reboot       — reset MCU\r\n");
    printf("  help         — this message\r\n");
}

/* -----------------------------------------------------------------------
 * Execute a single shell command line.
 * Called from the UART shell task and from UDP text passthrough.
 * ----------------------------------------------------------------------- */
void shell_execute(const char* line)
{
    if (strcmp(line, "status") == 0) {
        cmd_status();
    }
    else if (strcmp(line, "help") == 0) {
        cmd_help();
    }
    else if (strcmp(line, "clear") == 0) {
        printf("\033[2J\033[3J\033[H");
        fflush(stdout);
    }
    else if (strcmp(line, "config") == 0) {
        flash_store_print();
    }
    else if (strcmp(line, "save") == 0) {
        if (flash_store_save()) {
            printf("Settings saved to flash\r\n");
        }
        else {
            printf("Save FAILED\r\n");
        }
    }
    else if (strcmp(line, "reboot") == 0) {
        printf("Rebooting...\r\n");
        HAL_Delay(100);
        NVIC_SystemReset();
    }
    else if (strncmp(line, "tx ", 3) == 0) {
        cmd_tx(line + 3);
    }
    else if (strcmp(line, "tdma") == 0) {
        cmd_tdma("");
    }
    else if (strncmp(line, "tdma ", 5) == 0) {
        cmd_tdma(line + 5);
    }
    else if (strcmp(line, "cca") == 0) {
        cmd_cca("");
    }
    else if (strncmp(line, "cca ", 4) == 0) {
        cmd_cca(line + 4);
    }
    else if (strcmp(line, "eth") == 0) {
        cmd_eth();
    }
    else if (strncmp(line, "rx ", 3) == 0) {
        cmd_rx(line + 3);
    }
    else if (strcmp(line, "ccx") == 0) {
        cmd_ccx("");
    }
    else if (strncmp(line, "ccx ", 4) == 0) {
        cmd_ccx(line + 4);
    }
    else if (strcmp(line, "stream") == 0) {
        cmd_stream("");
    }
    else if (strncmp(line, "stream ", 7) == 0) {
        cmd_stream(line + 7);
    }
    else if (strcmp(line, "ot") == 0) {
        cmd_ot("");
    }
    else if (strncmp(line, "ot ", 3) == 0) {
        cmd_ot(line + 3);
    }
    else if (strncmp(line, "spinel ", 7) == 0) {
        cmd_spinel(line + 7);
    }
    else if (strcmp(line, "spinel") == 0) {
        cmd_spinel("");
    }
    else {
        printf("Unknown command: '%s' (type 'help')\r\n", line);
    }
}

/* -----------------------------------------------------------------------
 * Shell task
 * ----------------------------------------------------------------------- */
static void shell_task_func(void* param)
{
    (void)param;

    printf("\r\n");
    printf("========================================\r\n");
    printf("  Nucleo H723ZG — CCA/CCX Coordinator\r\n");
    printf("========================================\r\n");
    printf("Type 'help' for commands.\r\n\r\n");

    char cmd_buf[CMD_BUF_SIZE];

    for (;;) {
        watchdog_feed();
        size_t len = shell_readline(cmd_buf, sizeof(cmd_buf));
        if (len == 0) continue;

        /* Add to history */
        hist_add(cmd_buf);

        /* Parse and execute command */
        shell_execute(cmd_buf);
    }
}

void shell_task_start(void)
{
    xTaskCreate(shell_task_func, "Shell", SHELL_TASK_STACK_SIZE, NULL, SHELL_TASK_PRIORITY, NULL);
}
