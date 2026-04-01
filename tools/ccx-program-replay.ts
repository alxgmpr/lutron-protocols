#!/usr/bin/env npx tsx
/**
 * CCX Programming Replay — replays a captured /cg/db programming sequence
 * to a device via udp6 (ot-daemon), with optional payload overrides.
 *
 * Usage:
 *   bun run tools/ccx-program-replay.ts \
 *     --dst fd0d:02ef:a82c:0000:3c2e:f5ff:fef9:73f9 \
 *     --override-aha '82186ca2040f0505' \
 *     --device keypad-office
 *
 * Requires ot-daemon running with RCP joined to Thread network.
 */

import { createSocket, type Socket } from "dgram";

const COAP_PORT = 5683;

// ─── CoAP helpers ────────────────────────────────────────────────────

function encodeOption(
  buf: Buffer,
  offset: number,
  delta: number,
  value: Buffer,
): number {
  let pos = offset;
  const deltaNibble = delta < 13 ? delta : delta < 269 ? 13 : 14;
  const lenNibble =
    value.length < 13 ? value.length : value.length < 269 ? 13 : 14;
  buf[pos++] = ((deltaNibble & 0xf) << 4) | (lenNibble & 0xf);
  if (deltaNibble === 13) buf[pos++] = delta - 13;
  else if (deltaNibble === 14) {
    buf.writeUInt16BE(delta - 269, pos);
    pos += 2;
  }
  if (lenNibble === 13) buf[pos++] = value.length - 13;
  else if (lenNibble === 14) {
    buf.writeUInt16BE(value.length - 269, pos);
    pos += 2;
  }
  value.copy(buf, pos);
  pos += value.length;
  return pos;
}

function buildCoap(
  code: number,
  mid: number,
  token: number,
  path: string,
  payload?: Buffer,
): Buffer {
  const buf = Buffer.alloc(256);
  let pos = 0;
  buf[pos++] = 0x41; // Ver=1, Type=CON, TKL=1
  buf[pos++] = code;
  buf.writeUInt16BE(mid, pos);
  pos += 2;
  buf[pos++] = token;

  // URI-Path options (option 11)
  let prevOpt = 0;
  const segments = path.split("/").filter(Boolean);
  for (const seg of segments) {
    const delta = 11 - prevOpt;
    const val = Buffer.from(seg, "utf8");
    pos = encodeOption(buf, pos, delta, val);
    prevOpt = 11;
  }

  if (payload && payload.length > 0) {
    buf[pos++] = 0xff;
    payload.copy(buf, pos);
    pos += payload.length;
  }

  return buf.subarray(0, pos);
}

function parseCoapHeader(buf: Buffer) {
  if (buf.length < 4) return null;
  const ver = buf[0] >> 6;
  if (ver !== 1) return null;
  const type = (buf[0] >> 4) & 0x3;
  const tkl = buf[0] & 0xf;
  const code = buf[1];
  const mid = buf.readUInt16BE(2);
  const token = tkl > 0 ? buf.subarray(4, 4 + tkl) : Buffer.alloc(0);
  return { type, code, mid, token };
}

function coapCodeStr(code: number): string {
  const cls = (code >> 5) & 0x7;
  const detail = code & 0x1f;
  return `${cls}.${detail.toString().padStart(2, "0")}`;
}

// CoAP method codes
const METHOD: Record<string, number> = { DELETE: 4, POST: 2, PUT: 3, GET: 1 };

// ─── Programming records from capture ────────────────────────────────

interface ProgramRecord {
  method: number; // CoAP code
  path: string;
  payload: string; // hex
}

// Extracted from ccx-full-transfer-20260306.pcapng, keypad ::3c2e:f5ff:fef9:73f9
const KEYPAD_OFFICE_RECORDS: ProgramRecord[] = [
  // Phase 1: DELETE /cg/db
  { method: METHOD.DELETE, path: "/cg/db", payload: "" },
  // Phase 2: mc records
  { method: METHOD.POST, path: "/cg/db/mc/c/AAI", payload: "814500000206ef" },
  { method: METHOD.POST, path: "/cg/db/mc/c/AAI", payload: "8145000001e3ef" },
  { method: METHOD.POST, path: "/cg/db/mc/c/AAI", payload: "814500000207ef" },
  { method: METHOD.POST, path: "/cg/db/mc/c/AAI", payload: "814500000020ef" },
  // Phase 3: pr records
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440ee4ef20821848a10000",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440ea6ef20821848a20019feff031828",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440e10ef20821848a10019feff",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440744ef20821848a10019feff",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440aeaef20821848a10019feff",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440ae8ef20821848a200193dd20301",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14409b1ef20821848a10019feff",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440629ef20821848a10019feff",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a144023def20821848a20019feff0301",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440c10ef20821848a20019feff0301",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440a97ef20821848a10000",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14402c5ef20821848a200000301",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14402c2ef20821848a10019feff",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14402bfef20821848a10019feff",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14402bcef20821848a20019feff0301",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440220ef20821848a20019feff0301",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a1440274ef20821848a10000",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14401f9ef20821848a10000",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14401f8ef20821848a200193dd20301",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14401f0ef20821848a20019feff0301",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14328ef20821848a100193dd2",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14327ef20821848a100197e36",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14326ef20821848a10019be9b",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14325ef20821848a10019feff",
  },
  {
    method: METHOD.POST,
    path: "/cg/db/pr/c/AAI",
    payload: "a14324ef20821848a10000",
  },
  // Phase 4: ct records
  { method: METHOD.PUT, path: "/cg/db/ct/c/AAQ", payload: "82185ca0" },
  {
    method: METHOD.PUT,
    path: "/cg/db/ct/c/AAI",
    payload: "8203a20219e53d0805",
  },
  { method: METHOD.PUT, path: "/cg/db/ct/c/AAU", payload: "821839a1011832" },
  { method: METHOD.PUT, path: "/cg/db/ct/c/AAc", payload: "821839a1011832" },
  { method: METHOD.PUT, path: "/cg/db/ct/c/AAg", payload: "821839a10101" },
  { method: METHOD.PUT, path: "/cg/db/ct/c/ABI", payload: "821839a200040103" },
  { method: METHOD.PUT, path: "/cg/db/ct/c/ABM", payload: "821839a200010103" },
  { method: METHOD.PUT, path: "/cg/db/ct/c/AFE", payload: "82186ba10000" },
  { method: METHOD.PUT, path: "/cg/db/ct/c/AFI", payload: "82186ba10001" },
  { method: METHOD.PUT, path: "/cg/db/ct/c/AFM", payload: "82186ba10002" },
  {
    method: METHOD.PUT,
    path: "/cg/db/ct/c/AHA",
    payload: "82186ca20418990514",
  }, // original: active=153, inactive=20
  { method: METHOD.PUT, path: "/cg/db/ct/c/AIE", payload: "82185ea0" },
];

// ─── CBOR helpers for AHA payload ────────────────────────────────────

function buildAhaPayload(k4: number, k5: number): string {
  // [108, {4: k4, 5: k5}] as CBOR
  // 82 = array(2)
  // 186c = uint(108)
  // a2 = map(2)
  // 04 = uint(4), then value
  // 05 = uint(5), then value
  const parts: number[] = [0x82, 0x18, 0x6c, 0xa2, 0x04];
  if (k4 < 24) parts.push(k4);
  else parts.push(0x18, k4);
  parts.push(0x05);
  if (k5 < 24) parts.push(k5);
  else parts.push(0x18, k5);
  return Buffer.from(parts).toString("hex");
}

// ─── Send single CoAP and wait for response ─────────────────────────

function sendCoap(
  sock: Socket,
  dst: string,
  method: number,
  path: string,
  payload: Buffer | undefined,
  mid: number,
  token: number,
  timeoutMs: number,
): Promise<{ code: number; mid: number }> {
  return new Promise((resolve, reject) => {
    const packet = buildCoap(method, mid, token, path, payload);
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      sock.removeListener("message", onMsg);
      reject(new Error(`timeout waiting for response to mid=${mid}`));
    }, timeoutMs);

    function onMsg(msg: Buffer) {
      const rsp = parseCoapHeader(msg);
      if (!rsp) return;
      if (rsp.mid !== mid) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeListener("message", onMsg);
      resolve({ code: rsp.code, mid: rsp.mid });
    }

    sock.on("message", onMsg);
    sock.send(packet, COAP_PORT, dst, (err) => {
      if (err && !done) {
        done = true;
        clearTimeout(timer);
        sock.removeListener("message", onMsg);
        reject(err);
      }
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const dst = getArg("dst");
const src = getArg("src");
const k4str = getArg("k4");
const k5str = getArg("k5");
const dryRun = args.includes("--dry-run");
const skipDelete = args.includes("--skip-delete");
const timeoutMs = parseInt(getArg("timeout-ms") ?? "5000", 10);

if (!dst) {
  console.error(`Usage: bun run tools/ccx-program-replay.ts --dst <ipv6> [--k4 <n>] [--k5 <n>] [--dry-run] [--skip-delete] [--timeout-ms <ms>]

Replays the full /cg/db programming sequence for the office keypad,
optionally overriding AHA LED brightness values.

  --dst          Target device ML-EID (required)
  --src          Source IPv6 to bind (spoof processor ML-EID)
  --k4           AHA activated LED level 0-255 (default: 153 from capture)
  --k5           AHA deactivated LED level 0-255 (default: 20 from capture)
  --dry-run      Print records without sending
  --skip-delete  Skip DELETE /cg/db (DANGEROUS: will likely cause 4.04)
  --timeout-ms   Per-request timeout (default: 5000)
`);
  process.exit(1);
}

// Apply AHA override
const records = [...KEYPAD_OFFICE_RECORDS];
if (k4str !== undefined || k5str !== undefined) {
  const ahaIdx = records.findIndex((r) => r.path === "/cg/db/ct/c/AHA");
  if (ahaIdx >= 0) {
    const k4 = k4str !== undefined ? parseInt(k4str, 10) : 153;
    const k5 = k5str !== undefined ? parseInt(k5str, 10) : 20;
    records[ahaIdx] = {
      ...records[ahaIdx],
      payload: buildAhaPayload(k4, k5),
    };
    console.log(`AHA override: k4=${k4} k5=${k5} → ${records[ahaIdx].payload}`);
  }
}

const methodName = (code: number) =>
  ({ 1: "GET", 2: "POST", 3: "PUT", 4: "DELETE" })[code] ?? `code=${code}`;

if (dryRun) {
  console.log(`\nDry run — ${records.length} records to ${dst}:\n`);
  for (const [i, r] of records.entries()) {
    console.log(
      `  ${(i + 1).toString().padStart(2)}. ${methodName(r.method).padEnd(6)} ${r.path}  ${r.payload || "(empty)"}`,
    );
  }
  process.exit(0);
}

// Real send
console.log(`\nReplaying ${records.length} records to ${dst}\n`);

const sock = createSocket({ type: "udp6", reuseAddr: true });
await new Promise<void>((resolve) => {
  if (src) {
    sock.bind(0, src, resolve);
  } else {
    sock.bind(0, resolve);
  }
});
if (src) console.log(`Bound source: ${src}`);

let mid = (Math.random() * 0xffff) | 0;
let token = (Math.random() * 0xff) | 0;
let ok = 0;
let fail = 0;

for (const [i, rec] of records.entries()) {
  if (skipDelete && rec.method === METHOD.DELETE) {
    console.log(`  ${(i + 1).toString().padStart(2)}. SKIP DELETE /cg/db`);
    continue;
  }

  const payload = rec.payload ? Buffer.from(rec.payload, "hex") : undefined;
  const label = `${methodName(rec.method).padEnd(6)} ${rec.path}`;
  mid = (mid + 1) & 0xffff;
  token = (token + 1) & 0xff;

  try {
    const rsp = await sendCoap(
      sock,
      dst,
      rec.method,
      rec.path,
      payload,
      mid,
      token,
      timeoutMs,
    );
    const codeStr = coapCodeStr(rsp.code);
    const isOk = rsp.code >= 64 && rsp.code < 96; // 2.xx
    console.log(
      `  ${(i + 1).toString().padStart(2)}. ${label}  → ${codeStr}${isOk ? "" : " ⚠️"}`,
    );
    if (isOk) ok++;
    else fail++;

    // After DELETE, wait longer for device to initialize DB
    if (rec.method === METHOD.DELETE) {
      console.log(`      waiting 3s for DB init...`);
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      // Small delay between requests (matches ~120ms spacing in capture)
      await new Promise((r) => setTimeout(r, 120));
    }
  } catch (err: any) {
    console.log(
      `  ${(i + 1).toString().padStart(2)}. ${label}  → FAIL: ${err.message}`,
    );
    fail++;
    if (rec.method === METHOD.DELETE) {
      console.error("\nDELETE failed — aborting (device DB not initialized)");
      break;
    }
  }
}

sock.close();
console.log(`\nDone: ${ok} ok, ${fail} failed (total ${records.length})`);
process.exit(fail > 0 ? 1 : 0);
