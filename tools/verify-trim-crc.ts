#!/usr/bin/env bun
// Figure out what bytes 22-23 (0x23 0x0B) are in trim config packets.
// They're the SAME across packets with different seq/zone/trim values.
// So they're NOT CRC of the full packet. Test CRC over various subsets.

const CRC_POLY = 0xca0f;
const CRC_TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let crc = (i << 8) & 0xffff;
  for (let j = 0; j < 8; j++) {
    if (crc & 0x8000) crc = ((crc << 1) ^ CRC_POLY) & 0xffff;
    else crc = (crc << 1) & 0xffff;
  }
  CRC_TABLE[i] = crc;
}

function calcCrc(data: number[]): number {
  let crc = 0;
  for (const byte of data) {
    const upper = (crc >> 8) & 0xff;
    crc = ((((crc << 8) & 0xff00) + byte) ^ CRC_TABLE[upper]) & 0xffff;
  }
  return crc;
}

function hex(b: number): string {
  return b.toString(16).padStart(2, "0").toUpperCase();
}
function parseHex(s: string): number[] {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((b) => parseInt(b, 16));
}

// All real bridge trim config packets (from user's captures)
const packets = [
  // Call 1, pkt 1 (AD, seq 01) - byte 20=F6, byte 21=30
  parseHex(
    "a1 01 ad 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 f6 30 23 0b",
  ),
  // Call 1, pkt 2 (AF, seq 88) - byte 20=F6, byte 21=30
  parseHex(
    "a1 88 af 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 f6 30 23 0b",
  ),
  // Call 2, pkt 1 (AD, seq 01) - byte 20=F9, byte 21=20 (DIFFERENT!)
  parseHex(
    "a1 01 ad 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 f9 20 23 0b",
  ),
  // Call 2, pkt 2 (AF, seq 02) - byte 20=F9, byte 21=30
  parseHex(
    "a1 02 af 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 f9 30 23 0b",
  ),
  // Earlier high-end capture
  parseHex(
    "a2 02 af 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 35 23 0b",
  ),
  // Earlier low-end capture
  parseHex(
    "a2 02 af 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 38 23 0b",
  ),
  // Earlier 92% capture
  parseHex(
    "a2 01 ad 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ea 35 23 0b",
  ),
  // Earlier 93% capture
  parseHex(
    "a2 01 ad 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ec 35 23 0b",
  ),
  // New low-end from user
  parseHex(
    "a3 02 af 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 f9 35 23 0b",
  ),
];

const TARGET = 0x230b;

console.log("=== TESTING CRC OVER VARIOUS BYTE SUBSETS ===\n");
console.log(`Target: 0x${TARGET.toString(16).toUpperCase()} (bytes 22-23)\n`);

// Test every possible starting position (0-21) with ending at byte 21
for (let start = 0; start <= 21; start++) {
  const subset = packets[0].slice(start, 22);
  const crc = calcCrc(subset);
  // Check if ALL packets produce the same CRC for this range
  let allMatch = true;
  for (const pkt of packets) {
    if (calcCrc(pkt.slice(start, 22)) !== crc) {
      allMatch = false;
      break;
    }
  }
  const match = crc === TARGET ? " <<< MATCH!" : "";
  const consistent = allMatch ? " (same across all packets)" : " (varies)";
  if (match || allMatch) {
    console.log(
      `  CRC[${start}..21] = 0x${hex(crc >> 8)}${hex(crc & 0xff)}${match}${consistent}`,
    );
  }
}

// Also test subsets ending at byte 20 (maybe byte 21 is part of "CRC")
console.log("\n--- Testing subsets ending at byte 20 ---");
for (let start = 0; start <= 20; start++) {
  const results = packets.map((pkt) => calcCrc(pkt.slice(start, 21)));
  // Check if any of these match 0x230B
  if (results[0] === TARGET) {
    console.log(
      `  CRC[${start}..20] = 0x${hex(results[0] >> 8)}${hex(results[0] & 0xff)} <<< MATCH!`,
    );
  }
}

// What if 23 0B isn't CRC at all but just constant data?
console.log("\n=== CHECKING IF 0x23 0x0B ARE CONSTANT ACROSS ALL CAPTURES ===");
for (let i = 0; i < packets.length; i++) {
  const b22 = packets[i][22],
    b23 = packets[i][23];
  console.log(
    `  Packet ${i}: bytes[22-23] = ${hex(b22)} ${hex(b23)} ${b22 === 0x23 && b23 === 0x0b ? "✓" : "✗ DIFFERENT!"}`,
  );
}

// Check byte 21 difference between AD and AF zone packets
console.log("\n=== BYTE 20-21 (TRIM VALUES) ANALYSIS ===");
for (let i = 0; i < packets.length; i++) {
  const zone = packets[i][2] === 0xad ? "AD" : "AF";
  const b20 = packets[i][20],
    b21 = packets[i][21];
  const seq = packets[i][1];
  const pctHigh = Math.round((b20 * 100) / 254);
  const pctLow = Math.round((b21 * 100) / 254);
  console.log(
    `  Pkt ${i}: zone=${zone} seq=${hex(seq)} high=0x${hex(b20)}(${pctHigh}%) low=0x${hex(b21)}(${pctLow}%)`,
  );
}

// What if it's a simple checksum (not CRC)?
console.log("\n=== TESTING SIMPLE CHECKSUMS ===");
// XOR of all bytes
for (const range of [
  [13, 22],
  [6, 22],
  [8, 22],
  [0, 22],
]) {
  const [s, e] = range;
  const results = packets.map((pkt) => {
    let xor = 0;
    for (let i = s; i < e; i++) xor ^= pkt[i];
    return xor;
  });
  const allSame = results.every((r) => r === results[0]);
  console.log(
    `  XOR[${s}..${e - 1}] = 0x${hex(results[0])} ${allSame ? "(consistent)" : "(varies)"}`,
  );
}

// Sum mod 256
for (const range of [
  [13, 22],
  [6, 22],
  [8, 22],
]) {
  const [s, e] = range;
  const results = packets.map((pkt) => {
    let sum = 0;
    for (let i = s; i < e; i++) sum = (sum + pkt[i]) & 0xff;
    return sum;
  });
  const allSame = results.every((r) => r === results[0]);
  console.log(
    `  SUM[${s}..${e - 1}] mod 256 = 0x${hex(results[0])} ${allSame ? "(consistent)" : "(varies)"}`,
  );
}
