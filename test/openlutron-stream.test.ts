/**
 * openlutron stream client — tests.
 *
 * The socket and the clock are both injected, so every case here is
 * deterministic and none of them needs a board on the network. The point of the
 * client is that four consumers stop hand-rolling this loop, so the cases that
 * matter are the ones the hand-rolled versions got wrong or skipped: silence
 * detection, recovery, and a socket error that must not become a throw.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
  STATUS_BLOB_V1_SIZE,
  STATUS_FIELD_OFFSETS,
} from "../lib/nucleo-status";
import {
  CMD_KEEPALIVE,
  OpenlutronStream,
  type StreamDatagramSocket,
  type StreamTimerHandle,
} from "../lib/openlutron-stream";

function isTimerId(handle: StreamTimerHandle): handle is number {
  return typeof handle === "number";
}

import {
  FLAG_CCX,
  FLAG_SRC,
  FRAME_HEADER_LEN,
  rloc16FromIpv6,
  type StreamPacketFrame,
} from "../lib/stream-frame";

// ── Test doubles ──────────────────────────────────────────

interface SentDatagram {
  bytes: Buffer;
  port: number;
  address: string;
}

/**
 * A dgram-shaped socket that records what was sent and lets a test inject
 * datagrams. `failSend` makes send() report an error through its callback, the
 * way an unreachable host does.
 */
class FakeSocket implements StreamDatagramSocket {
  readonly sent: SentDatagram[] = [];
  bound = false;
  closed = false;
  failSend: Error | null = null;
  /** Bind reports failure the way dgram does: an `error` event, no callback. */
  failBind: Error | null = null;

  private messageListeners: Array<(msg: Buffer) => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];

  on(event: "message" | "error", listener: (arg: any) => void): void {
    if (event === "message") this.messageListeners.push(listener);
    else this.errorListeners.push(listener);
  }

  bind(callback?: () => void): void {
    if (this.failBind) {
      const err = this.failBind;
      for (const l of this.errorListeners) l(err);
      return;
    }
    this.bound = true;
    callback?.();
  }

  send(
    msg: Buffer,
    offset: number,
    length: number,
    port: number,
    address: string,
    callback?: (err: Error | null) => void,
  ): void {
    if (this.failSend) {
      callback?.(this.failSend);
      return;
    }
    this.sent.push({
      bytes: Buffer.from(msg.subarray(offset, offset + length)),
      port,
      address,
    });
    callback?.(null);
  }

  close(callback?: () => void): void {
    this.closed = true;
    callback?.();
  }

  /** Deliver a datagram as if the board had sent it. */
  deliver(msg: Buffer): void {
    for (const l of this.messageListeners) l(msg);
  }

  /** Raise a socket-level error, as dgram does on a dead socket. */
  raise(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
}

/** Manual clock and timer queue — no real waiting anywhere in this file. */
function fakeTimers() {
  let now = 1_000;
  let nextId = 1;
  const pending = new Map<
    number,
    { fn: () => void; due: number; every: number | null }
  >();

  return {
    now: () => now,
    api: {
      now: () => now,
      setInterval(fn: () => void, ms: number): number {
        const id = nextId++;
        pending.set(id, { fn, due: now + ms, every: ms });
        return id;
      },
      setTimeout(fn: () => void, ms: number): number {
        const id = nextId++;
        pending.set(id, { fn, due: now + ms, every: null });
        return id;
      },
      clearInterval(handle: StreamTimerHandle): void {
        if (isTimerId(handle)) pending.delete(handle);
      },
      clearTimeout(handle: StreamTimerHandle): void {
        if (isTimerId(handle)) pending.delete(handle);
      },
    },
    /** Advance the clock, firing everything due along the way. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextDue = Infinity;
        for (const [id, t] of pending) {
          if (t.due <= target && t.due < nextDue) {
            nextDue = t.due;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const timer = pending.get(nextId)!;
        now = timer.due;
        if (timer.every === null) pending.delete(nextId);
        else timer.due = now + timer.every;
        timer.fn();
      }
      now = target;
    },
    get count() {
      return pending.size;
    },
  };
}

function makeStream(
  overrides: { keepaliveMs?: number; rebindDelayMs?: number } = {},
) {
  const first = new FakeSocket();
  const sockets: FakeSocket[] = [first];
  const timers = fakeTimers();
  let created = 0;
  const stream = new OpenlutronStream({
    host: "10.0.0.9",
    keepaliveMs: overrides.keepaliveMs,
    rebindDelayMs: overrides.rebindDelayMs,
    timers: timers.api,
    socketFactory: () => {
      if (created++ === 0) return first;
      const next = new FakeSocket();
      sockets.push(next);
      return next;
    },
  });
  return { stream, socket: first, timers, sockets };
}

// ── Registration ──────────────────────────────────────────

describe("openlutron stream client", () => {
  it("registers with the board by sending a keepalive on connect", async () => {
    const { stream, socket } = makeStream();

    await stream.connect();

    assert.equal(socket.bound, true);
    assert.deepEqual(socket.sent.length, 1);
    assert.deepEqual(socket.sent[0].bytes, Buffer.from([CMD_KEEPALIVE, 0x00]));
    assert.equal(socket.sent[0].port, 9433);
    assert.equal(socket.sent[0].address, "10.0.0.9");

    stream.close();
  });

  it("keeps re-registering, because registration expires on the board", async () => {
    const { stream, socket, timers } = makeStream({ keepaliveMs: 5000 });
    await stream.connect();

    timers.advance(12_000);

    // One on connect, then one per interval.
    assert.equal(socket.sent.length, 3);
    for (const sent of socket.sent) {
      assert.deepEqual(sent.bytes, Buffer.from([CMD_KEEPALIVE, 0x00]));
    }

    stream.close();
  });

  it("stops sending keepalives once closed", async () => {
    const { stream, socket, timers } = makeStream({ keepaliveMs: 5000 });
    await stream.connect();

    stream.close();
    timers.advance(30_000);

    assert.equal(socket.sent.length, 1);
    assert.equal(socket.closed, true);
    assert.equal(timers.count, 0, "left a timer running after close");
  });

  // ── Liveness ────────────────────────────────────────────

  it("reports up on the first datagram", async () => {
    const { stream, socket } = makeStream();
    let ups = 0;
    stream.on("up", () => ups++);
    await stream.connect();

    assert.equal(ups, 0, "up before the board has said anything");
    socket.deliver(heartbeat());

    assert.equal(ups, 1);
    assert.equal(stream.connected, true);

    stream.close();
  });

  it("reports down after silence longer than the connection timeout", async () => {
    const { stream, socket, timers } = makeStream({ keepaliveMs: 5000 });
    const seen: string[] = [];
    stream.on("up", () => seen.push("up"));
    stream.on("down", () => seen.push("down"));
    await stream.connect();
    socket.deliver(heartbeat());

    timers.advance(20_000);

    assert.deepEqual(seen, ["up", "down"]);
    assert.equal(stream.connected, false);

    stream.close();
  });

  it("reports up again when datagrams resume, without a restart", async () => {
    const { stream, socket, timers } = makeStream({ keepaliveMs: 5000 });
    const seen: string[] = [];
    stream.on("up", () => seen.push("up"));
    stream.on("down", () => seen.push("down"));
    await stream.connect();
    socket.deliver(heartbeat());
    timers.advance(20_000);

    socket.deliver(heartbeat());

    assert.deepEqual(seen, ["up", "down", "up"]);
    assert.equal(stream.connected, true);

    stream.close();
  });

  it("reports down when the board never answers at all", async () => {
    const { stream, timers } = makeStream({ keepaliveMs: 5000 });
    const seen: string[] = [];
    stream.on("up", () => seen.push("up"));
    stream.on("down", () => seen.push("down"));
    await stream.connect();

    // Nothing delivered — the board is off, or unreachable. Reporting only
    // after a first success would leave an add-on that never reached its board
    // completely silent, which reads exactly like working-but-quiet.
    timers.advance(20_000);

    assert.deepEqual(seen, ["down"]);
    assert.equal(stream.connected, false);

    stream.close();
  });

  it("reports down once, not once per keepalive, while never reachable", async () => {
    const { stream, timers } = makeStream({ keepaliveMs: 5000 });
    let downs = 0;
    stream.on("down", () => downs++);
    await stream.connect();

    timers.advance(120_000);

    assert.equal(downs, 1);

    stream.close();
  });

  it("reports down only once per outage", async () => {
    const { stream, socket, timers } = makeStream({ keepaliveMs: 5000 });
    let downs = 0;
    stream.on("down", () => downs++);
    await stream.connect();
    socket.deliver(heartbeat());

    timers.advance(120_000);

    assert.equal(downs, 1);

    stream.close();
  });

  // ── Datagram dispatch ───────────────────────────────────

  it("emits a parsed frame for a CCA packet datagram", async () => {
    const { stream, socket } = makeStream();
    const frames: StreamPacketFrame[] = [];
    stream.on("frame", (f: StreamPacketFrame) => frames.push(f));
    await stream.connect();

    const payload = Buffer.from("8f04a3984300000e", "hex");
    socket.deliver(packetFrame(0x1a, payload, { tsMs: 4242 }));

    assert.equal(frames.length, 1);
    assert.equal(frames[0].isCcx, false);
    assert.equal(frames[0].tsMs, 4242);
    assert.deepEqual(frames[0].data, payload);

    stream.close();
  });

  it("emits a CCX frame with its source attribution intact", async () => {
    const { stream, socket } = makeStream();
    const frames: StreamPacketFrame[] = [];
    stream.on("frame", (f: StreamPacketFrame) => frames.push(f));
    await stream.connect();

    const src = Buffer.alloc(16);
    src[0] = 0xfd;
    src.writeUInt16BE(0x1234, 14);
    src[11] = 0xff;
    src[12] = 0xfe;
    socket.deliver(
      packetFrame(FLAG_CCX | FLAG_SRC, Buffer.from([0x82, 0x00]), { src }),
    );

    assert.equal(frames.length, 1);
    assert.equal(frames[0].isCcx, true);
    assert.equal(frames[0].srcKind, "attributed");
    assert.equal(rloc16FromIpv6(frames[0].srcAddr!), 0x1234);

    stream.close();
  });

  it("routes text, status and heartbeat away from the frame channel", async () => {
    const { stream, socket } = makeStream();
    const frames: StreamPacketFrame[] = [];
    const texts: string[] = [];
    const blobs: Buffer[] = [];
    stream.on("frame", (f: StreamPacketFrame) => frames.push(f));
    stream.on("text", (t: string) => texts.push(t));
    stream.on("status", (b: Buffer) => blobs.push(b));
    await stream.connect();

    socket.deliver(heartbeat());
    socket.deliver(textDatagram("rx on\n"));
    socket.deliver(statusDatagram(Buffer.alloc(48, 0x07)));

    assert.equal(frames.length, 0, "a control datagram was read as a frame");
    assert.deepEqual(texts, ["rx on"]);
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].length, 48);

    stream.close();
  });

  it("drops a truncated packet frame rather than emitting a misparsed one", async () => {
    const { stream, socket } = makeStream();
    let frames = 0;
    stream.on("frame", () => frames++);
    await stream.connect();

    // Header claims 8 payload bytes; only 3 are present.
    const short = Buffer.concat([
      Buffer.from([0x1a, 0x08, 0, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from([0xaa, 0xbb, 0xcc]),
    ]);
    socket.deliver(short);
    socket.deliver(Buffer.from([0x1a]));

    assert.equal(frames, 0);

    stream.close();
  });

  // ── Unattended operation ────────────────────────────────

  it("ready() rejects when the board never answers", async () => {
    const { stream, timers } = makeStream();
    await stream.connect();

    const waiting = stream.ready(8000);
    timers.advance(8000);

    await assert.rejects(waiting, /10\.0\.0\.9:9433/);

    stream.close();
  });

  it("ready() resolves on the first datagram back", async () => {
    const { stream, socket, timers } = makeStream();
    await stream.connect();

    const waiting = stream.ready(8000);
    socket.deliver(heartbeat());
    timers.advance(8000);

    await waiting;

    stream.close();
  });

  it("rebinds after a socket error instead of going deaf", async () => {
    const { stream, socket, sockets, timers } = makeStream({
      rebindDelayMs: 1000,
    });
    const errors: Error[] = [];
    stream.on("error", (err: Error) => errors.push(err));
    await stream.connect();

    socket.raise(new Error("ECONNREFUSED"));
    timers.advance(1000);
    await flush();

    assert.equal(errors.length, 1);
    assert.equal(socket.closed, true, "left the dead socket open");
    assert.equal(sockets.length, 2, "did not rebind");
    assert.equal(sockets[1].bound, true);
    assert.deepEqual(sockets[1].sent[0].bytes, Buffer.from([CMD_KEEPALIVE, 0]));

    stream.close();
  });

  it("delivers frames on the rebound socket", async () => {
    const { stream, socket, sockets, timers } = makeStream({
      rebindDelayMs: 1000,
    });
    let frames = 0;
    stream.on("error", () => {});
    stream.on("frame", () => frames++);
    await stream.connect();
    socket.raise(new Error("ECONNREFUSED"));
    timers.advance(1000);
    await flush();

    sockets[1].deliver(packetFrame(0x1a, Buffer.from([0x8f, 0x04])));

    assert.equal(frames, 1);

    stream.close();
  });

  it("does not rebind after close", async () => {
    const { stream, socket, sockets, timers } = makeStream({
      rebindDelayMs: 1000,
    });
    stream.on("error", () => {});
    await stream.connect();

    stream.close();
    socket.raise(new Error("ECONNREFUSED"));
    timers.advance(10_000);

    assert.equal(sockets.length, 1);
  });

  it("reports a failed send instead of throwing", async () => {
    const { stream, socket } = makeStream();
    const errors: Error[] = [];
    stream.on("error", (err: Error) => errors.push(err));
    await stream.connect();

    socket.failSend = new Error("EHOSTUNREACH");
    stream.sendText("rx on");

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /EHOSTUNREACH/);

    stream.close();
  });

  it("survives a send that throws synchronously", async () => {
    const { stream, socket } = makeStream();
    const errors: Error[] = [];
    stream.on("error", (err: Error) => errors.push(err));
    await stream.connect();

    socket.send = () => {
      throw new Error("socket closed");
    };
    stream.sendText("rx on");

    assert.equal(errors.length, 1);

    stream.close();
  });

  // ── Commands ────────────────────────────────────────────

  it("frames a text command as [0x20][len][body]", async () => {
    const { stream, socket } = makeStream();
    await stream.connect();

    stream.sendText("rx on");

    const sent = socket.sent[1].bytes;
    assert.equal(sent[0], 0x20);
    assert.equal(sent[1], 5);
    assert.equal(sent.subarray(2).toString("utf-8"), "rx on");

    stream.close();
  });

  it("requestStatus resolves the parsed status blob", async () => {
    const { stream, socket } = makeStream();
    await stream.connect();

    const pending = stream.requestStatus(5000);
    assert.deepEqual(socket.sent[1].bytes, Buffer.from([0x11, 0x00]));
    socket.deliver(statusDatagram(statusBlob()));

    const status = await pending;
    assert.equal(status.ccaRx, 4242);

    stream.close();
  });

  it("requestStatus rejects when the board does not answer", async () => {
    const { stream, timers } = makeStream();
    await stream.connect();

    const pending = stream.requestStatus(5000);
    timers.advance(5000);

    await assert.rejects(pending, /status/);

    stream.close();
  });

  it("connect() rejects instead of hanging when the bind fails", async () => {
    // dgram reports a failed bind with an `error` event and never calls the
    // listening callback. Awaiting only that callback left connect() pending
    // forever: no keepalive timer, nothing to re-register with the board, and
    // in cli/nucleo.ts a `await setupStream()` that never returns.
    const { stream, socket } = makeStream();
    socket.failBind = new Error("EADDRINUSE");

    await assert.rejects(stream.connect(), /EADDRINUSE/);

    stream.close();
  });

  it("keeps the status waiter when a status datagram does not parse", async () => {
    // The waiters used to be cleared before the blob was parsed, so one short
    // or garbled status reply dropped them permanently and the caller timed
    // out with "unreachable, or firmware too old" — for a board that answered.
    const { stream, socket, timers } = makeStream();
    await stream.connect();

    const pending = stream.requestStatus(5000);
    // Too short to be a status blob — parseNucleoStatus rejects it.
    socket.deliver(statusDatagram(Buffer.from([0x00, 0x00])));
    timers.advance(10);
    socket.deliver(statusDatagram(statusBlob()));

    const status = await pending;
    assert.equal(status.ccaRx, 4242);

    stream.close();
  });
});

// ── Datagram builders ─────────────────────────────────────

/**
 * Let pending microtasks run. The rebind binds a socket asynchronously, so its
 * first keepalive is one tick behind the timer that scheduled it.
 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Heartbeat: [0xFF][0x00]. */
function heartbeat(): Buffer {
  return Buffer.from([0xff, 0x00]);
}

/** Text response: [0xFD][text…]. */
function textDatagram(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xfd]), Buffer.from(text, "utf-8")]);
}

/** Status response: [0xFE][len][blob]. */
function statusDatagram(blob: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xfe, blob.length]), blob]);
}

/** A v1-sized status blob with a recognizable CCA RX count. */
function statusBlob(): Buffer {
  const blob = Buffer.alloc(STATUS_BLOB_V1_SIZE);
  blob.writeUInt32LE(4242, STATUS_FIELD_OFFSETS.ccaRx);
  return blob;
}

/** Packet frame: [FLAGS][LEN][TS_MS:4][TS_CYC:4][DATA]([SRC:16]). */
function packetFrame(
  flags: number,
  data: Buffer,
  opts: { tsMs?: number; tsCyc?: number; src?: Buffer } = {},
): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_LEN);
  header[0] = flags;
  header[1] = data.length;
  header.writeUInt32LE(opts.tsMs ?? 0, 2);
  header.writeUInt32LE(opts.tsCyc ?? 0, 6);
  const parts = [header, data];
  if (opts.src) parts.push(opts.src);
  return Buffer.concat(parts);
}
