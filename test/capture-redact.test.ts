/**
 * Corpus redaction — tests.
 *
 * The corpus ships in a public repo, so these are safety properties, not
 * formatting preferences. The metric-preservation tests matter just as much:
 * a redaction that changed decode results would make the committed baseline
 * describe frames nobody ever received.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  harvestDeviceIds,
  REDACTED_ID,
  redactCcaFrame,
} from "../lib/capture-redact";
import { decodeCcaFrame } from "../lib/cca-decode-adapter";

/** Real PICO_EXTENDED frame; device_id 08692D70 sits at offsets 2 and 12. */
const BUTTON_FRAME = Buffer.from(
  "8a0c08692d70210e03000a0108692d70004202 00001e65f7".replace(/\s/g, ""),
  "hex",
);

/** Type 0x0B — 29% of captured traffic and unidentified. */
const UNKNOWN_FRAME = Buffer.from("0b1122334455661e8899aabbccddeeff", "hex");

describe("redactCcaFrame", () => {
  it("replaces every device_id field in an identified frame", () => {
    const out = redactCcaFrame(BUTTON_FRAME);

    assert.deepEqual(out.subarray(2, 6), REDACTED_ID);
    assert.deepEqual(out.subarray(12, 16), REDACTED_ID);
    // The original id must not survive anywhere in the frame.
    assert.equal(out.includes(Buffer.from("08692d70", "hex")), false);
  });

  it("leaves the rest of an identified frame byte-for-byte intact", () => {
    const out = redactCcaFrame(BUTTON_FRAME);

    assert.equal(out.length, BUTTON_FRAME.length);
    assert.equal(out[0], 0x8a); // type
    assert.equal(out[1], 0x0c); // sequence
    assert.equal(out[7], 0x0e); // format
    assert.equal(out[10], 0x0a); // button
    assert.equal(out[11], 0x01); // action
  });

  it("preserves every decode metric for an identified frame", () => {
    const before = decodeCcaFrame(BUTTON_FRAME);
    const after = decodeCcaFrame(redactCcaFrame(BUTTON_FRAME));

    assert.equal(after.typeName, before.typeName);
    assert.equal(after.identified, before.identified);
    assert.equal(after.seq, before.seq);
    assert.equal(after.fieldsDefined, before.fieldsDefined);
    assert.equal(after.fieldsPresent, before.fieldsPresent);
    assert.equal(after.fieldsNamed, before.fieldsNamed);
  });

  it("keeps only type, format and length of an unidentified frame", () => {
    const out = redactCcaFrame(UNKNOWN_FRAME);

    assert.equal(out.length, UNKNOWN_FRAME.length);
    assert.equal(out[0], 0x0b); // type byte drives identification
    assert.equal(out[7], 0x1e); // format byte drives virtual reclassification
    // Everything else is gone.
    for (const i of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15]) {
      assert.equal(out[i], 0, `byte ${i} should be zeroed`);
    }
  });

  it("preserves every decode metric for an unidentified frame", () => {
    const before = decodeCcaFrame(UNKNOWN_FRAME);
    const after = decodeCcaFrame(redactCcaFrame(UNKNOWN_FRAME));

    assert.equal(after.identified, false);
    assert.equal(after.typeName, before.typeName);
    assert.equal(after.fieldsDefined, before.fieldsDefined);
  });

  it("scrubs a known serial that appears outside any device_id field", () => {
    const serial = 0x08692d70;
    // Same id parked at an offset no field definition covers.
    const frame = Buffer.from("930008692d7000000e0000000000000000", "hex");

    const out = redactCcaFrame(frame, { knownSerials: [serial] });

    assert.equal(out.includes(Buffer.from("08692d70", "hex")), false);
  });

  it("scrubs a known serial stored little-endian", () => {
    const frame = Buffer.from("9300702d690800000e0000000000000000", "hex");

    const out = redactCcaFrame(frame, { knownSerials: [0x08692d70] });

    assert.equal(out.includes(Buffer.from("702d6908", "hex")), false);
  });

  it("is idempotent", () => {
    const once = redactCcaFrame(BUTTON_FRAME);
    const twice = redactCcaFrame(once);

    assert.deepEqual(twice, once);
  });

  it("does not mutate the frame it was given", () => {
    const copy = Buffer.from(BUTTON_FRAME);
    redactCcaFrame(BUTTON_FRAME);

    assert.deepEqual(BUTTON_FRAME, copy);
  });
});

describe("harvestDeviceIds", () => {
  it("collects ids from every device_id field position", () => {
    const ids = harvestDeviceIds([BUTTON_FRAME]);

    assert.ok(ids.includes(0x08692d70), "should find the button's device id");
  });

  it("ignores values too small to be a Lutron serial", () => {
    // A device_id field landing on padding reads as a tiny number; scrubbing
    // those would corrupt unrelated payload bytes across the corpus.
    const frame = Buffer.from(
      "8a0c00000a01210e03000a0100000a0100420200001e65f7",
      "hex",
    );

    assert.deepEqual(harvestDeviceIds([frame]), []);
  });

  it("ignores uniform values like broadcast and filler markers", () => {
    const broadcast = Buffer.from(
      "8a0cffffffff210e03000a01ccccccccc0420200001e65f7",
      "hex",
    );

    assert.deepEqual(harvestDeviceIds([broadcast]), []);
  });

  it("deduplicates ids seen in many frames", () => {
    const ids = harvestDeviceIds([BUTTON_FRAME, BUTTON_FRAME, BUTTON_FRAME]);

    assert.equal(ids.filter((i) => i === 0x08692d70).length, 1);
  });
});
