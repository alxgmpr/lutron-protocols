#!/usr/bin/env bun

/**
 * Thread 802.15.4 Frame Decryptor
 *
 * Decrypts Thread MAC-layer encrypted frames that Wireshark can't handle
 * (key identifier mode 1 with short addressing, no key source field).
 *
 * Thread Key Derivation:
 *   HMAC-SHA256(master_key, key_sequence_as_4_bytes_BE)
 *   → bytes[0:16]  = MAC encryption key
 *   → bytes[16:32] = MLE key
 *
 * AES-128-CCM* nonce (13 bytes):
 *   source_eui64[8] || frame_counter_LE[4] || security_level[1]
 */

import { createHmac, createDecipheriv } from "crypto";
import { execSync } from "child_process";
import { buildPacket, formatMessage, getMessageTypeName } from "../ccx/decoder";

const MASTER_KEY = Buffer.from("00000000000000000000000000000000", "hex");

function deriveThreadKeys(masterKey: Buffer, keySequence: number): { mleKey: Buffer; macKey: Buffer } {
  // Thread spec: HMAC-SHA256(master_key, seq_counter_BE || "Thread")
  const data = Buffer.alloc(10);
  data.writeUInt32BE(keySequence, 0);
  Buffer.from("Thread").copy(data, 4);
  const hash = createHmac("sha256", masterKey).update(data).digest();
  // MLE key = first 16 bytes, MAC key = last 16 bytes
  return { mleKey: hash.subarray(0, 16), macKey: hash.subarray(16, 32) };
}

function parseFrame(frame: Buffer) {
  let o = 0;
  const fc = frame.readUInt16LE(o); o += 2;
  const seqNum = frame[o++];
  const dstAddrMode = (fc >> 10) & 0x03;
  const srcAddrMode = (fc >> 14) & 0x03;
  const panCompress = !!(fc & 0x40);

  // Dest PAN
  let dstPan = 0;
  if (dstAddrMode) { dstPan = frame.readUInt16LE(o); o += 2; }

  // Dest addr
  const dstLen = dstAddrMode === 2 ? 2 : dstAddrMode === 3 ? 8 : 0;
  const dstAddr = frame.subarray(o, o + dstLen); o += dstLen;

  // Src PAN
  if (!panCompress && srcAddrMode) { o += 2; }

  // Src addr
  const srcLen = srcAddrMode === 2 ? 2 : srcAddrMode === 3 ? 8 : 0;
  const srcAddr = frame.subarray(o, o + srcLen); o += srcLen;

  // Aux security header
  const secControl = frame[o++];
  const secLevel = secControl & 0x07;
  const keyIdMode = (secControl >> 3) & 0x03;
  const frameCounter = frame.readUInt32LE(o); o += 4;

  let keyIndex = 0;
  if (keyIdMode === 1) { keyIndex = frame[o++]; }
  else if (keyIdMode === 2) { o += 4; keyIndex = frame[o++]; }
  else if (keyIdMode === 3) { o += 8; keyIndex = frame[o++]; }

  return { seqNum, dstPan, dstAddr, srcAddr, secLevel, keyIdMode, frameCounter, keyIndex, headerEnd: o, srcAddrMode };
}

function tryDecrypt(
  frame: Buffer,
  headerEnd: number,
  secLevel: number,
  frameCounter: number,
  macKey: Buffer,
  eui64: Buffer,
): Buffer | null {
  const micLen = secLevel === 5 ? 4 : secLevel === 6 ? 8 : secLevel === 7 ? 16 : secLevel === 1 ? 4 : secLevel === 2 ? 8 : secLevel === 3 ? 16 : 0;
  if (micLen === 0) return null;

  const authData = frame.subarray(0, headerEnd);
  const encPayload = frame.subarray(headerEnd, frame.length - micLen);
  const mic = frame.subarray(frame.length - micLen);

  if (encPayload.length <= 0) return null;

  // Build nonce: EUI-64(8) + frame_counter_LE(4) + sec_level(1)
  const nonce = Buffer.alloc(13);
  eui64.copy(nonce, 0);
  nonce.writeUInt32LE(frameCounter, 8);
  nonce[12] = secLevel;

  try {
    const decipher = createDecipheriv("aes-128-ccm", macKey, nonce, { authTagLength: micLen });
    decipher.setAuthTag(mic);
    decipher.setAAD(authData, { plaintextLength: encPayload.length });
    const plaintext = decipher.update(encPayload);
    decipher.final();
    return plaintext;
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────

const pcapFile = process.argv[2] || "/tmp/ccx-raw-capture.pcapng";

// Get all known EUI-64s
const eui64sRaw = execSync(
  `tshark -r "${pcapFile}" -T fields -e wpan.src64 2>/dev/null`,
).toString().trim().split("\n").filter(s => s.includes(":"));
const uniqueEui64s = [...new Set(eui64sRaw)];
const eui64Bufs = uniqueEui64s.map(s => Buffer.from(s.replace(/:/g, ""), "hex"));

// Add candidate EUI-64s for the slider dimmer
// Serial 72460192 = 0x00000000
// Try common EUI-64 derivations from serial
const serial = 0x00000000;
const serialBytes = Buffer.alloc(4);
serialBytes.writeUInt32BE(serial);

// Pattern: 00:00:00:ff:fe:00:XX:XX (short addr padded with ff:fe)
// Short addr 0x6c06 → 00:00:00:ff:fe:00:6c:06
const shortAddrEui = Buffer.from("000000fffe006c06", "hex");
eui64Bufs.push(shortAddrEui);

// Pattern: short addr padded different ways
eui64Bufs.push(Buffer.from("0000006c06000000", "hex"));
eui64Bufs.push(Buffer.from("00006c0600000000", "hex"));

// Pattern: serial-based EUI-64
eui64Bufs.push(Buffer.from("000000fffe" + serialBytes.toString("hex"), "hex")); // 00:00:00:ff:fe:04:51:a7
eui64Bufs.push(Buffer.from("0000" + serialBytes.toString("hex") + "0000", "hex"));
eui64Bufs.push(Buffer.from(serialBytes.toString("hex") + "00000000", "hex"));
eui64Bufs.push(Buffer.from("00000000" + serialBytes.toString("hex"), "hex"));

// Try Lutron OUI-based patterns (Lutron IEEE OUI: 00:0B:E1 or 24:86:F4)
eui64Bufs.push(Buffer.from("000be1fffe" + serialBytes.toString("hex").slice(2), "hex"));
eui64Bufs.push(Buffer.from("2486f4fffe" + serialBytes.toString("hex").slice(2), "hex"));

// Also try all-zeros and ff-padded
eui64Bufs.push(Buffer.from("0000000000000000", "hex"));
eui64Bufs.push(Buffer.from("ffffffffffffffff", "hex"));

// Try the source short address in the nonce position directly
// Per 802.15.4 spec, when extended address is not available,
// the nonce may use the short address padded to 8 bytes
// Format: 0x0000 || 0xFFFF || PAN_ID(2) || SHORT_ADDR(2) (per some implementations)
const panId = 0xXXXX;
const srcShort = 0x6c06;
const noncePad1 = Buffer.alloc(8);
noncePad1.writeUInt16BE(panId, 0);
noncePad1.writeUInt16LE(srcShort, 2); // or BE
eui64Bufs.push(noncePad1);

const noncePad2 = Buffer.alloc(8);
noncePad2.writeUInt16LE(panId, 4);
noncePad2.writeUInt16LE(srcShort, 6);
eui64Bufs.push(noncePad2);

const noncePad3 = Buffer.alloc(8);
noncePad3.writeUInt16BE(0xFFFF, 0);
noncePad3.writeUInt16BE(panId, 2);
noncePad3.writeUInt16BE(srcShort, 4);
eui64Bufs.push(noncePad3);

console.log(`EUI-64 candidates: ${eui64Bufs.length} (${uniqueEui64s.length} from network + ${eui64Bufs.length - uniqueEui64s.length} generated)`);

// Derive MAC keys for key sequences 0-10
const macKeys: { seq: number; key: Buffer }[] = [];
for (let seq = 0; seq <= 10; seq++) {
  const { macKey } = deriveThreadKeys(MASTER_KEY, seq);
  macKeys.push({ seq, key: macKey });
}

// Get undecrypted frames via tshark hex dump
const hexDump = execSync(
  `tshark -r "${pcapFile}" -Y "wpan.dst_pan == 0xXXXX && !(ipv6 || mle || zbee_nwk)" -x 2>/dev/null`,
).toString();

// Parse hex dump blocks
const frameBlocks = hexDump.split(/\nPacket \(/).map((b, i) => i === 0 ? b : "Packet (" + b);

let decrypted = 0;
for (const block of frameBlocks) {
  // Extract the "IEEE 802.15.4 Data" hex section
  const dataMatch = block.match(/IEEE 802\.15\.4 Data \((\d+) bytes\):\n([\s\S]+?)(?:\n\n|\n$|$)/);
  if (!dataMatch) continue;

  let frameHex = "";
  for (const line of dataMatch[2].split("\n")) {
    if (/^[0-9a-f]{4}\s/.test(line)) {
      frameHex += line.substring(6, 53).trim().replace(/\s+/g, "");
    }
  }
  if (!frameHex) continue;

  const frame = Buffer.from(frameHex, "hex");
  const parsed = parseFrame(frame);

  const srcHex = parsed.srcAddr.toString("hex");
  const dstHex = parsed.dstAddr.toString("hex");
  console.log(`\nFrame: src=0x${srcHex} dst=0x${dstHex} secLevel=${parsed.secLevel} keyMode=${parsed.keyIdMode} keyIdx=${parsed.keyIndex} fc=${parsed.frameCounter} payloadLen=${frame.length - parsed.headerEnd}`);

  let found = false;
  for (const { seq, key } of macKeys) {
    for (const eui64 of eui64Bufs) {
      const result = tryDecrypt(frame, parsed.headerEnd, parsed.secLevel, parsed.frameCounter, key, eui64);
      if (result) {
        const eui64Hex = eui64.toString("hex").replace(/(.{2})/g, "$1:").slice(0, -1);
        console.log(`  DECRYPTED (seq=${seq}, eui64=${eui64Hex})`);
        console.log(`  Plaintext (${result.length} bytes): ${result.toString("hex")}`);

        // Try to find the UDP payload (6LoWPAN → IPv6 → UDP → CBOR)
        // The decrypted data is a 6LoWPAN compressed IPv6+UDP packet
        // Look for CBOR array marker (0x82) followed by CCX message type
        const cborIdx = result.indexOf(0x82);
        if (cborIdx >= 0) {
          const cborData = result.subarray(cborIdx);
          console.log(`  CBOR at offset ${cborIdx}: ${cborData.toString("hex")}`);
          try {
            const pkt = buildPacket({
              timestamp: "", srcAddr: `mesh:0x${srcHex}`, dstAddr: `mesh:0x${dstHex}`,
              srcEui64: eui64Hex, dstEui64: "", payloadHex: cborData.toString("hex"),
            });
            console.log(`  → ${getMessageTypeName(pkt.msgType)} ${formatMessage(pkt.parsed)}`);
          } catch (e) {
            console.log(`  → CBOR decode failed: ${(e as Error).message}`);
          }
        }

        decrypted++;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    console.log("  FAILED — no key/EUI-64 combination worked");
  }
}

console.log(`\n${decrypted} frame(s) decrypted`);
