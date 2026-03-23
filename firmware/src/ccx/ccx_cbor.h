#ifndef CCX_CBOR_H
#define CCX_CBOR_H

/**
 * Minimal CBOR encoder/decoder for CCX messages.
 *
 * Supports only what CCX needs:
 *   Major 0: unsigned integer
 *   Major 2: byte string
 *   Major 4: array (header only)
 *   Major 5: map (header only)
 *
 * No dynamic allocation. Encoder writes into caller-provided buffer.
 * Decoder reads one item header at a time (pull-style).
 */

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* -----------------------------------------------------------------------
 * CBOR major types
 * ----------------------------------------------------------------------- */
#define CBOR_MAJOR_UINT  0
#define CBOR_MAJOR_NINT  1
#define CBOR_MAJOR_BSTR  2
#define CBOR_MAJOR_TSTR  3
#define CBOR_MAJOR_ARRAY 4
#define CBOR_MAJOR_MAP   5

/* -----------------------------------------------------------------------
 * Encoder — returns bytes written, 0 on buffer overflow
 * ----------------------------------------------------------------------- */

/** Encode a CBOR unsigned integer */
size_t cbor_encode_uint(uint8_t* buf, size_t buf_size, uint32_t val);

/** Encode a CBOR array header (caller encodes items after) */
size_t cbor_encode_array(uint8_t* buf, size_t buf_size, uint32_t count);

/** Encode a CBOR map header (caller encodes key-value pairs after) */
size_t cbor_encode_map(uint8_t* buf, size_t buf_size, uint32_t count);

/** Encode a CBOR byte string (major 2, header + data) */
size_t cbor_encode_bstr(uint8_t* buf, size_t buf_size, const uint8_t* data, size_t len);

/** Encode a CBOR text string (major 3, header + data) */
size_t cbor_encode_tstr(uint8_t* buf, size_t buf_size, const char* str, size_t len);

/* -----------------------------------------------------------------------
 * Decoder — pull-style, one item at a time
 * ----------------------------------------------------------------------- */

typedef struct {
    uint8_t  major;      /* CBOR major type (0-7) */
    uint32_t value;      /* Additional info value */
    size_t   header_len; /* Bytes consumed for this header */
} cbor_item_t;

/** Decode one CBOR item header. Returns false if buffer too short. */
bool cbor_decode_item(const uint8_t* buf, size_t len, cbor_item_t* item);

/** Convenience: decode a CBOR unsigned integer. Returns false on type mismatch. */
bool cbor_decode_uint(const uint8_t* buf, size_t len, uint32_t* val, size_t* consumed);

#ifdef __cplusplus
}
#endif

#endif /* CCX_CBOR_H */
