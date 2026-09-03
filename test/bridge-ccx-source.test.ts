import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { CCXPacket } from "../ccx/types";
import type { ApplyResult, SourceIntent } from "../lib/bridge/types";

// ── Packet builders ──────────────────────────────────────

function makeLevelControlPacket(opts: {
  zoneId: number;
  level?: number;
  fade?: number;
  sequence?: number;
  cct?: number;
  colorXy?: [number, number];
  warmDimMode?: number;
  levelPresent?: boolean;
}): CCXPacket {
  const level = opts.level ?? 50;
  const levelPresent = opts.levelPresent ?? true;
  const inner = { 3: opts.fade ?? 1 };
  if (levelPresent) inner[0] = Math.round((level * 0xfeff) / 100);
  if (opts.colorXy) inner[1] = opts.colorXy;
  if (opts.warmDimMode != null) inner[5] = opts.warmDimMode;
  if (opts.cct != null) inner[6] = opts.cct;

  return {
    timestamp: new Date().toISOString(),
    srcAddr: "fd00::1",
    dstAddr: "ff03::1",
    srcEui64: "",
    dstEui64: "",
    msgType: 0,
    body: { 0: inner, 1: [16, opts.zoneId], 5: opts.sequence ?? 0 },
    parsed: {
      type: "LEVEL_CONTROL",
      level: levelPresent ? Math.round((level * 0xfeff) / 100) : 0,
      levelPercent: levelPresent ? level : 0,
      zoneType: 16,
      zoneId: opts.zoneId,
      fade: opts.fade ?? 1,
      delay: 0,
      colorXy: opts.colorXy,
      cct: opts.cct,
      warmDimMode: opts.warmDimMode,
      sequence: opts.sequence ?? 0,
      rawBody: { 0: inner, 1: [16, opts.zoneId], 5: opts.sequence ?? 0 },
    },
    rawHex: "",
  };
}

function makeButtonPressPacket(opts: {
  presetId: number;
  sequence?: number;
}): CCXPacket {
  const hi = (opts.presetId >> 8) & 0xff;
  const lo = opts.presetId & 0xff;
  const deviceId = new Uint8Array([hi, lo, 0xef, 0x20]);
  return {
    timestamp: new Date().toISOString(),
    srcAddr: "fd00::1",
    dstAddr: "ff03::1",
    srcEui64: "",
    dstEui64: "",
    msgType: 1,
    body: { 0: { 0: deviceId, 1: [1, 2, 3] }, 5: opts.sequence ?? 0 },
    parsed: {
      type: "BUTTON_PRESS",
      deviceId,
      buttonZone: lo,
      cmdType: hi,
      counters: [1, 2, 3],
      sequence: opts.sequence ?? 0,
      rawBody: { 0: { 0: deviceId, 1: [1, 2, 3] }, 5: opts.sequence ?? 0 },
    },
    rawHex: "",
  };
}

function makeDimHoldPacket(opts: {
  zoneId: number;
  action: number;
  presetId?: number;
  sequence?: number;
}): CCXPacket {
  const presetId = opts.presetId ?? 3;
  const deviceId = new Uint8Array([
    (presetId >> 8) & 0xff,
    presetId & 0xff,
    0xef,
    0x20,
  ]);
  return {
    timestamp: new Date().toISOString(),
    srcAddr: "fd00::1",
    dstAddr: "ff03::1",
    srcEui64: "",
    dstEui64: "",
    msgType: 2,
    body: {},
    parsed: {
      type: "DIM_HOLD",
      deviceId,
      buttonZone: 0,
      cmdType: 3,
      action: opts.action,
      direction: opts.action === 3 ? "RAISE" : "LOWER",
      zoneType: 16,
      zoneId: opts.zoneId,
      sequence: opts.sequence ?? 0,
      rawBody: {},
    },
    rawHex: "",
  };
}

function makeDimStepPacket(opts: {
  zoneId: number;
  presetId?: number;
  sequence?: number;
}): CCXPacket {
  const presetId = opts.presetId ?? 3;
  const deviceId = new Uint8Array([
    (presetId >> 8) & 0xff,
    presetId & 0xff,
    0xef,
    0x20,
  ]);
  return {
    timestamp: new Date().toISOString(),
    srcAddr: "fd00::1",
    dstAddr: "ff03::1",
    srcEui64: "",
    dstEui64: "",
    msgType: 3,
    body: {},
    parsed: {
      type: "DIM_STEP",
      deviceId,
      buttonZone: 0,
      cmdType: 3,
      action: 3,
      direction: "RAISE",
      stepValue: 1000,
      zoneType: 16,
      zoneId: opts.zoneId,
      sequence: opts.sequence ?? 0,
      rawBody: {},
    },
    rawHex: "",
  };
}

// ── Recording target ─────────────────────────────────────

/**
 * Stands in for the model so a test can assert on the intents the source
 * produces. This is the source's real output, not a mock of a collaborator.
 */
function recorder(result: ApplyResult = { accepted: true, applied: 1 }) {
  const intents: SourceIntent[] = [];
  return {
    intents,
    apply(intent: SourceIntent, onAccepted?: () => void): ApplyResult {
      intents.push(intent);
      if (result.accepted) onAccepted?.();
      return result;
    },
  };
}

/**
 * Pick the one intent of a given kind. A packet can yield several — a button
 * press is both a device event and a scene recall — so tests say which fact
 * they are asserting on rather than relying on emission order.
 */
function pick<K extends SourceIntent["kind"]>(
  intents: SourceIntent[],
  kind: K,
): Extract<SourceIntent, { kind: K }> {
  const hits = intents.filter((i) => i.kind === kind);
  assert.equal(hits.length, 1, `expected exactly one ${kind} intent`);
  // SAFETY: The test controls this fixture and intentionally uses the asserted test-only shape.
  return hits[0] as Extract<SourceIntent, { kind: K }>;
}

async function makeSource(
  target: { apply(i: SourceIntent, onAccepted?: () => void): ApplyResult },
  log?: (msg: string) => void,
) {
  const { CcxSource } = await import("../lib/bridge/sources/ccx");
  return new CcxSource({ model: target, log });
}

// ── LEVEL_CONTROL ────────────────────────────────────────

describe("CcxSource LEVEL_CONTROL", () => {
  test("normalizes to a zoneLevel intent with a type-tagged dedup key", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 75, fade: 8, sequence: 9 }),
    );

    assert.equal(target.intents.length, 1);
    const intent = target.intents[0];
    assert.equal(intent.kind, "zoneLevel");
    if (intent.kind !== "zoneLevel") return;
    assert.equal(intent.zoneId, 100);
    assert.equal(intent.level, 75);
    assert.equal(intent.fade, 8);
    assert.equal(intent.origin, "LEVEL");
    assert.equal(intent.dedupKey, "0:100:9");
  });

  test("a missing CBOR level key becomes a null level (colour-only)", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeLevelControlPacket({
        zoneId: 100,
        colorXy: [3000, 4000],
        levelPresent: false,
      }),
    );

    const intent = target.intents[0];
    assert.equal(intent.kind, "zoneLevel");
    if (intent.kind !== "zoneLevel") return;
    assert.equal(intent.level, null);
    assert.deepEqual(intent.colorXy, [3000, 4000]);
  });

  test("carries an explicit cct through untouched", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 50, cct: 3000 }),
    );

    const intent = target.intents[0];
    if (intent.kind !== "zoneLevel") throw new Error("wrong intent");
    assert.equal(intent.cct, 3000);
    assert.equal(intent.warmDimHint, undefined);
  });

  test("a warmDimMode field forces the default curve", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 50, warmDimMode: 1 }),
    );

    const intent = target.intents[0];
    if (intent.kind !== "zoneLevel") throw new Error("wrong intent");
    assert.equal(intent.warmDimHint, "default");
  });
});

// ── BUTTON_PRESS ─────────────────────────────────────────

describe("CcxSource BUTTON_PRESS", () => {
  test("normalizes to a preset intent keyed on the decoded preset ID", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeButtonPressPacket({ presetId: 0x0c2c, sequence: 4 }),
    );

    const intent = pick(target.intents, "preset");
    assert.equal(intent.presetId, 0x0c2c);
    assert.equal(intent.origin, "PRESET");
    assert.equal(intent.dedupKey, "1:3116:4");
  });
});

// ── Device events ────────────────────────────────────────
//
// A button press is two different facts about one packet: the press itself
// (which HA surfaces as an `event` entity) and the scene it recalls. Both have
// consumers, so the source emits both.

describe("CcxSource device events", () => {
  test("BUTTON_PRESS emits a device event alongside the preset intent", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeButtonPressPacket({ presetId: 0x0c2c, sequence: 4 }),
    );

    assert.equal(target.intents.length, 2, "one packet, two facts");
    const kinds = target.intents.map((i) => i.kind);
    assert.deepEqual(kinds, ["deviceEvent", "preset"]);
  });

  test("the device event carries identity, button, action and origin", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeButtonPressPacket({ presetId: 0x0c2c, sequence: 4 }),
    );

    const intent = target.intents[0];
    assert.equal(intent.kind, "deviceEvent");
    if (intent.kind !== "deviceEvent") return;
    // Full 4-byte wire device id, not the 2-byte preset slice, namespaced by
    // transport: a CCA id is also four undifferentiated bytes, and a collision
    // would merge two physical controls into one Home Assistant entity.
    assert.equal(intent.deviceId, "ccx_0c2cef20");
    assert.equal(intent.button, 0x2c);
    assert.equal(intent.action, "press");
    assert.equal(intent.origin, "PRESET");
    assert.equal(intent.source, "ccx");
    assert.equal(intent.sequence, 4);
  });

  test("the device event dedup key is keyed on the wire sequence", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeButtonPressPacket({ presetId: 0x0c2c, sequence: 4 }),
    );

    const intent = target.intents[0];
    if (intent.kind !== "deviceEvent") throw new Error("wrong intent");
    assert.equal(intent.dedupKey, "4:ccx_0c2cef20:press:4");
  });

  test("DIM_HOLD and DIM_STEP emit hold and release device events", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeDimHoldPacket({ zoneId: 0, action: 3, presetId: 7, sequence: 5 }),
    );
    source.handlePacket(
      makeDimStepPacket({ zoneId: 0, presetId: 7, sequence: 6 }),
    );

    const events = target.intents.filter((i) => i.kind === "deviceEvent");
    assert.equal(events.length, 2);
    assert.equal(events[0].kind === "deviceEvent" && events[0].action, "hold");
    assert.equal(
      events[1].kind === "deviceEvent" && events[1].action,
      "release",
    );
  });
});

// ── DIM_HOLD / DIM_STEP ──────────────────────────────────

describe("CcxSource dim ramps", () => {
  test("DIM_HOLD action 3 starts a raise ramp", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeDimHoldPacket({ zoneId: 100, action: 3, sequence: 2 }),
    );

    const intent = pick(target.intents, "ramp");
    assert.equal(intent.action, "start");
    assert.equal(intent.direction, "raise");
    assert.equal(intent.zoneId, 100);
    assert.equal(intent.dedupKey, "2:100:2");
  });

  test("DIM_HOLD action 2 starts a lower ramp", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(makeDimHoldPacket({ zoneId: 100, action: 2 }));

    assert.equal(pick(target.intents, "ramp").direction, "lower");
  });

  test("a pico DIM_HOLD carries no zone but does carry the preset fallback", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(
      makeDimHoldPacket({ zoneId: 0, action: 3, presetId: 7, sequence: 5 }),
    );

    const intent = pick(target.intents, "ramp");
    assert.equal(
      intent.zoneId,
      undefined,
      "zone 0 means absent, not zone number zero",
    );
    assert.equal(intent.presetId, 7);
    assert.equal(intent.dedupKey, "2:p:5");
  });

  test("DIM_STEP stops the ramp", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(makeDimStepPacket({ zoneId: 100, sequence: 3 }));

    const intent = pick(target.intents, "ramp");
    assert.equal(intent.action, "stop");
    assert.equal(intent.origin, "DIM_STEP");
    assert.equal(intent.dedupKey, "3:100:3");
  });
});

// ── Packet counting and logging ──────────────────────────

describe("CcxSource bookkeeping", () => {
  test("counts every packet, including ones it does not translate", async () => {
    const target = recorder();
    const source = await makeSource(target);

    source.handlePacket(makeLevelControlPacket({ zoneId: 100 }));
    const unknown = makeLevelControlPacket({ zoneId: 100, sequence: 1 });
    // SAFETY: The test controls this fixture and intentionally uses the asserted test-only shape.
    (unknown.parsed as { type: string }).type = "UNKNOWN";

    source.handlePacket(unknown);

    assert.equal(source.packetCount, 2);
    assert.equal(target.intents.length, 1, "unknown type produces no intent");
  });

  test("logs a packet the model accepted", async () => {
    const lines: string[] = [];
    const source = await makeSource(
      recorder({ accepted: true, applied: 1 }),
      (m) => lines.push(m),
    );

    source.handlePacket(makeLevelControlPacket({ zoneId: 100, level: 75 }));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /LEVEL_CONTROL/);
    assert.match(lines[0], /fd00::1 → ff03::1/);
  });

  test("stays quiet when the model rejects the packet as a duplicate", async () => {
    const lines: string[] = [];
    const source = await makeSource(
      recorder({ accepted: false, applied: 0 }),
      (m) => lines.push(m),
    );

    source.handlePacket(makeLevelControlPacket({ zoneId: 100, level: 75 }));

    assert.equal(lines.length, 0);
  });
});

// ── End to end through the real model ────────────────────

describe("CcxSource against a real DeviceModel", () => {
  test("a LEVEL_CONTROL packet drives zone state through the model", async () => {
    const { DeviceModel } = await import("../lib/bridge/model");
    const model = new DeviceModel({
      watchedZones: new Set([100]),
      autoTick: false,
    });
    const source = await makeSource(model);

    source.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 75, fade: 1 }),
    );

    assert.equal(model.getZoneState(100)?.level, 75);
    assert.equal(model.appliedCount, 1);
    model.destroy();
  });

  test("Thread retransmissions of one command apply once", async () => {
    const { DeviceModel } = await import("../lib/bridge/model");
    const model = new DeviceModel({
      watchedZones: new Set([100]),
      autoTick: false,
    });
    const source = await makeSource(model);

    for (let i = 0; i < 3; i++) {
      source.handlePacket(
        makeLevelControlPacket({ zoneId: 100, level: 75, sequence: 42 }),
      );
    }

    assert.equal(source.packetCount, 3);
    assert.equal(model.appliedCount, 1);
    model.destroy();
  });
});
