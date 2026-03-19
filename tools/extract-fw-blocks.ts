#!/usr/bin/env -S npx tsx
/**
 * Extract firmware image from captured CoAP Block1 PUT payloads.
 *
 * Reads the TSV file produced by tshark (frame.time_relative + udp.payload hex)
 * and reconstructs the firmware image from CoAP Block1 numbered chunks.
 *
 * Usage:
 *   npx tsx tools/extract-fw-blocks.ts /tmp/ccx-fw-capture/fw-payloads.tsv
 */

import { readFileSync, writeFileSync } from "fs";
import { parseCoapPacket } from "../ccx/coap";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx tools/extract-fw-blocks.ts <payloads.tsv>");
  process.exit(1);
}

const lines = readFileSync(file, "utf-8").trim().split("\n");
console.log(`Loaded ${lines.length} CoAP PUT payloads\n`);

// Parse all packets and extract Block1 option + payload
interface FwBlock {
  blockNum: number;
  szx: number;
  more: boolean;
  payload: Buffer;
  time: number;
}

const blocks = new Map<number, FwBlock>();
let totalPackets = 0;
let duplicates = 0;
let parseErrors = 0;

for (const line of lines) {
  const [timeStr, payloadHex] = line.split("\t");
  if (!payloadHex) continue;
  totalPackets++;

  const cleanHex = payloadHex.replace(/:/g, "");
  const pkt = parseCoapPacket(Buffer.from(cleanHex, "hex"));
  if (!pkt) {
    parseErrors++;
    continue;
  }

  // Find Block1 option (option number 27)
  const block1Opt = pkt.options.find((o) => o.number === 27);
  if (!block1Opt) {
    parseErrors++;
    continue;
  }

  // Decode Block1 value: NUM | M | SZX
  // SZX = last 3 bits, M = 4th bit, NUM = remaining upper bits
  let block1Val = 0;
  for (let i = 0; i < block1Opt.value.length; i++) {
    block1Val = (block1Val << 8) | block1Opt.value[i];
  }

  const szx = block1Val & 0x07;
  const more = (block1Val >> 3) & 0x01;
  const blockNum = block1Val >> 4;

  if (!blocks.has(blockNum)) {
    blocks.set(blockNum, {
      blockNum,
      szx,
      more: more === 1,
      payload: pkt.payload,
      time: parseFloat(timeStr),
    });
  } else {
    duplicates++;
  }
}

console.log(`Parsed: ${totalPackets} packets`);
console.log(`Unique blocks: ${blocks.size}`);
console.log(`Duplicates: ${duplicates} (retransmissions)`);
console.log(`Parse errors: ${parseErrors}`);

if (blocks.size === 0) {
  console.error("No blocks extracted!");
  process.exit(1);
}

// Sort blocks by number
const sorted = [...blocks.values()].sort((a, b) => a.blockNum - b.blockNum);
const firstBlock = sorted[0];
const lastBlock = sorted[sorted.length - 1];
const blockSize = 1 << (firstBlock.szx + 4);

console.log(`\nBlock size: ${blockSize} bytes (SZX=${firstBlock.szx})`);
console.log(
  `Block range: ${firstBlock.blockNum} — ${lastBlock.blockNum} (${sorted.length} blocks)`,
);
console.log(`Expected blocks: 0 — ${lastBlock.blockNum}`);
console.log(
  `Last block more flag: ${lastBlock.more} (should be false for final block)`,
);

// Check for gaps
const expectedCount = lastBlock.blockNum - firstBlock.blockNum + 1;
const gaps: number[] = [];
for (let i = firstBlock.blockNum; i <= lastBlock.blockNum; i++) {
  if (!blocks.has(i)) gaps.push(i);
}

if (gaps.length > 0) {
  console.log(`\nGAPS: ${gaps.length} missing blocks!`);
  if (gaps.length <= 20) {
    console.log(`  Missing: ${gaps.join(", ")}`);
  } else {
    console.log(`  First 20: ${gaps.slice(0, 20).join(", ")}...`);
  }
} else {
  console.log(`\nNo gaps — all ${expectedCount} blocks present!`);
}

// Reconstruct image
const imageSize = lastBlock.blockNum * blockSize + lastBlock.payload.length;
const image = Buffer.alloc(imageSize);

for (const block of sorted) {
  const offset = block.blockNum * blockSize;
  block.payload.copy(image, offset);
}

console.log(
  `\nReconstructed image: ${imageSize} bytes (${(imageSize / 1024).toFixed(1)} KB)`,
);

// Content identification
const MCUBOOT_MAGIC = 0x96f3b83d;
if (image.length >= 4 && image.readUInt32LE(0) === MCUBOOT_MAGIC) {
  console.log("\nMCUboot image header found at offset 0!");
  if (image.length >= 32) {
    const hdrSize = image.readUInt16LE(8);
    const imgSize = image.readUInt32LE(12);
    const flags = image.readUInt32LE(16);
    const major = image[20];
    const minor = image[21];
    const rev = image.readUInt16LE(22);
    const buildNum = image.readUInt32LE(24);
    console.log(`  Header size: ${hdrSize}`);
    console.log(`  Image size:  ${imgSize} bytes`);
    console.log(`  Flags:       0x${flags.toString(16)}`);
    console.log(`  Version:     ${major}.${minor}.${rev}+${buildNum}`);
  }
} else {
  console.log(
    `\nFirst 4 bytes: 0x${image.readUInt32LE(0).toString(16).padStart(8, "0")} (not MCUboot magic)`,
  );
}

// Entropy check
const byteFreq = new Uint32Array(256);
const sample = image.subarray(0, Math.min(image.length, 4096));
for (const b of sample) byteFreq[b]++;
let entropy = 0;
for (const count of byteFreq) {
  if (count === 0) continue;
  const p = count / sample.length;
  entropy -= p * Math.log2(p);
}
console.log(
  `Entropy: ${entropy.toFixed(2)} bits/byte (${entropy > 7.5 ? "ENCRYPTED/COMPRESSED" : entropy > 6 ? "binary/code" : "structured data"})`,
);
console.log(`First 64 bytes: ${image.subarray(0, 64).toString("hex")}`);
console.log(`Last 16 bytes:  ${image.subarray(-16).toString("hex")}`);

// Save
const outFile = "/tmp/ccx-fw-capture/fw-image.bin";
writeFileSync(outFile, image);
console.log(`\nFirmware image saved to: ${outFile}`);

// Also dump the /fw/ia and other metadata if found
console.log("\n--- Transfer timeline ---");
const times = sorted.map((b) => b.time);
const duration = times[times.length - 1] - times[0];
const speed = imageSize / duration;
console.log(
  `First block at t=${times[0].toFixed(1)}s, last at t=${times[times.length - 1].toFixed(1)}s`,
);
console.log(
  `Duration: ${duration.toFixed(1)}s, speed: ${(speed / 1024).toFixed(1)} KB/s`,
);
console.log(
  `Passes: ~${(totalPackets / sorted.length).toFixed(1)} (${totalPackets} packets / ${sorted.length} blocks)`,
);
