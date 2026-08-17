/**
 * openlutron bridge wiring — tests.
 *
 * The add-on runs unattended, so the cases here are the ones nobody will be
 * watching for: a board that never answers, a board that goes quiet mid-run,
 * and a socket that dies. None of them may take the bridge down, and all of
 * them have to be visible in Home Assistant rather than silently stale.
 *
 * These run the real client, the real demux, the real model and the real MQTT
 * sink against a fake socket and a fake broker.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it, type TestContext } from "node:test";
import type { MqttClientLike } from "../lib/bridge/sinks/mqtt";
import { OpenlutronBridge } from "../lib/openlutron-bridge";
import {
  OpenlutronStream,
  type StreamDatagramSocket,
} from "../lib/openlutron-stream";
import { FLAG_CCX, FLAG_SRC, FRAME_HEADER_LEN } from "../lib/stream-frame";

const AVAILABILITY = "lutron/bridge/source/openlutron/availability";

/** BUTTON_PRESS, device 1234ef20, from the committed CCX corpus. */
const CCX_PRESS = "8201a200a200441234ef20018301020305182a";

// ── Fakes ─────────────────────────────────────────────────

class FakeSocket implements StreamDatagramSocket {
  closed = false;
  private messageListeners: Array<(msg: Buffer) => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];

  on(event: "message" | "error", listener: (arg: any) => void): unknown {
    if (event === "message") this.messageListeners.push(listener);
    else this.errorListeners.push(listener);
    return this;
  }
  bind(cb?: () => void): void {
    cb?.();
  }
  send(): void {}
  close(): void {
    this.closed = true;
  }
  deliver(msg: Buffer): void {
    for (const l of this.messageListeners) l(msg);
  }
  raise(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
}

interface Published {
  topic: string;
  payload: string;
  retain: boolean;
}

class FakeBroker implements MqttClientLike {
  connected = true;
  readonly published: Published[] = [];
  private connectListeners: Array<() => void> = [];

  publish(
    topic: string,
    payload: string,
    opts: { retain?: boolean },
    cb?: (err?: Error) => void,
  ): void {
    this.published.push({ topic, payload, retain: opts.retain ?? false });
    cb?.();
  }
  on(event: string, listener: (...args: any[]) => void): unknown {
    if (event === "connect") this.connectListeners.push(listener as () => void);
    return this;
  }
  end(): void {}

  goOnline(): void {
    for (const l of this.connectListeners) l();
  }
  last(topic: string): Published | undefined {
    return this.published.filter((p) => p.topic === topic).pop();
  }
  count(topic: string): number {
    return this.published.filter((p) => p.topic === topic).length;
  }
}

function fakeTimers() {
  let now = 1000;
  let nextId = 1;
  const pending = new Map<
    number,
    { fn: () => void; due: number; every: number | null }
  >();
  return {
    api: {
      now: () => now,
      setInterval(fn: () => void, ms: number): unknown {
        const id = nextId++;
        pending.set(id, { fn, due: now + ms, every: ms });
        return id;
      },
      setTimeout(fn: () => void, ms: number): unknown {
        const id = nextId++;
        pending.set(id, { fn, due: now + ms, every: null });
        return id;
      },
      clearInterval(h: unknown): void {
        pending.delete(h as number);
      },
      clearTimeout(h: unknown): void {
        pending.delete(h as number);
      },
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let id: number | null = null;
        let due = Infinity;
        for (const [k, t] of pending) {
          if (t.due <= target && t.due < due) {
            due = t.due;
            id = k;
          }
        }
        if (id === null) break;
        const t = pending.get(id)!;
        now = t.due;
        if (t.every === null) pending.delete(id);
        else t.due = now + t.every;
        t.fn();
      }
      now = target;
    },
  };
}

// ── Frame builders ────────────────────────────────────────

function heartbeat(): Buffer {
  return Buffer.from([0xff, 0x00]);
}

function ccxPressDatagram(): Buffer {
  const src = Buffer.alloc(16);
  src[0] = 0xfd;
  src[11] = 0xff;
  src[12] = 0xfe;
  src.writeUInt16BE(0x1234, 14);
  return datagram(FLAG_CCX | FLAG_SRC, Buffer.from(CCX_PRESS, "hex"), src);
}

function ccaTapDatagram(seq = 0): Buffer {
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
  return datagram(0x0a, p, null);
}

function datagram(flags: number, data: Buffer, src: Buffer | null): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  header[0] = flags;
  header[1] = data.length;
  return Buffer.concat(src ? [header, data, src] : [header, data]);
}

// ── Harness ───────────────────────────────────────────────

async function makeBridge(t: TestContext) {
  const socket = new FakeSocket();
  const timers = fakeTimers();
  const broker = new FakeBroker();
  const stream = new OpenlutronStream({
    host: "10.0.0.9",
    timers: timers.api,
    socketFactory: () => socket,
  });
  const bridge = new OpenlutronBridge({
    host: "10.0.0.9",
    stream,
    pairings: [],
    presetZones: new Map(),
    watchedZones: new Set(),
    mqtt: { client: broker },
    // One clock for the stream and the model, so dedup windows can be tested
    // without waiting.
    now: timers.api.now,
  });
  // Registered before the assertions so a failure cannot leave the model's
  // tick interval running and hang the whole run.
  t.after(() => bridge.close());
  broker.goOnline();
  await bridge.start();
  return { bridge, socket, timers, broker };
}

describe("openlutron bridge", () => {
  // ── Availability ────────────────────────────────────────

  it("reports the source offline until the board has answered", async (t) => {
    const { broker } = await makeBridge(t);

    // UDP gives no handshake, so a bound socket says nothing about the board.
    // Defaulting to online here would show HA a full set of live entities fed
    // by a board that may not exist.
    assert.equal(broker.last(AVAILABILITY)?.payload, "offline");
    assert.equal(broker.last(AVAILABILITY)?.retain, true);
  });

  it("reports the source online once the board answers", async (t) => {
    const { socket, broker } = await makeBridge(t);

    socket.deliver(heartbeat());

    assert.equal(broker.last(AVAILABILITY)?.payload, "online");
  });

  it("reports the source offline when the board goes quiet mid-run", async (t) => {
    const { socket, timers, broker } = await makeBridge(t);
    socket.deliver(heartbeat());

    timers.advance(30_000);

    assert.equal(broker.last(AVAILABILITY)?.payload, "offline");
  });

  it("comes back online when the board returns", async (t) => {
    const { socket, timers, broker } = await makeBridge(t);
    socket.deliver(heartbeat());
    timers.advance(30_000);

    socket.deliver(heartbeat());

    assert.equal(broker.last(AVAILABILITY)?.payload, "online");
  });

  // ── Survival ────────────────────────────────────────────

  it("starts against an unreachable board without failing", async (t) => {
    // start() resolving is the assertion: an add-on that throws here never
    // reaches the point where it could recover.
    const { timers, broker } = await makeBridge(t);

    timers.advance(120_000);

    assert.equal(broker.last(AVAILABILITY)?.payload, "offline");
    assert.equal(broker.last("lutron/bridge/availability")?.payload, "online");
  });

  it("survives a socket error mid-run and keeps publishing", async (t) => {
    const { socket, timers, broker } = await makeBridge(t);
    socket.deliver(heartbeat());

    socket.raise(new Error("ENETUNREACH"));
    timers.advance(2000);
    // The client rebinds onto a fresh socket; this one is the old one, but the
    // bridge itself must still be alive and publishing.
    socket.deliver(ccaTapDatagram());

    assert.equal(
      broker.last("lutron/bridge/availability")?.payload,
      "online",
      "the bridge took itself down over a socket error",
    );
  });

  // ── Both radios reach HA ────────────────────────────────

  it("publishes a CCA button press as an HA event", async (t) => {
    const { socket, broker } = await makeBridge(t);

    socket.deliver(ccaTapDatagram());

    const evt = broker.last("lutron/device/cca_deadbeef/event");
    assert.ok(evt, "no CCA event published");
    assert.equal(JSON.parse(evt.payload).event_type, "press");
    assert.equal(JSON.parse(evt.payload).source, "cca");
    // Never retained: a replayed press re-fires every bound automation.
    assert.equal(evt.retain, false);
  });

  it("publishes a CCX button press as an HA event", async (t) => {
    const { socket, broker } = await makeBridge(t);

    socket.deliver(ccxPressDatagram());

    const evt = broker.last("lutron/device/ccx_1234ef20/event");
    assert.ok(evt, "no CCX event published");
    assert.equal(JSON.parse(evt.payload).source, "ccx");
  });

  it("announces both radios' controls under one discovery prefix", async (t) => {
    const { socket, broker } = await makeBridge(t);

    socket.deliver(ccaTapDatagram());
    socket.deliver(ccxPressDatagram());

    assert.ok(
      broker.last("homeassistant/event/lutron_button_cca_deadbeef/config"),
    );
    assert.ok(
      broker.last("homeassistant/event/lutron_button_ccx_1234ef20/config"),
    );
  });

  it("fires twice for two presses of the same CCA button", async (t) => {
    const { socket, timers, broker } = await makeBridge(t);

    // Two real presses. Each starts its own burst at sequence 0, which is how
    // they stay distinguishable inside a window long enough to cover a full
    // retransmit burst.
    socket.deliver(ccaTapDatagram(0));
    timers.advance(400);
    socket.deliver(ccaTapDatagram(0));

    assert.equal(broker.count("lutron/device/cca_deadbeef/event"), 2);
  });

  it("fires twice even for a double tap inside the burst window", async (t) => {
    const { socket, timers, broker } = await makeBridge(t);

    // 120 ms apart — well inside the 1200 ms window. A timer alone would eat
    // the second press; the wire's own burst-start marker is what saves it.
    socket.deliver(ccaTapDatagram(0));
    timers.advance(120);
    socket.deliver(ccaTapDatagram(0));

    assert.equal(broker.count("lutron/device/cca_deadbeef/event"), 2);
  });

  it("fires once for a retransmit burst of one CCA press", async (t) => {
    const { socket, timers, broker } = await makeBridge(t);

    // One tap as the bench rig showed it: sequence 0, then retransmits at a
    // fixed stride, one frame apart. Five more frames of the same burst arrive
    // over the next 450 ms — one wire event, one HA event.
    socket.deliver(ccaTapDatagram(0));
    for (const seq of [6, 12, 18, 24, 30, 36]) {
      timers.advance(76);
      socket.deliver(ccaTapDatagram(seq));
    }

    assert.equal(broker.count("lutron/device/cca_deadbeef/event"), 1);
  });
});
