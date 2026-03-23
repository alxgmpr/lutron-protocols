/**
 * Shared CoAP encode/decode utilities for CCX Thread communication.
 *
 * Extracted from tools/ccx-coap-send.ts for reuse by virtual device,
 * commission capture, and other CoAP-speaking tools.
 */

import { Decoder } from "cbor-x";

const decoder = new Decoder({ mapsAsObjects: false });

// --- CoAP constants ---

export const COAP_TYPE_CON = 0;
export const COAP_TYPE_NON = 1;
export const COAP_TYPE_ACK = 2;
export const COAP_TYPE_RST = 3;

export const COAP_CODE_GET = 1;
export const COAP_CODE_POST = 2;
export const COAP_CODE_PUT = 3;
export const COAP_CODE_DELETE = 4;

export function coapTypeToString(type: number): string {
  if (type === 0) return "CON";
  if (type === 1) return "NON";
  if (type === 2) return "ACK";
  if (type === 3) return "RST";
  return `TYPE_${type}`;
}

export function coapCodeToString(code: number): string {
  if (code === 0) return "0.00";
  if (code <= 31) {
    if (code === 1) return "GET";
    if (code === 2) return "POST";
    if (code === 3) return "PUT";
    if (code === 4) return "DELETE";
    return `REQ(${code})`;
  }
  const cls = code >> 5;
  const detail = code & 0x1f;
  return `${cls}.${detail.toString().padStart(2, "0")}`;
}

export function coapCodeFromName(name: string): number {
  const lower = name.toLowerCase();
  if (lower === "get") return 1;
  if (lower === "post") return 2;
  if (lower === "put") return 3;
  if (lower === "delete") return 4;
  const n = parseInt(name, 10);
  if (!Number.isFinite(n) || n < 0 || n > 255)
    throw new Error(`Invalid CoAP code: ${name}`);
  return n;
}

// --- CoAP option encoding ---

function encodeOptNibble(v: number): { nibble: number; ext: number[] } {
  if (v < 13) return { nibble: v, ext: [] };
  if (v < 269) return { nibble: 13, ext: [v - 13] };
  if (v < 65805) {
    const x = v - 269;
    return { nibble: 14, ext: [(x >> 8) & 0xff, x & 0xff] };
  }
  throw new Error(`CoAP option value too large: ${v}`);
}

function encodeOption(delta: number, value: Buffer): Buffer {
  const d = encodeOptNibble(delta);
  const l = encodeOptNibble(value.length);
  return Buffer.concat([
    Buffer.from([(d.nibble << 4) | l.nibble, ...d.ext, ...l.ext]),
    value,
  ]);
}

// --- CoAP packet build/parse ---

export interface CoapPacketParams {
  type: number;
  code: number;
  mid: number;
  token: Buffer;
  path: string;
  payload?: Buffer;
}

export function buildCoapPacket(params: CoapPacketParams): Buffer {
  const { type, code, mid, token, path, payload } = params;
  if (token.length > 8) throw new Error("CoAP token must be 0..8 bytes");

  const first = (1 << 6) | ((type & 0x03) << 4) | (token.length & 0x0f);
  const header = Buffer.alloc(4);
  header[0] = first;
  header[1] = code & 0xff;
  header.writeUInt16BE(mid & 0xffff, 2);

  let prevOpt = 0;
  const opts: Buffer[] = [];
  const segs = path.split("/").filter(Boolean);
  for (const seg of segs) {
    const num = 11; // Uri-Path
    const delta = num - prevOpt;
    prevOpt = num;
    opts.push(encodeOption(delta, Buffer.from(seg, "utf8")));
  }

  if (payload && payload.length > 0) {
    return Buffer.concat([
      header,
      token,
      ...opts,
      Buffer.from([0xff]),
      payload,
    ]);
  }
  return Buffer.concat([header, token, ...opts]);
}

export interface ParsedCoapPacket {
  type: number;
  code: number;
  mid: number;
  token: Buffer;
  options: CoapOption[];
  payload: Buffer;
}

export interface CoapOption {
  number: number;
  value: Buffer;
}

export function parseCoapPacket(pkt: Buffer): ParsedCoapPacket | null {
  if (pkt.length < 4) return null;
  const ver = pkt[0] >> 6;
  if (ver !== 1) return null;
  const type = (pkt[0] >> 4) & 0x03;
  const tkl = pkt[0] & 0x0f;
  if (pkt.length < 4 + tkl) return null;

  const code = pkt[1];
  const mid = pkt.readUInt16BE(2);
  const token = pkt.subarray(4, 4 + tkl);

  const options: CoapOption[] = [];
  let i = 4 + tkl;
  let prevOptNum = 0;
  while (i < pkt.length) {
    if (pkt[i] === 0xff) {
      i++;
      break;
    }
    const b = pkt[i++];
    let delta = (b >> 4) & 0x0f;
    let len = b & 0x0f;

    if (delta === 13) {
      if (i >= pkt.length) return null;
      delta = 13 + pkt[i++];
    } else if (delta === 14) {
      if (i + 1 >= pkt.length) return null;
      delta = 269 + ((pkt[i] << 8) | pkt[i + 1]);
      i += 2;
    } else if (delta === 15) {
      return null;
    }

    if (len === 13) {
      if (i >= pkt.length) return null;
      len = 13 + pkt[i++];
    } else if (len === 14) {
      if (i + 1 >= pkt.length) return null;
      len = 269 + ((pkt[i] << 8) | pkt[i + 1]);
      i += 2;
    } else if (len === 15) {
      return null;
    }

    if (i + len > pkt.length) return null;
    const optNum = prevOptNum + delta;
    options.push({ number: optNum, value: pkt.subarray(i, i + len) });
    prevOptNum = optNum;
    i += len;
  }

  return {
    type,
    code,
    mid,
    token,
    options,
    payload: i <= pkt.length ? pkt.subarray(i) : Buffer.alloc(0),
  };
}

/** Legacy-compatible parse that returns just type/code/mid/token/payload */
export function parseCoapHeader(pkt: Buffer): {
  type: number;
  code: number;
  mid: number;
  token: Buffer;
  payload: Buffer;
} | null {
  const parsed = parseCoapPacket(pkt);
  if (!parsed) return null;
  return {
    type: parsed.type,
    code: parsed.code,
    mid: parsed.mid,
    token: parsed.token,
    payload: parsed.payload,
  };
}

/** Extract Uri-Path from parsed options */
export function getUriPath(options: CoapOption[]): string {
  const segs = options
    .filter((o) => o.number === 11)
    .map((o) => o.value.toString("utf8"));
  return segs.length > 0 ? "/" + segs.join("/") : "";
}

/** Build a CoAP ACK response */
export function buildCoapAck(
  mid: number,
  token: Buffer,
  code: number = 0,
  payload?: Buffer,
): Buffer {
  return buildCoapPacket({
    type: COAP_TYPE_ACK,
    code,
    mid,
    token,
    path: "",
    payload,
  });
}

/** Build a CoAP response (piggy-backed on ACK or separate) */
export function buildCoapResponse(params: {
  type: number;
  code: number;
  mid: number;
  token: Buffer;
  payload?: Buffer;
}): Buffer {
  return buildCoapPacket({ ...params, path: "" });
}

// --- CBOR encode/decode ---

export function encodeCborUint(v: number): Buffer {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`CBOR uint must be integer >= 0, got ${v}`);
  }
  if (v < 24) return Buffer.from([v]);
  if (v <= 0xff) return Buffer.from([0x18, v]);
  if (v <= 0xffff) return Buffer.from([0x19, (v >> 8) & 0xff, v & 0xff]);
  if (v <= 0xffffffff) {
    return Buffer.from([
      0x1a,
      (v >>> 24) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    ]);
  }
  throw new Error(`CBOR uint too large: ${v}`);
}

function encodeCborTypeAndLength(major: number, len: number): Buffer {
  if (!Number.isInteger(len) || len < 0) {
    throw new Error(`Invalid CBOR length: ${len}`);
  }
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len <= 0xff) return Buffer.from([(major << 5) | 24, len]);
  if (len <= 0xffff) {
    return Buffer.from([(major << 5) | 25, (len >> 8) & 0xff, len & 0xff]);
  }
  if (len <= 0xffffffff) {
    return Buffer.from([
      (major << 5) | 26,
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
    ]);
  }
  throw new Error(`CBOR length too large: ${len}`);
}

export function encodeCborValue(value: unknown): Buffer {
  if (value == null) return Buffer.from([0xf6]); // null
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Unsupported CBOR number: ${value}`);
    }
    if (Number.isInteger(value)) {
      if (value >= 0) return encodeCborUint(value);
      return encodeCborTypeAndLength(1, -1 - value);
    }
    const out = Buffer.alloc(9);
    out[0] = 0xfb; // float64
    out.writeDoubleBE(value, 1);
    return out;
  }

  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([encodeCborTypeAndLength(3, text.length), text]);
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const bytes = Buffer.from(value);
    return Buffer.concat([encodeCborTypeAndLength(2, bytes.length), bytes]);
  }

  if (Array.isArray(value)) {
    const parts = value.map((v) => encodeCborValue(v));
    return Buffer.concat([encodeCborTypeAndLength(4, parts.length), ...parts]);
  }

  if (value instanceof Map) {
    const parts: Buffer[] = [encodeCborTypeAndLength(5, value.size)];
    for (const [k, v] of value.entries()) {
      parts.push(encodeCborValue(k), encodeCborValue(v));
    }
    return Buffer.concat(parts);
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const parts: Buffer[] = [encodeCborTypeAndLength(5, entries.length)];
    for (const [k, v] of entries) {
      const key: string | number = /^-?\d+$/.test(k)
        ? Number.parseInt(k, 10)
        : k;
      parts.push(encodeCborValue(key), encodeCborValue(v));
    }
    return Buffer.concat(parts);
  }

  throw new Error(`Unsupported CBOR value type: ${typeof value}`);
}

export function decodeMaybeCbor(buf: Buffer): unknown | null {
  if (!buf.length) return null;
  try {
    const v = decoder.decode(buf);
    const norm = (x: unknown): unknown => {
      if (x instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [k, vv] of x.entries()) out[String(k)] = norm(vv);
        return out;
      }
      if (Array.isArray(x)) return x.map(norm);
      if (x instanceof Uint8Array) return Buffer.from(x).toString("hex");
      return x;
    };
    return norm(v);
  } catch {
    return null;
  }
}

// --- IPv6/UDP packet building (for STM32 raw injection) ---

export function parseIpv6(addr: string): Buffer {
  const stripped = addr.trim().split("%")[0];
  if (!stripped) throw new Error("Invalid IPv6: empty address");
  if (stripped.includes(".")) {
    throw new Error(`IPv4-embedded IPv6 not supported: ${addr}`);
  }

  let parts: string[] = [];
  if (stripped.includes("::")) {
    if (stripped.indexOf("::") !== stripped.lastIndexOf("::")) {
      throw new Error(`Invalid IPv6 (multiple ::): ${addr}`);
    }
    const [head, tail] = stripped.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = tail ? tail.split(":") : [];
    const missing = 8 - (headParts.length + tailParts.length);
    if (missing < 0) {
      throw new Error(`Invalid IPv6 (too many segments): ${addr}`);
    }
    parts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  } else {
    parts = stripped.split(":");
    if (parts.length !== 8) {
      throw new Error(`Invalid IPv6 (expected 8 segments): ${addr}`);
    }
  }

  if (parts.length !== 8) {
    throw new Error(`Invalid IPv6 (resolved segments != 8): ${addr}`);
  }

  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const part = parts[i];
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
      throw new Error(`Invalid IPv6 segment "${part}" in ${addr}`);
    }
    out.writeUInt16BE(Number.parseInt(part, 16), i * 2);
  }
  return out;
}

function isIpv6Unspecified(addr: Buffer): boolean {
  for (let i = 0; i < addr.length; i++) {
    if (addr[i] !== 0) return false;
  }
  return true;
}

function onesComplementFold(sum: number): number {
  while (sum >>> 16 !== 0) {
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return sum & 0xffff;
}

function sum16(buf: Buffer): number {
  let sum = 0;
  let i = 0;
  for (; i + 1 < buf.length; i += 2) {
    sum += buf.readUInt16BE(i);
  }
  if (i < buf.length) {
    sum += buf[i] << 8;
  }
  return sum;
}

function udpChecksumIpv6(
  srcAddr: Buffer,
  dstAddr: Buffer,
  udpHeaderAndPayload: Buffer,
): number {
  let sum = 0;
  sum += sum16(srcAddr);
  sum += sum16(dstAddr);
  sum += (udpHeaderAndPayload.length >>> 16) & 0xffff;
  sum += udpHeaderAndPayload.length & 0xffff;
  sum += 17; // Next Header = UDP
  sum += sum16(udpHeaderAndPayload);
  const folded = onesComplementFold(sum);
  const checksum = ~folded & 0xffff;
  return checksum === 0 ? 0xffff : checksum;
}

export function buildIpv6UdpPacket(params: {
  dst: string;
  src?: string;
  srcPort: number;
  dstPort: number;
  udpPayload: Buffer;
}): Buffer {
  const { dst, src, srcPort, dstPort, udpPayload } = params;
  const dstAddr = parseIpv6(dst);
  const srcAddr = src ? parseIpv6(src) : null;
  if (!srcAddr || isIpv6Unspecified(srcAddr)) {
    throw new Error(
      "STM32 raw IPv6 injection requires non-zero src (full mesh-local IPv6)",
    );
  }
  if (isIpv6Unspecified(dstAddr)) {
    throw new Error("Invalid dst: unspecified IPv6 address (::)");
  }
  const udpLen = 8 + udpPayload.length;
  const total = 40 + udpLen;
  if (udpLen > 0xffff) throw new Error("UDP payload too large");

  const pkt = Buffer.alloc(total);
  pkt[0] = 0x60;
  pkt.writeUInt16BE(udpLen, 4);
  pkt[6] = 17;
  pkt[7] = 64;
  srcAddr.copy(pkt, 8);
  dstAddr.copy(pkt, 24);

  const udpOff = 40;
  pkt.writeUInt16BE(srcPort & 0xffff, udpOff);
  pkt.writeUInt16BE(dstPort & 0xffff, udpOff + 2);
  pkt.writeUInt16BE(udpLen, udpOff + 4);
  pkt.writeUInt16BE(0x0000, udpOff + 6);
  udpPayload.copy(pkt, udpOff + 8);
  const checksum = udpChecksumIpv6(srcAddr, dstAddr, pkt.subarray(udpOff));
  pkt.writeUInt16BE(checksum, udpOff + 6);

  return pkt;
}

// --- Bucket token utilities ---

export function toB64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function fromB64Url(s: string): Buffer {
  const padLen = (4 - (s.length % 4)) % 4;
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  return Buffer.from(padded, "base64");
}

export function bucketIdToToken(bucketId: number): string {
  if (!Number.isInteger(bucketId) || bucketId < 0 || bucketId > 0xffff) {
    throw new Error(`Bucket ID out of range (0..65535): ${bucketId}`);
  }
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(bucketId, 0);
  return toB64Url(buf);
}

export function bucketTokenToId(token: string): number {
  const buf = fromB64Url(token);
  if (buf.length !== 2) {
    throw new Error(
      `Bucket token must decode to 2 bytes, got ${buf.length}: ${token}`,
    );
  }
  return buf.readUInt16BE(0);
}
