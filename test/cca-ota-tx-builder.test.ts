/**
 * Tests for the host-side OTA TX builder — the TS mirror of
 * firmware/src/cca/cca_ota_tx.h.
 *
 * Ground truth pulled from
 * data/captures/cca-ota-20260428-190439.packets.jsonl
 * (Caseta Pro REP2 → DVRF-6L OTA, subnet 0xEFFD, target serial 0x06FE8020).
 *
 * The tests assert byte-for-byte equality against captured packets, with
 * the sequence byte at offset 1 zeroed (the TDMA engine sets it on the
 * wire — the builder writes 0x00 placeholder).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBeginTransfer,
  buildChangeAddressOffset,
  buildTransferData,
  OtaChunkIter,
  packetsEqualIgnoringSeq,
  walkOtaPackets,
} from "../lib/cca-ota-tx-builder";

// Captured: 92 01 a1 ef fd 00 21 0e 00 06 fe 80 20 fe 06 00 02 20 00 00 00 1f
// (sequence byte [1] = 0x00 in builder output — TDMA engine sets it)
const EXPECT_BEGIN_TRANSFER = new Uint8Array([
  0x92, 0x00, 0xa1, 0xef, 0xfd, 0x00, 0x21, 0x0e, 0x00, 0x06, 0xfe, 0x80, 0x20,
  0xfe, 0x06, 0x00, 0x02, 0x20, 0x00, 0x00, 0x00, 0x1f,
]);

test("buildBeginTransfer matches captured DVRF-6L OTA ground truth", () => {
  const pkt = buildBeginTransfer(0xeffd, 0x06fe8020);
  assert.deepEqual(pkt, EXPECT_BEGIN_TRANSFER);
  assert.equal(pkt.length, 22);
});

test("buildBeginTransfer encodes target serial big-endian at bytes 9..12", () => {
  const pkt = buildBeginTransfer(0xffff, 0xdeadbeef);
  assert.equal(pkt[9], 0xde);
  assert.equal(pkt[10], 0xad);
  assert.equal(pkt[11], 0xbe);
  assert.equal(pkt[12], 0xef);
});

test("buildBeginTransfer encodes subnet big-endian at bytes 3..4", () => {
  const pkt = buildBeginTransfer(0xfffe, 0x12345678);
  assert.equal(pkt[3], 0xff);
  assert.equal(pkt[4], 0xfe);
});

test("buildBeginTransfer payload trailing chunk size is 0x1F", () => {
  const pkt = buildBeginTransfer(0xffff, 0x12345678);
  assert.equal(pkt[21], 0x1f);
});

test("buildBeginTransfer unicast marker is 0xFE at byte 13", () => {
  const pkt = buildBeginTransfer(0xffff, 0x12345678);
  assert.equal(pkt[13], 0xfe);
});

// Captured: 91 01 a1 ef fd 00 21 0c 00 06 fe 80 20 fe 06 01 00 01 00 02 cc cc
const EXPECT_CHANGE_ADDR = new Uint8Array([
  0x91, 0x00, 0xa1, 0xef, 0xfd, 0x00, 0x21, 0x0c, 0x00, 0x06, 0xfe, 0x80, 0x20,
  0xfe, 0x06, 0x01, 0x00, 0x01, 0x00, 0x02, 0xcc, 0xcc,
]);

test("buildChangeAddressOffset matches captured ground truth", () => {
  const pkt = buildChangeAddressOffset(0xeffd, 0x06fe8020, 0x0001, 0x0002);
  assert.deepEqual(pkt, EXPECT_CHANGE_ADDR);
});

test("buildChangeAddressOffset encodes page indices big-endian at bytes 16..19", () => {
  const pkt = buildChangeAddressOffset(0xffff, 0x12345678, 0x00ab, 0x00cd);
  assert.equal(pkt[16], 0x00);
  assert.equal(pkt[17], 0xab);
  assert.equal(pkt[18], 0x00);
  assert.equal(pkt[19], 0xcd);
});

test("buildChangeAddressOffset padding bytes 20..21 are 0xCC", () => {
  const pkt = buildChangeAddressOffset(0xffff, 0x12345678, 0, 1);
  assert.equal(pkt[20], 0xcc);
  assert.equal(pkt[21], 0xcc);
});

// Captured TransferData header (bytes 0..19): sub_counter=0x23, addrLo=0x49FD.
// Hex: b3 01 a1 ef fd 00 21 2b 00 06 fe 80 20 fe 06 02 23 49 fd 1f <31 bytes>
const EXPECT_TRANSFER_DATA_HEADER = new Uint8Array([
  0xb3, 0x00, 0xa1, 0xef, 0xfd, 0x00, 0x21, 0x2b, 0x00, 0x06, 0xfe, 0x80, 0x20,
  0xfe, 0x06, 0x02, 0x23, 0x49, 0xfd, 0x1f,
]);

test("buildTransferData header matches captured DVRF-6L OTA ground truth", () => {
  const chunk = new Uint8Array(31);
  for (let i = 0; i < 31; i++) chunk[i] = (0xaa + i) & 0xff;
  const pkt = buildTransferData(0xb3, 0xeffd, 0x06fe8020, 0x23, 0x49fd, chunk);
  assert.equal(pkt.length, 51);
  assert.deepEqual(pkt.slice(0, 20), EXPECT_TRANSFER_DATA_HEADER);
});

test("buildTransferData carries chunk payload verbatim at bytes 20..50", () => {
  const chunk = new Uint8Array(31);
  for (let i = 0; i < 31; i++) chunk[i] = (0x55 + i) & 0xff;
  const pkt = buildTransferData(0xb2, 0xeffd, 0x06fe8020, 0x10, 0x0000, chunk);
  assert.deepEqual(pkt.slice(20, 51), chunk);
});

test("buildTransferData rejects non-B1/B2/B3 carriers", () => {
  const chunk = new Uint8Array(31);
  assert.throws(() => buildTransferData(0xa1, 0xffff, 0x12345678, 0, 0, chunk));
  assert.throws(() => buildTransferData(0xb0, 0xffff, 0x12345678, 0, 0, chunk));
  assert.throws(() => buildTransferData(0xb4, 0xffff, 0x12345678, 0, 0, chunk));
  assert.throws(() => buildTransferData(0x92, 0xffff, 0x12345678, 0, 0, chunk));
});

test("buildTransferData rejects wrong chunk length", () => {
  assert.throws(() =>
    buildTransferData(0xb2, 0xffff, 0x12345678, 0, 0, new Uint8Array(30)),
  );
  assert.throws(() =>
    buildTransferData(0xb2, 0xffff, 0x12345678, 0, 0, new Uint8Array(32)),
  );
});

test("buildTransferData chunk-size byte at offset 19 is 0x1F", () => {
  const pkt = buildTransferData(
    0xb2,
    0xffff,
    0x12345678,
    0,
    0,
    new Uint8Array(31),
  );
  assert.equal(pkt[19], 0x1f);
});

test("buildTransferData encodes addrLo big-endian at bytes 17..18", () => {
  const pkt = buildTransferData(
    0xb2,
    0xffff,
    0x12345678,
    0,
    0xcafe,
    new Uint8Array(31),
  );
  assert.equal(pkt[17], 0xca);
  assert.equal(pkt[18], 0xfe);
});

// OtaChunkIter

test("OtaChunkIter emits chunks of exactly 31 bytes, advances addrLo by 31", () => {
  const body = new Uint8Array(100);
  for (let i = 0; i < 100; i++) body[i] = i & 0xff;
  const it = new OtaChunkIter(body);
  assert.equal(it.addrLo, 0);
  assert.equal(it.page, 0);
  assert.equal(it.subCounter, 0);

  const c1 = it.fill();
  assert.equal(c1.length, 31);
  assert.equal(c1[0], 0);
  assert.equal(c1[30], 30);
  it.advance();
  assert.equal(it.addrLo, 31);
  assert.equal(it.subCounter, 1);

  const c2 = it.fill();
  assert.equal(c2[0], 31);
  it.advance();
  assert.equal(it.addrLo, 62);
});

test("OtaChunkIter signals page wrap at 64KB boundary", () => {
  const body = new Uint8Array(0x12000);
  const it = new OtaChunkIter(body);
  it.addrLo = 0xffe3;
  const wrapped = it.advance();
  assert.equal(wrapped, true);
  assert.equal(it.page, 1);
  assert.equal(it.addrLo, 2);
});

test("OtaChunkIter pads short final chunk with 0x00", () => {
  const body = new Uint8Array(40);
  for (let i = 0; i < 40; i++) body[i] = (0x10 + i) & 0xff;
  const it = new OtaChunkIter(body);
  it.advance(); // skip first chunk
  const c = it.fill();
  assert.equal(c[0], 0x10 + 31);
  assert.equal(c[8], 0x10 + 39);
  assert.equal(c[9], 0x00);
  assert.equal(c[30], 0x00);
});

test("OtaChunkIter subCounter cycles 0..0x3F then wraps to 0", () => {
  const body = new Uint8Array(31 * 65);
  const it = new OtaChunkIter(body);
  for (let i = 0; i < 64; i++) it.advance();
  assert.equal(it.subCounter, 0); // (0+64) & 0x3F = 0
  it.advance();
  assert.equal(it.subCounter, 1);
});

test("OtaChunkIter done() returns true when cursor reaches body length", () => {
  const body = new Uint8Array(31);
  const it = new OtaChunkIter(body);
  assert.equal(it.done(), false);
  it.advance();
  assert.equal(it.done(), true);
});

// walkOtaPackets — orchestrator generator (mirrors cca_ota_full_tx_walk in firmware)

test("walkOtaPackets emits BeginTransfer first", () => {
  const body = new Uint8Array(31); // exactly 1 chunk
  const packets = [...walkOtaPackets(body, 0xeffd, 0x06fe8020)];
  assert.equal(packets.length, 2);
  assert.equal(packets[0].label, "BeginTransfer");
  assert.equal(packets[0].pkt[0], 0x92);
  assert.equal(packets[1].label, "TransferData[0]");
  assert.equal(packets[1].pkt[0], 0xb1);
});

test("walkOtaPackets cycles carriers B1/B2/B3", () => {
  const body = new Uint8Array(31 * 6);
  const packets = [...walkOtaPackets(body, 0xeffd, 0x06fe8020)];
  // 1 BeginTransfer + 6 TransferData
  assert.equal(packets.length, 7);
  assert.equal(packets[1].pkt[0], 0xb1);
  assert.equal(packets[2].pkt[0], 0xb2);
  assert.equal(packets[3].pkt[0], 0xb3);
  assert.equal(packets[4].pkt[0], 0xb1);
  assert.equal(packets[5].pkt[0], 0xb2);
  assert.equal(packets[6].pkt[0], 0xb3);
});

test("walkOtaPackets emits ChangeAddrOff at page wrap (and not on body that ends at the boundary)", () => {
  // 64 KB exactly -> no ChangeAddrOff (no further TransferData follows)
  const body1 = new Uint8Array(0x10000);
  const labels1 = [...walkOtaPackets(body1, 0xeffd, 0x06fe8020)].map(
    (p) => p.label,
  );
  assert.equal(labels1.filter((l) => l === "ChangeAddrOff").length, 0);

  // 64 KB + 31 bytes -> exactly one ChangeAddrOff before the wrapping TransferData
  const body2 = new Uint8Array(0x10000 + 31);
  const labels2 = [...walkOtaPackets(body2, 0xeffd, 0x06fe8020)].map(
    (p) => p.label,
  );
  const changeIdx = labels2.indexOf("ChangeAddrOff");
  assert.equal(labels2.filter((l) => l === "ChangeAddrOff").length, 1);
  // ChangeAddrOff comes after the last page-0 TransferData and before the page-1 TransferData
  assert.ok(changeIdx > 0);
  assert.ok(labels2[changeIdx - 1].startsWith("TransferData"));
  assert.ok(labels2[changeIdx + 1].startsWith("TransferData"));
});

// packetsEqualIgnoringSeq — comparison helper for TX echo / SDR validation

test("packetsEqualIgnoringSeq returns true when bytes match except offset 1", () => {
  const a = new Uint8Array([0x92, 0x00, 0xa1, 0xef, 0xfd]);
  const b = new Uint8Array([0x92, 0x07, 0xa1, 0xef, 0xfd]); // seq byte differs
  assert.equal(packetsEqualIgnoringSeq(a, b), true);
});

test("packetsEqualIgnoringSeq returns false when other bytes differ", () => {
  const a = new Uint8Array([0x92, 0x00, 0xa1, 0xef, 0xfd]);
  const b = new Uint8Array([0x92, 0x00, 0xa1, 0xff, 0xff]); // subnet differs
  assert.equal(packetsEqualIgnoringSeq(a, b), false);
});

test("packetsEqualIgnoringSeq returns false on different lengths", () => {
  assert.equal(
    packetsEqualIgnoringSeq(new Uint8Array(22), new Uint8Array(51)),
    false,
  );
});
