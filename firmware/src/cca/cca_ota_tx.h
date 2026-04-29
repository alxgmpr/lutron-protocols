#pragma once

/**
 * Synth-OTA-TX builders — emit on-air OTA packets that match captured
 * Caseta Pro REP2 → DVRF-6L OTA traffic byte-for-byte.
 *
 * Used by the PowPak RMJ/RMJS → LMJ conversion attack to push an LMJ LDF
 * body to a target PowPak from a Nucleo+CC1101, bypassing every Lutron
 * host system. See docs/firmware-re/powpak-conversion-attack.md.
 *
 * Each builder fills a raw packet buffer pre-CRC (CRC-16/0xCA0F is added by
 * the N81 framer downstream). Sequence byte at offset 1 is left as 0x00 —
 * the TDMA engine writes it before TX.
 *
 * Packet layout (live-capture confirmed 2026-04-29; see
 * docs/firmware-re/cca-ota-live-capture.md and protocol/cca.protocol.ts
 * `OTAOnAirSubOpcode`):
 *
 *   [0]      type            0x91/92 short unicast, 0xB1/B2/B3 long unicast
 *   [1]      sequence        TDMA-engine-set; builder writes 0x00
 *   [2]      flags           0xA1 retx (high nibble = packet class)
 *   [3-4]    subnet          BE 16-bit; 0xFFFF for unpaired/factory devices
 *   [5]      pair_flag       0x00 normal
 *   [6]      proto           0x21 = QS_PROTO_RADIO_TX
 *   [7]      body length sig 0x0C/0x0E (short) / 0x2B (long)
 *   [8]      0x00
 *   [9-12]   device serial   BE 4-byte (target's hardware serial)
 *   [13]     0xFE            unicast marker
 *   [14-15]  06 nn           sub-opcode (`OTAOnAirSubOpcode`)
 *   [16+]    payload         sub-op-specific
 */

#include "cca_types.h"

#include <cstdint>
#include <cstddef>
#include <cstring>

/* On-air OTA sub-opcodes (mirrors protocol/cca.protocol.ts OTAOnAirSubOpcode). */
static const uint8_t OTA_SUB_BEGIN_TRANSFER = 0x00;
static const uint8_t OTA_SUB_CHANGE_ADDRESS_OFF = 0x01;
static const uint8_t OTA_SUB_TRANSFER_DATA = 0x02;
static const uint8_t OTA_SUB_POLL = 0x03;

/* Carrier type bytes. */
static const uint8_t OTA_TYPE_BEGIN_TRANSFER = 0x92;
static const uint8_t OTA_TYPE_CHANGE_ADDR_OFF = 0x91;
/* TransferData TDMA arms: caller cycles 0xB1/B2/B3 (B1 was rare/absent in
 * the captured OTA — Caseta REP2 used 2-arm B2/B3 cycle). */

/* Body length signatures at packet[7]. */
static const uint8_t OTA_BODY_LEN_SIG_BEGIN = 0x0E;  /* short, payload 6 bytes  */
static const uint8_t OTA_BODY_LEN_SIG_CHADDR = 0x0C; /* short, payload 4 bytes  */
static const uint8_t OTA_BODY_LEN_SIG_POLL = 0x08;   /* short, payload filler   */
static const uint8_t OTA_BODY_LEN_SIG_LONG = 0x2B;   /* long,  payload 35 bytes */

/* Byte[13] markers — distinguishes broadcast vs unicast addressing. */
static const uint8_t OTA_BCAST_MARKER = 0xFD;
static const uint8_t OTA_UNICAST_MARKER = 0xFE;

static const uint8_t OTA_CHUNK_SIZE = 31;
static const uint32_t OTA_PAGE_SIZE = 0x10000; /* 64 KB */

/* -----------------------------------------------------------------------
 * Common header writer for OTA short/long packets.
 * ----------------------------------------------------------------------- */
inline void cca_ota_write_header(uint8_t* pkt, uint8_t type_byte, uint8_t body_len_sig, uint16_t subnet,
                                 uint32_t target_serial)
{
    pkt[0] = type_byte;
    pkt[1] = 0x00; /* seq — TDMA engine sets */
    pkt[2] = 0xA1; /* flags: retx-class for cmd packets */
    pkt[3] = (subnet >> 8) & 0xFF;
    pkt[4] = subnet & 0xFF;
    pkt[5] = 0x00; /* pair_flag normal */
    pkt[6] = QS_PROTO_RADIO_TX;
    pkt[7] = body_len_sig;
    pkt[8] = 0x00;
    pkt[9] = (target_serial >> 24) & 0xFF;
    pkt[10] = (target_serial >> 16) & 0xFF;
    pkt[11] = (target_serial >> 8) & 0xFF;
    pkt[12] = (target_serial) & 0xFF;
    pkt[13] = 0xFE; /* unicast marker */
}

/* -----------------------------------------------------------------------
 * BeginTransfer (type 0x92, sub-op 06 00, payload `02 20 00 00 00 1F`).
 *
 * Emitted once at OTA session start. The trailing `1F` of the payload
 * is the chunk size (31 bytes). The leading 5 bytes' meaning is open —
 * captured value verbatim from the Caseta REP2 → DVRF-6L OTA. May need
 * Phoenix EFR32 coproc RE at IPC `0x2A` handler if commit step fails.
 *
 * Returns 22 (pre-CRC packet length).
 * ----------------------------------------------------------------------- */
inline size_t cca_ota_build_begin_transfer(uint8_t* pkt, uint16_t subnet, uint32_t target_serial)
{
    memset(pkt, 0x00, 22);
    cca_ota_write_header(pkt, OTA_TYPE_BEGIN_TRANSFER, OTA_BODY_LEN_SIG_BEGIN, subnet, target_serial);
    pkt[14] = 0x06;
    pkt[15] = OTA_SUB_BEGIN_TRANSFER;
    /* Payload: copied verbatim from captured OTA. */
    pkt[16] = 0x02;
    pkt[17] = 0x20;
    pkt[18] = 0x00;
    pkt[19] = 0x00;
    pkt[20] = 0x00;
    pkt[21] = 0x1F; /* chunk size */
    return 22;
}

/* -----------------------------------------------------------------------
 * ChangeAddressOffset (type 0x91, sub-op 06 01, payload `00 PREV 00 NEW`).
 *
 * Emitted at each 64 KB page boundary. PREV/NEW are 16-bit BE page indices
 * (page 0 = first 64 KB, page 1 = second 64 KB, etc.). Body padding bytes
 * 20-21 = 0xCC (matches captured OTA filler).
 *
 * Returns 22 (pre-CRC packet length).
 * ----------------------------------------------------------------------- */
inline size_t cca_ota_build_change_addr_offset(uint8_t* pkt, uint16_t subnet, uint32_t target_serial,
                                               uint16_t prev_page, uint16_t next_page)
{
    memset(pkt, 0xCC, 22);
    cca_ota_write_header(pkt, OTA_TYPE_CHANGE_ADDR_OFF, OTA_BODY_LEN_SIG_CHADDR, subnet, target_serial);
    pkt[14] = 0x06;
    pkt[15] = OTA_SUB_CHANGE_ADDRESS_OFF;
    pkt[16] = (prev_page >> 8) & 0xFF;
    pkt[17] = prev_page & 0xFF;
    pkt[18] = (next_page >> 8) & 0xFF;
    pkt[19] = next_page & 0xFF;
    /* pkt[20..21] = 0xCC from memset. */
    return 22;
}

/* -----------------------------------------------------------------------
 * Device-poll (sub-op 06 03) — SAFE pre-flight, no flash side effects.
 *
 * Two variants distinguished by carrier byte and byte[13] marker:
 *   BROADCAST: type 0x81/82/83, byte[13]=0xFD, target_id is DeviceClass
 *              at bytes 9-12 (e.g. 0x16030201 for RMJ-16R-DV-B).
 *   UNICAST:   type 0x91/92,    byte[13]=0xFE, target_id is device serial
 *              at bytes 9-12.
 *
 * Body bytes [16..21] are filler (0xCC). Body length sig 0x08.
 *
 * SHOULD be sent BEFORE BeginTransfer (sub-op 06 00) in any OTA workflow:
 * BeginTransfer erases the application section, while Device-poll has
 * no payload and confirms reachability without touching flash. See
 * docs/firmware-re/powpak-conversion-attack.md §"Brick incident".
 *
 * Returns 22 (pre-CRC packet length); 0 on validation error.
 * ----------------------------------------------------------------------- */
inline size_t cca_ota_build_poll(uint8_t* pkt, uint8_t carrier_type, uint16_t subnet, uint32_t target_id,
                                 bool is_broadcast)
{
    if (is_broadcast) {
        if (carrier_type < 0x81 || carrier_type > 0x83) return 0;
    }
    else {
        if (carrier_type != 0x91 && carrier_type != 0x92) return 0;
    }

    memset(pkt, 0xCC, 22);
    cca_ota_write_header(pkt, carrier_type, OTA_BODY_LEN_SIG_POLL, subnet, target_id);
    if (is_broadcast) pkt[13] = OTA_BCAST_MARKER;
    pkt[14] = 0x06;
    pkt[15] = OTA_SUB_POLL;
    /* pkt[16..21] = 0xCC from memset (header writes pkt[0..13] only). */
    return 22;
}

/* -----------------------------------------------------------------------
 * TransferData (type 0xB1/B2/B3, sub-op 06 02, 31-byte chunk payload).
 *
 * Emitted ~3,300 times for a 102 KB LMJ body. Carrier cycles through
 * the 3-arm TDMA group (B1/B2/B3) — caller picks the carrier; the TDMA
 * engine downstream will rotate. `sub_counter` cycles 0..0x3F per chunk
 * stream. `addr_lo` is the 16-bit BE chunk address within the current
 * 64 KB page (advances by 31 per packet, wraps to page boundary).
 *
 * Returns 51 (pre-CRC packet length); 0 on validation error.
 * ----------------------------------------------------------------------- */
inline size_t cca_ota_build_transfer_data(uint8_t* pkt, uint8_t carrier_type, uint16_t subnet, uint32_t target_serial,
                                          uint8_t sub_counter, uint16_t addr_lo, const uint8_t* chunk, size_t chunk_len)
{
    if (carrier_type < 0xB1 || carrier_type > 0xB3) return 0;
    if (chunk_len != OTA_CHUNK_SIZE) return 0;
    if (!chunk) return 0;

    memset(pkt, 0x00, 51);
    cca_ota_write_header(pkt, carrier_type, OTA_BODY_LEN_SIG_LONG, subnet, target_serial);
    pkt[14] = 0x06;
    pkt[15] = OTA_SUB_TRANSFER_DATA;
    pkt[16] = sub_counter;
    pkt[17] = (addr_lo >> 8) & 0xFF;
    pkt[18] = addr_lo & 0xFF;
    pkt[19] = OTA_CHUNK_SIZE;
    memcpy(pkt + 20, chunk, OTA_CHUNK_SIZE);
    return 51;
}

/* -----------------------------------------------------------------------
 * Chunk-stream iterator — walks a firmware body in 31-byte chunks,
 * tracking the (page, addr_lo) pair the TransferData packets need.
 *
 * Workflow:
 *   OtaChunkIter it;
 *   cca_ota_chunk_iter_init(&it, body, body_len);
 *   while (!cca_ota_chunk_iter_done(&it)) {
 *       uint8_t chunk[31];
 *       cca_ota_chunk_iter_fill(&it, chunk);
 *       // build + TX TransferData(carrier, ..., it.sub_counter, it.addr_lo, chunk)
 *       bool wrapped = cca_ota_chunk_iter_advance(&it);
 *       if (wrapped) {
 *           // build + TX ChangeAddressOffset(it.page - 1, it.page)
 *       }
 *   }
 * ----------------------------------------------------------------------- */
struct OtaChunkIter {
    const uint8_t* body;
    size_t body_len;
    size_t cursor;       /* byte offset into body for next chunk */
    uint16_t addr_lo;    /* 16-bit chunk address within current page */
    uint16_t page;       /* 64 KB page index (0, 1, 2, ...) */
    uint8_t sub_counter; /* cycles 0..0x3F per packet */
};

inline void cca_ota_chunk_iter_init(OtaChunkIter* it, const uint8_t* body, size_t body_len)
{
    it->body = body;
    it->body_len = body_len;
    it->cursor = 0;
    it->addr_lo = 0;
    it->page = 0;
    it->sub_counter = 0;
}

inline bool cca_ota_chunk_iter_done(const OtaChunkIter* it)
{
    return it->cursor >= it->body_len;
}

inline void cca_ota_chunk_iter_fill(const OtaChunkIter* it, uint8_t* chunk)
{
    size_t remaining = (it->cursor < it->body_len) ? it->body_len - it->cursor : 0;
    size_t n = remaining < OTA_CHUNK_SIZE ? remaining : OTA_CHUNK_SIZE;
    if (n > 0) memcpy(chunk, it->body + it->cursor, n);
    if (n < OTA_CHUNK_SIZE) memset(chunk + n, 0x00, OTA_CHUNK_SIZE - n);
}

/* Advance to the next chunk. Returns true if we crossed a 64 KB page
 * boundary (caller should emit a ChangeAddressOffset before the next
 * TransferData). */
inline bool cca_ota_chunk_iter_advance(OtaChunkIter* it)
{
    it->cursor += OTA_CHUNK_SIZE;
    it->sub_counter = (it->sub_counter + 1) & 0x3F;

    uint32_t next = (uint32_t)it->addr_lo + OTA_CHUNK_SIZE;
    if (next >= OTA_PAGE_SIZE) {
        it->page++;
        it->addr_lo = (uint16_t)(next - OTA_PAGE_SIZE);
        return true;
    }
    it->addr_lo = (uint16_t)next;
    return false;
}

/* -----------------------------------------------------------------------
 * Full-OTA orchestrator — walks the LDF body in cca_ota_session, invoking
 * `cb` for each on-air packet (1× BeginTransfer, then TransferData× chunks
 * with carrier rotation B1/B2/B3, plus a ChangeAddressOffset between
 * packets that span a 64 KB page boundary).
 *
 * Pure orchestration — no TX side effects. The caller chooses how to
 * deliver each packet (TDMA queue, test logger, file dump, etc.). The
 * sequence byte at offset 1 is left as 0x00; whoever delivers the packet
 * is responsible for setting it (the TDMA engine does this in firmware).
 *
 * Use this for unit-testing the orchestration layer and for the
 * exec_ota_full_tx shell command in cca_pairing.cpp.
 * ----------------------------------------------------------------------- */
typedef void (*OtaTxPacketCallback)(const uint8_t* pkt, size_t len, void* ctx);

extern "C" const uint8_t* cca_ota_session_body(void);
extern "C" uint32_t cca_ota_session_body_len(void);

inline void cca_ota_full_tx_walk(uint16_t subnet, uint32_t target_serial, OtaTxPacketCallback cb, void* ctx)
{
    /* 1× BeginTransfer */
    uint8_t pkt22[22];
    cca_ota_build_begin_transfer(pkt22, subnet, target_serial);
    cb(pkt22, 22, ctx);

    /* TransferData stream + ChangeAddrOff at page wraps */
    OtaChunkIter it;
    cca_ota_chunk_iter_init(&it, cca_ota_session_body(), cca_ota_session_body_len());

    static const uint8_t carriers[3] = {0xB1, 0xB2, 0xB3};
    uint32_t chunk_count = 0;
    while (!cca_ota_chunk_iter_done(&it)) {
        uint8_t carrier = carriers[chunk_count % 3];
        uint8_t chunk[OTA_CHUNK_SIZE];
        cca_ota_chunk_iter_fill(&it, chunk);
        uint8_t pkt51[51];
        cca_ota_build_transfer_data(pkt51, carrier, subnet, target_serial, it.sub_counter, it.addr_lo, chunk,
                                    OTA_CHUNK_SIZE);
        cb(pkt51, 51, ctx);
        bool wrapped = cca_ota_chunk_iter_advance(&it);
        if (wrapped && !cca_ota_chunk_iter_done(&it)) {
            cca_ota_build_change_addr_offset(pkt22, subnet, target_serial, (uint16_t)(it.page - 1), (uint16_t)it.page);
            cb(pkt22, 22, ctx);
        }
        chunk_count++;
    }
}
