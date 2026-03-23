/**
 * CC1101 radio driver — STM32 HAL SPI implementation.
 *
 * Simple linear-accumulation RX with hardware sync detection.
 *
 * Design:
 *   - One packet at a time: sync detect → accumulate → deliver → restart
 *   - Linear buffer (no ring) — minimal state, predictable behavior
 *   - Type peek at bit 30 after verifying FF FA DE prefix
 *   - FIFO drained every 2ms by cca_task — well within 64-byte limit
 *   - Clean restart between packets (~0.5ms idle+flush+SRX)
 */

#include "cc1101.h"
#include "bsp.h"
#include <stdio.h>
#include <string.h>

/* -----------------------------------------------------------------------
 * Accumulation buffer — FIFO drains here, one packet at a time
 * ----------------------------------------------------------------------- */
#define RX_PKT_LEN       80 /* fixed-length RX: covers all CCA packet types */
#define ACCUM_TIMEOUT_MS 25 /* max time to accumulate one packet      */

/* -----------------------------------------------------------------------
 * Private state
 * ----------------------------------------------------------------------- */
static bool                 initialized_ = false;
static bool                 rx_active_ = false;
static cc1101_rx_callback_t rx_callback_ = NULL;

static uint8_t  accum_[RX_PKT_LEN + 4]; /* +4 margin */
static size_t   accum_len_ = 0;
static bool     accum_active_ = false;
static uint32_t accum_start_ms_ = 0;
static int8_t   accum_rssi_ = 0;

/* Counters */
static uint32_t overflow_count_ = 0;
static uint32_t runt_count_ = 0;
static uint32_t short_packet_count_ = 0;
static uint32_t timeout_count_ = 0;
static uint32_t restart_manual_count_ = 0;
static uint32_t restart_overflow_count_ = 0;
static uint32_t peek_hit_count_ = 0;
static uint32_t peek_miss_count_ = 0;

/* -----------------------------------------------------------------------
 * Microsecond delay via DWT cycle counter
 * ----------------------------------------------------------------------- */
static inline void delay_us(uint32_t us)
{
    uint32_t start = DWT->CYCCNT;
    uint32_t cycles = us * (SystemCoreClock / 1000000);
    while ((DWT->CYCCNT - start) < cycles);
}

/* -----------------------------------------------------------------------
 * SPI primitives
 * ----------------------------------------------------------------------- */
static inline void spi_enable(void)
{
    HAL_GPIO_WritePin(CC1101_CS_PORT, CC1101_CS_PIN, GPIO_PIN_RESET);
}
static inline void spi_disable(void)
{
    HAL_GPIO_WritePin(CC1101_CS_PORT, CC1101_CS_PIN, GPIO_PIN_SET);
}

static inline uint8_t spi_transfer(uint8_t data)
{
    uint8_t rx;
    HAL_SPI_TransmitReceive(&hspi3, &data, &rx, 1, 10);
    return rx;
}

void cc1101_strobe(uint8_t cmd)
{
    spi_enable();
    spi_transfer(cmd);
    spi_disable();
}

void cc1101_write_register(uint8_t reg, uint8_t value)
{
    spi_enable();
    spi_transfer(reg | CC1101_WRITE_SINGLE);
    spi_transfer(value);
    spi_disable();
}

uint8_t cc1101_read_register(uint8_t reg)
{
    spi_enable();
    spi_transfer(reg | CC1101_READ_SINGLE);
    uint8_t value = spi_transfer(0);
    spi_disable();
    return value;
}

uint8_t cc1101_read_status_register(uint8_t reg)
{
    spi_enable();
    spi_transfer(reg | CC1101_READ_BURST);
    uint8_t value = spi_transfer(0);
    spi_disable();
    return value;
}

void cc1101_write_burst(uint8_t reg, const uint8_t* data, size_t len)
{
    spi_enable();
    spi_transfer(reg | CC1101_WRITE_BURST);
    for (size_t i = 0; i < len; i++) {
        spi_transfer(data[i]);
        if ((i + 1) % 16 == 0 && i + 1 < len) delay_us(10);
    }
    spi_disable();
}

void cc1101_read_burst(uint8_t reg, uint8_t* data, size_t len)
{
    spi_enable();
    spi_transfer(reg | CC1101_READ_BURST);
    if (len <= 64) {
        uint8_t tx_zeros[64] = {0};
        HAL_SPI_TransmitReceive(&hspi3, tx_zeros, data, (uint16_t)len, 10);
    }
    else {
        for (size_t i = 0; i < len; i++) data[i] = spi_transfer(0);
    }
    spi_disable();
}

/* -----------------------------------------------------------------------
 * Radio control
 * ----------------------------------------------------------------------- */
void cc1101_set_idle(void)
{
    cc1101_strobe(CC1101_SIDLE);
}
void cc1101_flush_rx(void)
{
    cc1101_strobe(CC1101_SFRX);
}
void cc1101_flush_tx(void)
{
    cc1101_strobe(CC1101_SFTX);
}
uint8_t cc1101_get_state(void)
{
    return cc1101_read_status_register(CC1101_MARCSTATE) & 0x1F;
}
uint8_t cc1101_get_tx_bytes(void)
{
    return cc1101_read_status_register(CC1101_TXBYTES) & 0x7F;
}
uint8_t cc1101_get_rx_bytes(void)
{
    return cc1101_read_status_register(CC1101_RXBYTES) & 0x7F;
}

/** Double-read RXBYTES to avoid SPI glitches */
static uint8_t cc1101_read_rxbytes_safe(void)
{
    uint8_t a = cc1101_read_status_register(CC1101_RXBYTES);
    uint8_t b = cc1101_read_status_register(CC1101_RXBYTES);
    if (a == b) return a;
    uint8_t c = cc1101_read_status_register(CC1101_RXBYTES);
    if (b == c) return b;
    return a;
}

/* -----------------------------------------------------------------------
 * Counter getters
 * ----------------------------------------------------------------------- */
bool cc1101_is_initialized(void)
{
    return initialized_;
}
bool cc1101_is_rx_active(void)
{
    return rx_active_;
}
uint32_t cc1101_overflow_count(void)
{
    return overflow_count_;
}
uint32_t cc1101_runt_count(void)
{
    return runt_count_;
}
uint32_t cc1101_short_packet_count(void)
{
    return short_packet_count_;
}

uint32_t cc1101_rx_restart_timeout_count(void)
{
    return timeout_count_;
}
uint32_t cc1101_rx_restart_overflow_count(void)
{
    return restart_overflow_count_;
}
uint32_t cc1101_rx_restart_manual_count(void)
{
    return restart_manual_count_;
}
uint32_t cc1101_rx_restart_packet_count(void)
{
    return 0;
} /* no ring bail-outs */

uint32_t cc1101_sync_peek_hit_count(void)
{
    return peek_hit_count_;
}
uint32_t cc1101_sync_peek_miss_count(void)
{
    return peek_miss_count_;
}

/* Ring buffer removed — stubs return 0 */
uint32_t cc1101_ring_bytes_in_count(void)
{
    return 0;
}
uint32_t cc1101_ring_bytes_dropped_count(void)
{
    return 0;
}
uint32_t cc1101_ring_max_occupancy(void)
{
    return 0;
}
uint32_t cc1101_ring_current_occupancy(void)
{
    return 0;
}

void cc1101_set_rx_callback(cc1101_rx_callback_t callback)
{
    rx_callback_ = callback;
}

void cc1101_reset_counters(void)
{
    overflow_count_ = 0;
    runt_count_ = 0;
    short_packet_count_ = 0;
    timeout_count_ = 0;
    restart_manual_count_ = 0;
    restart_overflow_count_ = 0;
    peek_hit_count_ = 0;
    peek_miss_count_ = 0;
}

/* -----------------------------------------------------------------------
 * Tuning stubs — API surface preserved for shell.cpp compatibility
 * ----------------------------------------------------------------------- */
static cc1101_tune_profile_t   tune_profile_ = CC1101_TUNE_PROFILE_DEFAULT;
static cc1101_runtime_tuning_t runtime_tuning_ = {
    .fifo_drain_passes = 1,
    .max_packets_per_check = 1,
    .sync_miss_bail_streak = 0,
    .sync_miss_bail_ring = 0,
    .stale_timeout_ms = 25,
    .fifothr = 0x07,
};

void cc1101_get_runtime_tuning(cc1101_runtime_tuning_t* out)
{
    if (out) *out = runtime_tuning_;
}

bool cc1101_set_runtime_tuning(const cc1101_runtime_tuning_t* in)
{
    if (!in || in->fifothr > 0x0F) return false;
    runtime_tuning_ = *in;
    tune_profile_ = CC1101_TUNE_PROFILE_CUSTOM;
    if (initialized_) cc1101_write_register(CC1101_FIFOTHR, in->fifothr);
    return true;
}

bool cc1101_apply_tune_profile(cc1101_tune_profile_t profile)
{
    tune_profile_ = (profile <= CC1101_TUNE_PROFILE_CUSTOM) ? profile : CC1101_TUNE_PROFILE_DEFAULT;
    return true;
}

cc1101_tune_profile_t cc1101_get_tune_profile(void)
{
    return tune_profile_;
}

const char* cc1101_tune_profile_name(cc1101_tune_profile_t profile)
{
    switch (profile) {
    case CC1101_TUNE_PROFILE_DEFAULT:
        return "default";
    case CC1101_TUNE_PROFILE_BURST:
        return "burst";
    case CC1101_TUNE_PROFILE_NOISY:
        return "noisy";
    case CC1101_TUNE_PROFILE_CUSTOM:
        return "custom";
    default:
        return "unknown";
    }
}

/* -----------------------------------------------------------------------
 * Reset & Init
 * ----------------------------------------------------------------------- */
void cc1101_reset(void)
{
    spi_disable();
    delay_us(5);
    spi_enable();
    delay_us(10);
    spi_disable();
    delay_us(45);
    cc1101_strobe(CC1101_SRES);
    HAL_Delay(10);
}

void cc1101_init(void)
{
    cc1101_reset();
    HAL_Delay(10);

    uint8_t version = cc1101_read_status_register(0x31);
    if (version != 0x14) return;

    cc1101_strobe(CC1101_SIDLE);
    HAL_Delay(1);

    /* Frequency: 433.602844 MHz */
    cc1101_write_register(CC1101_FREQ2, 0x10);
    cc1101_write_register(CC1101_FREQ1, 0xAD);
    cc1101_write_register(CC1101_FREQ0, 0x52);

    /* Modem: 2-FSK, 19200 baud, ~25kHz deviation */
    cc1101_write_register(CC1101_MDMCFG4, 0x5B);
    cc1101_write_register(CC1101_MDMCFG3, 0x3B);
    cc1101_write_register(CC1101_MDMCFG2, 0x00); /* no sync for TX mode */
    cc1101_write_register(CC1101_MDMCFG1, 0x00);
    cc1101_write_register(CC1101_MDMCFG0, 0x00);
    cc1101_write_register(CC1101_DEVIATN, 0x45);

    /* Sync word: 0x7FCB (CCA preamble) */
    cc1101_write_register(CC1101_SYNC1, 0x7F);
    cc1101_write_register(CC1101_SYNC0, 0xCB);

    /* Packet: infinite length, no addr check */
    cc1101_write_register(CC1101_PKTCTRL1, 0x00);
    cc1101_write_register(CC1101_PKTCTRL0, 0x00);
    cc1101_write_register(CC1101_ADDR, 0x00);
    cc1101_write_register(CC1101_CHANNR, 0x00);

    /* Frequency synthesizer */
    /* === Lutron RE change #3: IF=380kHz for better image rejection === */
    cc1101_write_register(CC1101_FSCTRL1, 0x0F);
    cc1101_write_register(CC1101_FSCTRL0, 0x00);

    /* Auto-calibration on IDLE→RX/TX, stay in RX after RX */
    cc1101_write_register(CC1101_MCSM1, 0x03);
    cc1101_write_register(CC1101_MCSM0, 0x18);

    /* AGC */
    cc1101_write_register(CC1101_AGCCTRL2, 0x43);
    cc1101_write_register(CC1101_AGCCTRL1, 0x40);
    cc1101_write_register(CC1101_AGCCTRL0, 0xFF);

    /* Frequency offset compensation & bit sync */
    cc1101_write_register(CC1101_FOCCFG, 0x16);
    cc1101_write_register(CC1101_BSCFG, 0x6C);

    /* Front-end config */
    cc1101_write_register(CC1101_FREND1, 0x56);
    cc1101_write_register(CC1101_FREND0, 0x10);

    /* Frequency calibration */
    cc1101_write_register(CC1101_FSCAL3, 0xEA);
    cc1101_write_register(CC1101_FSCAL2, 0x2A);
    cc1101_write_register(CC1101_FSCAL1, 0x00);
    cc1101_write_register(CC1101_FSCAL0, 0x1F);

    /* === Lutron RE change #1: Improved RX sensitivity (TEST2=0xAC) === */
    cc1101_write_register(CC1101_TEST2, 0xAC);

    /* === Lutron RE change #2: AGC max hysteresis (AGCCTRL0=0xFF) === */
    /* Holds gain longer, reduces gain hunting on bursty CCA signals */

    /* === Lutron RE change #4: RX terminate on weak signal === */
    cc1101_write_register(CC1101_MCSM2, 0x74);

    /* GDO0/2: sync word detect (0x06) — mirror both for flexible wiring */
    cc1101_write_register(CC1101_IOCFG2, 0x06);
    cc1101_write_register(CC1101_IOCFG0, 0x06);

    /* PA table: +10 dBm */
    uint8_t pa_table[] = {0xC0};
    cc1101_write_burst(CC1101_PATABLE, pa_table, 1);

    initialized_ = true;
}

/* -----------------------------------------------------------------------
 * RX restart — flush and re-enter RX
 * ----------------------------------------------------------------------- */
static void restart_rx(void)
{
    cc1101_set_idle();
    cc1101_flush_rx();
    accum_len_ = 0;
    accum_active_ = false;
    cc1101_strobe(CC1101_SRX);
}

/* -----------------------------------------------------------------------
 * RX start / stop
 *
 * Uses preamble sync (0xAAAA, 15/16 match) + fixed-length mode (80 bytes).
 * The CC1101 locks onto the alternating preamble, then reads 80 bytes
 * of FIFO data containing the packet.  The decoder scans for the 7F CB
 * data sync marker within those 80 bytes.
 * ----------------------------------------------------------------------- */
void cc1101_start_rx(void)
{
    if (!initialized_) return;
    restart_manual_count_++;

    cc1101_set_idle();
    HAL_Delay(1);
    cc1101_flush_rx();

    /* Preamble sync: 0xAAAA matches Lutron's alternating preamble.
     * 15/16 mode is tolerant enough for short preambles. */
    cc1101_write_register(CC1101_SYNC1, 0xAA);
    cc1101_write_register(CC1101_SYNC0, 0xAA);

    /* 2-FSK, 15/16 sync word match */
    cc1101_write_register(CC1101_MDMCFG2, 0x01);

    /* Fixed-length mode, 80 bytes — covers all CCA packet types */
    cc1101_write_register(CC1101_PKTCTRL0, 0x00);
    cc1101_write_register(CC1101_PKTCTRL1, 0x00);
    cc1101_write_register(CC1101_PKTLEN, RX_PKT_LEN);

    /* FIFO threshold (CLOSE_IN_RX=3 breaks our packet-mode RX — keep original) */
    cc1101_write_register(CC1101_FIFOTHR, 0x07);

    /* GDO0: sync word detect (assert) / end of packet (deassert) */
    cc1101_write_register(CC1101_IOCFG0, 0x06);
    cc1101_write_register(CC1101_IOCFG2, 0x06);

    accum_len_ = 0;
    accum_active_ = false;

    cc1101_strobe(CC1101_SCAL);
    HAL_Delay(1);
    cc1101_strobe(CC1101_SRX);
    rx_active_ = true;
}

void cc1101_stop_rx(void)
{
    cc1101_set_idle();
    /* Restore init-time registers for TX */
    cc1101_write_register(CC1101_SYNC1, 0x7F);
    cc1101_write_register(CC1101_SYNC0, 0xCB);
    cc1101_write_register(CC1101_MDMCFG2, 0x00);
    cc1101_write_register(CC1101_PKTCTRL0, 0x00);
    accum_len_ = 0;
    accum_active_ = false;
    rx_active_ = false;
}

/* -----------------------------------------------------------------------
 * cc1101_check_rx — main RX workhorse, called every ~2ms from cca_task
 *
 * With fixed-length mode, the CC1101 fills exactly RX_PKT_LEN bytes
 * after preamble sync detection.  We drain the FIFO incrementally and
 * deliver the full buffer to the decoder once complete.
 *
 * Returns true if a packet was delivered this call.
 * ----------------------------------------------------------------------- */
bool cc1101_check_rx(void)
{
    if (!rx_active_) return false;

    /* 1. Check for FIFO overflow */
    uint8_t rxbytes_raw = cc1101_read_rxbytes_safe();
    if (rxbytes_raw & 0x80) {
        overflow_count_++;
        restart_overflow_count_++;
        restart_rx();
        return false;
    }

    uint8_t avail = rxbytes_raw & 0x7F;

    /* 2. Drain FIFO into accumulation buffer */
    if (avail > 0) {
        if (!accum_active_) {
            accum_active_ = true;
            accum_start_ms_ = HAL_GetTick();
            accum_len_ = 0;
            /* Capture RSSI while signal is present */
            uint8_t rssi_raw = cc1101_read_status_register(CC1101_RSSI_REG);
            accum_rssi_ =
                (rssi_raw >= 128) ? (int8_t)((int16_t)(rssi_raw - 256) / 2 - 74) : (int8_t)(rssi_raw / 2 - 74);
        }

        size_t space = sizeof(accum_) - accum_len_;
        size_t to_read = (avail < space) ? avail : space;
        if (to_read > 0) {
            cc1101_read_burst(CC1101_RXFIFO, accum_ + accum_len_, to_read);
            accum_len_ += to_read;
        }
    }

    /* 3. Nothing accumulated yet — idle, return */
    if (!accum_active_) return false;

    /* 4. Full packet received — deliver to decoder */
    if (accum_len_ >= RX_PKT_LEN) {
        peek_hit_count_++;
        if (rx_callback_) {
            rx_callback_(accum_, accum_len_, accum_rssi_, accum_start_ms_);
        }
        restart_rx();
        return true;
    }

    /* 5. Check accumulation timeout */
    if ((HAL_GetTick() - accum_start_ms_) > ACCUM_TIMEOUT_MS) {
        if (accum_len_ > 0 && accum_len_ < 8) runt_count_++;
        timeout_count_++;
        restart_rx();
        return false;
    }

    /* 6. Still accumulating — will be called again next poll */
    return false;
}

/* -----------------------------------------------------------------------
 * TX
 * ----------------------------------------------------------------------- */
bool cc1101_transmit_raw(const uint8_t* data, size_t len)
{
    if (!initialized_) return false;

    cc1101_write_register(CC1101_MDMCFG2, 0x00); /* no sync for TX */
    cc1101_set_idle();

    uint32_t start = HAL_GetTick();
    while ((cc1101_read_status_register(CC1101_MARCSTATE) & 0x1F) != 0x01) {
        if (HAL_GetTick() - start > 10) break;
        delay_us(100);
    }

    cc1101_flush_rx();
    cc1101_flush_tx();
    HAL_Delay(1);

    if (len <= 64) {
        cc1101_write_register(CC1101_PKTCTRL0, 0x00); /* fixed length */
        cc1101_write_register(CC1101_PKTLEN, (uint8_t)len);
        cc1101_write_burst(CC1101_TXFIFO, data, len);
        cc1101_strobe(CC1101_STX);
    }
    else {
        cc1101_write_register(CC1101_PKTCTRL0, 0x02); /* infinite length */
        cc1101_write_burst(CC1101_TXFIFO, data, 64);
        size_t written = 64;
        cc1101_strobe(CC1101_STX);
        uint32_t start_refill = HAL_GetTick();
        while (written < len) {
            uint8_t tx_r = cc1101_read_status_register(CC1101_TXBYTES);
            if (tx_r & 0x80) break;
            if ((tx_r & 0x7F) < 48) {
                size_t to_w = (len - written < 16) ? len - written : 16;
                cc1101_write_burst(CC1101_TXFIFO, data + written, to_w);
                written += to_w;
            }
            if (HAL_GetTick() - start_refill > 100) break;
            delay_us(10);
        }
    }

    int timeout = 200;
    while (timeout-- > 0) {
        uint8_t s = cc1101_get_state();
        if (s == 0x01 || s == 0x0D || s == 0x0E) break;
        HAL_Delay(1);
    }

    return true;
}
