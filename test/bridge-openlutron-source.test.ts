/**
 * openlutron source — tests.
 *
 * One stream carries both radios, so this is the demux: CCX frames to the CCX
 * normalization, everything else to the CCA one, both feeding one model. The
 * cases that matter are the ones where a frame could take the wrong branch —
 * `FLAG_SRC` (0x10) overlaps the CCA `|RSSI|` mask, so a CCX frame that reached
 * the CCA path would have its source bit read as signal strength.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { OpenlutronSource } from "../lib/bridge/sources/openlutron";
import type { ApplyResult, SourceIntent } from "../lib/bridge/types";
import {
  FLAG_CCX,
  FLAG_SRC,
  FLAG_TX,
  FRAME_HEADER_LEN,
  parseStreamPacketFrame,
  type StreamPacketFrame,
} from "../lib/stream-frame";

// ── Real payloads, from the committed corpora ─────────────

/** BUTTON_PRESS, device 1234ef20, sequence 42. */
const CCX_PRESS = "8201a200a200441234ef20018301020305182a";
/** LEVEL_CONTROL for zone 100 at 50%. */
const CCX_LEVEL = "8200a300a300197f7f030806190bb801821018640501";

/** A CCA button tap: type 0x88, device deadbeef, button ON, action PRESS. */
function ccaTap(seq = 0): Buffer {
  const p = Buffer.alloc(24);
  p[0] = 0x88;
  p[1] = seq;
  p[2] = 0xde;
  p[3] = 0xad;
  p[4] = 0xbe;
  p[5] = 0xef;
  p[6] = 0x21;
  p[7] = 0x04;
  p[8] = 0x03;
  p[10] = 0x02;
  p[11] = 0x00;
  return p;
}

function ccxFrame(hex: string, opts: { tx?: boolean } = {}): StreamPacketFrame {
  const src = Buffer.alloc(16);
  src[0] = 0xfd;
  src[11] = 0xff;
  src[12] = 0xfe;
  src.writeUInt16BE(0x1234, 14);
  return opts.tx
    ? frameOf(FLAG_CCX | FLAG_TX, Buffer.from(hex, "hex"), null)
    : frameOf(FLAG_CCX | FLAG_SRC, Buffer.from(hex, "hex"), src);
}

function ccaFrame(payload: Buffer, flags = 0x0a): StreamPacketFrame {
  return frameOf(flags, payload, null);
}

function frameOf(
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

function recorder() {
  const intents: SourceIntent[] = [];
  return {
    intents,
    apply(intent: SourceIntent, onAccepted?: () => void): ApplyResult {
      intents.push(intent);
      onAccepted?.();
      return { accepted: true, applied: 0 };
    },
  };
}

function sourceWith() {
  const model = recorder();
  const logs: string[] = [];
  return {
    model,
    logs,
    source: new OpenlutronSource({ model, log: (m) => logs.push(m) }),
  };
}

function deviceEvents(intents: SourceIntent[]) {
  return intents.filter(
    (i): i is Extract<SourceIntent, { kind: "deviceEvent" }> =>
      i.kind === "deviceEvent",
  );
}

describe("openlutron source", () => {
  // ── Demux ───────────────────────────────────────────────

  it("routes a CCX frame through the CCX normalization", () => {
    const { model, source } = sourceWith();

    source.handleFrame(ccxFrame(CCX_PRESS));

    const events = deviceEvents(model.intents);
    assert.equal(events.length, 1);
    assert.equal(events[0].deviceId, "ccx_1234ef20");
    assert.equal(events[0].source, "ccx");
    // Keyed on the wire sequence, which CCX repeats on a retransmit.
    assert.equal(events[0].sequence, 42);
  });

  it("routes a CCA frame through the CCA normalization", () => {
    const { model, source } = sourceWith();

    source.handleFrame(ccaFrame(ccaTap()));

    const events = deviceEvents(model.intents);
    assert.equal(events.length, 1);
    assert.equal(events[0].deviceId, "cca_deadbeef");
    assert.equal(events[0].source, "cca");
  });

  it("never lets a CCX frame reach the CCA path", () => {
    const { source } = sourceWith();

    // FLAG_SRC is bit 4, which is also part of the CCA |RSSI| field. The CCA
    // path reads that field, so a CCX frame arriving there would report a
    // source-attribution bit as signal strength.
    source.handleFrame(ccxFrame(CCX_PRESS));

    assert.equal(source.ccaPacketCount, 0);
    assert.equal(source.ccxPacketCount, 1);
  });

  it("feeds both radios into the same model", () => {
    const { model, source } = sourceWith();

    source.handleFrame(ccxFrame(CCX_PRESS));
    source.handleFrame(ccaFrame(ccaTap()));

    const ids = deviceEvents(model.intents).map((e) => e.deviceId);
    assert.deepEqual(ids, ["ccx_1234ef20", "cca_deadbeef"]);
  });

  it("carries a CCX zone level through to a zone intent", () => {
    const { model, source } = sourceWith();

    source.handleFrame(ccxFrame(CCX_LEVEL));

    const level = model.intents.find((i) => i.kind === "zoneLevel");
    assert.ok(level, "no zoneLevel intent");
    if (level?.kind !== "zoneLevel") return;
    assert.equal(level.zoneId, 100);
    // 0x7f7f as a percent of 0xFEFF — the wire encoding is not round, and the
    // source passes it through rather than tidying it up.
    assert.ok(
      level.level !== null && Math.abs(level.level - 50) < 0.01,
      `level was ${level.level}`,
    );
  });

  // ── Robustness, because the add-on is unattended ─────────

  it("counts an undecodable CCX payload instead of throwing", () => {
    const { model, source } = sourceWith();

    // Garbage where CBOR should be. buildPacket throws on it, and a throw here
    // would come out of a UDP datagram handler and take the bridge down.
    source.handleFrame(ccxFrame("ff00ff00"));

    assert.equal(model.intents.length, 0);
    assert.equal(source.ccxPacketCount, 1);
  });

  it("does not treat its own CCX transmission as an observation", () => {
    const { model, source } = sourceWith();

    // TX set with no source trailer is locally originated — the DEVICE_REPORT
    // injection the bridge itself sent. Reading it back as an observation would
    // feed the bridge its own output.
    source.handleFrame(ccxFrame(CCX_PRESS, { tx: true }));

    assert.equal(model.intents.length, 0);
  });

  it("survives a frame with no payload at all", () => {
    const { model, source } = sourceWith();

    source.handleFrame(ccaFrame(Buffer.alloc(0)));
    source.handleFrame(ccxFrame(""));

    assert.equal(model.intents.length, 0);
  });

  // ── Stream wiring ───────────────────────────────────────

  it("takes frames from a stream it is attached to", () => {
    const { model, source } = sourceWith();
    const stream = new EventEmitter();

    source.attach(stream);
    stream.emit("frame", ccaFrame(ccaTap()));

    assert.equal(deviceEvents(model.intents).length, 1);
  });
});
