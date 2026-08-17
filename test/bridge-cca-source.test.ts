/**
 * CCA source — tests.
 *
 * The interesting half is dedup. CCA's sequence byte increments per retransmit
 * (it carries the TDMA slot in its low bits, per docs/protocols/cca/tdma.md §2),
 * so unlike CCX it cannot identify a retransmit by sequence — only by identical
 * payload bytes arriving inside the burst. Under-dedup shows up as a duplicate
 * event; over-dedup shows up as a button press that did nothing. Both are here.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { CCA_BURST_DEDUP_MS, CcaSource } from "../lib/bridge/sources/cca";
import type { ApplyResult, SourceIntent } from "../lib/bridge/types";
import {
  FLAG_TX,
  FRAME_HEADER_LEN,
  parseStreamPacketFrame,
  type StreamPacketFrame,
} from "../lib/stream-frame";

// ── Frame builders ────────────────────────────────────────

/** Action codes, from the CCA `action` enum. */
const PRESS = 0x00;
const RELEASE = 0x01;
const HOLD = 0x02;
const SAVE = 0x03;

/** Button codes. */
const BTN_ON = 0x02;
const BTN_RAISE = 0x05;

/**
 * A 24-byte button packet (type 0x88 BTN_SHORT_A), laid out per `btnFields` in
 * protocol/cca.protocol.ts.
 */
function buttonPacket(
  opts: {
    seq?: number;
    id?: number[];
    button?: number;
    action?: number;
    type?: number;
    format?: number;
  } = {},
): Buffer {
  const p = Buffer.alloc(24);
  p[0] = opts.type ?? 0x88;
  p[1] = opts.seq ?? 0;
  const id = opts.id ?? [0xde, 0xad, 0xbe, 0xef];
  p[2] = id[0];
  p[3] = id[1];
  p[4] = id[2];
  p[5] = id[3];
  p[6] = 0x21; // protocol
  p[7] = opts.format ?? 0x04; // tap
  p[8] = 0x03; // pico frame
  p[10] = opts.button ?? BTN_ON;
  p[11] = opts.action ?? PRESS;
  return p;
}

/** A zone level command — carries a target device id, never a LEAP zone. */
function setLevelPacket(): Buffer {
  const p = Buffer.alloc(24);
  p[0] = 0xa0;
  p[1] = 0x00;
  p[2] = 0xde;
  p[3] = 0xad;
  p[4] = 0xbe;
  p[5] = 0xef;
  p[6] = 0x21;
  p[7] = 0x0e;
  p.writeUInt16BE(0x7f7f, 16);
  return p;
}

function frameOf(payload: Buffer, flags = 0x0a): StreamPacketFrame {
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  header[0] = flags;
  header[1] = payload.length;
  const parsed = parseStreamPacketFrame(Buffer.concat([header, payload]));
  assert.ok(parsed, "test built an unparseable datagram");
  return parsed;
}

// ── Recording model ───────────────────────────────────────

/** Collects intents rather than acting on them; dedup is the model's job. */
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
  return { model, source: new CcaSource({ model }) };
}

describe("cca source", () => {
  // ── Device events ───────────────────────────────────────

  it("turns a button tap into a press event", () => {
    const { model, source } = sourceWith();

    source.handleFrame(frameOf(buttonPacket({ button: BTN_ON })));

    assert.equal(model.intents.length, 1);
    const intent = model.intents[0];
    assert.equal(intent.kind, "deviceEvent");
    if (intent.kind !== "deviceEvent") return;
    assert.equal(intent.action, "press");
    assert.equal(intent.button, BTN_ON);
    assert.equal(intent.source, "cca");
  });

  it("identifies the control by its wire id, namespaced by transport", () => {
    const { model, source } = sourceWith();

    source.handleFrame(frameOf(buttonPacket({})));

    const intent = model.intents[0];
    if (intent.kind !== "deviceEvent") throw new Error("wrong intent kind");
    // The 4-byte id is the device's provisioned radio serial: stable across a
    // rename and a restart. The prefix keeps it from colliding with a CCX id
    // made of the same four bytes.
    assert.equal(intent.deviceId, "cca_deadbeef");
  });

  it("maps hold and release to their own actions", () => {
    const { model, source } = sourceWith();

    source.handleFrame(frameOf(buttonPacket({ action: HOLD, seq: 0 })));
    source.handleFrame(frameOf(buttonPacket({ action: RELEASE, seq: 8 })));

    const actions = model.intents.map((i) =>
      i.kind === "deviceEvent" ? i.action : null,
    );
    assert.deepEqual(actions, ["hold", "release"]);
  });

  it("ignores an action that is not in the vocabulary", () => {
    const { model, source } = sourceWith();

    // SAVE (favourite programming) is neither a press nor a ramp.
    source.handleFrame(frameOf(buttonPacket({ action: SAVE })));

    assert.equal(model.intents.length, 0);
  });

  // ── Dedup ───────────────────────────────────────────────

  it("gives one wire event one dedup key however the sequence advances", () => {
    const { model, source } = sourceWith();

    // The two frames of a tap burst: identical payload, sequence +8 (stride is
    // slot_count, not the slot number).
    source.handleFrame(frameOf(buttonPacket({ seq: 6 })));
    source.handleFrame(frameOf(buttonPacket({ seq: 14 })));

    assert.equal(model.intents.length, 2, "source should not dedup itself");
    const [a, b] = model.intents;
    if (a.kind !== "deviceEvent" || b.kind !== "deviceEvent") {
      throw new Error("wrong intent kind");
    }
    assert.equal(a.dedupKey, b.dedupKey, "retransmit got a different key");
  });

  it("gives a different button a different key", () => {
    const { model, source } = sourceWith();

    source.handleFrame(frameOf(buttonPacket({ button: BTN_ON })));
    source.handleFrame(frameOf(buttonPacket({ button: BTN_RAISE })));

    const [a, b] = model.intents;
    if (a.kind !== "deviceEvent" || b.kind !== "deviceEvent") {
      throw new Error("wrong intent kind");
    }
    assert.notEqual(a.dedupKey, b.dedupKey);
  });

  it("asks for a window sized to the burst, not the CCX default", () => {
    const { model, source } = sourceWith();

    source.handleFrame(frameOf(buttonPacket({})));

    const intent = model.intents[0];
    if (intent.kind !== "deviceEvent") throw new Error("wrong intent kind");
    // A tap burst is 2 frames at one-frame spacing (~75 ms). The window has to
    // cover that and no more: every millisecond past it is a double press this
    // transport would swallow.
    assert.equal(intent.dedupWindowMs, CCA_BURST_DEDUP_MS);
    assert.ok(
      CCA_BURST_DEDUP_MS < 500,
      "a CCA window at or past the CCX default would eat real double presses",
    );
    assert.ok(CCA_BURST_DEDUP_MS >= 150, "must cover a 2-frame burst at 75 ms");
  });

  // ── What CCA does not carry ─────────────────────────────

  it("does not invent a zone from a level command", () => {
    const { model, source } = sourceWith();

    // CCA addresses loads by 4-byte device id, not by LEAP zone. Guessing a
    // zone id here would drive the wrong Home Assistant entity.
    source.handleFrame(frameOf(setLevelPacket()));

    assert.equal(model.intents.length, 0);
  });

  it("ignores a frame it cannot identify", () => {
    const { model, source } = sourceWith();

    source.handleFrame(frameOf(Buffer.from("0300000000", "hex")));

    assert.equal(model.intents.length, 0);
  });

  it("ignores our own transmissions", () => {
    const { model, source } = sourceWith();

    // A TX echo is the board reporting what it sent. Treating it as a device
    // event would re-fire whatever the bridge itself just did.
    source.handleFrame(frameOf(buttonPacket({}), FLAG_TX));

    assert.equal(model.intents.length, 0);
  });

  it("counts every CCA frame it sees, decoded or not", () => {
    const { source } = sourceWith();

    source.handleFrame(frameOf(buttonPacket({})));
    source.handleFrame(frameOf(setLevelPacket()));
    source.handleFrame(frameOf(Buffer.from("03", "hex")));

    assert.equal(source.packetCount, 3);
  });
});
