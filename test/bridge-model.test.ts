import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type {
  CommandEvent,
  DeviceEvent,
  SourceIntent,
  ZoneChangedEvent,
  ZoneSettledEvent,
} from "../lib/bridge/types";

// ── Helpers ───────────────────────────────────────────────

/** Deterministic clock so fade/ramp/settle timing needs no real waiting. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function levelIntent(
  zoneId: number,
  level: number | null,
  opts: {
    fade?: number;
    cct?: number | null;
    colorXy?: [number, number] | null;
    warmDimHint?: string;
    dedupKey?: string;
  } = {},
): SourceIntent {
  return {
    kind: "zoneLevel",
    zoneId,
    level,
    cct: opts.cct ?? null,
    colorXy: opts.colorXy ?? null,
    fade: opts.fade ?? 1,
    warmDimHint: opts.warmDimHint,
    origin: "LEVEL",
    dedupKey: opts.dedupKey,
  };
}

async function makeModel(opts: {
  watchedZones?: Set<number>;
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
  zoneCurves?: Map<number, string>;
  now?: () => number;
}) {
  const { DeviceModel } = await import("../lib/bridge/model");
  return new DeviceModel({
    watchedZones: opts.watchedZones ?? new Set(),
    presetZones: opts.presetZones ?? new Map(),
    zoneCurves: opts.zoneCurves,
    resolveZoneName: (id) => `Zone ${id}`,
    now: opts.now,
    autoTick: false,
    reportDelayMs: 2000,
  });
}

function pressIntent(
  deviceId: string,
  button: number,
  sequence: number,
  opts: { action?: "press" | "hold" | "release"; origin?: string } = {},
): SourceIntent {
  const action = opts.action ?? "press";
  return {
    kind: "deviceEvent",
    deviceId,
    button,
    action,
    origin: opts.origin ?? "PRESET",
    source: "ccx",
    sequence,
    dedupKey: `4:${deviceId}:${action}:${sequence}`,
  };
}

// ── Device events ─────────────────────────────────────────

describe("model device events", () => {
  test("emits device:event with identity, button, action and origin", async () => {
    const model = await makeModel({});
    const events: DeviceEvent[] = [];
    model.on("device:event", (e: DeviceEvent) => events.push(e));

    const result = model.apply(pressIntent("0c2cef20", 0x2c, 1));

    assert.equal(result.accepted, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].deviceId, "0c2cef20");
    assert.equal(events[0].button, 0x2c);
    assert.equal(events[0].action, "press");
    assert.equal(events[0].origin, "PRESET");
    assert.equal(events[0].source, "ccx");
    assert.equal(events[0].sequence, 1);
    model.destroy();
  });

  test("resolves a display name, falling back to the device id", async () => {
    const { DeviceModel } = await import("../lib/bridge/model");
    const model = new DeviceModel({
      autoTick: false,
      resolveDeviceName: (id) =>
        id === "0c2cef20" ? "Kitchen Pico" : undefined,
    });
    const events: DeviceEvent[] = [];
    model.on("device:event", (e: DeviceEvent) => events.push(e));

    model.apply(pressIntent("0c2cef20", 0x2c, 1));
    model.apply(pressIntent("deadbeef", 0x01, 2));

    assert.equal(events[0].deviceName, "Kitchen Pico");
    assert.equal(events[1].deviceName, "Device deadbeef");
    model.destroy();
  });

  test("a press on a device bound to no watched zone still fires", async () => {
    // The whole point of the device channel: watch filtering is a zone concern.
    // A Pico that drives nothing is still an automation trigger.
    const model = await makeModel({ watchedZones: new Set([100]) });
    const events: DeviceEvent[] = [];
    model.on("device:event", (e: DeviceEvent) => events.push(e));

    model.apply(pressIntent("0c2cef20", 0x2c, 1));

    assert.equal(events.length, 1, "unwatched zones must not silence a press");
    model.destroy();
  });
});

// ── The dedup principle ───────────────────────────────────
//
// Dedup exists to suppress retransmissions of ONE wire event. It must never
// collapse two distinct user actions. CCX carries a sequence number, so a
// retransmit is identifiable and we key on it — never on (device, button).

describe("device event dedup keys on the wire sequence, not the action", () => {
  test("pressing the same button twice fires twice", async () => {
    const clock = fakeClock();
    const model = await makeModel({ now: clock.now });
    const events: DeviceEvent[] = [];
    model.on("device:event", (e: DeviceEvent) => events.push(e));

    // Two real presses of one button, back to back, well inside the 500ms
    // dedup window. Distinct wire events, so distinct sequence numbers.
    model.apply(pressIntent("0c2cef20", 0x2c, 1));
    clock.advance(80);
    model.apply(pressIntent("0c2cef20", 0x2c, 2));

    assert.equal(events.length, 2, "a double press is two events, not one");
    model.destroy();
  });

  test("a retransmission of one press fires once", async () => {
    const clock = fakeClock();
    const model = await makeModel({ now: clock.now });
    const events: DeviceEvent[] = [];
    model.on("device:event", (e: DeviceEvent) => events.push(e));

    // Thread relays the same frame across the mesh; same sequence every time.
    for (let i = 0; i < 3; i++) {
      model.apply(pressIntent("0c2cef20", 0x2c, 7));
      clock.advance(120);
    }

    assert.equal(events.length, 1);
    model.destroy();
  });

  test("distinct buttons and distinct actions never collapse into each other", async () => {
    const model = await makeModel({});
    const events: DeviceEvent[] = [];
    model.on("device:event", (e: DeviceEvent) => events.push(e));

    model.apply(pressIntent("0c2cef20", 0x2c, 1));
    model.apply(pressIntent("0c2def20", 0x2d, 1)); // different device, same seq
    model.apply(pressIntent("0c2cef20", 0x2c, 1, { action: "hold" }));

    assert.equal(events.length, 3);
    model.destroy();
  });
});

// ── Dedup (lives in the model, so every sink benefits) ────

describe("model dedup", () => {
  test("rejects a repeat of the same dedup key inside the window", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });

    const first = model.apply(levelIntent(100, 50, { dedupKey: "0:100:1" }));
    const second = model.apply(levelIntent(100, 50, { dedupKey: "0:100:1" }));

    assert.equal(first.accepted, true);
    assert.equal(second.accepted, false);
    assert.equal(model.appliedCount, 1);
    model.destroy();
  });

  test("accepts the same key again once the window has passed", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });

    model.apply(levelIntent(100, 50, { dedupKey: "0:100:1" }));
    clock.advance(600); // DEDUP_WINDOW_MS is 500
    const again = model.apply(levelIntent(100, 50, { dedupKey: "0:100:1" }));

    assert.equal(again.accepted, true);
    assert.equal(model.appliedCount, 2);
    model.destroy();
  });

  test("different keys are independent", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100, 200]),
      now: clock.now,
    });

    model.apply(levelIntent(100, 50, { dedupKey: "0:100:1" }));
    model.apply(levelIntent(200, 50, { dedupKey: "0:200:1" }));

    assert.equal(model.appliedCount, 2);
    model.destroy();
  });
});

// ── Watched-zone filtering ───────────────────────────────

describe("model watch filter", () => {
  test("ignores a zone outside the watch list without recording dedup state", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });

    const res = model.apply(levelIntent(999, 50, { dedupKey: "0:999:1" }));

    assert.equal(res.accepted, false);
    assert.equal(model.getZoneState(999), undefined);
    assert.equal(model.appliedCount, 0);
    model.destroy();
  });

  test("an empty watch list accepts every zone", async () => {
    const model = await makeModel({ watchedZones: new Set() });

    model.apply(levelIntent(999, 50));

    assert.equal(model.getZoneState(999)?.level, 50);
    model.destroy();
  });
});

// ── Zone state machine ───────────────────────────────────

describe("model zone state", () => {
  test("instant level sets the level and stays idle", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.apply(levelIntent(100, 75, { fade: 1 }));

    const zone = model.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.level, 75);
    assert.equal(zone.activity.type, "idle");
    model.destroy();
  });

  test("faded level enters fading with wall-clock duration", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.apply(levelIntent(100, 80, { fade: 8 }));

    const zone = model.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.activity.type, "fading");
    if (zone.activity.type === "fading") {
      assert.equal(zone.activity.targetLevel, 80);
      assert.equal(zone.activity.durationMs, 2000); // 8 quarter-seconds
    }
    model.destroy();
  });

  test("a null level is colour-only and preserves the current level", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.apply(levelIntent(100, 60));
    model.apply(levelIntent(100, null, { colorXy: [3000, 4000] }));

    const zone = model.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.level, 60);
    assert.equal(zone.colorMode, "xy");
    assert.deepEqual(zone.colorXy, [3000, 4000]);
    model.destroy();
  });

  test("an xy command clears a previously set cct", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.apply(levelIntent(100, 50, { cct: 3000 }));
    model.apply(levelIntent(100, 50, { colorXy: [3000, 4000] }));

    const zone = model.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.colorMode, "xy");
    assert.equal(zone.cct, null);
    model.destroy();
  });
});

// ── Fade interpolation ───────────────────────────────────

describe("model fade", () => {
  test("interpolates level across ticks and lands exactly on target", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });

    model.apply(levelIntent(100, 100, { fade: 8 })); // 2000ms from 0%
    clock.advance(1000);
    model.tick();
    assert.equal(Math.round(model.getZoneState(100)!.level), 50);

    clock.advance(1000);
    model.tick();
    const zone = model.getZoneState(100)!;
    assert.equal(zone.level, 100);
    assert.equal(zone.activity.type, "idle");
    model.destroy();
  });

  test("re-commanding the same target mid-fade does not restart the fade", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });

    model.apply(levelIntent(100, 80, { fade: 8, dedupKey: "a" }));
    const started = (model.getZoneState(100)!.activity as { startTime: number })
      .startTime;

    clock.advance(500);
    model.apply(levelIntent(100, 80, { fade: 8, dedupKey: "b" }));

    const zone = model.getZoneState(100)!;
    assert.equal(zone.activity.type, "fading");
    assert.equal(
      (zone.activity as { startTime: number }).startTime,
      started,
      "fade should not have been restarted",
    );
    model.destroy();
  });

  test("an instant command cancels an in-progress fade", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.apply(levelIntent(100, 80, { fade: 8, dedupKey: "a" }));
    model.apply(levelIntent(100, 50, { fade: 1, dedupKey: "b" }));

    const zone = model.getZoneState(100)!;
    assert.equal(zone.activity.type, "idle");
    assert.equal(zone.level, 50);
    model.destroy();
  });
});

// ── Ramp tracking ────────────────────────────────────────

describe("model ramp", () => {
  test("ramp start enters ramping and advances at the CCA rate", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });

    model.apply(levelIntent(100, 50, { dedupKey: "seed" }));
    model.apply({
      kind: "ramp",
      action: "start",
      direction: "raise",
      zoneId: 100,
      origin: "DIM_HOLD",
      dedupKey: "r1",
    });
    assert.equal(model.getZoneState(100)!.activity.type, "ramping");

    clock.advance(1000); // 100/4.75 %/s ≈ 21%
    model.tick();
    const level = model.getZoneState(100)!.level;
    assert.ok(level > 65 && level < 75, `expected ~71%, got ${level}`);
    model.destroy();
  });

  test("ramp stops on its own at 100% and schedules a settle", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });

    model.apply({
      kind: "ramp",
      action: "start",
      direction: "raise",
      zoneId: 100,
      origin: "DIM_HOLD",
    });
    clock.advance(10_000);
    model.tick();

    const zone = model.getZoneState(100)!;
    assert.equal(zone.level, 100);
    assert.equal(zone.activity.type, "idle");
    assert.ok(zone.reportAt > 0);
    model.destroy();
  });

  test("ramp stop freezes the level and leaves the zone idle", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });

    model.apply({
      kind: "ramp",
      action: "start",
      direction: "raise",
      zoneId: 100,
      origin: "DIM_HOLD",
      dedupKey: "r1",
    });
    clock.advance(500);
    model.tick();
    const mid = model.getZoneState(100)!.level;

    model.apply({
      kind: "ramp",
      action: "stop",
      zoneId: 100,
      origin: "DIM_STEP",
      dedupKey: "r2",
    });
    clock.advance(500);
    model.tick();

    const zone = model.getZoneState(100)!;
    assert.equal(zone.activity.type, "idle");
    assert.equal(zone.level, mid, "level should stop advancing after stop");
    model.destroy();
  });

  test("a level command cancels an in-progress ramp", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.apply({
      kind: "ramp",
      action: "start",
      direction: "raise",
      zoneId: 100,
      origin: "DIM_HOLD",
    });
    model.apply(levelIntent(100, 75));

    const zone = model.getZoneState(100)!;
    assert.equal(zone.activity.type, "idle");
    assert.equal(zone.level, 75);
    model.destroy();
  });

  test("an unwatched explicit zone falls through to preset expansion", async () => {
    // Mirrors the existing DIM_HOLD branch: an explicit zoneId that is not
    // watched does not short-circuit, it retries as a preset.
    const model = await makeModel({
      watchedZones: new Set([200]),
      presetZones: new Map([
        [7, { name: "Scene", zones: { "200": { level: 40 } } }],
      ]),
    });

    model.apply({
      kind: "ramp",
      action: "start",
      direction: "lower",
      zoneId: 999,
      presetId: 7,
      origin: "DIM_HOLD",
    });

    assert.equal(model.getZoneState(200)?.activity.type, "ramping");
    assert.equal(model.getZoneState(999), undefined);
    model.destroy();
  });
});

// ── Preset expansion ─────────────────────────────────────

describe("model presets", () => {
  test("a preset intent dispatches every watched zone in the scene", async () => {
    const model = await makeModel({
      watchedZones: new Set([100, 200]),
      presetZones: new Map([
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
      ]),
    });

    model.apply({ kind: "preset", presetId: 0x0c2c, origin: "BUTTON" });

    assert.equal(model.getZoneState(100)?.level, 80);
    assert.equal(model.getZoneState(200)?.level, 50);
    assert.equal(model.appliedCount, 2);
    model.destroy();
  });

  test("an unknown preset is still accepted for logging but applies nothing", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });

    const res = model.apply({
      kind: "preset",
      presetId: 0xdead,
      origin: "BUTTON",
    });

    assert.equal(res.accepted, true, "packet should still be logged");
    assert.equal(res.applied, 0);
    model.destroy();
  });

  test("a preset zone carrying a warm dim curve resolves a cct", async () => {
    const model = await makeModel({
      watchedZones: new Set([100]),
      presetZones: new Map([
        [
          5,
          {
            name: "Warm",
            zones: { "100": { level: 40, warmDimCurve: "halogen" } },
          },
        ],
      ]),
    });

    model.apply({ kind: "preset", presetId: 5, origin: "BUTTON" });

    const zone = model.getZoneState(100)!;
    assert.equal(zone.colorMode, "cct");
    assert.ok(zone.cct && zone.cct > 1000 && zone.cct < 4000);
    model.destroy();
  });
});

// ── Warm dim (model-owned, so every sink gets it) ────────

describe("model warm dim", () => {
  test("applies the zone curve when a level command carries no colour", async () => {
    const model = await makeModel({
      watchedZones: new Set([100]),
      zoneCurves: new Map([[100, "halogen"]]),
    });

    model.apply(levelIntent(100, 30));

    const zone = model.getZoneState(100)!;
    assert.equal(zone.colorMode, "cct");
    assert.ok(zone.cct, "curve should have produced a cct");
    model.destroy();
  });

  test("an explicit cct wins over the zone curve", async () => {
    const model = await makeModel({
      watchedZones: new Set([100]),
      zoneCurves: new Map([[100, "halogen"]]),
    });

    model.apply(levelIntent(100, 30, { cct: 5000 }));

    assert.equal(model.getZoneState(100)!.cct, 5000);
    model.destroy();
  });

  test("re-evaluates the curve on every ramp tick", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      zoneCurves: new Map([[100, "halogen"]]),
      now: clock.now,
    });

    model.apply({
      kind: "ramp",
      action: "start",
      direction: "raise",
      zoneId: 100,
      origin: "DIM_HOLD",
    });
    clock.advance(500);
    model.tick();
    const early = model.getZoneState(100)!.cct;

    clock.advance(2000);
    model.tick();
    const late = model.getZoneState(100)!.cct;

    assert.ok(early && late);
    assert.notEqual(early, late, "cct should track the rising level");
    model.destroy();
  });
});

// ── Settle-to-idle (the DEVICE_REPORT trigger) ───────────

describe("model settle-to-idle", () => {
  test("emits zone:settled exactly once, after the report delay", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });
    const settled: ZoneSettledEvent[] = [];
    model.on("zone:settled", (e: ZoneSettledEvent) => settled.push(e));

    model.apply(levelIntent(100, 75));

    clock.advance(1000);
    model.tick();
    assert.equal(settled.length, 0, "must not fire before the delay");

    clock.advance(1500);
    model.tick();
    assert.equal(settled.length, 1);
    assert.equal(settled[0].zoneId, 100);
    assert.equal(settled[0].level, 75);

    clock.advance(5000);
    model.tick();
    model.tick();
    assert.equal(settled.length, 1, "must not re-fire once settled");
    model.destroy();
  });

  test("a burst of repeats settles once, not once per repeat", async () => {
    // This is the behaviour that keeps DEVICE_REPORT from firing six times at
    // 500ms: each repeat pushes the settle deadline out.
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });
    const settled: ZoneSettledEvent[] = [];
    model.on("zone:settled", (e: ZoneSettledEvent) => settled.push(e));

    for (let i = 0; i < 6; i++) {
      model.apply(levelIntent(100, 60, { dedupKey: `0:100:${i}` }));
      clock.advance(500);
      model.tick();
    }
    assert.equal(
      settled.length,
      0,
      "still inside the delay of the last repeat",
    );

    clock.advance(2000);
    model.tick();
    assert.equal(settled.length, 1);
    model.destroy();
  });

  test("does not settle while the zone is still fading", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });
    const settled: ZoneSettledEvent[] = [];
    model.on("zone:settled", (e: ZoneSettledEvent) => settled.push(e));

    model.apply(levelIntent(100, 100, { fade: 40 })); // 10s fade
    clock.advance(3000);
    model.tick();
    assert.equal(settled.length, 0, "fade still running");

    clock.advance(8000);
    model.tick(); // fade completes here → idle
    assert.equal(settled.length, 1);
    model.destroy();
  });
});

// ── Change events (what sinks subscribe to) ──────────────

describe("model change events", () => {
  test("an instant level emits zone:changed immediately, not on the next tick", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });
    const changes: ZoneChangedEvent[] = [];
    model.on("zone:changed", (e: ZoneChangedEvent) => changes.push(e));

    model.apply(levelIntent(100, 75));

    assert.equal(changes.length, 1);
    assert.equal(changes[0].zoneId, 100);
    assert.equal(changes[0].level, 75);
    assert.equal(changes[0].activity, "idle");
    model.destroy();
  });

  test("a fade emits one zone:changed per tick while running", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });
    const changes: ZoneChangedEvent[] = [];
    model.on("zone:changed", (e: ZoneChangedEvent) => changes.push(e));

    model.apply(levelIntent(100, 100, { fade: 8 }));
    const afterDispatch = changes.length;

    clock.advance(500);
    model.tick();
    clock.advance(500);
    model.tick();

    assert.equal(changes.length, afterDispatch + 2);
    model.destroy();
  });

  test("an idle zone emits nothing on tick", async () => {
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });
    model.apply(levelIntent(100, 50));

    const changes: ZoneChangedEvent[] = [];
    model.on("zone:changed", (e: ZoneChangedEvent) => changes.push(e));
    clock.advance(100);
    model.tick();
    model.tick();

    assert.equal(changes.length, 0);
    model.destroy();
  });

  test("emits a command event describing what was resolved", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });
    const commands: CommandEvent[] = [];
    model.on("command", (e: CommandEvent) => commands.push(e));

    model.apply(levelIntent(100, 75, { fade: 8 }));

    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, "level");
    assert.equal(commands[0].zoneId, 100);
    assert.equal(commands[0].zoneName, "Zone 100");
    if (commands[0].kind === "level") {
      assert.equal(commands[0].level, 75);
      assert.equal(commands[0].fade, 8);
      assert.equal(commands[0].origin, "LEVEL");
    }
    model.destroy();
  });
});
