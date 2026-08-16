#ifndef STREAM_FRAME_H
#define STREAM_FRAME_H

/**
 * Stream wire format (STM32 → host), shared by the firmware emitter and the
 * host-side parsers in cli/ and tools/.
 *
 * Packet frame:
 *   [FLAGS:1][LEN:1][TS_MS:4 LE][TS_CYC:4 LE][DATA:LEN]([SRC:16])
 *
 * The 16-byte source IPv6 trailer is present only when STREAM_FLAG_SRC is set,
 * and only ever on CCX frames.  It is a *trailer*, not a header field, so LEN
 * keeps its original meaning (payload bytes) and the payload keeps its original
 * offset: a client written before the trailer existed slices [10, 10+LEN) and
 * recovers exactly the same payload, ignoring the extra bytes.  See
 * docs/protocols/ccx/index.md § "Stream Source Attribution".
 *
 * This module is deliberately free of FreeRTOS/lwIP/HAL dependencies so it can
 * be unit-tested on the host (firmware/tests/test_stream_frame.cpp).
 */

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * FLAGS byte:
 *   Bit 7:    Direction (0=RX from radio, 1=TX echo)
 *   Bit 6:    Protocol  (0=CCA, 1=CCX)
 *   Bit 5:    Raw 802.15.4 frame (promiscuous sniff)
 *   Bit 4:    Source-address trailer present  — CCX ONLY
 *   Bits 0-4: |RSSI| for CCA RX frames
 *
 * Bit 4 is shared: it is part of the CCA RSSI magnitude and, on CCX frames
 * (which never carry RSSI), the source-address marker.  There is no globally
 * free bit left, so readers MUST check STREAM_FLAG_CCX before interpreting
 * STREAM_FLAG_SRC.
 */
#define STREAM_FLAG_TX 0x80
#define STREAM_FLAG_CCX 0x40
#define STREAM_FLAG_RAW 0x20
#define STREAM_FLAG_SRC 0x10
#define STREAM_FLAG_RSSI_MASK 0x1F

/** Fixed header: FLAGS(1) LEN(1) TS_MS(4) TS_CYC(4) */
#define STREAM_FRAME_HEADER_LEN 10

/** Source IPv6 trailer length */
#define STREAM_SRC_ADDR_LEN 16

/** Largest payload a frame can carry (LEN is a single byte, and the TX ring
 *  item caps it lower — see TX_ITEM_MAX_DATA in stream.cpp). */
#define STREAM_FRAME_MAX_PAYLOAD 255

/** Largest possible frame on the wire */
#define STREAM_FRAME_MAX_LEN (STREAM_FRAME_HEADER_LEN + STREAM_FRAME_MAX_PAYLOAD + STREAM_SRC_ADDR_LEN)

/**
 * Serialize one packet frame into @p out.
 *
 * @param flags     Base flags.  STREAM_FLAG_SRC is set or cleared by this
 *                  function to match @p src_addr — a caller cannot make the
 *                  flag claim a trailer that was not written.
 * @param data      Payload; may be NULL only when @p len is 0.
 * @param src_addr  16-byte source IPv6 in network byte order, or NULL when the
 *                  frame has no meaningful sender (locally-originated TX).
 *
 * @return frame length in bytes, or 0 if the arguments or capacity are invalid.
 */
size_t stream_frame_build(uint8_t* out, size_t out_cap, uint8_t flags, const uint8_t* data, uint8_t len, uint32_t ts_ms,
                          uint32_t ts_cyc, const uint8_t* src_addr);

#ifdef __cplusplus
}
#endif

#endif /* STREAM_FRAME_H */
