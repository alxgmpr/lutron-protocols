/**
 * CCA Firmware-OTA wire codec — pure byte-level packet build/parse.
 *
 * On-air framing (after preamble + sync delimiter):
 *
 *   [FA DE][LEN:1][OP:1][PAYLOAD:N][CRC16:2]
 *
 * LEN covers `[OP][PAYLOAD]` (LEN = 1 + N). CRC-16 (polynomial 0xCA0F, big-endian)
 * is computed over `[LEN][OP][PAYLOAD]`.
 *
 * See docs/protocols/cca.md §9 and docs/firmware-re/powpak.md.
 *
 * This module is RF-agnostic — input/output is bytes, not IQ samples. The
 * RTL-SDR demodulator and any TX builder use this for wire-level encoding.
 */

// --- CRC-16 / poly 0xCA0F (Lutron CCA) ---

const CRC_TABLE: number[] = [];
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let j = 0; j < 8; j++) {
    c = c & 0x8000 ? ((c << 1) ^ 0xca0f) & 0xffff : (c << 1) & 0xffff;
  }
  CRC_TABLE.push(c);
}

export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    const upper = (crc >> 8) & 0xff;
    crc = (((crc << 8) & 0xff00) + byte) ^ CRC_TABLE[upper];
  }
  return crc;
}

// --- Sync-word search ---

/** Sync word that follows the preamble + sync delimiter. */
export const SYNC_WORD: readonly [number, number] = [0xfa, 0xde];

/** Preamble + sync delimiter that prefix the sync word on air. */
export const PREAMBLE: readonly number[] = [0x55, 0x55, 0x55];
export const SYNC_DELIMITER = 0xff;

/**
 * Find the byte offset just past the first occurrence of sync word `FA DE`.
 * Returns `-1` if sync isn't present (or buffer ends mid-sync).
 */
export function findSyncOffset(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === SYNC_WORD[0] && bytes[i + 1] === SYNC_WORD[1]) {
      return i + 2;
    }
  }
  return -1;
}

// --- Packet parse ---

/** Result of attempting to parse one OTA packet from a byte stream. */
export type OtaParseResult =
  | {
      ok: true;
      /** Opcode byte (one of `OTAOpcode` values from protocol/cca.protocol.ts). */
      opcode: number;
      /** Body bytes (excludes LEN, OP, CRC). */
      body: Uint8Array;
      /** Total bytes consumed from the input: `LEN + 3` (LEN itself + OP+body + 2 CRC). */
      consumed: number;
    }
  | { ok: false; error: string };

/**
 * Parse an OTA packet from a byte buffer that starts at the LEN byte (i.e.
 * just past the `FA DE` sync word). The framing is:
 *
 *   [LEN:1][OP:1][BODY:LEN-1][CRC16:2]
 *
 * `LEN` covers `OP+BODY` (LEN = 1 + body_len). CRC is computed over
 * `[LEN, OP, BODY]` with poly 0xCA0F, stored big-endian.
 */
export function parseOtaPacket(bytes: Uint8Array): OtaParseResult {
  if (bytes.length < 1) return { ok: false, error: "buffer too short for LEN" };
  const len = bytes[0];
  if (len < 1) return { ok: false, error: "LEN must be >= 1 (no opcode)" };
  // Total wire bytes consumed: LEN(1) + OP+BODY(len) + CRC(2) = len + 3.
  const total = len + 3;
  if (bytes.length < total) {
    return {
      ok: false,
      error: `buffer too short / truncated: need ${total}, have ${bytes.length}`,
    };
  }
  const computed = crc16(bytes.subarray(0, 1 + len));
  const received = (bytes[1 + len] << 8) | bytes[2 + len];
  if (computed !== received) {
    return {
      ok: false,
      error: `CRC mismatch: computed 0x${computed.toString(16).padStart(4, "0")}, got 0x${received.toString(16).padStart(4, "0")}`,
    };
  }
  return {
    ok: true,
    opcode: bytes[1],
    body: bytes.slice(2, 1 + len),
    consumed: total,
  };
}

/** One successfully-parsed packet plus its absolute offset in the source stream. */
export interface OtaExtracted {
  /** Stream offset of the LEN byte (i.e. just past the `FA DE` sync). */
  offset: number;
  opcode: number;
  body: Uint8Array;
  /** Bytes consumed from `offset` onward: `LEN + 3`. */
  consumed: number;
}

// --- Bit-level helpers (CC1101 async serial mode) ---
//
// In OTA mode the CC1101 outputs raw bits at 30 kbps via GDO0 — no chip-side
// framing engine. The MCU shifts bytes out LSB-first. So the on-air bit
// sequence for byte N is: bit0, bit1, …, bit7. These helpers convert between
// byte buffers and the bit-array representation a GFSK demod produces.
//
// `bits` is represented as a `Uint8Array` where each element is 0 or 1.

/** Pack a byte buffer into an LSB-first bit array. */
export function bytesToBits(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      out[i * 8 + bit] = (b >> bit) & 1;
    }
  }
  return out;
}

/** Pack an LSB-first bit array back into bytes. Trailing partial byte dropped. */
export function bitsToBytes(bits: Uint8Array): Uint8Array {
  const nBytes = Math.floor(bits.length / 8);
  const out = new Uint8Array(nBytes);
  for (let i = 0; i < nBytes; i++) {
    let v = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (bits[i * 8 + bit]) v |= 1 << bit;
    }
    out[i] = v;
  }
  return out;
}

const SYNC_BIT_PATTERN = bytesToBits(
  new Uint8Array([SYNC_WORD[0], SYNC_WORD[1]]),
);

/**
 * Find the bit offset just past the first occurrence of the `FA DE` sync
 * word in an LSB-first bit stream. Returns the bit offset of the first bit
 * AFTER the sync (i.e. the LSB of the LEN byte). `-1` if not found.
 *
 * Useful when the GFSK demod produces a bit stream that hasn't yet been
 * byte-aligned — we don't know which bit starts a byte until sync is found.
 */
export function findBitSync(bits: Uint8Array): number {
  const needle = SYNC_BIT_PATTERN;
  outer: for (let i = 0; i + needle.length <= bits.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bits[i + j] !== needle[j]) continue outer;
    }
    return i + needle.length;
  }
  return -1;
}

/**
 * Walk a continuous byte stream and return every successfully-parsed OTA
 * packet. Skips CRC-failed candidates (advances past the spurious sync word).
 */
export function extractPackets(stream: Uint8Array): OtaExtracted[] {
  const out: OtaExtracted[] = [];
  let cursor = 0;
  while (cursor < stream.length) {
    const localSync = findSyncOffset(stream.subarray(cursor));
    if (localSync < 0) break;
    const absSync = cursor + localSync;
    const r = parseOtaPacket(stream.subarray(absSync));
    if (r.ok) {
      out.push({
        offset: absSync,
        opcode: r.opcode,
        body: r.body,
        consumed: r.consumed,
      });
      cursor = absSync + r.consumed;
    } else {
      // Skip past this (spurious) sync, continue searching.
      cursor = absSync;
    }
  }
  return out;
}

/**
 * Same as `extractPackets` but operates on a raw bit stream (one bit per
 * `Uint8Array` element). Aligns to byte boundaries via `findBitSync`, so the
 * caller doesn't need to know which bit starts a byte.
 *
 * For each returned packet, `offset` is a **bit offset** into the input.
 */
export function extractPacketsFromBits(bits: Uint8Array): OtaExtracted[] {
  const out: OtaExtracted[] = [];
  let cursor = 0;
  while (cursor < bits.length) {
    const localSync = findBitSync(bits.subarray(cursor));
    if (localSync < 0) break;
    const absSync = cursor + localSync;
    const bytes = bitsToBytes(bits.subarray(absSync));
    const r = parseOtaPacket(bytes);
    if (r.ok) {
      out.push({
        offset: absSync,
        opcode: r.opcode,
        body: r.body,
        consumed: r.consumed,
      });
      cursor = absSync + r.consumed * 8;
    } else {
      cursor = absSync;
    }
  }
  return out;
}

// --- Packet build ---

/**
 * Build the full on-air byte sequence for an OTA packet:
 *
 *   [55 55 55][FF][FA DE][LEN:1][OP:1][BODY:N][CRC16:2]
 *
 * Throws `RangeError` for invalid opcode (> 0xFF) or body too long (the LEN
 * byte caps `1 + body.length` at 255).
 */
export function buildOtaPacket(opcode: number, body: Uint8Array): Uint8Array {
  if (opcode < 0 || opcode > 0xff) {
    throw new RangeError(`opcode 0x${opcode.toString(16)} out of u8 range`);
  }
  if (body.length > 254) {
    throw new RangeError(
      `body length ${body.length} exceeds max 254 (LEN must fit in u8)`,
    );
  }
  const len = 1 + body.length;
  // Wire payload that gets CRC'd: [LEN, OP, ...BODY]
  const payload = new Uint8Array(1 + len);
  payload[0] = len;
  payload[1] = opcode;
  payload.set(body, 2);
  const crc = crc16(payload);
  // Full on-air sequence: preamble + delim + sync + payload + crc
  const wire = new Uint8Array(PREAMBLE.length + 1 + 2 + payload.length + 2);
  let off = 0;
  for (const b of PREAMBLE) wire[off++] = b;
  wire[off++] = SYNC_DELIMITER;
  wire[off++] = SYNC_WORD[0];
  wire[off++] = SYNC_WORD[1];
  wire.set(payload, off);
  off += payload.length;
  wire[off++] = (crc >> 8) & 0xff;
  wire[off++] = crc & 0xff;
  return wire;
}
