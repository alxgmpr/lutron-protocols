/**
 * Capture collection — tests.
 *
 * This is the half of capture-rate that decides what a frame *was*, split out
 * of the tool so it is checkable without the bench rig. capture-rate is an
 * instrument: if these rules shift, its loss numbers move for reasons that have
 * nothing to do with the radio, and the shift is invisible in the output.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { FrameCollector, observeFrame } from "../lib/capture-collect";
import {
  FLAG_CCX,
  FLAG_RAW,
  FLAG_SRC,
  FLAG_TX,
  FRAME_HEADER_LEN,
  parseStreamPacketFrame,
  type StreamPacketFrame,
} from "../lib/stream-frame";

/** A DEVICE_CTRL frame from the committed corpus (ids redacted there). */
const CCA_HEX = "8101deadbeef210900deadbeeffe020201cccccccccc0dac";
/** A state report — no 32-bit id, so its identity is link/subnet/zone. */
const CCA_STATE_HEX = "8200a300a200000301018210191097051845";

function ccaFrame(flags: number, hex = CCA_HEX): StreamPacketFrame {
  return frame(flags, Buffer.from(hex, "hex"), null);
}

function ccxFrame(payload: Buffer, src: Buffer | null): StreamPacketFrame {
  return frame(FLAG_CCX | (src ? FLAG_SRC : FLAG_TX), payload, src);
}

function frame(
  flags: number,
  data: Buffer,
  src: Buffer | null,
): StreamPacketFrame {
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  header[0] = flags;
  header[1] = data.length;
  const parsed = parseStreamPacketFrame(
    Buffer.concat(src ? [header, data, src] : [header, data]),
  );
  assert.ok(parsed, "test built an unparseable datagram");
  return parsed;
}

/** A mesh-local address the RLOC extractor recognizes. */
function rlocAddr(rloc16: number): Buffer {
  const src = Buffer.alloc(16);
  src[0] = 0xfd;
  src[11] = 0xff;
  src[12] = 0xfe;
  src.writeUInt16BE(rloc16, 14);
  return src;
}

describe("capture collection", () => {
  // ── RSSI ────────────────────────────────────────────────

  it("keeps the raw five-bit RSSI reading out of the analysis", () => {
    const observed = observeFrame(ccaFrame(0x1a));

    // -26 is what the flags byte says; it is also a lie past -31 dBm, which is
    // why the analysis gets null and the record keeps the reading (GLAB-115).
    assert.equal(observed.rssiRaw5Bit, -26);
    assert.equal(observed.observation.rssi, null);
  });

  it("reads no RSSI from a frame we transmitted ourselves", () => {
    const observed = observeFrame(ccaFrame(FLAG_TX));

    assert.equal(observed.rssiRaw5Bit, null);
    assert.equal(observed.observation.isTx, true);
  });

  it("masks the RSSI to five bits so bit 5 cannot inflate it", () => {
    // 0x20 is FLAG_RAW, not part of the magnitude. Reading six bits here would
    // report -42 for a frame the firmware sent as -10.
    const observed = observeFrame(ccaFrame(FLAG_RAW | 0x0a));

    assert.equal(observed.rssiRaw5Bit, -10);
  });

  // ── Attribution ─────────────────────────────────────────

  it("attributes a CCA frame to its wire sender", () => {
    const observed = observeFrame(ccaFrame(0x0a));

    assert.equal(observed.observation.band, "cca");
    assert.equal(observed.observation.sender, "DEADBEEF");
    assert.equal(observed.observation.type, "DEVICE_CTRL");
    assert.equal(observed.observation.seq, 1);
    assert.equal(observed.identified, true);
    assert.equal(observed.hex, CCA_HEX);
  });

  it("attributes a state report by link, subnet and zone, having no id", () => {
    const observed = observeFrame(ccaFrame(0x0a, CCA_STATE_HEX));

    assert.equal(observed.observation.sender, "A3-00A2-00");
    assert.equal(observed.observation.type, "STATE_RPT_82");
  });

  it("attributes a CCX frame to the stream's own source trailer", () => {
    const observed = observeFrame(
      ccxFrame(Buffer.from("82008101", "hex"), rlocAddr(0x1234)),
    );

    assert.equal(observed.observation.band, "ccx");
    assert.match(observed.observation.sender ?? "", /^fd/);
    // Never the CCA hex path: a CCX payload is not a CCA frame.
    assert.equal(observed.hex, null);
  });

  it("counts an undecodable CCX frame without inventing a type", () => {
    const observed = observeFrame(
      ccxFrame(Buffer.from("ff", "hex"), rlocAddr(0x1234)),
    );

    assert.equal(observed.decoded, false);
    assert.equal(observed.identified, false);
    assert.equal(observed.observation.type, null);
  });

  // ── The collecting gate ─────────────────────────────────

  it("collects nothing before the window opens", () => {
    const collector = new FrameCollector();

    collector.handleFrame(ccaFrame(0x0a));

    assert.equal(collector.frames.length, 0);
  });

  it("collects frames inside the window and stops at its end", () => {
    const collector = new FrameCollector();

    collector.start();
    collector.handleFrame(ccaFrame(0x0a));
    collector.stop();
    collector.handleFrame(ccaFrame(0x0b));

    assert.equal(collector.frames.length, 1);
    assert.equal(collector.frames[0].rssiRaw5Bit, -10);
  });

  it("does not decode a frame it is not collecting", () => {
    const collector = new FrameCollector();
    let decodes = 0;

    collector.handleFrame(
      new Proxy(ccaFrame(0x0a), {
        get(target, prop, receiver) {
          if (prop === "data") decodes++;
          return Reflect.get(target, prop, receiver);
        },
      }),
    );

    assert.equal(
      decodes,
      0,
      "decoded a frame outside the window — that is CPU the instrument spends " +
        "during the idle control period, where it can perturb what it measures",
    );
  });
});
