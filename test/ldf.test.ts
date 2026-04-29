/**
 * Tests for the pure-TS LDF header strip helper.
 *
 * Mirrors tools/firmware/ldf-extract.py — strips the 0x80-byte container
 * header to expose the plaintext HCS08 firmware body.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LDF_HEADER_LEN, stripLdfHeader } from "../lib/ldf";

test("LDF_HEADER_LEN is 0x80 (matches the LDF container header size)", () => {
  assert.equal(LDF_HEADER_LEN, 0x80);
});

test("stripLdfHeader returns body bytes after the 0x80-byte header", () => {
  const file = new Uint8Array(0x80 + 100);
  for (let i = 0; i < file.length; i++) file[i] = i & 0xff;
  const body = stripLdfHeader(file);
  assert.equal(body.length, 100);
  assert.equal(body[0], 0x80);
  assert.equal(body[99], (0x80 + 99) & 0xff);
});

test("stripLdfHeader is a zero-copy view (sub-array semantics)", () => {
  const file = new Uint8Array(0x80 + 4);
  file[0x80] = 0xab;
  const body = stripLdfHeader(file);
  // Mutating the body view should mutate the source, confirming no copy.
  body[0] = 0xcd;
  assert.equal(file[0x80], 0xcd);
});

test("stripLdfHeader throws on file shorter than header", () => {
  assert.throws(() => stripLdfHeader(new Uint8Array(0x70)), /too short/i);
});
