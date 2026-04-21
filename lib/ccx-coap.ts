/**
 * Shared CCX CoAP client — typed interface around the Nucleo firmware's
 * `ccx coap …` shell commands exposed over the UDP stream protocol (:9433).
 *
 * See docs/protocols/ccx-coap.md for the underlying endpoint reference.
 *
 * Callers in `tools/` should use `createCcxCoapClient()` instead of rolling
 * their own stream client and output parsing.
 */

import { createSocket, type Socket } from "node:dgram";
import { EventEmitter } from "node:events";

// ── Stream protocol constants ────────────────────────────

const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_TEXT = 0x20;
const STREAM_RESP_TEXT = 0xfd;
const STREAM_HEARTBEAT = 0xff;
const DEFAULT_STREAM_PORT = 9433;

// ── Trim / level encoding ────────────────────────────────

/** Maximum raw 16-bit level used by CCA/CCX level and trim encoding. */
export const TRIM_MAX = 0xfeff;

/**
 * Convert a percentage (0..100) to the 16-bit raw value per the documented
 * formula `raw = percent * 0xFEFF / 100` (see docs/protocols/ccx-coap.md).
 */
export function percentToLevel16(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`percent must be 0..100, got ${percent}`);
  }
  return Math.round((percent * TRIM_MAX) / 100);
}

/** Inverse of {@link percentToLevel16}. */
export function level16ToPercent(raw: number): number {
  return (raw / TRIM_MAX) * 100;
}

// ── CoAP response codes ──────────────────────────────────

/** CoAP response code in dotted "class.detail" form (e.g. "2.05", "4.04"). */
export type CoapCode = `${number}.${number}`;

export function coapCodeToNumber(code: CoapCode): number {
  const m = /^(\d+)\.(\d+)$/.exec(code);
  if (!m) throw new Error(`Invalid CoAP code: ${code}`);
  const cls = Number(m[1]);
  const det = Number(m[2]);
  return ((cls & 0x07) << 5) | (det & 0x1f);
}

export function coapCodeFromNumber(code: number): CoapCode {
  const cls = (code >> 5) & 0x07;
  const det = code & 0x1f;
  return `${cls}.${det.toString().padStart(2, "0")}` as CoapCode;
}

export function coapCodeClass(code: CoapCode): number {
  return Number(code.split(".")[0]);
}

// ── Target addressing ────────────────────────────────────

/** Where to send a CoAP request. The firmware resolves each form to an IPv6 address. */
export type CoapTarget =
  | { kind: "rloc"; rloc: string }
  | { kind: "serial"; serial: number }
  | { kind: "ipv6"; addr: string };

/** Optional resolver returning a full IPv6 string for a known device serial. */
export type SerialAddressResolver = (serial: number) => string | undefined;

/** Render a target as the shell-command argument (`rloc:XXXX`, `serial:N`, or raw IPv6). */
export function formatCoapTarget(
  target: CoapTarget,
  resolveSerial?: SerialAddressResolver,
): string {
  switch (target.kind) {
    case "rloc":
      return `rloc:${target.rloc}`;
    case "serial": {
      const resolved = resolveSerial?.(target.serial);
      return resolved ?? `serial:${target.serial}`;
    }
    case "ipv6":
      return target.addr;
  }
}

// ── Response shapes ──────────────────────────────────────

export interface CoapResponse {
  code: CoapCode;
  codeNum: number;
  mid: number;
  /** Source IPv6 when the firmware includes it in the response line. */
  src?: string;
  payload: Buffer;
  /** True when the response code class is 2 (success). */
  ok: boolean;
}

export interface CoapNotification {
  code: CoapCode;
  path: string;
  mid: number;
  len: number;
}

// ── Text parsing helpers ─────────────────────────────────

/** Convert a space-separated hex string (as printed by the firmware) to bytes. */
export function hexPayloadToBuffer(hex: string): Buffer {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length === 0) return Buffer.alloc(0);
  return Buffer.from(clean, "hex");
}

type GetParse =
  | {
      kind: "response";
      code: CoapCode;
      codeNum: number;
      mid: number;
      src?: string;
      payload: Buffer;
      ok: boolean;
    }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

/**
 * Parse the text emitted by the firmware in reply to `ccx coap get/put/post/delete`.
 * Returns `null` if the text is still incomplete and we should keep buffering.
 */
export function parseCoapGetResponse(text: string): GetParse | null {
  const errRe =
    /(CoAP TX failed[^\r\n]*|Invalid address[^\r\n]*|Mesh-local prefix[^\r\n]*|Invalid hex payload[^\r\n]*)/;
  const errMatch = errRe.exec(text);
  if (errMatch) {
    return { kind: "error", message: errMatch[1].trim() };
  }

  if (/No CoAP response \(timeout/.test(text)) {
    return { kind: "timeout" };
  }

  const respRe =
    /CoAP response code=(\d+)\.(\d+) mid=0x([0-9a-fA-F]+)(?: from ([^\r\n]+))?/;
  const respMatch = respRe.exec(text);
  if (!respMatch) return null;

  const cls = Number(respMatch[1]);
  const det = Number(respMatch[2]);
  const code = `${cls}.${det.toString().padStart(2, "0")}` as CoapCode;
  const codeNum = ((cls & 0x07) << 5) | (det & 0x1f);
  const mid = Number.parseInt(respMatch[3], 16);
  const src = respMatch[4]?.trim();

  // Wait for the payload terminator so we don't return a partial response.
  const payloadRe = /Payload \((\d+) bytes\):([^\r\n]*)/;
  const payloadMatch = payloadRe.exec(text);
  const noPayloadMatch = /\(no payload\)/.test(text);
  if (!payloadMatch && !noPayloadMatch) return null;

  const payload = payloadMatch
    ? hexPayloadToBuffer(payloadMatch[2])
    : Buffer.alloc(0);

  return {
    kind: "response",
    code,
    codeNum,
    mid,
    src,
    payload,
    ok: cls === 2,
  };
}

const BROADCAST_RE =
  /^\[coap\]\s+(\d+)\.(\d+)\s+(?:(\S+)\s+)?mid=0x([0-9a-fA-F]+)\s+len=(\d+)/;

/** Parse a single `[coap] X.XX [path] mid=0xABCD len=N` broadcast line. */
export function parseCoapBroadcast(line: string): CoapNotification | null {
  const m = BROADCAST_RE.exec(line.trim());
  if (!m) return null;
  const cls = Number(m[1]);
  const det = Number(m[2]);
  const path = m[3] && !m[3].startsWith("mid=") ? m[3] : "";
  const mid = Number.parseInt(m[4], 16);
  const len = Number(m[5]);
  return {
    code: `${cls}.${det.toString().padStart(2, "0")}` as CoapCode,
    path,
    mid,
    len,
  };
}

// ── Scan helpers ─────────────────────────────────────────

const DEFAULT_SCAN_SUFFIXES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/** Expand a base path with suffixes to a flat list of full paths. */
export function generateScanPaths(
  basePath: string,
  suffixes?: string[],
): string[] {
  const list = suffixes ?? DEFAULT_SCAN_SUFFIXES;
  return list.map((s) => `${basePath}${s}`);
}

export interface ScanOptions {
  /** Suffix list to append to basePath (default: A–Z). */
  suffixes?: string[];
  /** Per-probe timeout in milliseconds. */
  timeoutMs?: number;
  /** Called after each probe completes. */
  onProgress?: (
    done: number,
    total: number,
    path: string,
    code: CoapCode | "timeout",
  ) => void;
}

export interface ScanHit {
  path: string;
  code: CoapCode;
  payload: Buffer;
}

export interface ScanResult {
  found: ScanHit[];
  missing: string[];
  timeout: string[];
}

// ── Transport abstraction ────────────────────────────────

/** Generic text transport — implementations produce and consume shell-protocol lines. */
export interface CoapTransport extends EventEmitter {
  start(): Promise<void>;
  sendText(text: string): Promise<void>;
  close(): void;
}

export interface UdpCoapTransportOptions {
  host: string;
  port?: number;
  keepaliveMs?: number;
}

/**
 * Default transport: UDP stream protocol to a Nucleo running the shell.
 *
 * Sends `CMD_TEXT` frames for commands, buffers incoming `RESP_TEXT` frames,
 * and emits complete lines as `"text"` events. Heartbeats and non-text frames
 * are discarded.
 */
export class UdpCoapTransport extends EventEmitter implements CoapTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly keepaliveMs: number;
  private sock: Socket | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private textBuffer = "";

  constructor(opts: UdpCoapTransportOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port ?? DEFAULT_STREAM_PORT;
    this.keepaliveMs = opts.keepaliveMs ?? 1000;
  }

  start(): Promise<void> {
    if (this.sock) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = createSocket("udp4");
      sock.on("error", (err) => this.emit("error", err));
      sock.on("message", (msg) => this.handleMessage(msg));
      sock.bind(0, async () => {
        this.sock = sock;
        try {
          await this.sendFrame(STREAM_CMD_KEEPALIVE, Buffer.alloc(0));
          this.keepaliveTimer = setInterval(() => {
            this.sendFrame(STREAM_CMD_KEEPALIVE, Buffer.alloc(0)).catch(() => {
              // best effort; a broken socket surfaces through the error event
            });
          }, this.keepaliveMs);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  sendText(text: string): Promise<void> {
    return this.sendFrame(STREAM_CMD_TEXT, Buffer.from(text, "utf8"));
  }

  close(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.sock) {
      this.sock.close();
      this.sock = null;
    }
  }

  private sendFrame(cmd: number, data: Buffer): Promise<void> {
    const sock = this.sock;
    if (!sock) return Promise.reject(new Error("transport not started"));
    if (data.length > 255) {
      return Promise.reject(
        new Error(`stream frame data too long: ${data.length}`),
      );
    }
    const frame = Buffer.alloc(2 + data.length);
    frame[0] = cmd & 0xff;
    frame[1] = data.length & 0xff;
    data.copy(frame, 2);
    return new Promise((resolve, reject) => {
      sock.send(frame, this.port, this.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleMessage(msg: Buffer): void {
    if (msg.length < 1) return;
    if (msg[0] === STREAM_HEARTBEAT) return;
    if (msg[0] !== STREAM_RESP_TEXT) return;

    this.textBuffer += msg.subarray(1).toString("utf8");
    // Emit whenever we accumulate new text. Consumers buffer until they see a
    // terminal marker; flushing on chunk boundaries keeps latency low.
    const flushed = this.textBuffer;
    this.textBuffer = "";
    this.emit("text", flushed);
  }
}

// ── Client ───────────────────────────────────────────────

type CoapMethod = "get" | "put" | "post" | "delete";

interface PendingRequest {
  resolve: (value: GetParse) => void;
  reject: (err: Error) => void;
  buffer: string;
  timer: ReturnType<typeof setTimeout>;
  kind: "response" | "probe" | "observe";
}

interface ObserveSub {
  path: string;
  handler: (notif: CoapNotification) => void;
}

const DEFAULT_TIMEOUT_MS = 7000;

export interface CoapRequestOptions {
  timeoutMs?: number;
}

export interface CcxCoapClientOptions {
  /**
   * Optional resolver for `{ kind: "serial" }` targets. When provided, the
   * client emits the full `fd00::` IPv6 address (from Designer DB data)
   * instead of the legacy `serial:N` form that depends on the firmware's
   * live-learned peer table.
   */
  resolveSerial?: SerialAddressResolver;
}

/**
 * Typed CoAP client — serializes `ccx coap …` commands through a transport
 * and returns parsed responses. Construct with {@link createCcxCoapClient}
 * for the default UDP transport.
 */
export class CcxCoapClient {
  private readonly transport: CoapTransport;
  private readonly textListener: (text: string) => void;
  private readonly resolveSerial?: SerialAddressResolver;
  private queue: Promise<unknown> = Promise.resolve();
  private current: PendingRequest | null = null;
  private readonly observeSubs: ObserveSub[] = [];
  private readonly broadcastListeners: Array<
    (notif: CoapNotification) => void
  > = [];

  constructor(transport: CoapTransport, options: CcxCoapClientOptions = {}) {
    this.transport = transport;
    this.resolveSerial = options.resolveSerial;
    this.textListener = (text) => this.handleText(text);
    this.transport.on("text", this.textListener);
  }

  async connect(): Promise<void> {
    await this.transport.start();
  }

  close(): void {
    this.transport.off("text", this.textListener);
    this.transport.close();
    if (this.current) {
      const err = new Error("CcxCoapClient closed");
      this.current.reject(err);
      this.current = null;
    }
  }

  get(
    target: CoapTarget,
    path: string,
    opts?: CoapRequestOptions,
  ): Promise<CoapResponse> {
    return this.sendRequest("get", target, path, undefined, opts);
  }

  put(
    target: CoapTarget,
    path: string,
    payload: Buffer,
    opts?: CoapRequestOptions,
  ): Promise<CoapResponse> {
    return this.sendRequest("put", target, path, payload, opts);
  }

  post(
    target: CoapTarget,
    path: string,
    payload: Buffer,
    opts?: CoapRequestOptions,
  ): Promise<CoapResponse> {
    return this.sendRequest("post", target, path, payload, opts);
  }

  delete(
    target: CoapTarget,
    path: string,
    opts?: CoapRequestOptions,
  ): Promise<CoapResponse> {
    return this.sendRequest("delete", target, path, undefined, opts);
  }

  /**
   * Register a catch-all listener for every `[coap]` broadcast the firmware
   * emits (probe responses, observe notifications, etc). Returns an unsubscribe
   * function. Use {@link observe} when you only care about a specific path.
   */
  onBroadcast(handler: (notif: CoapNotification) => void): () => void {
    this.broadcastListeners.push(handler);
    return () => {
      const idx = this.broadcastListeners.indexOf(handler);
      if (idx >= 0) this.broadcastListeners.splice(idx, 1);
    };
  }

  /**
   * Fire-and-forget GET (`ccx coap probe`). Resolves once the firmware reports
   * `OK`. Any subsequent CoAP response arrives as a `[coap]` broadcast — use
   * {@link observe} or {@link onBroadcast} to capture it.
   */
  probe(
    target: CoapTarget,
    path: string,
    opts?: CoapRequestOptions,
  ): Promise<void> {
    const command = `ccx coap probe ${formatCoapTarget(target, this.resolveSerial)} ${path}`;
    return this.enqueue(
      async () =>
        new Promise<void>((resolve, reject) => {
          this.startPending(
            command,
            {
              kind: "probe",
              timeoutMs: opts?.timeoutMs ?? 2000,
            },
            (parsed) => {
              if (parsed.kind === "error") reject(new Error(parsed.message));
              else resolve();
            },
            reject,
          );
        }),
    );
  }

  async scan(
    target: CoapTarget,
    basePath: string,
    opts?: ScanOptions,
  ): Promise<ScanResult> {
    const paths = generateScanPaths(basePath, opts?.suffixes);
    const result: ScanResult = { found: [], missing: [], timeout: [] };
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      try {
        const resp = await this.get(target, path, {
          timeoutMs: opts?.timeoutMs,
        });
        if (resp.code === "4.04") {
          result.missing.push(path);
        } else {
          result.found.push({ path, code: resp.code, payload: resp.payload });
        }
        opts?.onProgress?.(i + 1, paths.length, path, resp.code);
      } catch (err) {
        if (/timeout/i.test((err as Error).message)) {
          result.timeout.push(path);
          opts?.onProgress?.(i + 1, paths.length, path, "timeout");
        } else {
          throw err;
        }
      }
    }
    return result;
  }

  async observe(
    target: CoapTarget,
    path: string,
    handler: (notif: CoapNotification) => void,
    opts?: CoapRequestOptions,
  ): Promise<() => Promise<void>> {
    const command = `ccx coap observe ${formatCoapTarget(target, this.resolveSerial)} ${path}`;
    await this.enqueue(
      () =>
        new Promise<CoapResponse>((resolve, reject) => {
          this.startPending(
            command,
            {
              kind: "observe",
              timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            },
            (parsed) => resolveOrReject(parsed, resolve, reject),
            reject,
          );
        }),
    );

    const sub: ObserveSub = { path, handler };
    this.observeSubs.push(sub);

    return async () => {
      const idx = this.observeSubs.indexOf(sub);
      if (idx >= 0) this.observeSubs.splice(idx, 1);
      const derReg = `ccx coap observe ${formatCoapTarget(target, this.resolveSerial)} ${path} dereg`;
      await this.enqueue(
        () =>
          new Promise<void>((resolve, reject) => {
            this.startPending(
              derReg,
              {
                kind: "observe",
                timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              },
              (parsed) => {
                if (parsed.kind === "error") reject(new Error(parsed.message));
                else resolve();
              },
              reject,
            );
          }),
      );
    };
  }

  // ── internals ──────────────────────────────────────────

  private async sendRequest(
    method: CoapMethod,
    target: CoapTarget,
    path: string,
    payload: Buffer | undefined,
    opts?: CoapRequestOptions,
  ): Promise<CoapResponse> {
    const verb = method;
    const parts = [
      `ccx coap ${verb}`,
      formatCoapTarget(target, this.resolveSerial),
      path,
    ];
    if (payload && payload.length > 0) {
      parts.push(payload.toString("hex").toUpperCase());
    }
    const command = parts.join(" ");
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return this.enqueue(
      () =>
        new Promise<CoapResponse>((resolve, reject) => {
          this.startPending(
            command,
            { kind: "response", timeoutMs },
            (parsed) => resolveOrReject(parsed, resolve, reject),
            reject,
          );
        }),
    );
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private startPending(
    command: string,
    { kind, timeoutMs }: { kind: PendingRequest["kind"]; timeoutMs: number },
    onParsed: (parsed: GetParse) => void,
    onTimeout: (err: Error) => void,
  ): void {
    const timer = setTimeout(() => {
      this.current = null;
      onTimeout(
        new Error(`CoAP command timeout after ${timeoutMs}ms: ${command}`),
      );
    }, timeoutMs);

    this.current = {
      kind,
      buffer: "",
      timer,
      resolve: (value) => {
        clearTimeout(timer);
        this.current = null;
        onParsed(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        this.current = null;
        onTimeout(err);
      },
    };

    this.transport.sendText(command).catch((err) => {
      if (this.current) this.current.reject(err as Error);
    });
  }

  private handleText(text: string): void {
    // Dispatch any complete [coap] broadcast lines to observe / catch-all handlers.
    for (const line of splitLines(text)) {
      const notif = parseCoapBroadcast(line);
      if (notif) {
        for (const sub of this.observeSubs) {
          if (sub.path === notif.path) sub.handler(notif);
        }
        for (const listener of this.broadcastListeners) listener(notif);
      }
    }

    const current = this.current;
    if (!current) return;
    current.buffer += text;

    if (current.kind === "probe") {
      if (/^OK\b/m.test(current.buffer)) {
        current.resolve({
          kind: "response",
          code: "2.00",
          codeNum: 0x40,
          mid: 0,
          payload: Buffer.alloc(0),
          ok: true,
        });
        return;
      }
      if (/^FAIL\b/m.test(current.buffer)) {
        current.resolve({ kind: "error", message: "CoAP probe reported FAIL" });
        return;
      }
      return;
    }

    const parsed = parseCoapGetResponse(current.buffer);
    if (parsed) current.resolve(parsed);
  }
}

function resolveOrReject(
  parsed: GetParse,
  resolve: (value: CoapResponse) => void,
  reject: (err: Error) => void,
): void {
  if (parsed.kind === "timeout") {
    reject(new Error("No CoAP response (timeout)"));
    return;
  }
  if (parsed.kind === "error") {
    reject(new Error(parsed.message));
    return;
  }
  resolve({
    code: parsed.code,
    codeNum: parsed.codeNum,
    mid: parsed.mid,
    src: parsed.src,
    payload: parsed.payload,
    ok: parsed.ok,
  });
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

// ── Factory ──────────────────────────────────────────────

export interface CreateCcxCoapClientOptions {
  host: string;
  port?: number;
  keepaliveMs?: number;
}

/**
 * Create a {@link CcxCoapClient} wired to the default UDP stream transport.
 * Caller must `await client.connect()` before issuing requests and `client.close()`
 * when finished.
 */
export function createCcxCoapClient(
  opts: CreateCcxCoapClientOptions,
): CcxCoapClient {
  const transport = new UdpCoapTransport({
    host: opts.host,
    port: opts.port,
    keepaliveMs: opts.keepaliveMs,
  });
  return new CcxCoapClient(transport);
}
