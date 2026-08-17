/**
 * openlutron stream client — the one UDP :9433 receive loop.
 *
 * The board (STM32H723 + CC1101 + nRF52840) streams every CCA and CCX frame it
 * hears to whichever hosts have registered with it, and takes commands back on
 * the same socket. Registration is a keepalive datagram and it expires, so a
 * client that stops sending them stops receiving.
 *
 * Wire format is owned by lib/stream-frame.ts; this file owns the session
 * around it: bind, register, keep registering, notice silence, recover.
 */

import { Buffer } from "node:buffer";
import { createSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { type NucleoStatus, parseNucleoStatus } from "./nucleo-status";
import { parseStreamPacketFrame, type StreamPacketFrame } from "./stream-frame";

export const OPENLUTRON_UDP_PORT = 9433;

/** Commands, host → board (firmware/src/net/stream.cpp). */
export const CMD_KEEPALIVE = 0x00;
export const CMD_STATUS_QUERY = 0x11;
export const CMD_TEXT = 0x20;

/**
 * Response tags, board → host. These occupy the same byte as a packet frame's
 * FLAGS, which is why they are all ≥ 0xFD: no real flag combination collides.
 */
export const RESP_TEXT = 0xfd;
export const RESP_STATUS = 0xfe;
export const RESP_HEARTBEAT = 0xff;

// ── Injected dependencies ─────────────────────────────────

/**
 * The slice of `dgram.Socket` this client uses. Injected rather than
 * constructed so tests drive a real client with no network.
 */
export interface StreamDatagramSocket {
  on(event: "message", listener: (msg: Buffer) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  bind(callback?: () => void): void;
  send(
    msg: Buffer,
    offset: number,
    length: number,
    port: number,
    address: string,
    callback?: (err: Error | null) => void,
  ): void;
  close(callback?: () => void): void;
}

/** Clock and timers, injected for the same reason as the socket. */
export interface StreamTimers {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: StreamTimers = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface OpenlutronStreamOptions {
  /** Board address. */
  host: string;
  port?: number;
  /** How often to re-register. Default 5 s, matching the previous clients. */
  keepaliveMs?: number;
  /**
   * Silence after which the board counts as gone. Default 12 s — the value
   * cli/nucleo.ts used, and more than two missed keepalives.
   */
  connectionTimeoutMs?: number;
  /** How long to wait before replacing a socket that errored. Default 1 s. */
  rebindDelayMs?: number;
  timers?: StreamTimers;
  socketFactory?: () => StreamDatagramSocket;
}

const DEFAULT_KEEPALIVE_MS = 5000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 12_000;
const DEFAULT_REBIND_DELAY_MS = 1000;
const DEFAULT_STATUS_TIMEOUT_MS = 5000;
const DEFAULT_READY_TIMEOUT_MS = 8000;

/**
 * What the client reports.
 *
 * `up`/`down` are about the board, not the socket: a bound socket with nothing
 * at the far end is `down`, which is exactly what the add-on publishes as its
 * MQTT source availability.
 */
export interface OpenlutronStreamEvents {
  frame: [StreamPacketFrame];
  text: [string];
  status: [Buffer];
  up: [];
  down: [];
  error: [Error];
}

export class OpenlutronStream extends EventEmitter<OpenlutronStreamEvents> {
  private readonly host: string;
  private readonly port: number;
  private readonly keepaliveMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly timers: StreamTimers;
  private readonly socketFactory: () => StreamDatagramSocket;

  private readonly rebindDelayMs: number;

  private socket: StreamDatagramSocket | null = null;
  private keepaliveTimer: unknown = null;
  private rebindTimer: unknown = null;
  private lastDatagramAt = 0;
  private connectedAt = 0;
  private up = false;
  /** Suppresses a `down` per keepalive while the board stays unreachable. */
  private reportedDown = false;
  private closed = false;
  private datagramWaiters: Array<() => void> = [];
  private statusWaiters: Array<(blob: Buffer) => void> = [];

  constructor(opts: OpenlutronStreamOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? OPENLUTRON_UDP_PORT;
    this.keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.connectionTimeoutMs =
      opts.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.rebindDelayMs = opts.rebindDelayMs ?? DEFAULT_REBIND_DELAY_MS;
    this.timers = opts.timers ?? realTimers;
    this.socketFactory = opts.socketFactory ?? (() => createSocket("udp4"));
  }

  /**
   * True once the board has been heard from and not yet gone quiet.
   *
   * Starts false: UDP has no handshake, so a bound socket proves nothing about
   * whether anything is listening at the other end.
   */
  get connected(): boolean {
    return this.up;
  }

  /**
   * Bind and register. Resolves once the socket is up and the first keepalive
   * has gone out — NOT once the board has answered, which UDP cannot promise
   * and an unattended bridge must not block on. Use `ready()` for that.
   */
  async connect(): Promise<void> {
    this.closed = false;
    this.connectedAt = this.timers.now();
    this.reportedDown = false;
    await this.bindSocket();
    this.keepaliveTimer = this.timers.setInterval(
      () => this.onKeepaliveTick(),
      this.keepaliveMs,
    );
  }

  private async bindSocket(): Promise<void> {
    const socket = this.socketFactory();
    this.socket = socket;
    socket.on("message", (msg: Buffer) => this.onDatagram(msg));
    socket.on("error", (err: Error) => this.onSocketError(socket, err));
    await new Promise<void>((done) => socket.bind(() => done()));
    this.sendCommand(CMD_KEEPALIVE);
  }

  /**
   * Resolves on the first datagram back from the board, which is the only proof
   * that registration took — the board streams to registered clients only.
   */
  ready(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    if (this.up) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.datagramWaiters = this.datagramWaiters.filter((w) => w !== waiter);
        reject(
          new Error(
            `no response from ${this.host}:${this.port} — is the board powered and on the network?`,
          ),
        );
      }, timeoutMs);
      const waiter = () => {
        this.timers.clearTimeout(timer);
        resolve();
      };
      this.datagramWaiters.push(waiter);
    });
  }

  /**
   * Ask the board for its counter blob.
   *
   * Firmware that predates the 0x11 opcode simply ignores the query, so a
   * timeout here is a version gap as often as it is a network problem; the
   * message says both.
   */
  requestStatus(timeoutMs = DEFAULT_STATUS_TIMEOUT_MS): Promise<NucleoStatus> {
    return new Promise<NucleoStatus>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.statusWaiters = this.statusWaiters.filter((w) => w !== waiter);
        reject(
          new Error(
            `no status response from ${this.host} — unreachable, or firmware too old to answer 0x11?`,
          ),
        );
      }, timeoutMs);
      const waiter = (blob: Buffer) => {
        const parsed = parseNucleoStatus(blob);
        if (!parsed) return;
        this.timers.clearTimeout(timer);
        resolve(parsed);
      };
      this.statusWaiters.push(waiter);
      this.sendCommand(CMD_STATUS_QUERY);
    });
  }

  // ── Failure handling ────────────────────────────────────

  /**
   * A dgram socket that has errored may never deliver another datagram, and an
   * unattended bridge cannot notice that for itself. Report it, drop the
   * socket, and bind a fresh one — the board's registration expires on its own,
   * so the next keepalive re-registers.
   */
  private onSocketError(socket: StreamDatagramSocket, err: Error): void {
    this.emit("error", err);
    if (this.closed || socket !== this.socket) return;

    try {
      socket.close();
    } catch {
      // Already closed by the failure itself; the rebind is what matters.
    }
    this.socket = null;
    this.rebindTimer = this.timers.setTimeout(() => {
      this.rebindTimer = null;
      if (this.closed) return;
      void this.bindSocket().catch((bindErr: unknown) => {
        this.emit(
          "error",
          bindErr instanceof Error ? bindErr : new Error(String(bindErr)),
        );
      });
    }, this.rebindDelayMs);
  }

  // ── Liveness ────────────────────────────────────────────

  /**
   * Re-register, then judge whether the board is still there.
   *
   * Silence is measured from the last datagram, or from `connect()` when there
   * has never been one. A board that was never reachable has to report `down`
   * too: an unattended bridge that only ever speaks up after a first success
   * stays completely silent when its hardware is missing, which reads exactly
   * like working-but-quiet.
   */
  private onKeepaliveTick(): void {
    this.sendCommand(CMD_KEEPALIVE);
    if (this.reportedDown) return;

    const since = this.lastDatagramAt || this.connectedAt;
    if (this.timers.now() - since <= this.connectionTimeoutMs) return;

    this.up = false;
    this.reportedDown = true;
    this.emit("down");
  }

  /**
   * Every datagram is also a liveness signal, whatever else it carries — the
   * board sends heartbeats precisely so a quiet radio does not read as a dead
   * board.
   */
  private onDatagram(msg: Buffer): void {
    if (msg.length < 2) return;

    this.lastDatagramAt = this.timers.now();
    if (!this.up) {
      this.up = true;
      this.reportedDown = false;
      this.emit("up");
    }
    if (this.datagramWaiters.length > 0) {
      const waiters = this.datagramWaiters;
      this.datagramWaiters = [];
      for (const w of waiters) w();
    }

    const kind = msg[0];
    const len = msg[1];

    if (kind === RESP_HEARTBEAT && len === 0x00) return;

    if (kind === RESP_TEXT) {
      const text = msg.subarray(1).toString("utf-8").trim();
      if (text.length > 0) this.emit("text", text);
      return;
    }

    if (kind === RESP_STATUS) {
      const blob = msg.subarray(2, 2 + len);
      const waiters = this.statusWaiters;
      this.statusWaiters = [];
      for (const w of waiters) w(blob);
      this.emit("status", blob);
      return;
    }

    // Anything else is a packet frame. A truncated one is dropped by the
    // parser rather than read as garbage.
    const frame = parseStreamPacketFrame(msg);
    if (frame) this.emit("frame", frame);
  }

  /** Frame and send one command. */
  sendCommand(cmd: number, data?: Buffer): void {
    const body = data ?? Buffer.alloc(0);
    const frame = Buffer.alloc(2 + body.length);
    frame[0] = cmd;
    frame[1] = body.length;
    body.copy(frame, 2);
    this.send(frame);
  }

  /** Send a shell command as text: [CMD_TEXT][len][body]. */
  sendText(text: string): void {
    this.sendCommand(CMD_TEXT, Buffer.from(text, "utf-8"));
  }

  /**
   * Sending is best-effort, like the MQTT sink's publish: a host that has gone
   * away must surface as an event, never as a throw out of a timer callback
   * where nothing can catch it.
   */
  send(frame: Buffer): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(frame, 0, frame.length, this.port, this.host, (err) => {
        if (err) this.emit("error", err);
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(): void {
    this.closed = true;
    if (this.keepaliveTimer !== null) {
      this.timers.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.rebindTimer !== null) {
      this.timers.clearTimeout(this.rebindTimer);
      this.rebindTimer = null;
    }
    try {
      this.socket?.close();
    } catch {
      // Closing an already-dead socket is not worth reporting.
    }
    this.socket = null;
    this.up = false;
  }
}
