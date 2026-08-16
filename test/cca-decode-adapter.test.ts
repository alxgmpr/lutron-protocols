/**
 * CCA frame → decode observation.
 *
 * Frames here are real, taken from data/captures/cca-sessions/. Synthetic
 * bytes would prove the adapter self-consistent and nothing else.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeCcaFrame } from "../lib/cca-decode-adapter";

/**
 * RX button frame, rssi -22, from beacon-test_2026-03-23T07-00-58.csv.
 * That capture labelled it BTN_SHORT_B; the format byte at offset 7 now
 * reclassifies it to the more specific PICO_EXTENDED, so the labels in old
 * session CSVs are stale and only their raw_hex is worth reading.
 */
const BUTTON_FRAME = Buffer.from(
  "8a0c08692d70210e03000a0108692d70004202 00001e65f7".replace(/\s/g, ""),
  "hex",
);

/** RX BEACON_93, rssi -16, same session */
const BEACON = Buffer.from(
  "9325a182d70021080 0ffffffffff080 1cccccccccccc75f0".replace(/\s/g, ""),
  "hex",
);

describe("decodeCcaFrame", () => {
  it("identifies a real button packet and reads its sequence", () => {
    const f = decodeCcaFrame(BUTTON_FRAME);

    assert.equal(f.band, "cca");
    assert.equal(f.decoded, true);
    assert.equal(f.identified, true);
    assert.equal(f.typeName, "PICO_EXTENDED");
    assert.equal(f.seq, 0x0c);
  });

  it("identifies a real beacon", () => {
    const f = decodeCcaFrame(BEACON);

    assert.equal(f.identified, true);
    assert.equal(f.typeName, "BEACON_93");
    assert.equal(f.seq, 0x25);
  });

  it("reports an unrecognized type byte as unidentified despite it having a name", () => {
    // identifyPacket labels unknown packets with their own type byte, so the
    // name is truthy and only the flag distinguishes it from a real decode.
    const f = decodeCcaFrame(Buffer.from("5f00112233445566", "hex"));

    assert.equal(f.decoded, true);
    assert.equal(f.identified, false);
    assert.equal(f.typeName, "0x5F");
  });

  it("treats an empty frame as undecodable rather than unknown", () => {
    const f = decodeCcaFrame(Buffer.alloc(0));

    assert.equal(f.decoded, false);
    assert.equal(f.identified, false);
    assert.equal(f.seq, null);
  });

  it("separates fields that are absent from fields that are merely unnamed", () => {
    const f = decodeCcaFrame(BUTTON_FRAME);

    // All 13 fields have bytes in this frame; 5 of them (type, protocol,
    // format, cmd_param, crc) are raw hex with no symbolic meaning, which is
    // by design and must not read as a decode failure.
    assert.equal(f.fieldsDefined, 13);
    assert.equal(f.fieldsPresent, 13);
    assert.equal(f.fieldsNamed, 8);
  });

  it("counts fields past the end of a truncated frame as absent", () => {
    const truncated = decodeCcaFrame(BUTTON_FRAME.subarray(0, 12));

    assert.equal(truncated.fieldsDefined, 13);
    assert.ok(
      truncated.fieldsPresent < truncated.fieldsDefined,
      "fields beyond the truncation point should not count as present",
    );
  });
});
