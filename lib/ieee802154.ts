/**
 * IEEE 802.15.4 frame parser
 *
 * Parses MAC-layer frames including addressing and auxiliary security headers.
 * Handles short (16-bit) and extended (64-bit) addressing modes with PAN compression.
 */

export interface Ieee802154Frame {
  /** Frame control field */
  frameControl: number;
  /** Frame type (0=beacon, 1=data, 2=ack, 3=cmd) */
  frameType: number;
  /** Sequence number */
  seqNum: number;
  /** Destination PAN ID */
  dstPan: number;
  /** Destination address (2 or 8 bytes, or empty) */
  dstAddr: Buffer;
  /** Destination addressing mode (0=none, 2=short, 3=extended) */
  dstAddrMode: number;
  /** Source address (2 or 8 bytes, or empty) */
  srcAddr: Buffer;
  /** Source addressing mode (0=none, 2=short, 3=extended) */
  srcAddrMode: number;
  /** PAN ID compression flag */
  panCompress: boolean;
  /** Security enabled flag */
  securityEnabled: boolean;
  /** Security level from aux header (0-7) */
  secLevel: number;
  /** Key identifier mode from aux header */
  keyIdMode: number;
  /** Frame counter from aux header */
  frameCounter: number;
  /** Key index from aux header (only for keyIdMode >= 1) */
  keyIndex: number;
  /** Byte offset where payload (or encrypted data) begins */
  headerEnd: number;
}

/** Parse an IEEE 802.15.4 frame from raw bytes */
export function parseFrame(frame: Buffer): Ieee802154Frame {
  let o = 0;
  const fc = frame.readUInt16LE(o);
  o += 2;

  const frameType = fc & 0x07;
  const securityEnabled = !!(fc & 0x08);
  const panCompress = !!(fc & 0x40);
  const dstAddrMode = (fc >> 10) & 0x03;
  const srcAddrMode = (fc >> 14) & 0x03;

  const seqNum = frame[o++];

  // Destination PAN
  let dstPan = 0;
  if (dstAddrMode) {
    dstPan = frame.readUInt16LE(o);
    o += 2;
  }

  // Destination address
  const dstLen = dstAddrMode === 2 ? 2 : dstAddrMode === 3 ? 8 : 0;
  const dstAddr = frame.subarray(o, o + dstLen);
  o += dstLen;

  // Source PAN (skipped if PAN compression is set)
  if (!panCompress && srcAddrMode) {
    o += 2;
  }

  // Source address
  const srcLen = srcAddrMode === 2 ? 2 : srcAddrMode === 3 ? 8 : 0;
  const srcAddr = frame.subarray(o, o + srcLen);
  o += srcLen;

  // Auxiliary security header (only if security enabled)
  let secLevel = 0;
  let keyIdMode = 0;
  let frameCounter = 0;
  let keyIndex = 0;

  if (securityEnabled) {
    const secControl = frame[o++];
    secLevel = secControl & 0x07;
    keyIdMode = (secControl >> 3) & 0x03;
    frameCounter = frame.readUInt32LE(o);
    o += 4;

    if (keyIdMode === 1) {
      keyIndex = frame[o++];
    } else if (keyIdMode === 2) {
      o += 4;
      keyIndex = frame[o++];
    } else if (keyIdMode === 3) {
      o += 8;
      keyIndex = frame[o++];
    }
  }

  return {
    frameControl: fc,
    frameType,
    seqNum,
    dstPan,
    dstAddr,
    dstAddrMode,
    srcAddr,
    srcAddrMode,
    panCompress,
    securityEnabled,
    secLevel,
    keyIdMode,
    frameCounter,
    keyIndex,
    headerEnd: o,
  };
}

/** Format an address buffer as colon-separated hex */
export function formatAddr(addr: Buffer): string {
  if (addr.length === 2) {
    return `0x${addr.toString("hex")}`;
  }
  return addr
    .toString("hex")
    .replace(/(.{2})(?!$)/g, "$1:")
    .toLowerCase();
}
