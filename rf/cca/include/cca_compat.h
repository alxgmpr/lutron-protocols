/**
 * CCA Compatibility Header
 *
 * This header provides a unified interface that works with both:
 * - The Rust FFI library (libcca.a) for native builds
 * - The C++ implementation for ESP32/ESPHome builds
 *
 * Usage:
 *   #define CCA_USE_RUST  // Enable Rust FFI (native builds)
 *   #include "cca_compat.h"
 *
 * Or for ESP32:
 *   #include "cca_compat.h"  // Uses C++ implementation
 */

#ifndef CCA_COMPAT_H
#define CCA_COMPAT_H

#ifdef CCA_USE_RUST
// Use Rust FFI implementation
#include "cca.h"

#else
// Use C++ implementation (ESP32/ESPHome)

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Match the Rust API signatures for compatibility

#define CCA_MAX_PACKET_LEN 56

typedef struct CcaPacket {
    bool valid;
    uint8_t packet_type;
    uint8_t decoded_type;
    uint8_t sequence;
    uint32_t device_id;
    uint32_t target_id;
    uint8_t button;
    uint8_t action;
    uint8_t level;
    uint8_t format_byte;
    uint16_t crc;
    bool crc_valid;
    uint8_t raw[CCA_MAX_PACKET_LEN];
    size_t raw_len;
} CcaPacket;

// These will be implemented in the C++ ESPHome component
// as thin wrappers around the existing LutronDecoder class

typedef struct CcaDecoder CcaDecoder;

CcaDecoder* cca_decoder_new(void);
void cca_decoder_free(CcaDecoder* decoder);
bool cca_decode_fifo(const CcaDecoder* decoder, const uint8_t* fifo_data,
                     size_t len, CcaPacket* packet);
bool cca_parse_bytes(const CcaDecoder* decoder, const uint8_t* bytes,
                     size_t len, CcaPacket* packet);
uint16_t cca_calc_crc(const uint8_t* data, size_t len);
bool cca_verify_crc(const uint8_t* packet, size_t len);
const char* cca_packet_type_name(uint8_t pkt_type);
const char* cca_button_name(uint8_t button);
size_t cca_get_packet_length(uint8_t type_byte);

#ifdef __cplusplus
}
#endif

#endif // CCA_USE_RUST

#endif // CCA_COMPAT_H
