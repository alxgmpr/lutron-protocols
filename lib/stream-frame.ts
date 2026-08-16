/**
 * Nucleo UDP stream framing (STM32 → host).
 *
 * Wire layout, mirroring firmware/src/net/stream_frame.h:
 *
 *   [FLAGS:1][LEN:1][TS_MS:4 LE][TS_CYC:4 LE][DATA:LEN]([SRC:16])
 *
 * The 16-byte source IPv6 is a *trailer*, present only when FLAG_SRC is set and
 * only on CCX frames. LEN counts payload bytes only and the payload keeps
 * offset 10, so a parser written before the trailer existed slices
 * [10, 10+LEN) and recovers the identical payload.
 *
 * Keep the constants here in sync with stream_frame.h — test/stream-frame.test.ts
 * asserts them.
 */

import { canonicalizeIpv6, expandIpv6 } from "../ccx/addressing";

export const FLAG_TX = 0x80;
export const FLAG_CCX = 0x40;
export const FLAG_RAW = 0x20;
/** Source-address trailer present. Meaningful ONLY when FLAG_CCX is set —
 *  bit 4 is also part of the CCA |RSSI| field. */
export const FLAG_SRC = 0x10;
/**
 * |RSSI| on a CCA RX frame — bits 0-4, matching STREAM_FLAG_RSSI_MASK.
 *
 * Five bits, so the firmware's `(uint8_t)(-rssi) & 0x1F` truncates rather
 * than saturates: anything past -31 dBm aliases modulo 32. Read the value as
 * a magnitude only when it is known to be in range.
 */
export const FLAG_RSSI_MASK = 0x1f;

export const FRAME_HEADER_LEN = 10;
export const SRC_ADDR_LEN = 16;

/**
 * Why a frame does or does not carry a sender.
 *
 * - `attributed`  — the trailer is present; `srcAddr` is the sender.
 * - `local`       — the Nucleo originated this frame, so it has no sender.
 * - `unsupported` — no trailer and not marked TX. For a CCX frame this means
 *                   the firmware predates the trailer (GLAB-78); CCA frames are
 *                   always `unsupported` because CCA has no source field here.
 */
export type StreamSrcKind = "attributed" | "local" | "unsupported";

export interface StreamPacketFrame {
  flags: number;
  isCcx: boolean;
  isTx: boolean;
  isRaw: boolean;
  /** HAL_GetTick() at start-of-frame */
  tsMs: number;
  /** DWT->CYCCNT at the same instant */
  tsCyc: number;
  data: Buffer;
  /** Canonical IPv6 of the sender, or null when the frame carries no source. */
  srcAddr: string | null;
  srcKind: StreamSrcKind;
}

/**
 * Parse one packet frame. Returns null if the datagram is too short for what
 * its own header claims — a truncated frame is dropped rather than read as
 * garbage.
 *
 * Callers must handle the heartbeat (0xFF 0x00), text (0xFD) and status (0xFE)
 * datagrams before calling this; those are not packet frames.
 */
export function parseStreamPacketFrame(msg: Buffer): StreamPacketFrame | null {
  if (msg.length < FRAME_HEADER_LEN) return null;

  const flags = msg[0];
  const len = msg[1];
  if (msg.length < FRAME_HEADER_LEN + len) return null;

  const isCcx = !!(flags & FLAG_CCX);
  const hasSrc = isCcx && !!(flags & FLAG_SRC);
  if (hasSrc && msg.length < FRAME_HEADER_LEN + len + SRC_ADDR_LEN) return null;

  let srcAddr: string | null = null;
  let srcKind: StreamSrcKind = "unsupported";
  if (hasSrc) {
    const raw = msg.subarray(
      FRAME_HEADER_LEN + len,
      FRAME_HEADER_LEN + len + SRC_ADDR_LEN,
    );
    srcAddr = ipv6FromBytes(raw);
    srcKind = "attributed";
  } else if (isCcx && flags & FLAG_TX) {
    srcKind = "local";
  }

  return {
    flags,
    isCcx,
    isTx: !!(flags & FLAG_TX),
    isRaw: !!(flags & FLAG_RAW),
    tsMs: msg.readUInt32LE(2),
    tsCyc: msg.readUInt32LE(6),
    data: msg.subarray(FRAME_HEADER_LEN, FRAME_HEADER_LEN + len),
    srcAddr,
    srcKind,
  };
}

/** Format 16 raw address bytes as a canonical IPv6 string. */
export function ipv6FromBytes(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < SRC_ADDR_LEN; i += 2) {
    groups.push((((bytes[i] << 8) | bytes[i + 1]) >>> 0).toString(16));
  }
  return canonicalizeIpv6(groups.join(":"));
}

/**
 * Extract the RLOC16 from a mesh-local RLOC address, or null if the address is
 * not one. Mirrors extract_rloc16() in firmware/src/ccx/ccx_task.cpp:
 * `fd..::0000:00ff:fe00:XXXX` (bytes 8..13 = 00 00 00 ff fe 00).
 *
 * Sleepy children source from an ML-EID with no RLOC pattern, so this returns
 * null for exactly the devices the full address is needed for.
 */
export function rloc16FromIpv6(addr: string): number | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(expandIpv6(addr).replace(/:/g, ""), "hex");
  } catch {
    return null;
  }
  if (bytes.length !== SRC_ADDR_LEN) return null;
  if (bytes[0] !== 0xfd) return null;
  if (
    bytes[8] !== 0x00 ||
    bytes[9] !== 0x00 ||
    bytes[10] !== 0x00 ||
    bytes[11] !== 0xff ||
    bytes[12] !== 0xfe ||
    bytes[13] !== 0x00
  ) {
    return null;
  }
  return ((bytes[14] << 8) | bytes[15]) >>> 0;
}
