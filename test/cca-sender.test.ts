/**
 * CCA sender attribution.
 *
 * Sequence numbers are per-sender, so getting this wrong does not produce a
 * slightly-off loss figure — it produces a meaningless one. Two senders
 * merged into one stream make the GCD step inference collapse and invent
 * gaps; one sender split in two makes every run look short and clean.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ccaSender, decodeCcaFrame } from "../lib/cca-decode-adapter";

/** Real PICO_EXTENDED frame; device_id 08692D70 at offsets 2 and 12. */
const BUTTON_FRAME = Buffer.from(
  "8a0c08692d70210e03000a0108692d70004202 00001e65f7".replace(/\s/g, ""),
  "hex",
);

/** Type 0x0B — unidentified, so nothing in it can be read as a sender. */
const UNKNOWN_FRAME = Buffer.from("0b1122334455661e8899aabbccddeeff", "hex");

function build(type: number, fill: (b: Buffer) => void): Buffer {
  const b = Buffer.alloc(24);
  b[0] = type;
  b[1] = 0x10;
  fill(b);
  return b;
}

describe("ccaSender", () => {
  it("reads the device id off a button press", () => {
    assert.equal(ccaSender(BUTTON_FRAME), "08692D70");
  });

  it("prefers source_id over target_id on a command", () => {
    // SET_LEVEL carries both. The originator is source_id; keying on
    // target_id would file every controller's traffic under the load it
    // happened to address.
    const frame = build(0xa2, (b) => {
      b.writeUInt32BE(0x11111111, 2); // source_id
      b.writeUInt32BE(0x22222222, 9); // target_id
    });

    const sender = ccaSender(frame);

    assert.ok(sender?.includes("11111111"), `got ${sender}`);
    assert.ok(!sender?.includes("22222222"), `got ${sender}`);
  });

  it("keys a state report on its addressing tuple", () => {
    // STATE_RPT_81 carries no 32-bit id at all — link_addr, subnet and zone
    // are the whole of its identity, and zone alone is not unique.
    const a = build(0x81, (b) => {
      b[2] = 0x07; // link_addr
      b.writeUInt16BE(0x0001, 3); // subnet
      b[5] = 0x04; // zone
    });
    const b = build(0x81, (buf) => {
      buf[2] = 0x07;
      buf.writeUInt16BE(0x0002, 3); // different subnet
      buf[5] = 0x04;
    });

    assert.notEqual(ccaSender(a), ccaSender(b));
    assert.ok(ccaSender(a) !== null);
  });

  it("gives one device one key across packet types that disagree on endianness", () => {
    // Both frames were captured from the same plug-in dimmer seconds apart
    // and carry the identical bytes a3 98 43 00 at offset 2. The protocol
    // definition marks DEVICE_CTRL big-endian and SET_LEVEL little-endian,
    // which is a display convention; keying on it splits one device into two
    // senders, and a burst counted under two keys reports invented loss.
    const deviceCtrl = Buffer.from(
      "820da3984300210900058cb911fe420003cccccccccc8e80",
      "hex",
    );
    const setLevel = Buffer.from(
      "8187a3984300210e00058cb911fe400230f100010000f167",
      "hex",
    );

    assert.equal(ccaSender(deviceCtrl), ccaSender(setLevel));
  });

  it("reads the id in wire order", () => {
    const deviceCtrl = Buffer.from(
      "820da3984300210900058cb911fe420003cccccccccc8e80",
      "hex",
    );

    assert.equal(ccaSender(deviceCtrl), "A3984300");
  });

  it("returns null when the type is unidentified", () => {
    // No field definitions means no honest way to say who sent it. Guessing
    // offsets here would silently fabricate senders for 40% of the traffic.
    assert.equal(ccaSender(UNKNOWN_FRAME), null);
  });

  it("returns null for a frame truncated before its id", () => {
    assert.equal(ccaSender(Buffer.from("8a0c08", "hex")), null);
  });

  it("is stable across repeats of the same frame", () => {
    assert.equal(ccaSender(BUTTON_FRAME), ccaSender(Buffer.from(BUTTON_FRAME)));
  });
});

describe("decodeCcaFrame", () => {
  it("carries the sender alongside the decode metrics", () => {
    const obs = decodeCcaFrame(BUTTON_FRAME);

    assert.equal(obs.sender, "08692D70");
    assert.equal(obs.seq, 0x0c);
  });

  it("reports a null sender for an unidentified frame", () => {
    assert.equal(decodeCcaFrame(UNKNOWN_FRAME).sender, null);
  });
});
