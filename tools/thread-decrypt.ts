#!/usr/bin/env -S npx tsx

/**
 * Thread 802.15.4 Frame Decryptor
 *
 * Two-pass tshark approach:
 *   Pass 1 — Build short→EUI-64 address table from MLE exchanges
 *   Pass 2 — Decrypt encrypted data frames using native AES-128-CCM*
 *
 * Catches frames that tshark can't decrypt (key identifier mode 1 with
 * short addressing, no key source field).
 *
 * Usage:
 *   bun run tools/thread-decrypt.ts <capture.pcapng>
 *   bun run tools/thread-decrypt.ts <capture.pcapng> --json
 */

import { execSync } from "child_process";
import { getAllDevices } from "../ccx/config";
import { buildPacket, formatMessage, getMessageTypeName } from "../ccx/decoder";
import { THREAD_MASTER_KEY as THREAD_KEY_HEX, THREAD_PANID } from "../lib/env";
import { formatAddr, parseFrame } from "../lib/ieee802154";
import { decryptMacFrame, deriveThreadKeys } from "../lib/thread-crypto";

const MASTER_KEY = Buffer.from(THREAD_KEY_HEX, "hex");
const jsonOutput = process.argv.includes("--json");

// ── Pass 1: Build short→EUI-64 address table ──────────────────────

function buildAddressTable(pcapFile: string): Map<number, Buffer> {
  const table = new Map<number, Buffer>();

  // tshark resolves short→EUI-64 from MLE exchanges and exposes via wpan.src64
  const raw = execSync(
    `tshark -r "${pcapFile}" -T fields -e wpan.src16 -e wpan.src64 -Y "wpan.src64" 2>/dev/null`,
  )
    .toString()
    .trim();

  if (raw) {
    for (const line of raw.split("\n")) {
      const [shortHex, eui64Str] = line.split("\t");
      if (!shortHex || !eui64Str || !eui64Str.includes(":")) continue;
      const shortAddr = parseInt(shortHex.replace("0x", ""), 16);
      if (Number.isNaN(shortAddr)) continue;
      const eui64 = Buffer.from(eui64Str.replace(/:/g, ""), "hex");
      if (eui64.length === 8) {
        table.set(shortAddr, eui64);
      }
    }
  }

  // Supplement with EUI-64s from device map (Designer DB / LEAP)
  for (const dev of getAllDevices()) {
    if (dev.eui64) {
      const eui64 = Buffer.from(dev.eui64.replace(/:/g, ""), "hex");
      if (eui64.length === 8) {
        // We don't know the short address, but we can use these for brute-force fallback
        // Store with a sentinel key (negative serial) so they don't collide
        table.set(-dev.serial, eui64);
      }
    }
  }

  return table;
}

// ── Pass 2: Extract and decrypt frames ─────────────────────────────

interface ExtractedFrame {
  epoch: number;
  frameNum: number;
  srcEui64: string;
  rawBytes: Buffer;
}

function extractFrames(pcapFile: string): ExtractedFrame[] {
  const filter = "wpan.security == 1 and not ipv6 and not mle";

  // Pass 2a: Get frame numbers and timestamps for encrypted frames
  const fieldsRaw = execSync(
    `tshark -r "${pcapFile}" -T fields ` +
      `-e frame.number -e frame.time_epoch -e wpan.src64 ` +
      `-Y "${filter}" 2>/dev/null`,
  )
    .toString()
    .trim();

  if (!fieldsRaw) return [];

  // Build frame number → metadata map
  const metaMap = new Map<number, { epoch: number; srcEui64: string }>();
  for (const line of fieldsRaw.split("\n")) {
    const [numStr, epochStr, srcEui64] = line.split("\t");
    metaMap.set(parseInt(numStr, 10), {
      epoch: parseFloat(epochStr),
      srcEui64: srcEui64 || "",
    });
  }

  // Pass 2b: Get raw hex dump for those frames
  // Build frame number filter
  const frameNums = [...metaMap.keys()];
  if (frameNums.length === 0) return [];

  const frameFilter = frameNums.map((n) => `frame.number == ${n}`).join(" or ");
  const hexRaw = execSync(
    `tshark -r "${pcapFile}" -x -Y "${frameFilter}" 2>/dev/null`,
  ).toString();

  // Parse hex dump: each frame has a header line "Packet (...)" or starts with "Frame N"
  // then hex sections. We want the "IEEE 802.15.4 Data" section.
  const frames: ExtractedFrame[] = [];

  const packetBlocks = hexRaw.split(/\n(?=Packet \()/);

  for (const block of packetBlocks) {
    if (!block.trim()) continue;

    // Find frame number from the "Packet" header line or match from our filter order
    // tshark outputs packets in filter order, so we can use the order
    const frameIdx = frames.length;
    if (frameIdx >= frameNums.length) break;
    const frameNum = frameNums[frameIdx];
    const meta = metaMap.get(frameNum);
    if (!meta) continue;

    // Extract the "IEEE 802.15.4 Data" hex section
    const dataMatch = block.match(
      /IEEE 802\.15\.4 Data \(\d+ bytes\):\n([\s\S]+?)(?:\n\n|\n$|$)/,
    );
    if (!dataMatch) continue;

    let hexStr = "";
    for (const line of dataMatch[1].split("\n")) {
      if (/^[0-9a-f]{4}\s/.test(line)) {
        hexStr += line.substring(6, 53).trim().replace(/\s+/g, "");
      }
    }
    if (!hexStr) continue;

    frames.push({
      epoch: meta.epoch,
      frameNum,
      srcEui64: meta.srcEui64,
      rawBytes: Buffer.from(hexStr, "hex"),
    });
  }

  return frames;
}

// ── Decryption logic ───────────────────────────────────────────────

function decryptFrame(
  ef: ExtractedFrame,
  addrTable: Map<number, Buffer>,
): { plaintext: Buffer; eui64: Buffer } | null {
  const parsed = parseFrame(ef.rawBytes);
  if (!parsed.securityEnabled) return null;

  // Derive key: keySequence = keyIndex - 1 (Thread spec)
  const keySeq = parsed.keyIndex > 0 ? parsed.keyIndex - 1 : 0;
  const { macKey } = deriveThreadKeys(MASTER_KEY, keySeq);

  const tryWith = (eui64: Buffer) =>
    decryptMacFrame({
      frame: ef.rawBytes,
      headerEnd: parsed.headerEnd,
      secLevel: parsed.secLevel,
      frameCounter: parsed.frameCounter,
      macKey,
      eui64,
    });

  // Try EUI-64 from tshark first (most reliable — resolved from MLE)
  if (ef.srcEui64?.includes(":")) {
    const eui64 = Buffer.from(ef.srcEui64.replace(/:/g, ""), "hex");
    if (eui64.length === 8) {
      const result = tryWith(eui64);
      if (result) return { plaintext: result, eui64 };
    }
  }

  // Try address table lookup (short addr → EUI-64)
  if (parsed.srcAddrMode === 2 && parsed.srcAddr.length === 2) {
    const srcShort = parsed.srcAddr.readUInt16LE(0);
    const eui64 = addrTable.get(srcShort);
    if (eui64) {
      const result = tryWith(eui64);
      if (result) return { plaintext: result, eui64 };
    }
  }

  // Brute-force: try all known EUI-64s from address table
  for (const [, eui64] of addrTable) {
    const result = tryWith(eui64);
    if (result) return { plaintext: result, eui64 };
  }

  return null;
}

// ── CBOR extraction ────────────────────────────────────────────────

function findAndDecodeCbor(
  plaintext: Buffer,
  srcHex: string,
  dstHex: string,
  srcEui64Hex: string,
  epoch: number,
): string | null {
  // Scan for CBOR array marker (0x82 = 2-element array) — CCX messages are [type, body]
  for (let i = 0; i < plaintext.length - 2; i++) {
    if (plaintext[i] !== 0x82) continue;

    const cborData = plaintext.subarray(i);
    try {
      const pkt = buildPacket({
        timestamp: new Date(epoch * 1000).toISOString(),
        srcAddr: `mesh:${srcHex}`,
        dstAddr: `mesh:${dstHex}`,
        srcEui64: srcEui64Hex,
        dstEui64: "",
        payloadHex: cborData.toString("hex"),
      });

      if (jsonOutput) {
        return JSON.stringify(pkt);
      }

      const time = pkt.timestamp.slice(11, 23);
      const typeName = getMessageTypeName(pkt.msgType).padEnd(14);
      return `${time} ${typeName} ${formatMessage(pkt.parsed)}`;
    } catch {}
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────────────

const pcapFile = process.argv.find(
  (a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1],
);

if (!pcapFile) {
  console.log(
    `Usage: bun run tools/thread-decrypt.ts <capture.pcapng> [--json]`,
  );
  process.exit(1);
}

if (!jsonOutput) {
  console.log(`Thread Frame Decryptor`);
  console.log(`  File: ${pcapFile}`);
  console.log(`  PAN ID: 0x${THREAD_PANID.toString(16).padStart(4, "0")}`);
  console.log(`  Master key: ${THREAD_KEY_HEX.slice(0, 8)}...`);
  console.log("");
}

// Pass 1: Build address table
const addrTable = buildAddressTable(pcapFile);
if (!jsonOutput) {
  const tsharkAddrs = [...addrTable.entries()].filter(([k]) => k >= 0).length;
  const deviceAddrs = [...addrTable.entries()].filter(([k]) => k < 0).length;
  console.log(
    `Address table: ${tsharkAddrs} from tshark MLE, ${deviceAddrs} from device map`,
  );
  console.log("");
}

// Pass 2: Extract and decrypt
const frames = extractFrames(pcapFile);
let decrypted = 0;
let decoded = 0;

for (const ef of frames) {
  const result = decryptFrame(ef, addrTable);
  const parsed = parseFrame(ef.rawBytes);

  if (!result) {
    if (!jsonOutput) {
      console.log(
        `#${ef.frameNum} FAILED — src=${formatAddr(parsed.srcAddr)} fc=${parsed.frameCounter} keyIdx=${parsed.keyIndex}`,
      );
    }
    continue;
  }

  decrypted++;
  const eui64Hex = result.eui64
    .toString("hex")
    .replace(/(.{2})/g, "$1:")
    .slice(0, -1);

  const srcHex = formatAddr(parsed.srcAddr);
  const dstHex = formatAddr(parsed.dstAddr);

  const line = findAndDecodeCbor(
    result.plaintext,
    srcHex,
    dstHex,
    eui64Hex,
    ef.epoch,
  );

  if (line) {
    decoded++;
    console.log(line);
  } else if (!jsonOutput) {
    console.log(
      `#${ef.frameNum} decrypted (eui64=${eui64Hex}) but no CBOR found: ${result.plaintext.toString("hex").slice(0, 60)}...`,
    );
  }
}

if (!jsonOutput) {
  console.log(
    `\n${frames.length} encrypted frames, ${decrypted} decrypted, ${decoded} decoded as CCX`,
  );
}
