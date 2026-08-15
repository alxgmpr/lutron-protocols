import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import test, { describe, type TestContext } from "node:test";
import type { DeviceModel } from "../lib/bridge/model";
import type {
  BridgeSink,
  CommandEvent,
  SinkHost,
  SourceIntent,
  ZoneChangedEvent,
  ZoneSettledEvent,
} from "../lib/bridge/types";

// ── Helpers ───────────────────────────────────────────────

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/**
 * Bind a loopback UDP socket and resolve its ephemeral port. Closing is
 * registered on the test context so a failure mid-test cannot leave the socket
 * open and hang the runner.
 */
async function listener(t: TestContext) {
  const sock = createSocket("udp4");
  t.after(() => sock.close());
  const port = await new Promise<number>((resolve) => {
    sock.once("listening", () => resolve(sock.address().port));
    sock.bind(0, "127.0.0.1");
  });
  const messages: Buffer[] = [];
  sock.on("message", (m) => messages.push(m));
  const next = () =>
    new Promise<Buffer>((resolve) => sock.once("message", resolve));
  return { port, messages, next };
}

function levelIntent(
  zoneId: number,
  level: number,
  fade = 1,
  dedupKey?: string,
): SourceIntent {
  return {
    kind: "zoneLevel",
    zoneId,
    level,
    cct: null,
    colorXy: null,
    fade,
    origin: "LEVEL",
    dedupKey,
  };
}

async function makeModel(opts: {
  watchedZones?: Set<number>;
  now?: () => number;
}): Promise<DeviceModel> {
  const { DeviceModel } = await import("../lib/bridge/model");
  return new DeviceModel({
    watchedZones: opts.watchedZones ?? new Set(),
    resolveZoneName: (id) => `Zone ${id}`,
    now: opts.now,
    autoTick: false,
    reportDelayMs: 2000,
  });
}

// ── WiZ sink ─────────────────────────────────────────────

describe("WizSink", () => {
  test("turns a zone:changed into a setPilot datagram", async (t) => {
    const { port, next } = await listener(t);
    const { WizSink } = await import("../lib/bridge/sinks/wiz");
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.addSink(
      new WizSink({
        pairings: [
          {
            name: "Kitchen",
            zoneId: 100,
            wizIps: ["127.0.0.1"],
            wizPort: port,
          },
        ],
      }),
    );

    model.apply(levelIntent(100, 50));
    const msg = await next();

    const parsed = JSON.parse(msg.toString());
    assert.equal(parsed.method, "setPilot");
    assert.equal(parsed.params.state, true);
    model.destroy();
  });

  test("sends state:false when the zone reaches zero", async (t) => {
    const { port, next } = await listener(t);
    const { WizSink } = await import("../lib/bridge/sinks/wiz");
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.addSink(
      new WizSink({
        pairings: [
          {
            name: "Kitchen",
            zoneId: 100,
            wizIps: ["127.0.0.1"],
            wizPort: port,
          },
        ],
      }),
    );

    model.apply(levelIntent(100, 0));
    const msg = await next();

    assert.deepEqual(JSON.parse(msg.toString()).params, { state: false });
    model.destroy();
  });

  test("fans a zone out to every paired bulb", async (t) => {
    const a = await listener(t);
    const { WizSink } = await import("../lib/bridge/sinks/wiz");
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.addSink(
      new WizSink({
        pairings: [
          {
            name: "Pair",
            zoneId: 100,
            wizIps: ["127.0.0.1", "127.0.0.1"],
            wizPort: a.port,
          },
        ],
      }),
    );

    model.apply(levelIntent(100, 50));
    await a.next();
    await a.next(); // both bulbs addressed

    assert.equal(a.messages.length, 2);
    model.destroy();
  });

  test("warns once about a watched zone with no pairing", async () => {
    const { WizSink } = await import("../lib/bridge/sinks/wiz");
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });
    const lines: string[] = [];
    model.addSink(new WizSink({ pairings: [], log: (m) => lines.push(m) }));

    model.apply(levelIntent(100, 50, 8)); // fade → several ticks
    clock.advance(250);
    model.tick();
    clock.advance(250);
    model.tick();

    const warns = lines.filter((l) => l.includes("has no WiZ pairing"));
    assert.equal(warns.length, 1, `expected one warning, got ${warns.length}`);
    assert.match(warns[0], /Zone 100/);
    model.destroy();
  });
});

// ── Nucleo DEVICE_REPORT sink ────────────────────────────

describe("NucleoReportSink", () => {
  test("emits a framed DEVICE_REPORT when a zone settles", async (t) => {
    const { port, next } = await listener(t);
    const { NucleoReportSink } = await import(
      "../lib/bridge/sinks/nucleo-report"
    );
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });
    model.addSink(
      new NucleoReportSink({
        host: "127.0.0.1",
        port,
        serialByZone: new Map([[100, 71148018]]),
      }),
    );

    model.apply(levelIntent(100, 75));
    clock.advance(2500);
    model.tick();

    const frame = await next();
    assert.equal(frame[0], 0x16, "STREAM_CMD_TX_RAW_CCX_CBOR");
    assert.equal(frame[1], frame.length - 2, "length byte covers the payload");
    model.destroy();
  });

  test("stays silent for a zone with no device serial", async (t) => {
    const { port, messages } = await listener(t);
    const { NucleoReportSink } = await import(
      "../lib/bridge/sinks/nucleo-report"
    );
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });
    model.addSink(
      new NucleoReportSink({
        host: "127.0.0.1",
        port,
        serialByZone: new Map(),
      }),
    );

    model.apply(levelIntent(100, 75));
    clock.advance(2500);
    model.tick();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(messages.length, 0);
    model.destroy();
  });
});

// ── Log sink ─────────────────────────────────────────────

describe("LogSink", () => {
  test("formats a level command the way the bridge always has", async () => {
    const { LogSink } = await import("../lib/bridge/sinks/log");
    const model = await makeModel({ watchedZones: new Set([100]) });
    const lines: string[] = [];
    model.addSink(
      new LogSink({
        log: (m) => lines.push(m),
        timestamp: () => "12:00:00.000",
      }),
    );

    model.apply({
      kind: "zoneLevel",
      zoneId: 100,
      level: 75,
      cct: null,
      colorXy: null,
      fade: 8,
      origin: "LEVEL",
    });

    assert.equal(
      lines[0],
      "\n12:00:00.000 ** LEVEL → Zone 100 (zone=100) 75.0% fade=2s",
    );
    model.destroy();
  });

  test("labels a colour-only command instead of printing a level", async () => {
    const { LogSink } = await import("../lib/bridge/sinks/log");
    const model = await makeModel({ watchedZones: new Set([100]) });
    const lines: string[] = [];
    model.addSink(
      new LogSink({
        log: (m) => lines.push(m),
        timestamp: () => "12:00:00.000",
      }),
    );

    model.apply({
      kind: "zoneLevel",
      zoneId: 100,
      level: null,
      cct: null,
      colorXy: [3000, 4000],
      origin: "LEVEL",
    });

    assert.match(lines[0], /color-only/);
    assert.match(lines[0], /xy=\(0\.3000,0\.4000\)/);
    model.destroy();
  });

  test("formats ramp start and stop", async () => {
    const { LogSink } = await import("../lib/bridge/sinks/log");
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });
    const lines: string[] = [];
    model.addSink(
      new LogSink({
        log: (m) => lines.push(m),
        timestamp: () => "12:00:00.000",
      }),
    );

    model.apply({
      kind: "ramp",
      action: "start",
      direction: "raise",
      zoneId: 100,
      origin: "DIM_HOLD",
      dedupKey: "a",
    });
    clock.advance(750);
    model.apply({
      kind: "ramp",
      action: "stop",
      zoneId: 100,
      origin: "DIM_STEP",
      dedupKey: "b",
    });

    assert.equal(
      lines[0],
      "\n12:00:00.000 ** RAMP RAISE → Zone 100 (zone=100) from 0%",
    );
    assert.match(
      lines[1],
      /\*\* RAMP STOP → Zone 100 \(zone=100\) at \d+% \(750ms\)/,
    );
    model.destroy();
  });
});

// ── A second sink needs no protocol or model change ──────

/**
 * Test-only sink built against nothing but the public BridgeSink interface —
 * the same seam MQTT (GLAB-92) will use. It records what it is handed so a
 * test can prove it sees exactly what the WiZ sink sees.
 */
class RecordingSink implements BridgeSink {
  readonly name = "recording";
  changed: ZoneChangedEvent[] = [];
  settled: ZoneSettledEvent[] = [];
  commands: CommandEvent[] = [];
  detached = false;

  attach(model: SinkHost): void {
    model.on("zone:changed", (e) => this.changed.push(e));
    model.on("zone:settled", (e) => this.settled.push(e));
    model.on("command", (e) => this.commands.push(e));
  }

  detach(): void {
    this.detached = true;
  }
}

describe("adding a sink", () => {
  test("a new sink receives the same events that drive WiZ", async (t) => {
    const { port, messages } = await listener(t);
    const { WizSink } = await import("../lib/bridge/sinks/wiz");
    const clock = fakeClock();
    const model = await makeModel({
      watchedZones: new Set([100]),
      now: clock.now,
    });

    const recording = new RecordingSink();
    model.addSink(
      new WizSink({
        pairings: [
          {
            name: "Kitchen",
            zoneId: 100,
            wizIps: ["127.0.0.1"],
            wizPort: port,
          },
        ],
      }),
    );
    model.addSink(recording);

    // Instant level, then a fade, then settle.
    model.apply(levelIntent(100, 40, 1, "a"));
    model.apply(levelIntent(100, 100, 8, "b"));
    clock.advance(1000);
    model.tick();
    clock.advance(1000);
    model.tick();
    clock.advance(2500);
    model.tick();

    await new Promise((r) => setTimeout(r, 50));

    // The WiZ sink sent one datagram per change event; the recording sink saw
    // the same changes without a line of protocol or model code changing.
    assert.equal(recording.changed.length, messages.length);
    assert.ok(recording.changed.length >= 3);
    assert.equal(recording.changed.at(-1)?.level, 100);
    assert.equal(recording.settled.length, 1);
    assert.equal(recording.settled[0].zoneId, 100);
    assert.equal(recording.commands.length, 2);

    model.destroy();
    assert.equal(recording.detached, true, "destroy should detach sinks");
  });

  test("a sink added later still sees subsequent events", async () => {
    const model = await makeModel({ watchedZones: new Set([100]) });
    model.apply(levelIntent(100, 20, 1, "before"));

    const recording = new RecordingSink();
    model.addSink(recording);
    model.apply(levelIntent(100, 60, 1, "after"));

    assert.equal(recording.changed.length, 1);
    assert.equal(recording.changed[0].level, 60);
    model.destroy();
  });
});
