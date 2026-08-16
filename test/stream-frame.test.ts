/**
 * Nucleo UDP stream framing — parser tests.
 *
 * Mirrors firmware/tests/test_stream_frame.cpp: same wire layout, opposite
 * direction. Includes the version-mismatch cases (GLAB-78).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FLAG_CCX,
  FLAG_RAW,
  FLAG_SRC,
  FLAG_TX,
  FRAME_HEADER_LEN,
  parseStreamPacketFrame,
  rloc16FromIpv6,
  SRC_ADDR_LEN,
} from "../lib/stream-frame";

const CBOR = Buffer.from([0x82, 0x00, 0xa3, 0x01, 0x18, 0x2a]);

/** fd0d:1122:3344:5566:0000:00ff:fe00:8401 — an RLOC address (rloc16 0x8401) */
const SRC_RLOC = Buffer.from("fd0d112233445566000000fffe008401", "hex");
/** fd00::abb:ccdd:ee11:2233 — a sleepy child's ML-EID, no RLOC pattern */
const SRC_MLEID = Buffer.from("fd000000000000000abbccddee112233", "hex");

function buildFrame(opts: {
  flags: number;
  data?: Buffer;
  tsMs?: number;
  tsCyc?: number;
  src?: Buffer | null;
}): Buffer {
  const data = opts.data ?? CBOR;
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  header[0] = opts.src ? opts.flags | FLAG_SRC : opts.flags & ~FLAG_SRC;
  header[1] = data.length;
  header.writeUInt32LE(opts.tsMs ?? 1000, 2);
  header.writeUInt32LE(opts.tsCyc ?? 2000, 6);
  return Buffer.concat(opts.src ? [header, data, opts.src] : [header, data]);
}

describe("parseStreamPacketFrame", () => {
  it("parses the fixed header", () => {
    const frame = buildFrame({
      flags: FLAG_CCX,
      tsMs: 0x11223344,
      tsCyc: 0xaabbccdd,
    });
    const f = parseStreamPacketFrame(frame);

    assert.ok(f);
    assert.equal(f.isCcx, true);
    assert.equal(f.isTx, false);
    assert.equal(f.isRaw, false);
    assert.equal(f.tsMs, 0x11223344);
    assert.equal(f.tsCyc, 0xaabbccdd);
    assert.deepEqual(f.data, CBOR);
  });

  it("extracts the source address trailer and canonicalizes it", () => {
    const f = parseStreamPacketFrame(
      buildFrame({ flags: FLAG_CCX, src: SRC_RLOC }),
    );

    assert.ok(f);
    assert.equal(f.srcKind, "attributed");
    assert.equal(f.srcAddr, "fd0d:1122:3344:5566:0:ff:fe00:8401");
    // Payload is unaffected by the trailer
    assert.deepEqual(f.data, CBOR);
  });

  it("carries an RLOC-less ML-EID verbatim", () => {
    const f = parseStreamPacketFrame(
      buildFrame({ flags: FLAG_CCX, src: SRC_MLEID }),
    );

    assert.ok(f);
    assert.equal(f.srcKind, "attributed");
    assert.equal(rloc16FromIpv6(f.srcAddr!), null);
  });

  it("reports locally-originated frames as local, not as a zero address", () => {
    const f = parseStreamPacketFrame(
      buildFrame({ flags: FLAG_CCX | FLAG_TX, src: null }),
    );

    assert.ok(f);
    assert.equal(f.isTx, true);
    assert.equal(f.srcAddr, null);
    assert.equal(f.srcKind, "local");
  });

  it("preserves raw-sniff frames", () => {
    const f = parseStreamPacketFrame(
      buildFrame({ flags: FLAG_CCX | FLAG_RAW }),
    );
    assert.ok(f);
    assert.equal(f.isRaw, true);
  });

  // --- Version mismatch -----------------------------------------------------

  it("reports a CCX RX frame with no trailer as unsupported (old firmware)", () => {
    // Pre-GLAB-78 firmware: CCX RX frames carry neither TX nor SRC.
    const f = parseStreamPacketFrame(
      buildFrame({ flags: FLAG_CCX, src: null }),
    );

    assert.ok(f);
    assert.equal(f.srcAddr, null);
    assert.equal(f.srcKind, "unsupported");
  });

  it("never reads a trailer from a CCA frame whose RSSI sets bit 4", () => {
    // |RSSI| = 0x14 sets bit 4, which is FLAG_SRC's bit. CCA frames must not
    // be mistaken for carrying a source trailer.
    const f = parseStreamPacketFrame(buildFrame({ flags: 0x14, src: null }));

    assert.ok(f);
    assert.equal(f.isCcx, false);
    assert.equal(f.srcAddr, null);
    assert.equal(f.srcKind, "unsupported");
    assert.deepEqual(f.data, CBOR);
  });

  it("ignores an unexpected trailer rather than misparsing the payload", () => {
    // A future firmware could append more; LEN still bounds the payload.
    const frame = Buffer.concat([
      buildFrame({ flags: FLAG_CCX, src: null }),
      Buffer.alloc(8, 0xee),
    ]);
    const f = parseStreamPacketFrame(frame);

    assert.ok(f);
    assert.deepEqual(f.data, CBOR);
  });

  // --- Malformed input ------------------------------------------------------

  it("rejects a frame shorter than the header", () => {
    assert.equal(parseStreamPacketFrame(Buffer.alloc(9)), null);
  });

  it("rejects a frame whose payload is truncated", () => {
    const frame = buildFrame({ flags: FLAG_CCX, src: null }).subarray(0, 12);
    assert.equal(parseStreamPacketFrame(frame), null);
  });

  it("rejects a frame claiming a trailer it does not carry", () => {
    // Flag set, trailer truncated — must be dropped, not read as garbage.
    const full = buildFrame({ flags: FLAG_CCX, src: SRC_RLOC });
    assert.equal(
      parseStreamPacketFrame(full.subarray(0, full.length - 1)),
      null,
    );
    // ...and the intact frame still parses, so the guard is not over-eager.
    assert.ok(parseStreamPacketFrame(full));
  });

  it("accepts an empty payload with a trailer", () => {
    const f = parseStreamPacketFrame(
      buildFrame({ flags: FLAG_CCX, data: Buffer.alloc(0), src: SRC_RLOC }),
    );
    assert.ok(f);
    assert.equal(f.data.length, 0);
    assert.equal(f.srcAddr, "fd0d:1122:3344:5566:0:ff:fe00:8401");
  });
});

describe("rloc16FromIpv6", () => {
  it("extracts RLOC16 from an RLOC address", () => {
    assert.equal(rloc16FromIpv6("fd0d:1122:3344:5566:0:ff:fe00:8401"), 0x8401);
  });

  it("returns null for an ML-EID with no RLOC pattern", () => {
    assert.equal(rloc16FromIpv6("fd00::abb:ccdd:ee11:2233"), null);
  });

  it("returns null for a non-mesh-local address", () => {
    assert.equal(rloc16FromIpv6("fe80::200:ff:fe00:8401"), null);
  });

  it("returns null for a malformed address", () => {
    assert.equal(rloc16FromIpv6("not-an-address"), null);
  });
});

describe("wire constants match the firmware", () => {
  it("uses the same flag bits as stream_frame.h", () => {
    assert.equal(FLAG_TX, 0x80);
    assert.equal(FLAG_CCX, 0x40);
    assert.equal(FLAG_RAW, 0x20);
    assert.equal(FLAG_SRC, 0x10);
    assert.equal(FRAME_HEADER_LEN, 10);
    assert.equal(SRC_ADDR_LEN, 16);
  });
});
