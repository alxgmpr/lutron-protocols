#!/usr/bin/env npx tsx

/**
 * Standalone Spinel probe for Plan-1 verification of the NCP TMF vendor
 * extension. Builds raw Spinel frames, sends them via the STM32's existing
 * `shell spinel raw <hex>` passthrough on UDP :9433, and parses the responses
 * the STM32 prints back (format: `Response (N bytes): XX XX …`).
 *
 * Spinel frame encoding per OpenThread spec:
 *   [header:1][cmd:1][prop:packed-uint][value...]
 * where packed-uint is a 7-bit-per-byte little-endian encoding with the high
 * bit set on all bytes except the last (same as protobuf varint for small
 * positive values).
 *
 * See docs/superpowers/specs/2026-04-22-ncp-tmf-extension-design.md.
 */

import { createSocket } from "node:dgram";
import { fileURLToPath } from "node:url";
import { decodeDiagResponse } from "../ccx/tmf-diag";
import { config } from "../lib/config";

// --- Spinel constants ---

export const SPINEL_CMD_PROP_VALUE_GET = 0x02;
export const SPINEL_CMD_PROP_VALUE_SET = 0x03;
export const SPINEL_CMD_PROP_VALUE_IS = 0x06;
export const SPINEL_CMD_PROP_VALUE_INSERTED = 0x05;
export const SPINEL_CMD_PROP_VALUE_REMOVED = 0x08;

export const SPINEL_PROP_LAST_STATUS = 0x0000;
export const SPINEL_PROP_VENDOR_DIAG_GET_REQUEST = 0x3c00;
export const SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE = 0x3c01;
export const SPINEL_PROP_VENDOR_DIAG_GET_DONE = 0x3c02;
export const SPINEL_PROP_VENDOR_DIAG_RESET_REQUEST = 0x3c03;
export const SPINEL_PROP_VENDOR_NEIGHBOR_TABLE = 0x3c04;
export const SPINEL_PROP_VENDOR_CHILD_TABLE = 0x3c05;

export const SPINEL_STATUS_OK = 0;
export const SPINEL_STATUS_FAILURE = 1;
export const SPINEL_STATUS_INVALID_ARGUMENT = 3;
export const SPINEL_STATUS_BUSY = 12;

// --- Spinel packed-int encoding (for prop keys > 127) ---

/**
 * Encode a non-negative integer as Spinel's packed-uint: 7 bits per byte,
 * little-endian (LSB first), with the high bit set on continuation bytes.
 * E.g. 0x3C01 = 15361 → [0x81, 0x78].
 */
export function encodePackedUint(value: number): Buffer {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error(`packed uint must be non-negative integer: ${value}`);
  }
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

/**
 * Decode a Spinel packed-uint starting at `offset` in `buf`. Returns both the
 * decoded value and how many bytes were consumed so the caller can advance.
 */
export function decodePackedUint(
  buf: Buffer,
  offset: number,
): { value: number; bytes: number } {
  let value = 0;
  let shift = 0;
  let i = 0;
  while (true) {
    if (offset + i >= buf.length) throw new Error("truncated packed uint");
    const b = buf[offset + i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error("packed uint overflow");
  }
  return { value, bytes: i };
}

// --- Frame builders ---

export function buildPropGet(header: number, prop: number): Buffer {
  return Buffer.concat([
    Buffer.from([header, SPINEL_CMD_PROP_VALUE_GET]),
    encodePackedUint(prop),
  ]);
}

export function buildPropSet(
  header: number,
  prop: number,
  value: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from([header, SPINEL_CMD_PROP_VALUE_SET]),
    encodePackedUint(prop),
    value,
  ]);
}

export function buildDiagGetRequest(
  dstAddr: Buffer,
  tlvTypes: readonly number[],
): Buffer {
  if (dstAddr.length !== 16) throw new Error("dstAddr must be 16 bytes");
  if (tlvTypes.length === 0 || tlvTypes.length > 32) {
    throw new Error("tlvTypes must contain 1..32 entries");
  }
  const value = Buffer.concat([
    dstAddr,
    Buffer.from([tlvTypes.length]),
    Buffer.from(tlvTypes),
  ]);
  return buildPropSet(0x81, SPINEL_PROP_VENDOR_DIAG_GET_REQUEST, value);
}

export function buildDiagResetRequest(
  dstAddr: Buffer,
  tlvTypes: readonly number[],
): Buffer {
  if (dstAddr.length !== 16) throw new Error("dstAddr must be 16 bytes");
  if (tlvTypes.length === 0 || tlvTypes.length > 32) {
    throw new Error("tlvTypes must contain 1..32 entries");
  }
  const value = Buffer.concat([
    dstAddr,
    Buffer.from([tlvTypes.length]),
    Buffer.from(tlvTypes),
  ]);
  return buildPropSet(0x81, SPINEL_PROP_VENDOR_DIAG_RESET_REQUEST, value);
}

// --- Response decoder ---

export type SpinelResponse =
  | { kind: "is"; prop: number; value: Buffer }
  | { kind: "insert"; prop: number; value: Buffer }
  | { kind: "remove"; prop: number; value: Buffer }
  | { kind: "other"; cmd: number; value: Buffer };

/**
 * Decode a Spinel frame: [header][cmd][prop-packed][value]. The header is
 * ignored (we only build with 0x81 and only inspect responses from the NCP).
 * Returns null on frames too short to contain cmd + prop.
 */
export function decodeResponse(frame: Buffer): SpinelResponse | null {
  if (frame.length < 3) return null;
  const cmd = frame[1];
  let prop: number;
  let bytes: number;
  try {
    ({ value: prop, bytes } = decodePackedUint(frame, 2));
  } catch {
    return null;
  }
  const value = frame.subarray(2 + bytes);
  switch (cmd) {
    case SPINEL_CMD_PROP_VALUE_IS:
      return { kind: "is", prop, value };
    case SPINEL_CMD_PROP_VALUE_INSERTED:
      return { kind: "insert", prop, value };
    case SPINEL_CMD_PROP_VALUE_REMOVED:
      return { kind: "remove", prop, value };
    default:
      return { kind: "other", cmd, value };
  }
}

// --- Neighbor / child table parsing ---

export interface NeighborEntry {
  extAddr: string;
  rloc16: number;
  ageSec: number;
  avgRssi: number;
  lastRssi: number;
  isChild: boolean;
  rxOnWhenIdle: boolean;
  fullThreadDevice: boolean;
}

function formatExtAddr(bytes: Buffer): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

/**
 * Parse a neighbor-table response body: [count:1][entries:17 * count]. Each
 * entry: ext_addr(8) | rloc16(LE:2) | age_s(LE:4) | avg_rssi(i8) | last_rssi(i8) | flags(1).
 */
export function parseNeighborTable(body: Buffer): NeighborEntry[] {
  if (body.length < 1) return [];
  const count = body[0];
  const entries: NeighborEntry[] = [];
  let i = 1;
  for (let n = 0; n < count; n++) {
    if (i + 17 > body.length) break;
    const extAddr = formatExtAddr(body.subarray(i, i + 8));
    i += 8;
    const rloc16 = body.readUInt16LE(i);
    i += 2;
    const ageSec = body.readUInt32LE(i);
    i += 4;
    const avgRssi = body.readInt8(i);
    i += 1;
    const lastRssi = body.readInt8(i);
    i += 1;
    const flags = body[i++];
    entries.push({
      extAddr,
      rloc16,
      ageSec,
      avgRssi,
      lastRssi,
      isChild: !!(flags & 0x01),
      rxOnWhenIdle: !!(flags & 0x02),
      fullThreadDevice: !!(flags & 0x04),
    });
  }
  return entries;
}

export interface ChildEntry extends NeighborEntry {
  timeoutSec: number;
}

/**
 * Parse a child-table response body: [count:1][entries:21 * count]. Each
 * entry adds a 4-byte timeout_s before age_s relative to the neighbor layout.
 */
export function parseChildTable(body: Buffer): ChildEntry[] {
  if (body.length < 1) return [];
  const count = body[0];
  const entries: ChildEntry[] = [];
  let i = 1;
  for (let n = 0; n < count; n++) {
    if (i + 21 > body.length) break;
    const extAddr = formatExtAddr(body.subarray(i, i + 8));
    i += 8;
    const rloc16 = body.readUInt16LE(i);
    i += 2;
    const timeoutSec = body.readUInt32LE(i);
    i += 4;
    const ageSec = body.readUInt32LE(i);
    i += 4;
    const avgRssi = body.readInt8(i);
    i += 1;
    const lastRssi = body.readInt8(i);
    i += 1;
    const flags = body[i++];
    entries.push({
      extAddr,
      rloc16,
      ageSec,
      timeoutSec,
      avgRssi,
      lastRssi,
      isChild: true,
      rxOnWhenIdle: !!(flags & 0x02),
      fullThreadDevice: !!(flags & 0x04),
    });
  }
  return entries;
}

// --- Transport: wrap Spinel frame in `shell spinel raw <hex>` command ---

const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_TEXT = 0x20;
const STREAM_RESP_TEXT = 0xfd;
const STREAM_HEARTBEAT = 0xff;

function buildStreamCommand(cmd: number, data: Buffer): Buffer {
  if (data.length > 255) {
    throw new Error(`Stream command data too long (${data.length})`);
  }
  const out = Buffer.alloc(2 + data.length);
  out[0] = cmd & 0xff;
  out[1] = data.length & 0xff;
  data.copy(out, 2);
  return out;
}

/**
 * Send a Spinel frame via the STM32's `shell spinel raw <hex>` passthrough and
 * collect all text the shell broadcasts for `windowMs` milliseconds. Callers
 * parse the text with `extractSpinelResponses`.
 */
async function sendSpinelAndCollect(
  host: string,
  port: number,
  spinelFrame: Buffer,
  windowMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    let captured = "";
    const keepalive = buildStreamCommand(STREAM_CMD_KEEPALIVE, Buffer.alloc(0));
    const shellCmd = `spinel raw ${spinelFrame.toString("hex")}`;
    const textCmd = buildStreamCommand(
      STREAM_CMD_TEXT,
      Buffer.from(shellCmd, "utf8"),
    );

    let ka: ReturnType<typeof setInterval> | null = null;
    const done = (err?: Error) => {
      if (ka) clearInterval(ka);
      sock.close();
      if (err) reject(err);
      else resolve(captured);
    };

    sock.on("error", done);
    sock.on("message", (msg) => {
      if (msg.length >= 2 && msg[0] === STREAM_HEARTBEAT && msg[1] === 0x00) {
        return;
      }
      if (msg.length >= 1 && msg[0] === STREAM_RESP_TEXT) {
        captured += msg.subarray(1).toString("utf8");
      }
    });
    sock.bind(0, async () => {
      try {
        await new Promise<void>((r, rj) =>
          sock.send(keepalive, port, host, (e) => (e ? rj(e) : r())),
        );
        ka = setInterval(() => {
          sock.send(keepalive, port, host, () => {});
        }, 1000);
        await new Promise<void>((r, rj) =>
          sock.send(textCmd, port, host, (e) => (e ? rj(e) : r())),
        );
        setTimeout(() => done(), windowMs);
      } catch (err) {
        done(err as Error);
      }
    });
  });
}

/**
 * Scan shell output for lines of the form `Response (N bytes): XX XX …` and
 * return the decoded hex as Buffers. The shell prints one such line per
 * Spinel frame the NCP emits.
 */
export function extractSpinelResponses(text: string): Buffer[] {
  const re = /Response\s+\(\d+\s+bytes\):\s+([0-9A-Fa-f ]+)/g;
  const out: Buffer[] = [];
  let m: RegExpExecArray | null;
  m = re.exec(text);
  while (m !== null) {
    out.push(Buffer.from(m[1].replace(/\s+/g, ""), "hex"));
    m = re.exec(text);
  }
  return out;
}

/**
 * Parse a textual IPv6 address into its 16-byte wire representation. Handles
 * zone-id suffixes (`%eth0`) and the `::` shorthand.
 */
export function ipv6Bytes(addr: string): Buffer {
  const stripped = addr.split("%")[0];
  let parts: string[];
  if (stripped.includes("::")) {
    const [h, t] = stripped.split("::");
    const hp = h ? h.split(":") : [];
    const tp = t ? t.split(":") : [];
    const missing = 8 - hp.length - tp.length;
    if (missing < 0) throw new Error(`Invalid IPv6: ${addr}`);
    parts = [...hp, ...Array(missing).fill("0"), ...tp];
  } else {
    parts = stripped.split(":");
  }
  if (parts.length !== 8) throw new Error(`Invalid IPv6: ${addr}`);
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(Number.parseInt(parts[i] || "0", 16), i * 2);
  }
  return buf;
}

// --- Main command surface ---

async function cmdNeighbors(host: string, port: number): Promise<void> {
  const frame = buildPropGet(0x81, SPINEL_PROP_VENDOR_NEIGHBOR_TABLE);
  const text = await sendSpinelAndCollect(host, port, frame, 500);
  const frames = extractSpinelResponses(text);
  for (const f of frames) {
    const r = decodeResponse(f);
    if (r?.kind === "is" && r.prop === SPINEL_PROP_VENDOR_NEIGHBOR_TABLE) {
      const entries = parseNeighborTable(r.value);
      console.log(`# ${entries.length} neighbors`);
      for (const e of entries) {
        const flags = [
          e.isChild && "child",
          e.rxOnWhenIdle && "rxOn",
          e.fullThreadDevice && "ftd",
        ]
          .filter(Boolean)
          .join(",");
        console.log(
          `  ext=${e.extAddr} rloc=0x${e.rloc16.toString(16).padStart(4, "0")} age=${e.ageSec}s rssi=${e.avgRssi}/${e.lastRssi} flags=${flags}`,
        );
      }
    }
  }
}

async function cmdChildren(host: string, port: number): Promise<void> {
  const frame = buildPropGet(0x81, SPINEL_PROP_VENDOR_CHILD_TABLE);
  const text = await sendSpinelAndCollect(host, port, frame, 500);
  const frames = extractSpinelResponses(text);
  for (const f of frames) {
    const r = decodeResponse(f);
    if (r?.kind === "is" && r.prop === SPINEL_PROP_VENDOR_CHILD_TABLE) {
      const entries = parseChildTable(r.value);
      console.log(`# ${entries.length} children`);
      for (const e of entries) {
        console.log(
          `  ext=${e.extAddr} rloc=0x${e.rloc16.toString(16).padStart(4, "0")} timeout=${e.timeoutSec}s age=${e.ageSec}s rssi=${e.avgRssi}/${e.lastRssi}`,
        );
      }
    }
  }
}

async function cmdDiagGet(
  host: string,
  port: number,
  dst: string,
  types: number[],
): Promise<void> {
  const frame = buildDiagGetRequest(ipv6Bytes(dst), types);
  const text = await sendSpinelAndCollect(host, port, frame, 6000);
  const frames = extractSpinelResponses(text);
  let responderCount = 0;
  for (const f of frames) {
    const r = decodeResponse(f);
    if (
      r?.kind === "insert" &&
      r.prop === SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE
    ) {
      const srcHex = r.value.subarray(0, 16).toString("hex").match(/.{4}/g);
      const srcStr = srcHex ? srcHex.join(":") : "?";
      const tlvLenField = r.value.readUInt16LE(16);
      const truncated = !!(tlvLenField & 0x8000);
      const realLen = tlvLenField & 0x7fff;
      const tlv = r.value.subarray(18, 18 + realLen);
      const decoded = decodeDiagResponse(tlv);
      console.log(
        `src=${srcStr} eui64=${decoded.eui64 ?? "-"} rloc=${decoded.rloc16 !== undefined ? `0x${decoded.rloc16.toString(16).padStart(4, "0")}` : "-"} addrs=[${decoded.ipv6Addresses.join(",")}]${truncated ? " (truncated)" : ""}`,
      );
      responderCount++;
    } else if (
      r?.kind === "insert" &&
      r.prop === SPINEL_PROP_VENDOR_DIAG_GET_DONE
    ) {
      const reason = r.value[0];
      const count = r.value.readUInt16LE(1);
      console.log(
        `# DONE reason=${reason} responders=${count} (probe saw ${responderCount})`,
      );
    } else if (r?.kind === "is" && r.prop === SPINEL_PROP_LAST_STATUS) {
      const { value: status } = decodePackedUint(r.value, 0);
      if (status !== SPINEL_STATUS_OK) {
        console.log(`# LAST_STATUS=${status}`);
      }
    }
  }
}

async function cmdDiagReset(
  host: string,
  port: number,
  dst: string,
  types: number[],
): Promise<void> {
  const frame = buildDiagResetRequest(ipv6Bytes(dst), types);
  const text = await sendSpinelAndCollect(host, port, frame, 500);
  const frames = extractSpinelResponses(text);
  for (const f of frames) {
    const r = decodeResponse(f);
    if (r?.kind === "is" && r.prop === SPINEL_PROP_LAST_STATUS) {
      const { value: status } = decodePackedUint(r.value, 0);
      console.log(`# diag-reset LAST_STATUS=${status}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const hostIdx = args.indexOf("--host");
  const host = hostIdx !== -1 ? args[hostIdx + 1] : config.openBridge;
  const port = 9433;
  const cmd = args.find((a) => !a.startsWith("--")) ?? "neighbors";
  const rest = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    if (a === cmd && args.indexOf(a) === i) return false;
    return true;
  });

  if (!host) {
    throw new Error(
      "Missing --host and config.openBridge is unset. Pass --host <ip>.",
    );
  }

  switch (cmd) {
    case "neighbors":
      await cmdNeighbors(host, port);
      break;
    case "children":
      await cmdChildren(host, port);
      break;
    case "diag-get":
      if (!rest[0]) throw new Error("diag-get requires <dst-addr> <types...>");
      await cmdDiagGet(
        host,
        port,
        rest[0],
        rest.slice(1).map((n) => Number(n)),
      );
      break;
    case "diag-reset":
      if (!rest[0])
        throw new Error("diag-reset requires <dst-addr> <types...>");
      await cmdDiagReset(
        host,
        port,
        rest[0],
        rest.slice(1).map((n) => Number(n)),
      );
      break;
    default:
      throw new Error(
        `Unknown command: ${cmd}. Use: neighbors | children | diag-get <addr> <types...> | diag-reset <addr> <types...>`,
      );
  }
}

// Run main() only when this file is the entry point, not when imported by
// tests.
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  });
}
