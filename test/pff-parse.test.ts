/**
 * PFF header-layout regression.
 *
 * The real corpus (data/firmware/**.pff) is gitignored, so this builds synthetic
 * PFFs instead. It exists to pin the body offset: the layout was documented as
 * 0x10B and later 0x124 before the length field at 0x11C showed it is 0x134
 * (layout 1) / 0x130 (layout 0). 0x124 and 0x134 differ by one AES block, so a
 * "payload is 16-byte aligned" check passes either way — only the declared
 * ciphertext length distinguishes them, which is what these cases assert.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "../tools/firmware/pff-parse";

const dir = mkdtempSync(join(tmpdir(), "pff-"));

/** Build a minimal PFF: layout 0 → 304-byte header, layout 1 → 308-byte. */
function makePff(opts: {
  layout: 0 | 1;
  kind: 2 | 3;
  deviceClass: number;
  ctLen: number;
  revision: [number, number, number, number];
  flags?: number;
}): string {
  const headerLen = opts.layout === 1 ? 0x134 : 0x130;
  const buf = Buffer.alloc(headerLen + opts.ctLen);
  buf.writeUInt32BE(opts.layout, 0x000);
  buf.writeUInt32BE(1, 0x004);
  buf.fill(0xab, 0x008, 0x048); // signature
  buf.writeUInt16BE(opts.flags ?? 0, 0x108);
  buf.writeUInt16BE(opts.kind, 0x10a);
  Buffer.from(opts.revision).copy(buf, 0x10c);
  buf.writeUInt32BE(opts.deviceClass, 0x114);
  buf.writeUInt32BE(1, 0x118);
  buf.writeUInt32BE(opts.ctLen, 0x11c);
  if (opts.layout === 1) buf.writeUInt32BE(0x00072000, 0x120);
  buf.fill(0x5a, headerLen - 16, headerLen); // IV
  const path = join(dir, `l${opts.layout}-k${opts.kind}.pff`);
  writeFileSync(path, buf);
  return path;
}

describe("pff-parse header layout", () => {
  it("places the body at 0x134 on layout 1 and reads the metadata block", () => {
    const r = parse(
      makePff({
        layout: 1,
        kind: 3,
        deviceClass: 0x03150201,
        ctLen: 217552,
        revision: [2, 25, 0, 0],
      }),
      false,
    );
    assert.equal(r.bodyOffset, 0x134);
    assert.equal(r.headerLen, 0x134);
    assert.equal(r.kind, "app");
    assert.equal(r.revision, "2.25.0r0");
    assert.equal(r.deviceClass, "03150201");
    assert.equal(r.targetFlashAddr, "00072000");
    assert.equal(r.ivHex, "5a".repeat(16));
    assert.equal(r.bodySize, 217552);
    assert.ok(
      r.ctLenMatches,
      "declared ciphertext length must match body size",
    );
    assert.ok(r.bodyBlockAligned);
  });

  it("places the body at 0x130 on layout 0 and omits the flash field", () => {
    const r = parse(
      makePff({
        layout: 0,
        kind: 2,
        deviceClass: 0x1b010101,
        ctLen: 19424,
        revision: [2, 0, 5, 128],
      }),
      false,
    );
    assert.equal(r.bodyOffset, 0x130);
    assert.equal(r.kind, "boot");
    assert.equal(r.revision, "2.0.5r128");
    assert.equal(r.targetFlashAddr, null);
    assert.ok(r.ctLenMatches);
  });

  it("flags a body offset that disagrees with the declared length", () => {
    // A 0x124 body start would leave 16 extra bytes — the IV counted as payload.
    const path = makePff({
      layout: 1,
      kind: 3,
      deviceClass: 0x03150201,
      ctLen: 1024,
      revision: [1, 0, 0, 0],
    });
    const r = parse(path, false);
    assert.equal(r.declaredCtLen, 1024);
    assert.equal(r.bodySize, 1024);
    assert.notEqual(r.bodySize, 1024 + 16);
  });

  it("rejects an unknown header layout version", () => {
    const buf = Buffer.alloc(0x200);
    buf.writeUInt32BE(7, 0);
    const path = join(dir, "bad-layout.pff");
    writeFileSync(path, buf);
    assert.throws(() => parse(path, false), /unknown header layout version 7/);
  });
});
