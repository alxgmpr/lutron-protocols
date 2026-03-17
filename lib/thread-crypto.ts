/**
 * Thread 802.15.4 MAC-layer cryptography
 *
 * Key derivation: HMAC-SHA256(master_key, seq_BE[4] || "Thread")
 *   → bytes[0:16]  = MLE key
 *   → bytes[16:32] = MAC key
 *
 * AES-128-CCM* nonce (13 bytes):
 *   EUI-64[8] || frame_counter_BE[4] || security_level[1]
 *
 * Key insight: keySequence = keyIndex - 1 (Thread spec)
 * Key insight: frame counter in nonce is BIG-endian (not LE)
 */

import { createDecipheriv, createHmac } from "crypto";

export interface ThreadKeyPair {
  mleKey: Buffer;
  macKey: Buffer;
}

/** Derive Thread MAC and MLE keys from master key + key sequence */
export function deriveThreadKeys(
  masterKey: Buffer,
  keySequence: number,
): ThreadKeyPair {
  const data = Buffer.alloc(10);
  data.writeUInt32BE(keySequence, 0);
  Buffer.from("Thread").copy(data, 4);
  const hash = createHmac("sha256", masterKey).update(data).digest();
  return { mleKey: hash.subarray(0, 16), macKey: hash.subarray(16, 32) };
}

/** MIC length for a given 802.15.4 security level */
export function micLength(secLevel: number): number {
  // Levels 0,4 = no MIC; 1,5 = 4; 2,6 = 8; 3,7 = 16
  const micMap: Record<number, number> = {
    0: 0,
    1: 4,
    2: 8,
    3: 16,
    4: 0,
    5: 4,
    6: 8,
    7: 16,
  };
  return micMap[secLevel] ?? 0;
}

/** Build 13-byte AES-CCM* nonce: EUI-64[8] + frameCounter_BE[4] + secLevel[1] */
export function buildNonce(
  eui64: Buffer,
  frameCounter: number,
  secLevel: number,
): Buffer {
  const nonce = Buffer.alloc(13);
  eui64.copy(nonce, 0);
  nonce.writeUInt32BE(frameCounter, 8);
  nonce[12] = secLevel;
  return nonce;
}

export interface DecryptMacFrameOpts {
  /** Full 802.15.4 frame bytes */
  frame: Buffer;
  /** Byte offset where encrypted payload begins (end of header) */
  headerEnd: number;
  /** 802.15.4 security level (typically 5 for Thread) */
  secLevel: number;
  /** Frame counter from aux security header */
  frameCounter: number;
  /** AES-128 MAC key (16 bytes) */
  macKey: Buffer;
  /** Source EUI-64 (8 bytes) — used in nonce */
  eui64: Buffer;
}

/** Decrypt an 802.15.4 MAC-layer encrypted frame. Returns plaintext or null. */
export function decryptMacFrame(opts: DecryptMacFrameOpts): Buffer | null {
  const { frame, headerEnd, secLevel, frameCounter, macKey, eui64 } = opts;
  const mic = micLength(secLevel);
  if (mic === 0) return null;

  const authData = frame.subarray(0, headerEnd);
  const encPayload = frame.subarray(headerEnd, frame.length - mic);
  const tag = frame.subarray(frame.length - mic);

  if (encPayload.length <= 0) return null;

  const nonce = buildNonce(eui64, frameCounter, secLevel);

  try {
    const decipher = createDecipheriv("aes-128-ccm", macKey, nonce, {
      authTagLength: mic,
    });
    decipher.setAuthTag(tag);
    decipher.setAAD(authData, { plaintextLength: encPayload.length });
    const plaintext = decipher.update(encPayload);
    decipher.final();
    return plaintext;
  } catch {
    return null;
  }
}
