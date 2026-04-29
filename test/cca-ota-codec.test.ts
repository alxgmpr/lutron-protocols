import assert from "node:assert/strict";
import test from "node:test";
import {
  bitsToBytes,
  buildOtaPacket,
  bytesToBits,
  crc16,
  extractPackets,
  extractPacketsFromBits,
  findBitSync,
  findSyncOffset,
  parseOtaPacket,
} from "../lib/cca-ota-codec";

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

test("crc16 of empty buffer is 0", () => {
  assert.equal(crc16(new Uint8Array([])), 0);
});

test("crc16 with poly 0xCA0F: [0x01, 0x00, 0x00] is 0xCA0F", () => {
  assert.equal(crc16(new Uint8Array([0x01, 0x00, 0x00])), 0xca0f);
});

test("findSyncOffset returns offset just past FA DE", () => {
  // [55 55 FF FA DE 08 02 ...]  — FA DE at index 3, returns 5
  const buf = new Uint8Array([0x55, 0x55, 0xff, 0xfa, 0xde, 0x08, 0x02]);
  assert.equal(findSyncOffset(buf), 5);
});

test("findSyncOffset returns -1 when sync not present", () => {
  const buf = new Uint8Array([0x55, 0x55, 0xff, 0x12, 0x34]);
  assert.equal(findSyncOffset(buf), -1);
});

test("findSyncOffset returns first occurrence when sync appears multiple times", () => {
  const buf = new Uint8Array([0xfa, 0xde, 0x01, 0x02, 0xfa, 0xde, 0x03]);
  assert.equal(findSyncOffset(buf), 2);
});

test("findSyncOffset returns -1 when buffer ends mid-sync", () => {
  // FA at end, no DE follows
  const buf = new Uint8Array([0x55, 0xff, 0xfa]);
  assert.equal(findSyncOffset(buf), -1);
});

test("parseOtaPacket parses valid empty-body packet (op=0x35)", () => {
  // [LEN=0x01, OP=0x35, CRC_HI=0x01, CRC_LO=0x35]
  // CRC of [0x01, 0x35] = 0x0135 (hand-verified)
  const buf = new Uint8Array([0x01, 0x35, 0x01, 0x35]);
  const r = parseOtaPacket(buf);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.opcode, 0x35);
  assert.deepEqual(r.body, new Uint8Array([]));
  assert.equal(r.consumed, 4);
});

test("parseOtaPacket rejects on CRC mismatch", () => {
  const buf = new Uint8Array([0x01, 0x35, 0xde, 0xad]);
  const r = parseOtaPacket(buf);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /crc/i);
});

test("parseOtaPacket rejects buffer too short for LEN byte", () => {
  const r = parseOtaPacket(new Uint8Array([]));
  assert.equal(r.ok, false);
});

test("parseOtaPacket rejects when LEN exceeds remaining bytes", () => {
  // LEN=0x05 says op+body is 5 bytes, but buffer only has 1 byte after LEN
  const buf = new Uint8Array([0x05, 0x35]);
  const r = parseOtaPacket(buf);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /short|truncat/i);
});

test("parseOtaPacket rejects LEN=0 (no opcode)", () => {
  const buf = new Uint8Array([0x00, 0x00, 0x00]);
  const r = parseOtaPacket(buf);
  assert.equal(r.ok, false);
});

test("buildOtaPacket emits preamble + sync + LEN + OP + body + CRC for empty-body packet", () => {
  // op=0x35, body=[] → CRC over [0x01, 0x35] = 0x0135 (hand-verified)
  const wire = buildOtaPacket(0x35, new Uint8Array([]));
  assert.deepEqual(
    wire,
    new Uint8Array([
      0x55, 0x55, 0x55, 0xff, 0xfa, 0xde, 0x01, 0x35, 0x01, 0x35,
    ]),
  );
});

test("buildOtaPacket round-trips through parseOtaPacket", () => {
  for (const [op, body] of [
    [0x2a, [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]], // BeginTransfer body=7
    [0x32, [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]], // Control body=6
    [0x41, [0xde, 0xad, 0xbe, 0xef]], // TransferData body=4
    [0x58, [0x01, 0x02, 0x03, 0x04, 0x05]], // QueryDevice body=5
  ] as const) {
    const wire = buildOtaPacket(op, new Uint8Array(body));
    // Strip preamble (3) + delim (1) + sync (2) = 6 bytes to get to LEN
    const r = parseOtaPacket(wire.subarray(6));
    assert.equal(r.ok, true, `op=0x${op.toString(16)} should parse`);
    if (!r.ok) continue;
    assert.equal(r.opcode, op);
    assert.deepEqual(r.body, new Uint8Array(body));
  }
});

test("buildOtaPacket rejects opcode > 0xFF", () => {
  assert.throws(() => buildOtaPacket(0x100, new Uint8Array([])));
});

test("buildOtaPacket rejects body too long for 1-byte LEN", () => {
  // body_len + 1 (for opcode) must fit in u8 → body_len <= 254
  assert.throws(() => buildOtaPacket(0x2a, new Uint8Array(255)));
});

test("extractPackets returns empty array when stream has no sync words", () => {
  const stream = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
  assert.deepEqual(extractPackets(stream), []);
});

test("extractPackets recovers a single packet from clean stream", () => {
  const stream = buildOtaPacket(0x35, new Uint8Array([]));
  const packets = extractPackets(stream);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].opcode, 0x35);
});

test("extractPackets recovers multiple back-to-back packets", () => {
  const stream = concat(
    buildOtaPacket(0x58, new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05])),
    buildOtaPacket(0x36, new Uint8Array([0x10, 0x20, 0x30, 0x40])),
    buildOtaPacket(
      0x2a,
      new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]),
    ),
  );
  const packets = extractPackets(stream);
  assert.equal(packets.length, 3);
  assert.deepEqual(
    packets.map((p) => p.opcode),
    [0x58, 0x36, 0x2a],
  );
});

test("extractPackets skips junk between packets", () => {
  const junk = new Uint8Array([0x00, 0x00, 0xab, 0xcd, 0xef]);
  const stream = concat(
    junk,
    buildOtaPacket(0x35, new Uint8Array([])),
    junk,
    buildOtaPacket(0x41, new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
  );
  const packets = extractPackets(stream);
  assert.equal(packets.length, 2);
  assert.deepEqual(
    packets.map((p) => p.opcode),
    [0x35, 0x41],
  );
});

test("extractPackets skips CRC-corrupted packets and returns the rest", () => {
  const good = buildOtaPacket(0x35, new Uint8Array([]));
  const corrupted = buildOtaPacket(
    0x41,
    new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  );
  // Flip a body byte to break CRC
  corrupted[corrupted.length - 4] ^= 0xff;
  const stream = concat(corrupted, good);
  const packets = extractPackets(stream);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].opcode, 0x35);
});

test("extractPackets reports byte offset of each packet (LEN byte position)", () => {
  const prefix = new Uint8Array([0xab, 0xcd, 0xef]);
  const stream = concat(prefix, buildOtaPacket(0x35, new Uint8Array([])));
  const packets = extractPackets(stream);
  assert.equal(packets.length, 1);
  // Stream: [AB CD EF | 55 55 55 FF FA DE | 01 35 01 35]
  //                                         ^ offset 9 (after sync)
  assert.equal(packets[0].offset, prefix.length + 6);
});

test("bytesToBits emits LSB-first bits (0x55 → 10101010)", () => {
  assert.deepEqual(
    Array.from(bytesToBits(new Uint8Array([0x55]))),
    [1, 0, 1, 0, 1, 0, 1, 0],
  );
});

test("bytesToBits handles sync word [0xFA, 0xDE] LSB-first", () => {
  // 0xFA = 11111010 → LSB first: 0,1,0,1,1,1,1,1
  // 0xDE = 11011110 → LSB first: 0,1,1,1,1,0,1,1
  assert.deepEqual(
    Array.from(bytesToBits(new Uint8Array([0xfa, 0xde]))),
    [0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  );
});

test("bitsToBytes inverts bytesToBits", () => {
  const original = new Uint8Array([
    0x00, 0x55, 0xaa, 0xff, 0xfa, 0xde, 0x12, 0x34,
  ]);
  const bits = bytesToBits(original);
  const recovered = bitsToBytes(bits);
  assert.deepEqual(recovered, original);
});

test("bitsToBytes truncates when bit count is not multiple of 8", () => {
  // 9 bits → 1 byte (8 bits worth), trailing bit dropped
  const bits = new Uint8Array([1, 0, 1, 0, 1, 0, 1, 0, 1]);
  const bytes = bitsToBytes(bits);
  assert.equal(bytes.length, 1);
  assert.equal(bytes[0], 0x55);
});

test("findBitSync locates FA DE pattern in a bit stream", () => {
  // Junk bit, then the 16-bit FA DE pattern.
  const fade = bytesToBits(new Uint8Array([0xfa, 0xde]));
  const stream = new Uint8Array(1 + fade.length);
  stream[0] = 1; // one junk bit
  stream.set(fade, 1);
  // Returns bit offset of the byte AFTER the FA DE pattern
  assert.equal(findBitSync(stream), 1 + fade.length);
});

test("findBitSync returns -1 when sync pattern is absent", () => {
  const bits = bytesToBits(new Uint8Array([0x12, 0x34, 0x56]));
  assert.equal(findBitSync(bits), -1);
});

test("findBitSync recovers byte alignment when sync straddles a byte boundary", () => {
  // Build a stream where FA DE starts at bit offset 3 (mid-byte).
  // [3 bits junk][FA DE bits][some payload bits]
  const fade = bytesToBits(new Uint8Array([0xfa, 0xde]));
  const stream = new Uint8Array(3 + fade.length + 8);
  stream[0] = 1;
  stream[1] = 1;
  stream[2] = 0;
  stream.set(fade, 3);
  // Trailing payload bits
  for (let i = 0; i < 8; i++) stream[3 + fade.length + i] = i & 1;
  assert.equal(findBitSync(stream), 3 + fade.length);
});

test("extractPacketsFromBits recovers a packet round-tripped through bytesToBits", () => {
  const wire = buildOtaPacket(0x41, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  const bits = bytesToBits(wire);
  const packets = extractPacketsFromBits(bits);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].opcode, 0x41);
  assert.deepEqual(packets[0].body, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
});

test("extractPacketsFromBits recovers multiple bursts in a single bit stream", () => {
  const wire1 = buildOtaPacket(
    0x58,
    new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]),
  );
  const wire2 = buildOtaPacket(0x36, new Uint8Array([0x10, 0x20, 0x30, 0x40]));
  const bits = bytesToBits(concat(wire1, wire2));
  const packets = extractPacketsFromBits(bits);
  assert.equal(packets.length, 2);
  assert.deepEqual(
    packets.map((p) => p.opcode),
    [0x58, 0x36],
  );
});

test("extractPacketsFromBits tolerates bit-level junk before the sync", () => {
  const wire = buildOtaPacket(0x35, new Uint8Array([]));
  // Add 5 random junk bits before the wire bits — sync search must still align
  const wireBits = bytesToBits(wire);
  const bits = new Uint8Array(5 + wireBits.length);
  bits.set([1, 0, 1, 1, 0]);
  bits.set(wireBits, 5);
  const packets = extractPacketsFromBits(bits);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].opcode, 0x35);
});

test("extractPacketsFromBits returns empty when no sync is present", () => {
  const bits = bytesToBits(new Uint8Array([0x00, 0x11, 0x22]));
  assert.deepEqual(extractPacketsFromBits(bits), []);
});
