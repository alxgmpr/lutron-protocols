#ifndef CC1101_H
#define CC1101_H

/**
 * CC1101 radio driver for STM32 HAL SPI.
 * Ported from esphome/custom_components/cc1101_cca/cc1101_radio.h/.cpp
 *
 * Changes from ESPHome version:
 * - Replaced CC1101SPI virtual class with direct HAL_SPI calls
 * - Replaced ESP_LOG* with printf
 * - Replaced delay()/delayMicroseconds() with HAL_Delay()/DWT cycle counter
 * - Removed GPIOPin abstraction, uses direct HAL_GPIO calls
 * - Pure C API (no classes) for ISR and FreeRTOS compatibility
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* -----------------------------------------------------------------------
 * CC1101 Strobe Commands
 * ----------------------------------------------------------------------- */
#define CC1101_SRES 0x30
#define CC1101_SFSTXON 0x31
#define CC1101_SXOFF 0x32
#define CC1101_SCAL 0x33
#define CC1101_SRX 0x34
#define CC1101_STX 0x35
#define CC1101_SIDLE 0x36
#define CC1101_SFRX 0x3A
#define CC1101_SFTX 0x3B
#define CC1101_SNOP 0x3D

/* -----------------------------------------------------------------------
 * CC1101 Registers
 * ----------------------------------------------------------------------- */
#define CC1101_IOCFG2 0x00
#define CC1101_IOCFG1 0x01
#define CC1101_IOCFG0 0x02
#define CC1101_FIFOTHR 0x03
#define CC1101_SYNC1 0x04
#define CC1101_SYNC0 0x05
#define CC1101_PKTLEN 0x06
#define CC1101_PKTCTRL1 0x07
#define CC1101_PKTCTRL0 0x08
#define CC1101_ADDR 0x09
#define CC1101_CHANNR 0x0A
#define CC1101_FSCTRL1 0x0B
#define CC1101_FSCTRL0 0x0C
#define CC1101_FREQ2 0x0D
#define CC1101_FREQ1 0x0E
#define CC1101_FREQ0 0x0F
#define CC1101_MDMCFG4 0x10
#define CC1101_MDMCFG3 0x11
#define CC1101_MDMCFG2 0x12
#define CC1101_MDMCFG1 0x13
#define CC1101_MDMCFG0 0x14
#define CC1101_DEVIATN 0x15
#define CC1101_MCSM2 0x16
#define CC1101_MCSM1 0x17
#define CC1101_MCSM0 0x18
#define CC1101_FOCCFG 0x19
#define CC1101_BSCFG 0x1A
#define CC1101_AGCCTRL2 0x1B
#define CC1101_AGCCTRL1 0x1C
#define CC1101_AGCCTRL0 0x1D
#define CC1101_WOREVT1 0x1E
#define CC1101_WOREVT0 0x1F
#define CC1101_WORCTRL 0x20
#define CC1101_FREND1 0x21
#define CC1101_FREND0 0x22
#define CC1101_FSCAL3 0x23
#define CC1101_FSCAL2 0x24
#define CC1101_FSCAL1 0x25
#define CC1101_FSCAL0 0x26
#define CC1101_TEST2 0x2C
#define CC1101_TEST1 0x2D
#define CC1101_TEST0 0x2E
#define CC1101_PATABLE 0x3E
#define CC1101_TXFIFO 0x3F
#define CC1101_RXFIFO 0x3F

/* Status registers (read with burst bit set) */
#define CC1101_LQI_REG 0x33
#define CC1101_RSSI_REG 0x34
#define CC1101_MARCSTATE 0x35
#define CC1101_PKTSTATUS 0x38
#define CC1101_TXBYTES 0x3A
#define CC1101_RXBYTES 0x3B

/* SPI access modes */
#define CC1101_WRITE_SINGLE 0x00
#define CC1101_WRITE_BURST 0x40
#define CC1101_READ_SINGLE 0x80
#define CC1101_READ_BURST 0xC0

/* RX accumulation buffer size */
#define CC1101_RX_ACCUM_SIZE 128

/* -----------------------------------------------------------------------
 * RX callback type
 * ----------------------------------------------------------------------- */
typedef void (*cc1101_rx_callback_t)(const uint8_t* data, size_t len, int8_t rssi, uint32_t timestamp_ms);

typedef enum {
    CC1101_TUNE_PROFILE_DEFAULT = 0,
    CC1101_TUNE_PROFILE_BURST = 1,
    CC1101_TUNE_PROFILE_NOISY = 2,
    CC1101_TUNE_PROFILE_CUSTOM = 3,
} cc1101_tune_profile_t;

typedef struct {
    uint8_t fifo_drain_passes;
    uint8_t max_packets_per_check;
    uint8_t sync_miss_bail_streak;
    uint8_t sync_miss_bail_ring;
    uint8_t stale_timeout_ms;
    uint8_t fifothr;
} cc1101_runtime_tuning_t;

/* -----------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

/** Initialize CC1101 radio (reset + configure for Lutron CCA) */
void cc1101_init(void);

/** Check if radio is initialized */
bool cc1101_is_initialized(void);

/* Low-level register access */
void cc1101_strobe(uint8_t cmd);
void cc1101_write_register(uint8_t reg, uint8_t value);
uint8_t cc1101_read_register(uint8_t reg);
uint8_t cc1101_read_status_register(uint8_t reg);
void cc1101_write_burst(uint8_t reg, const uint8_t* data, size_t len);
void cc1101_read_burst(uint8_t reg, uint8_t* data, size_t len);

/* Radio control */
void cc1101_reset(void);
void cc1101_set_idle(void);
void cc1101_flush_tx(void);
void cc1101_flush_rx(void);
uint8_t cc1101_get_state(void);
uint8_t cc1101_get_tx_bytes(void);
uint8_t cc1101_get_rx_bytes(void);

/** Start continuous RX mode with sync word matching */
void cc1101_start_rx(void);

/** Stop RX mode, return to IDLE */
void cc1101_stop_rx(void);

/** Check for received data and invoke callback if a packet is ready */
bool cc1101_check_rx(void);

/** Transmit raw bytes (blocks until TX complete) */
bool cc1101_transmit_raw(const uint8_t* data, size_t len);

/** Transmit then immediately resume RX with minimal dead time.
 *  Caller must NOT call cc1101_stop_rx/start_rx around this. */
bool cc1101_transmit_and_resume_rx(const uint8_t* data, size_t len);

/** Set RX callback */
void cc1101_set_rx_callback(cc1101_rx_callback_t callback);

/** Runtime-tunable RX extraction settings */
void cc1101_get_runtime_tuning(cc1101_runtime_tuning_t* out);
bool cc1101_set_runtime_tuning(const cc1101_runtime_tuning_t* in);

/** Apply one of the built-in tuning profiles */
bool cc1101_apply_tune_profile(cc1101_tune_profile_t profile);
cc1101_tune_profile_t cc1101_get_tune_profile(void);
const char* cc1101_tune_profile_name(cc1101_tune_profile_t profile);

/** Reset radio-side telemetry counters */
void cc1101_reset_counters(void);

/** Get FIFO overflow count */
uint32_t cc1101_overflow_count(void);

/** Get count of packets where type-peek reduced the RX target */
uint32_t cc1101_short_packet_count(void);

/** Get count of runt packets (< 8 bytes, too short to decode) */
uint32_t cc1101_runt_count(void);

/** RX restart counters by reason */
uint32_t cc1101_rx_restart_timeout_count(void);
uint32_t cc1101_rx_restart_overflow_count(void);
uint32_t cc1101_rx_restart_manual_count(void);
uint32_t cc1101_rx_restart_packet_count(void);

/** Sync peek counters */
uint32_t cc1101_sync_peek_hit_count(void);
uint32_t cc1101_sync_peek_miss_count(void);

/** Ring telemetry */
uint32_t cc1101_ring_bytes_in_count(void);
uint32_t cc1101_ring_bytes_dropped_count(void);
uint32_t cc1101_ring_max_occupancy(void);
uint32_t cc1101_ring_current_occupancy(void);

/** Check if RX is active */
bool cc1101_is_rx_active(void);

#ifdef __cplusplus
}
#endif

#endif /* CC1101_H */
