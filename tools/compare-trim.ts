#!/usr/bin/env bun
// Deep byte-by-byte comparison of our trim TX vs real bridge captures

const FIELD_MAP: Record<number, string> = {
  0: 'type',
  1: 'seq',
  2: 'zone[0]',
  3: 'zone[1]',
  4: 'zone[2]',
  5: 'zone[3]',
  6: 'proto',
  7: 'format',
  8: 'zero',
  9: 'dev[0]',
  10: 'dev[1]',
  11: 'dev[2]',
  12: 'dev[3]',
  13: 'cmd[0]',
  14: 'cmd[1]',
  15: 'cmd[2]',
  16: 'cmd[3]',
  17: 'sub[0]',
  18: 'sub[1]',
  19: 'sub[2]',
  20: 'HIGH_TRIM',
  21: 'LOW_TRIM',
  22: 'byte22',
  23: 'byte23',
  24: 'byte24',
  25: 'byte25',
  26: 'byte26',
  51: 'crc[0]',
  52: 'crc[1]',
};

// Bytes that are EXPECTED to differ between devices
const EXPECTED_DIFF = new Set([0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 20, 21, 51, 52]);

function parseHex(s: string): number[] {
  const clean = s.replace(/\s+/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

function hex(b: number): string {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

// ── Our TX packets ──
const ourTx = parseHex('A101AD01100021150006FDEF87FE065000020813983F230B600000CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC6929');

// ── Real bridge captures ──

// High-end trim (entire-trim-test-and-save-high-end_2026-02-10T13-33-14.csv)
// Line 5: a2 02 af 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 35 23 0b
// Line 6 (shifted +3): 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 35 23 0b 60 00 00
const realHighNonShifted = parseHex('a2 02 af 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 35 23 0b');
const realHighShifted = parseHex('90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 35 23 0b 60 00 00');
// Reconstruct full packet: non-shifted gives bytes 0-23, shifted gives bytes 3-26
const realHigh = [...realHighNonShifted];
// Fill bytes 24-26 from shifted (shifted offset=3, so shifted[21]=byte24, shifted[22]=byte25, shifted[23]=byte26)
realHigh[24] = realHighShifted[21]; // 0x60
realHigh[25] = realHighShifted[22]; // 0x00
realHigh[26] = realHighShifted[23]; // 0x00

// Low-end trim (entire-trim-test-and-save-low-end_2026-02-10T13-33-58.csv)
// Line 5: a2 02 af 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 38 23 0b
// Line 6 (shifted +3): 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 38 23 0b 60 00 00
const realLowNonShifted = parseHex('a2 02 af 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 38 23 0b');
const realLowShifted = parseHex('90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ef 38 23 0b 60 00 00');
const realLow = [...realLowNonShifted];
realLow[24] = realLowShifted[21];
realLow[25] = realLowShifted[22];
realLow[26] = realLowShifted[23];

// Earlier captures for cross-reference
// high-end-trim-92: a2 01 ad 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ea 35 23 0b
// high-end-trim-93: a2 01 ad 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ec 35 23 0b
const real92 = parseHex('a2 01 ad 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ea 35 23 0b');
const real93 = parseHex('a2 01 ad 90 2c 00 21 15 00 07 03 c3 c6 fe 06 50 00 02 08 13 ec 35 23 0b');

console.log('═══════════════════════════════════════════════════════════════');
console.log('TRIM PACKET DEEP COMPARISON');
console.log('═══════════════════════════════════════════════════════════════\n');

// Compare function
function compare(label: string, ours: number[], theirs: number[], theirLabel: string) {
  console.log(`── ${label} ──`);
  console.log(`Ours:   ${ours.length} bytes`);
  console.log(`Theirs: ${theirs.length} bytes (${theirLabel})\n`);

  const maxLen = Math.max(ours.length, theirs.length);
  const diffs: string[] = [];
  const unexpectedDiffs: string[] = [];

  console.log('Byte  Field        Ours   Theirs  Match');
  console.log('────  ───────────  ─────  ──────  ─────');

  for (let i = 0; i < Math.min(maxLen, 53); i++) {
    const field = FIELD_MAP[i] || (i >= 27 && i <= 50 ? 'pad' : `b${i}`);
    const ourByte = i < ours.length ? hex(ours[i]) : '--';
    const theirByte = i < theirs.length ? hex(theirs[i]) : '--';

    let match: string;
    if (i >= theirs.length) {
      match = '(no data)';
    } else if (i >= ours.length) {
      match = '(no data)';
    } else if (ours[i] === theirs[i]) {
      match = '  ✓';
    } else if (EXPECTED_DIFF.has(i)) {
      match = '  ~ (expected diff)';
      diffs.push(`  b${i.toString().padStart(2)} ${field.padEnd(10)} ${ourByte} vs ${theirByte} (expected: different device/zone/seq)`);
    } else {
      match = '  ✗ UNEXPECTED';
      unexpectedDiffs.push(`  b${i.toString().padStart(2)} ${field.padEnd(10)} ${ourByte} vs ${theirByte}`);
    }

    // Only print interesting bytes (not padding)
    if (i <= 26 || i >= 51 || ours[i] !== 0xCC || (i < theirs.length && theirs[i] !== 0xCC)) {
      console.log(`  ${i.toString().padStart(2)}   ${field.padEnd(12)} 0x${ourByte}   0x${theirByte}   ${match}`);
    }
  }

  if (unexpectedDiffs.length > 0) {
    console.log('\n⚠️  UNEXPECTED DIFFERENCES (these should match!):');
    unexpectedDiffs.forEach(d => console.log(d));
  } else {
    console.log('\n✓ All non-device-specific bytes match');
  }
  console.log('');
}

// Run comparisons
compare('Our TX vs Real Bridge HIGH-END trim', ourTx, realHigh, 'entire-trim-high-end');
compare('Our TX vs Real Bridge LOW-END trim', ourTx, realLow, 'entire-trim-low-end');
compare('Our TX vs Earlier HIGH-END 92%', ourTx, real92, 'high-end-trim-92');
compare('Our TX vs Earlier HIGH-END 93%', ourTx, real93, 'high-end-trim-93');

// Cross-reference all real captures
console.log('── REAL BRIDGE CROSS-REFERENCE (bytes 13-26) ──');
console.log('Shows ONLY the command payload across all real captures\n');
const reals = [
  { label: 'high-end (full)', data: realHigh },
  { label: 'low-end (full)',  data: realLow },
  { label: '92% (earlier)',   data: real92 },
  { label: '93% (earlier)',   data: real93 },
];

console.log('Byte  Field       ' + reals.map(r => r.label.padEnd(18)).join(''));
console.log('────  ──────────  ' + reals.map(() => '──────────────────').join(''));
for (let i = 13; i <= 26; i++) {
  const field = FIELD_MAP[i] || `b${i}`;
  const values = reals.map(r => i < r.data.length ? `0x${hex(r.data[i])}`.padEnd(18) : '--'.padEnd(18));
  console.log(`  ${i.toString().padStart(2)}   ${field.padEnd(12)}${values.join('')}`);
}

console.log('\n── OUR TX command payload (bytes 13-26) ──');
for (let i = 13; i <= 26; i++) {
  const field = FIELD_MAP[i] || `b${i}`;
  console.log(`  ${i.toString().padStart(2)}   ${field.padEnd(12)}0x${hex(ourTx[i])}`);
}
