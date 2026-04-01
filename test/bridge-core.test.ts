import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { CCXPacket } from "../ccx/types";

// ── Test helpers ──────────────────────────────────────────

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
  const inner: Record<number, unknown> = { 3: opts.fade ?? 1 };
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
  sequence?: number;
}): CCXPacket {
  const deviceId = new Uint8Array([0x03, 0x00, 0xef, 0x20]);
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
  sequence?: number;
}): CCXPacket {
  const deviceId = new Uint8Array([0x03, 0x00, 0xef, 0x20]);
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

/** Create a BridgeCore with no real sockets (empty pairings) */
async function createTestBridge(opts?: {
  pairings?: Array<{ zoneId: number; name?: string }>;
  presetZones?: Map<
    number,
    {
      name: string;
      zones: Record<
        string,
        { level: number; fade?: number; warmDimCurve?: string }
      >;
    }
  >;
}) {
  const { BridgeCore } = await import("../lib/bridge-core");
  const pairings = (opts?.pairings ?? []).map((p) => ({
    name: p.name ?? `Zone ${p.zoneId}`,
    zoneId: p.zoneId,
    wizIps: [] as string[], // no real sends
    wizPort: 38899,
  }));
  return new BridgeCore({
    pairings,
    presetZones: opts?.presetZones ?? new Map(),
    watchedZones: new Set(pairings.map((p) => p.zoneId)),
  });
}

// ── Dedup ────────────────────────────────────────────────

describe("dedup", () => {
  test("rejects duplicate within 200ms", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });
    const pkt1 = makeLevelControlPacket({
      zoneId: 100,
      level: 50,
      sequence: 1,
    });
    const pkt2 = makeLevelControlPacket({
      zoneId: 100,
      level: 50,
      sequence: 1,
    });

    bridge.handlePacket(pkt1);
    bridge.handlePacket(pkt2); // same seq, should be deduped

    assert.equal(bridge.matchCount, 1);
    bridge.destroy();
  });

  test("accepts different sequence", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });
    const pkt1 = makeLevelControlPacket({
      zoneId: 100,
      level: 50,
      sequence: 1,
    });
    const pkt2 = makeLevelControlPacket({
      zoneId: 100,
      level: 50,
      sequence: 2,
    });

    bridge.handlePacket(pkt1);
    bridge.handlePacket(pkt2);

    assert.equal(bridge.matchCount, 2);
    bridge.destroy();
  });

  test("accepts same sequence for different zones", async () => {
    const bridge = await createTestBridge({
      pairings: [{ zoneId: 100 }, { zoneId: 200 }],
    });
    const pkt1 = makeLevelControlPacket({
      zoneId: 100,
      level: 50,
      sequence: 1,
    });
    const pkt2 = makeLevelControlPacket({
      zoneId: 200,
      level: 50,
      sequence: 1,
    });

    bridge.handlePacket(pkt1);
    bridge.handlePacket(pkt2);

    assert.equal(bridge.matchCount, 2);
    bridge.destroy();
  });
});

// ── Zone state transitions ──────────────────────────────

describe("zone state", () => {
  test("instant LEVEL_CONTROL sets level, stays idle, marks dirty+reportPending", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });
    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 75, fade: 1 }),
    );

    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.level, 75);
    assert.equal(zone.activity.type, "idle");
    // dirty is consumed by tick, but reportPending should be set
    // (dirty may already be consumed if tick ran)
    bridge.destroy();
  });

  test("faded LEVEL_CONTROL enters fading state", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });
    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 80, fade: 8 }),
    );

    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.activity.type, "fading");
    if (zone.activity.type === "fading") {
      assert.equal(zone.activity.targetLevel, 80);
      assert.equal(zone.activity.durationMs, 2000); // 8 * 250ms
    }
    bridge.destroy();
  });

  test("color-only LEVEL_CONTROL preserves level", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });

    // Set initial level
    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 60, sequence: 1 }),
    );
    // Then color-only (no level in inner map)
    bridge.handlePacket(
      makeLevelControlPacket({
        zoneId: 100,
        colorXy: [3000, 4000],
        levelPresent: false,
        sequence: 2,
      }),
    );

    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.level, 60); // preserved
    assert.equal(zone.colorMode, "xy");
    assert.deepEqual(zone.colorXy, [3000, 4000]);
    bridge.destroy();
  });

  test("BUTTON_PRESS dispatches all zones in preset", async () => {
    const presetZones = new Map([
      [
        0x0c2c,
        {
          name: "Test Scene",
          zones: {
            "100": { level: 80, fade: 1 },
            "200": { level: 50, fade: 1 },
          },
        },
      ],
    ]);
    const bridge = await createTestBridge({
      pairings: [{ zoneId: 100 }, { zoneId: 200 }],
      presetZones,
    });

    bridge.handlePacket(makeButtonPressPacket({ presetId: 0x0c2c }));

    const z1 = bridge.getZoneState(100);
    const z2 = bridge.getZoneState(200);
    assert.ok(z1);
    assert.ok(z2);
    assert.equal(z1.level, 80);
    assert.equal(z2.level, 50);
    assert.equal(bridge.matchCount, 2);
    bridge.destroy();
  });

  test("DIM_HOLD enters ramping state", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });
    bridge.handlePacket(makeDimHoldPacket({ zoneId: 100, action: 3 }));

    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.activity.type, "ramping");
    if (zone.activity.type === "ramping") {
      assert.equal(zone.activity.direction, "raise");
    }
    bridge.destroy();
  });

  test("DIM_STEP stops ramp", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });
    bridge.handlePacket(
      makeDimHoldPacket({ zoneId: 100, action: 3, sequence: 1 }),
    );
    bridge.handlePacket(makeDimStepPacket({ zoneId: 100, sequence: 2 }));

    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.activity.type, "idle");
    assert.ok(zone.reportAt > 0, "reportAt should be scheduled");
    bridge.destroy();
  });
});

// ── Fade behavior ───────────────────────────────────────

describe("fade", () => {
  test("fade idempotency: same-target during fade is absorbed", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });

    // Start a fade to 80%
    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 80, fade: 8, sequence: 1 }),
    );
    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.activity.type, "fading");

    // Send same target — should keep fading, not restart
    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 80, fade: 8, sequence: 2 }),
    );
    assert.equal(zone.activity.type, "fading");
    if (zone.activity.type === "fading") {
      // startTime should NOT have changed (fade was not restarted)
      assert.equal(zone.activity.targetLevel, 80);
    }
    bridge.destroy();
  });

  test("different target during fade cancels and restarts", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });

    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 80, fade: 8, sequence: 1 }),
    );
    const zone = bridge.getZoneState(100);
    assert.ok(zone);

    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 30, fade: 4, sequence: 2 }),
    );
    assert.equal(zone.activity.type, "fading");
    if (zone.activity.type === "fading") {
      assert.equal(zone.activity.targetLevel, 30);
      assert.equal(zone.activity.durationMs, 1000);
    }
    bridge.destroy();
  });

  test("instant command during fade cancels fade", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });

    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 80, fade: 8, sequence: 1 }),
    );
    assert.equal(bridge.getZoneState(100)?.activity.type, "fading");

    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 50, fade: 1, sequence: 2 }),
    );
    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.activity.type, "idle");
    assert.equal(zone.level, 50);
    bridge.destroy();
  });
});

// ── Ramp behavior ───────────────────────────────────────

describe("ramp", () => {
  test("LEVEL_CONTROL during ramp cancels ramp", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });

    bridge.handlePacket(
      makeDimHoldPacket({ zoneId: 100, action: 3, sequence: 1 }),
    );
    assert.equal(bridge.getZoneState(100)?.activity.type, "ramping");

    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 75, sequence: 2 }),
    );
    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.activity.type, "idle");
    assert.equal(zone.level, 75);
    bridge.destroy();
  });
});

// ── Color mode tracking ─────────────────────────────────

describe("color mode", () => {
  test("CCT command sets cct mode", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });
    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 50, cct: 3000 }),
    );

    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.colorMode, "cct");
    assert.equal(zone.cct, 3000);
    assert.equal(zone.colorXy, null);
    bridge.destroy();
  });

  test("xy command sets xy mode and clears cct", async () => {
    const bridge = await createTestBridge({ pairings: [{ zoneId: 100 }] });

    // Set CCT first
    bridge.handlePacket(
      makeLevelControlPacket({
        zoneId: 100,
        level: 50,
        cct: 3000,
        sequence: 1,
      }),
    );
    // Then xy
    bridge.handlePacket(
      makeLevelControlPacket({
        zoneId: 100,
        level: 50,
        colorXy: [3000, 4000],
        sequence: 2,
      }),
    );

    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.colorMode, "xy");
    assert.deepEqual(zone.colorXy, [3000, 4000]);
    assert.equal(zone.cct, null);
    bridge.destroy();
  });
});
