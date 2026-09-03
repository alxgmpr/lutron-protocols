import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { CCXPacket } from "../ccx/types";
import type {
  CommandEvent,
  DeviceEvent,
  ZoneChangedEvent,
  ZoneSettledEvent,
} from "../lib/bridge/types";

type BridgeEventPayload =
  | CommandEvent
  | DeviceEvent
  | ZoneChangedEvent
  | ZoneSettledEvent;

// ── Fake broker ───────────────────────────────────────────

interface Published {
  topic: string;
  payload: string;
  retain: boolean;
}

/**
 * Stands in for an MQTT client. The sink is written against this shape, so a
 * test asserts on the exact topics and payloads a broker would receive without
 * one running.
 */
class FakeMqttClient {
  published: Published[] = [];
  connected = false;
  ended = false;
  /** Set to make every publish throw, standing in for a dead client. */
  throwOnPublish = false;

  private handlers = new Map<string, ((...a: unknown[]) => void)[]>();

  publish(
    topic: string,
    payload: string,
    opts: { retain?: boolean },
    cb?: (err?: Error) => void,
  ): void {
    if (this.throwOnPublish) throw new Error("client destroyed");
    this.published.push({ topic, payload, retain: opts?.retain ?? false });
    cb?.();
  }

  on(event: string, listener: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  end(_force?: boolean, cb?: () => void): void {
    this.ended = true;
    cb?.();
  }

  // ── Test drivers ────────────────────────────────────────

  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }

  goOnline(): void {
    this.connected = true;
    this.emit("connect");
  }

  goOffline(): void {
    this.connected = false;
    this.emit("offline");
  }

  /** Every publish to a topic, oldest first. */
  on_(topic: string): Published[] {
    return this.published.filter((p) => p.topic === topic);
  }

  last(topic: string): Published | undefined {
    return this.on_(topic).at(-1);
  }

  json(topic: string): any {
    const hit = this.last(topic);
    assert.ok(hit, `nothing published to ${topic}`);
    return JSON.parse(hit.payload);
  }

  clear(): void {
    this.published = [];
  }
}

// ── Sink under test ───────────────────────────────────────

async function makeSink(
  client: FakeMqttClient,
  opts: { sources?: string[]; baseTopic?: string } = {},
) {
  const { MqttSink } = await import("../lib/bridge/sinks/mqtt");
  return new MqttSink({
    // SAFETY: The test controls this fixture and intentionally uses the asserted test-only shape.
    client: client as any,
    sources: opts.sources ?? ["ccx"],
    baseTopic: opts.baseTopic,
  });
}

/** Minimal SinkHost so a sink can be driven without a whole model. */
function host() {
  const listeners = new Map<string, ((e: any) => void)[]>();
  return {
    on(event: string, listener: (e: any) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    isExplicitlyWatched: () => true,
    fire(event: string, payload: BridgeEventPayload) {
      for (const l of listeners.get(event) ?? []) l(payload);
    },
  };
}

function zoneChange(over: Partial<ZoneChangedEvent> = {}): ZoneChangedEvent {
  return {
    zoneId: 100,
    zoneName: "Kitchen",
    level: 50,
    colorMode: "cct",
    cct: null,
    colorXy: null,
    activity: "idle",
    ...over,
  };
}

function press(over: Partial<DeviceEvent> = {}): DeviceEvent {
  return {
    deviceId: "0c2cef20",
    deviceName: "Kitchen Pico",
    button: 0x2c,
    action: "press",
    origin: "PRESET",
    source: "ccx",
    sequence: 4,
    ...over,
  };
}

function buttonPacket(opts: { presetId: number; sequence: number }): CCXPacket {
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
    body: { 0: { 0: deviceId, 1: [1] }, 5: opts.sequence },
    parsed: {
      type: "BUTTON_PRESS",
      deviceId,
      buttonZone: lo,
      cmdType: hi,
      counters: [1],
      sequence: opts.sequence,
      rawBody: { 0: { 0: deviceId, 1: [1] }, 5: opts.sequence },
    },
    rawHex: "",
  };
}

// ── Zone lights ───────────────────────────────────────────

describe("MqttSink zone lights", () => {
  test("announces a light discovery config the first time a zone is seen", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("zone:changed", zoneChange());

    const cfg = client.json("homeassistant/light/lutron_zone_100/config");
    assert.equal(cfg.unique_id, "lutron_zone_100");
    assert.equal(cfg.name, "Kitchen");
    assert.equal(cfg.schema, "json");
    assert.equal(cfg.state_topic, "lutron/zone/100/state");
    assert.equal(cfg.brightness, true);
    assert.ok(
      client.last("homeassistant/light/lutron_zone_100/config")?.retain,
      "discovery must be retained so entities survive an HA restart",
    );
  });

  test("announces each zone once, however many events it sees", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("zone:changed", zoneChange({ level: 10 }));
    h.fire("zone:changed", zoneChange({ level: 20 }));
    h.fire("zone:changed", zoneChange({ level: 30 }));

    assert.equal(
      client.on_("homeassistant/light/lutron_zone_100/config").length,
      1,
    );
    assert.equal(client.on_("lutron/zone/100/state").length, 3);
  });

  test("publishes retained zone state as an HA JSON light payload", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("zone:changed", zoneChange({ level: 50 }));

    const state = client.json("lutron/zone/100/state");
    assert.equal(state.state, "ON");
    assert.equal(state.brightness, 128); // 50% of 255
    assert.ok(
      client.last("lutron/zone/100/state")?.retain,
      "state topics are retained",
    );
  });

  test("a zone at zero is OFF", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("zone:changed", zoneChange({ level: 0 }));

    assert.equal(client.json("lutron/zone/100/state").state, "OFF");
  });

  test("carries CCT through as color_temp_kelvin", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("zone:changed", zoneChange({ level: 80, cct: 2700 }));

    const state = client.json("lutron/zone/100/state");
    assert.equal(state.color_mode, "color_temp");
    assert.equal(state.color_temp_kelvin, 2700);
  });

  test("carries xy through, rescaled from the wire's x10000 integers", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire(
      "zone:changed",
      zoneChange({ level: 80, colorMode: "xy", colorXy: [3127, 3290] }),
    );

    const state = client.json("lutron/zone/100/state");
    assert.equal(state.color_mode, "xy");
    assert.equal(state.color.x, 0.3127);
    assert.equal(state.color.y, 0.329);
  });
});

// ── Button events ─────────────────────────────────────────

describe("MqttSink button events", () => {
  test("announces an event entity the first time a device is seen", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("device:event", press());

    const cfg = client.json(
      "homeassistant/event/lutron_button_0c2cef20/config",
    );
    assert.equal(cfg.unique_id, "lutron_button_0c2cef20");
    assert.equal(cfg.state_topic, "lutron/device/0c2cef20/event");
    assert.deepEqual(cfg.event_types, ["press", "hold", "release"]);
    assert.equal(cfg.device.name, "Kitchen Pico");
  });

  test("publishes the press with an event_type HA can trigger on", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("device:event", press());

    const evt = client.json("lutron/device/0c2cef20/event");
    assert.equal(evt.event_type, "press");
    assert.equal(evt.button, 0x2c);
    assert.equal(evt.origin, "PRESET");
    assert.equal(evt.source, "ccx");
  });

  test("event topics are NOT retained", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("device:event", press());

    assert.equal(
      client.last("lutron/device/0c2cef20/event")?.retain,
      false,
      "a retained press would re-fire every automation on HA restart",
    );
  });

  test("pressing the same button twice publishes twice", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("device:event", press({ sequence: 1 }));
    h.fire("device:event", press({ sequence: 2 }));

    assert.equal(client.on_("lutron/device/0c2cef20/event").length, 2);
  });
});

// ── Availability ──────────────────────────────────────────

describe("MqttSink availability", () => {
  test("publishes bridge and per-source availability on connect", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client, { sources: ["ccx"] });
    sink.attach(host());

    client.goOnline();

    assert.equal(client.last("lutron/bridge/availability")?.payload, "online");
    assert.equal(
      client.last("lutron/bridge/source/ccx/availability")?.payload,
      "online",
    );
    assert.ok(client.last("lutron/bridge/availability")?.retain);
  });

  test("entities depend on both the bridge and their source being up", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client, { sources: ["ccx"] });
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("zone:changed", zoneChange());

    const cfg = client.json("homeassistant/light/lutron_zone_100/config");
    assert.equal(cfg.availability_mode, "all");
    assert.deepEqual(
      cfg.availability.map((a: { topic: string }) => a.topic),
      ["lutron/bridge/availability", "lutron/bridge/source/ccx/availability"],
    );
  });

  test("a source going down does not take the whole bridge offline", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client, { sources: ["ccx", "leap"] });
    sink.attach(host());
    client.goOnline();
    client.clear();

    sink.setSourceAvailable("ccx", false);

    assert.equal(
      client.last("lutron/bridge/source/ccx/availability")?.payload,
      "offline",
    );
    assert.equal(
      client.last("lutron/bridge/availability"),
      undefined,
      "the bridge itself is still up",
    );
    assert.equal(
      client.last("lutron/bridge/source/leap/availability"),
      undefined,
      "the other source is untouched",
    );
  });

  test("detach marks the bridge offline and closes the client", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    sink.attach(host());
    client.goOnline();

    sink.detach();

    assert.equal(client.last("lutron/bridge/availability")?.payload, "offline");
    assert.equal(client.ended, true);
  });
});

// ── Surviving a broker that is not there ──────────────────
//
// The bridge runs unattended as an HA add-on. A missing or flapping broker is
// a normal operating condition, not an error path — it must never stop the
// bridge from decoding packets and driving the other sinks.

describe("MqttSink never takes the bridge down", () => {
  test("events published while the broker is unreachable do not throw", async () => {
    const client = new FakeMqttClient(); // never goes online
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);

    assert.doesNotThrow(() => {
      h.fire("zone:changed", zoneChange());
      h.fire("device:event", press());
    });
    // Nothing was announced, because nothing could be.
    assert.equal(client.published.length, 0);
  });

  test("a client that throws on publish is swallowed and logged", async () => {
    const client = new FakeMqttClient();
    const lines: string[] = [];
    const { MqttSink } = await import("../lib/bridge/sinks/mqtt");
    const sink = new MqttSink({
      // SAFETY: The test controls this fixture and intentionally uses the asserted test-only shape.
      client: client as any,
      log: (m) => lines.push(m),
    });
    const h = host();
    sink.attach(h);
    client.goOnline();
    client.throwOnPublish = true;

    assert.doesNotThrow(() => h.fire("zone:changed", zoneChange()));
    assert.ok(
      lines.some((l) => /client destroyed/.test(l)),
      "the failure should be visible in the log",
    );
  });

  test("a client error event does not become an unhandled throw", async () => {
    const client = new FakeMqttClient();
    const lines: string[] = [];
    const { MqttSink } = await import("../lib/bridge/sinks/mqtt");
    const sink = new MqttSink({
      // SAFETY: The test controls this fixture and intentionally uses the asserted test-only shape.
      client: client as any,
      log: (m) => lines.push(m),
    });
    sink.attach(host());

    assert.doesNotThrow(() => client.emit("error", new Error("ECONNREFUSED")));
    assert.ok(lines.some((l) => /ECONNREFUSED/.test(l)));
  });

  test("dropping offline mid-run stops publishing but keeps serving events", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();
    h.fire("zone:changed", zoneChange({ level: 20 }));

    client.goOffline();
    client.clear();

    assert.doesNotThrow(() =>
      h.fire("zone:changed", zoneChange({ level: 60 })),
    );
    assert.equal(client.published.length, 0, "nothing goes out while offline");
  });

  test("reconnecting re-announces every entity seen so far", async () => {
    const client = new FakeMqttClient();
    const sink = await makeSink(client);
    const h = host();
    sink.attach(h);
    client.goOnline();

    h.fire("zone:changed", zoneChange());
    h.fire("device:event", press());

    client.goOffline();
    client.clear();
    client.goOnline();

    // The broker may have lost its retained set; HA needs the entities back
    // without waiting for someone to touch a light.
    assert.equal(
      client.on_("homeassistant/light/lutron_zone_100/config").length,
      1,
    );
    assert.equal(
      client.on_("homeassistant/event/lutron_button_0c2cef20/config").length,
      1,
    );
    assert.equal(client.last("lutron/bridge/availability")?.payload, "online");
  });
});

// ── End to end: real source, real model, real sink ────────

describe("MqttSink behind the real CCX source and model", () => {
  async function pipeline(opts: { watchedZones?: Set<number> } = {}) {
    const { DeviceModel } = await import("../lib/bridge/model");
    const { CcxSource } = await import("../lib/bridge/sources/ccx");
    const { MqttSink } = await import("../lib/bridge/sinks/mqtt");

    const client = new FakeMqttClient();
    const model = new DeviceModel({
      watchedZones: opts.watchedZones ?? new Set(),
      autoTick: false,
      resolveDeviceName: () => "Kitchen Pico",
    });
    // SAFETY: The test controls this fixture and intentionally uses the asserted test-only shape.
    model.addSink(new MqttSink({ client: client as any, sources: ["ccx"] }));
    client.goOnline();

    return { client, model, source: new CcxSource({ model }) };
  }

  test("a real press reaches the broker as an HA event", async () => {
    const { client, source, model } = await pipeline();

    source.handlePacket(buttonPacket({ presetId: 0x0c2c, sequence: 1 }));

    const evt = client.json("lutron/device/ccx_0c2cef20/event");
    assert.equal(evt.event_type, "press");
    assert.equal(evt.button, 0x2c);
    assert.ok(
      client.last("homeassistant/event/lutron_button_ccx_0c2cef20/config"),
    );
    model.destroy();
  });

  test("pressing the same button twice publishes two events", async () => {
    const { client, source, model } = await pipeline();

    // Two distinct wire events, distinct sequence numbers, well inside the
    // dedup window. Both are real user actions and both must get through.
    source.handlePacket(buttonPacket({ presetId: 0x0c2c, sequence: 1 }));
    source.handlePacket(buttonPacket({ presetId: 0x0c2c, sequence: 2 }));

    assert.equal(client.on_("lutron/device/ccx_0c2cef20/event").length, 2);
    model.destroy();
  });

  test("a Thread retransmission publishes one event", async () => {
    const { client, source, model } = await pipeline();

    // The mesh relays one frame three times, carrying the same sequence.
    for (let i = 0; i < 3; i++) {
      source.handlePacket(buttonPacket({ presetId: 0x0c2c, sequence: 9 }));
    }

    assert.equal(client.on_("lutron/device/ccx_0c2cef20/event").length, 1);
    model.destroy();
  });

  test("a Pico bound to no watched zone still reaches HA", async () => {
    // Watching zone 100 only; this press drives nothing at all. Before the
    // device channel existed it produced no output whatsoever.
    const { client, source, model } = await pipeline({
      watchedZones: new Set([100]),
    });

    source.handlePacket(buttonPacket({ presetId: 0x0c2c, sequence: 1 }));

    assert.equal(client.on_("lutron/device/ccx_0c2cef20/event").length, 1);
    model.destroy();
  });
});
