/**
 * Frame Pipeline — Raw 802.15.4 frames → CCXPacket
 *
 * Consolidates the decrypt-and-decode logic into a
 * reusable module. Handles:
 *   1. Parse 802.15.4 MAC header
 *   2. Derive Thread MAC key from master key + key sequence
 *   3. Decrypt with AES-128-CCM* (try known EUI-64, addr table, brute force)
 *   4. Scan plaintext for CBOR 0x82 marker
 *   5. Build typed CCXPacket
 *
 * Also learns short-addr → EUI-64 mappings from frames with extended source.
 */

import { buildPacket } from "../ccx/decoder";
import type { CCXPacket } from "../ccx/types";
import { formatAddr, parseFrame } from "./ieee802154";
import { decryptMacFrame, deriveThreadKeys } from "./thread-crypto";

export interface FramePipelineOptions {
  /** Thread network master key (hex string) */
  masterKey: string;
  /** Pre-populated EUI-64 entries: serial → eui64 hex string */
  knownDevices?: { serial: number; eui64: string }[];
}

export class FramePipeline {
  private masterKeyBuf: Buffer;
  /** short addr → EUI-64 buffer */
  private addrTable = new Map<number, Buffer>();
  /** key sequence → derived MAC key */
  private keyCache = new Map<number, Buffer>();
  /** Callback for new address table entries (for logging) */
  onAddressLearned?: (shortAddr: number, eui64: string) => void;

  constructor(opts: FramePipelineOptions) {
    this.masterKeyBuf = Buffer.from(opts.masterKey, "hex");

    // Pre-populate addr table with negative-serial keys (same convention as original)
    if (opts.knownDevices) {
      for (const dev of opts.knownDevices) {
        if (dev.eui64) {
          const eui64 = Buffer.from(dev.eui64.replace(/:/g, ""), "hex");
          if (eui64.length === 8) {
            this.addrTable.set(-dev.serial, eui64);
          }
        }
      }
    }
  }

  /** Get number of EUI-64 entries in the address table */
  get addressCount(): number {
    return this.addrTable.size;
  }

  private getMacKey(keySequence: number): Buffer {
    let key = this.keyCache.get(keySequence);
    if (!key) {
      key = deriveThreadKeys(this.masterKeyBuf, keySequence).macKey;
      this.keyCache.set(keySequence, key);
    }
    return key;
  }

  /**
   * Process a raw 802.15.4 frame and attempt to decrypt + decode CCX.
   * Returns a CCXPacket on success, or null if frame can't be decoded.
   */
  process(frame: Buffer, timestamp?: Date): CCXPacket | null {
    const parsed = parseFrame(frame);

    // Learn EUI-64 from frames with extended source addresses.
    // 802.15.4 stores extended addresses in LE byte order in the frame;
    // reverse to canonical BE for nonce construction and addr table storage.
    if (parsed.srcAddrMode === 3 && parsed.srcAddr.length === 8) {
      const eui64BE = reverseEui64(parsed.srcAddr);
      const hex = formatEui64(eui64BE);
      // Store in addr table keyed by a hash (negative of first 4 bytes as int)
      const hashKey = -(eui64BE.readUInt32BE(0) ^ eui64BE.readUInt32BE(4));
      if (!this.addrTable.has(hashKey)) {
        this.addrTable.set(hashKey, eui64BE);
        this.onAddressLearned?.(hashKey, hex);
      }
    }

    // Only process secured data frames
    if (parsed.frameType !== 1 || !parsed.securityEnabled) return null;

    const keySeq = parsed.keyIndex > 0 ? parsed.keyIndex - 1 : 0;
    const macKey = this.getMacKey(keySeq);

    const tryWith = (eui64: Buffer) =>
      decryptMacFrame({
        frame,
        headerEnd: parsed.headerEnd,
        secLevel: parsed.secLevel,
        frameCounter: parsed.frameCounter,
        macKey,
        eui64,
      });

    let plaintext: Buffer | null = null;
    let matchedEui64 = Buffer.alloc(8);

    // Try source address if it's an extended EUI-64 in the frame
    // (reverse from LE frame order to BE canonical for nonce)
    if (parsed.srcAddrMode === 3 && parsed.srcAddr.length === 8) {
      const eui64BE = reverseEui64(parsed.srcAddr);
      plaintext = tryWith(eui64BE);
      if (plaintext) {
        matchedEui64 = eui64BE;
      }
    }

    // Try address table (short → EUI-64)
    if (!plaintext && parsed.srcAddrMode === 2 && parsed.srcAddr.length === 2) {
      const shortAddr = parsed.srcAddr.readUInt16LE(0);

      // Direct short-addr lookup
      const eui64 = this.addrTable.get(shortAddr);
      if (eui64) {
        plaintext = tryWith(eui64);
        if (plaintext) matchedEui64 = eui64;
      }
    }

    // Brute-force all known EUI-64s
    if (!plaintext) {
      for (const [, eui64] of this.addrTable) {
        plaintext = tryWith(eui64);
        if (plaintext) {
          matchedEui64 = eui64;
          // Learn the short addr for next time
          if (parsed.srcAddrMode === 2 && parsed.srcAddr.length === 2) {
            const shortAddr = parsed.srcAddr.readUInt16LE(0);
            if (!this.addrTable.has(shortAddr)) {
              this.addrTable.set(shortAddr, eui64);
              const eui64Hex = formatEui64(eui64);
              this.onAddressLearned?.(shortAddr, eui64Hex);
            }
          }
          break;
        }
      }
    }

    if (!plaintext) return null;

    // Scan for CBOR array marker (0x82 = 2-element array)
    for (let i = 0; i < plaintext.length - 2; i++) {
      if (plaintext[i] !== 0x82) continue;
      try {
        const ts = timestamp ?? new Date();
        const eui64Hex = formatEui64(matchedEui64);
        return buildPacket({
          timestamp: ts.toISOString(),
          srcAddr: formatAddr(parsed.srcAddr),
          dstAddr: formatAddr(parsed.dstAddr),
          srcEui64: eui64Hex,
          dstEui64: "",
          payloadHex: plaintext.subarray(i).toString("hex"),
        });
      } catch {
        /* try next offset */
      }
    }

    return null;
  }

  /**
   * Learn a short-addr → EUI-64 mapping externally (e.g., from tshark fields).
   */
  learnAddress(shortAddr: number, eui64: Buffer): boolean {
    if (this.addrTable.has(shortAddr)) return false;
    this.addrTable.set(shortAddr, eui64);
    return true;
  }
}

/** Reverse 8-byte EUI-64 from LE (802.15.4 frame order) to BE (canonical) */
function reverseEui64(le: Buffer): Buffer {
  const be = Buffer.allocUnsafe(8);
  for (let i = 0; i < 8; i++) be[i] = le[7 - i];
  return be;
}

function formatEui64(eui64: Buffer): string {
  return eui64
    .toString("hex")
    .replace(/(.{2})/g, "$1:")
    .slice(0, -1);
}
