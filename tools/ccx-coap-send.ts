#!/usr/bin/env bun

/**
 * CCX CoAP Sender - send dynamic CoAP programming packets on Thread
 *
 * Focused for rapid /cg/db/* experimentation (e.g. status LED intensity).
 *
 * Examples:
 *   bun run tools/ccx-coap-send.ts aha --dst fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00 --src fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00 --k4 229 --k5 25 --stm32-host 10.0.0.3
 *   bun run tools/ccx-coap-send.ts send --dst fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00 --src fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00 --path /cg/db/ct/c/AHA --hex 82186ca20418e5051819 --stm32-host 10.0.0.3
 *   bun run tools/ccx-coap-send.ts trim --dst fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00 --src fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00 --high16 58685 --low16 2638 --k8 5 --stm32-host 10.0.0.3
 *   bun run tools/ccx-coap-send.ts bucket decode AHA
 *   bun run tools/ccx-coap-send.ts bucket encode 0x0070
 */

import { randomBytes } from "crypto";
import { createSocket } from "dgram";
import {
  buildCoapPacket,
  buildIpv6UdpPacket,
  bucketIdToToken,
  bucketTokenToId,
  coapCodeToString,
  coapCodeFromName,
  coapTypeToString,
  decodeMaybeCbor,
  encodeCborUint,
  encodeCborValue,
  parseCoapHeader,
} from "../ccx/coap";

const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_TEXT = 0x20;
const STREAM_RESP_TEXT = 0xfd;
const STREAM_HEARTBEAT = 0xff;
const STREAM_DEFAULT_PORT = 9433;

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function positionalArgs(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function parseIntLike(s: string, name: string): number {
  const v = /^0x/i.test(s) ? Number.parseInt(s, 16) : Number.parseInt(s, 10);
  if (!Number.isFinite(v)) throw new Error(`Invalid ${name}: ${s}`);
  return v;
}

function hexToBuf(hex: string, name = "hex"): Buffer {
  const clean = hex.replace(/[\s:,]/g, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length === 0 || clean.length % 2) {
    throw new Error(`Invalid ${name}: ${hex}`);
  }
  return Buffer.from(clean, "hex");
}

function parseCborInput(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Invalid --cbor: empty input");
  }

  const parseJsonish = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      const normalized = text
        .replace(/([{,]\s*)(-?\d+)\s*:/g, '$1"$2":')
        .replace(/'/g, '"');
      return JSON.parse(normalized);
    }
  };

  try {
    return parseJsonish(trimmed);
  } catch (err) {
    throw new Error(
      `Invalid --cbor payload. Example: --cbor '[107,{1:3}]' (${(err as Error).message})`,
    );
  }
}

function parseBucket(input: string): { id: number; token: string } {
  if (
    /^[A-Za-z0-9_-]+$/.test(input) &&
    input.length <= 6 &&
    !/^0x/i.test(input)
  ) {
    try {
      const id = bucketTokenToId(input);
      return { id, token: input };
    } catch {
      // fall through to integer parse
    }
  }

  const id = parseIntLike(input, "bucket");
  return { id, token: bucketIdToToken(id) };
}

function encodeAhaPayload(op: number, k4: number, k5: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x82]), // array(2)
    encodeCborUint(op),
    Buffer.from([0xa2, 0x04]), // map(2), key=4
    encodeCborUint(k4),
    Buffer.from([0x05]), // key=5
    encodeCborUint(k5),
  ]);
}

function encodeTrimPayload(
  op: number,
  kv: { k2?: number; k3?: number; k8?: number },
): Buffer {
  const entries: Array<[number, number]> = [];
  if (kv.k2 != null) entries.push([2, kv.k2]);
  if (kv.k3 != null) entries.push([3, kv.k3]);
  if (kv.k8 != null) entries.push([8, kv.k8]);
  if (entries.length === 0) {
    throw new Error("trim payload requires at least one of k2/k3/k8");
  }
  if (entries.length > 15) {
    throw new Error("trim payload map too large");
  }
  const parts: Buffer[] = [
    Buffer.from([0x82]),
    encodeCborUint(op),
    Buffer.from([0xa0 | entries.length]),
  ];
  for (const [k, v] of entries) {
    parts.push(encodeCborUint(k), encodeCborUint(v));
  }
  return Buffer.concat(parts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Aliases for local readability
const codeFromName = coapCodeFromName;
const typeNameFromNum = coapTypeToString;

function buildSpinelStreamNetValue(ipv6Packet: Buffer): Buffer {
  if (ipv6Packet.length > 0xffff) {
    throw new Error("STREAM_NET packet too large");
  }
  return Buffer.concat([
    Buffer.from([ipv6Packet.length & 0xff, (ipv6Packet.length >> 8) & 0xff]),
    ipv6Packet,
    Buffer.from([0x00, 0x00]),
  ]);
}

function buildStreamCommand(cmd: number, data: Buffer): Buffer {
  if (data.length > 255) {
    throw new Error(`Stream command data too long: ${data.length} bytes`);
  }
  const out = Buffer.alloc(2 + data.length);
  out[0] = cmd & 0xff;
  out[1] = data.length & 0xff;
  data.copy(out, 2);
  return out;
}

async function sendCoapViaStm32(params: {
  host: string;
  streamPort: number;
  shellCommand: string;
  shellTimeoutMs: number;
  coapTimeoutMs: number;
  repeat: number;
  intervalMs: number;
  requestMid: number;
  requestToken: Buffer;
}): Promise<void> {
  const {
    host,
    streamPort,
    shellCommand,
    shellTimeoutMs,
    coapTimeoutMs,
    repeat,
    intervalMs,
    requestMid,
    requestToken,
  } = params;

  const keepalive = buildStreamCommand(STREAM_CMD_KEEPALIVE, Buffer.alloc(0));
  const textCmd = buildStreamCommand(
    STREAM_CMD_TEXT,
    Buffer.from(shellCommand, "utf8"),
  );

  await new Promise<void>((resolve, reject) => {
    const sock = createSocket("udp4");
    let textResolver: ((s: string) => void) | null = null;
    let textTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let coapAckSeen = false;
    let coapResponse: {
      code: number;
      mid: number;
      tokenHex: string;
      payload: Buffer;
    } | null = null;

    const clearTextWait = () => {
      if (textTimer) clearTimeout(textTimer);
      textTimer = null;
      textResolver = null;
    };

    const sendFrame = (frame: Buffer): Promise<void> =>
      new Promise((res, rej) => {
        sock.send(frame, streamPort, host, (err) => (err ? rej(err) : res()));
      });

    const sendTextAndWait = (timeoutMs: number): Promise<string> =>
      new Promise((res, rej) => {
        textResolver = res;
        textTimer = setTimeout(() => {
          clearTextWait();
          rej(new Error(`No STM32 text response within ${timeoutMs}ms`));
        }, timeoutMs);
        sendFrame(textCmd).catch((err) => {
          clearTextWait();
          rej(err as Error);
        });
      });

    const finish = (err?: Error) => {
      clearTextWait();
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      sock.close();
      if (err) reject(err);
      else resolve();
    };

    sock.on("error", (err) => finish(err));

    sock.on("message", (msg) => {
      if (msg.length >= 2 && msg[0] === STREAM_HEARTBEAT && msg[1] === 0x00)
        return;

      if (msg.length >= 1 && msg[0] === STREAM_RESP_TEXT) {
        const text = msg.subarray(1).toString("utf8");
        if (textResolver) {
          const r = textResolver;
          clearTextWait();
          r(text);
        }
        return;
      }

      // Stream frame: [flags][len][ts_le32][data]
      if (msg.length < 6) return;
      const flags = msg[0];
      const len = msg[1];
      if (msg.length < 6 + len) return;
      if ((flags & 0x40) === 0) return; // only CCX channel

      const data = msg.subarray(6, 6 + len);
      const coap = parseCoapHeader(data);
      if (!coap) return;

      console.log(
        `coap.rx type=${typeNameFromNum(coap.type)} code=${coapCodeToString(coap.code)} mid=${coap.mid} token=${coap.token.toString("hex")}`,
      );
      if (coap.payload.length) {
        console.log(`coap.rx.payload=${coap.payload.toString("hex")}`);
      }

      if (coap.type === 2 && coap.code === 0 && coap.mid === requestMid) {
        coapAckSeen = true;
      }

      const cls = coap.code >> 5;
      if (
        cls >= 2 &&
        cls <= 5 &&
        (coap.token.equals(requestToken) || coap.mid === requestMid)
      ) {
        coapResponse = {
          code: coap.code,
          mid: coap.mid,
          tokenHex: coap.token.toString("hex"),
          payload: coap.payload,
        };
      }
    });

    sock.bind(0, async () => {
      try {
        await sendFrame(keepalive);
        keepaliveTimer = setInterval(() => {
          void sendFrame(keepalive);
        }, 1000);
        await sleep(20);

        for (let i = 0; i < repeat; i++) {
          const response = await sendTextAndWait(shellTimeoutMs);
          const trimmed = response.trim();
          if (trimmed.length > 0) {
            console.log(`stm32.response=${trimmed}`);
          }
          if (!/Response\s+\(\d+\s+bytes\):\s+[0-9A-Fa-f ]+/.test(response)) {
            finish(
              new Error(
                `STM32 did not return a raw Spinel response: ${trimmed || "(empty response)"}`,
              ),
            );
            return;
          }
          if (!/\b06 00 00\b/.test(response)) {
            finish(
              new Error(
                `STM32 raw Spinel response was not LAST_STATUS=0: ${trimmed || "(empty response)"}`,
              ),
            );
            return;
          }
          if (i < repeat - 1) await sleep(intervalMs);
        }

        const deadline = Date.now() + coapTimeoutMs;
        while (Date.now() < deadline) {
          if (coapResponse) {
            const cls = coapResponse.code >> 5;
            if (cls === 2) {
              finish();
            } else {
              finish(
                new Error(
                  `CoAP error response ${coapCodeToString(coapResponse.code)} mid=${coapResponse.mid} token=${coapResponse.tokenHex}`,
                ),
              );
            }
            return;
          }
          await sleep(25);
        }

        finish(
          new Error(
            `No matching CoAP 2.xx response within ${coapTimeoutMs}ms (ack_seen=${coapAckSeen})`,
          ),
        );
      } catch (err) {
        finish(err as Error);
      }
    });
  });
}

async function sendCoap(params: {
  dst: string;
  src?: string;
  port: number;
  path: string;
  payload: Buffer;
  code: number;
  type: number;
  mid?: number;
  token?: Buffer;
  timeoutMs: number;
  repeat: number;
  intervalMs: number;
  dryRun: boolean;
  transport: "udp6" | "stm32";
  stm32Host?: string;
  stm32Port: number;
  shellTimeoutMs: number;
  spinelStreamProp: number;
}) {
  const {
    dst,
    src,
    port,
    path,
    payload,
    code,
    type,
    mid,
    token,
    timeoutMs,
    repeat,
    intervalMs,
    dryRun,
    transport,
    stm32Host,
    stm32Port,
    shellTimeoutMs,
    spinelStreamProp,
  } = params;

  const requestMid = (mid ?? Math.floor(Math.random() * 65536)) & 0xffff;
  const requestToken = token ?? randomBytes(2);

  const packet = buildCoapPacket({
    type,
    code,
    mid: requestMid,
    token: requestToken,
    path,
    payload,
  });

  console.log(
    `dst=${dst} port=${port} type=${typeNameFromNum(type)} code=${coapCodeToString(code)} path=${path}`,
  );
  if (src) console.log(`src=${src}`);
  console.log(`mid=${requestMid} token=${requestToken.toString("hex")}`);
  console.log(`payload=${payload.toString("hex")}`);
  const decoded = decodeMaybeCbor(payload);
  if (decoded) console.log(`payload.cbor=${decoded}`);
  console.log(`coap.packet=${packet.toString("hex")}`);
  console.log(`transport=${transport}`);

  if (dryRun) return;

  if (transport === "stm32") {
    if (!stm32Host) {
      throw new Error(
        "Missing --stm32-host (or NUCLEO_HOST) for STM32 transport",
      );
    }

    const ipv6Packet = buildIpv6UdpPacket({
      dst,
      src,
      srcPort: port,
      dstPort: port,
      udpPayload: packet,
    });
    const streamNetValue = buildSpinelStreamNetValue(ipv6Packet);
    const rawFrame = Buffer.concat([
      Buffer.from([0x81, 0x03, spinelStreamProp & 0xff]), // tid1, PROP_SET, STREAM_NET*
      streamNetValue,
    ]);
    const shellCommand = `spinel raw ${rawFrame.toString("hex")}`;
    const shellLen = Buffer.byteLength(shellCommand, "utf8");
    if (shellLen > 255) {
      throw new Error(
        `Shell command too long (${shellLen} bytes, max 255). Reduce path/payload size.`,
      );
    }

    console.log(`stm32.host=${stm32Host}:${stm32Port}`);
    console.log(`stream.net.value_len=${streamNetValue.length} bytes`);
    console.log(`spinel.command=${shellCommand}`);

    await sendCoapViaStm32({
      host: stm32Host,
      streamPort: stm32Port,
      shellCommand,
      shellTimeoutMs,
      coapTimeoutMs: timeoutMs,
      repeat,
      intervalMs,
      requestMid,
      requestToken,
    });
    return;
  }

  const sock = createSocket({ type: "udp6", reuseAddr: true });

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      sock.close();
      if (err) reject(err);
      else resolve();
    };

    const timeout = setTimeout(() => {
      finish(new Error(`No CoAP response within ${timeoutMs}ms`));
    }, timeoutMs);

    sock.on("error", (err) => {
      clearTimeout(timeout);
      finish(err);
    });

    sock.on("message", (msg, rinfo) => {
      const rsp = parseCoapHeader(msg);
      if (!rsp) return;
      if (rsp.mid !== requestMid) return;
      if (!rsp.token.equals(requestToken)) return;

      clearTimeout(timeout);

      console.log(
        `response from ${rinfo.address}:${rinfo.port} type=${typeNameFromNum(rsp.type)} code=${coapCodeToString(rsp.code)} mid=${rsp.mid} token=${rsp.token.toString("hex")}`,
      );
      if (rsp.payload.length) {
        console.log(`response.payload=${rsp.payload.toString("hex")}`);
        const rspDecoded = decodeMaybeCbor(rsp.payload);
        if (rspDecoded) console.log(`response.payload.cbor=${rspDecoded}`);
      }

      finish();
    });

    sock.bind(0, () => {
      let sent = 0;
      const sendNext = () => {
        if (sent >= repeat) return;
        sock.send(packet, port, dst, (err) => {
          if (err) {
            clearTimeout(timeout);
            finish(err);
            return;
          }
          sent++;
          if (sent < repeat) setTimeout(sendNext, intervalMs);
        });
      };
      sendNext();
    });
  });
}

function usage() {
  console.log(`
CCX CoAP Sender - dynamic Thread programming packet sender

Commands:
  send     Generic CoAP send to /cg/db/* (or any path)
  aha      Convenience write for /cg/db/ct/c/AHA payload [108,{4:k4,5:k5}]
  trim     Convenience write for /cg/db/ct/c/AAI payload [3,{2:high16,3:low16,8:k8}]
  bucket   Encode/decode ct bucket token

Examples:
  bun run tools/ccx-coap-send.ts send --dst fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00 --src fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00 --path /cg/db/ct/c/AHA --hex 82186ca20418e5051819 --stm32-host 10.0.0.3
  bun run tools/ccx-coap-send.ts send --dst fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00 --src fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00 --path /cg/db/ct/c/AFE --cbor '[107,{1:3}]' --stm32-host 10.0.0.3
  bun run tools/ccx-coap-send.ts aha --dst fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00 --src fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00 --k4 229 --k5 25 --stm32-host 10.0.0.3
  bun run tools/ccx-coap-send.ts trim --dst fd0d:02ef:a82c:0000:0000:00ff:fe00:2c00 --src fd0d:02ef:a82c:0000:0000:00ff:fe00:4c00 --high16 58685 --low16 2638 --k8 5 --stm32-host 10.0.0.3
  bun run tools/ccx-coap-send.ts bucket decode AHA
  bun run tools/ccx-coap-send.ts bucket encode 0x0070

send options:
  --dst <ipv6>         Destination IPv6
  --src <ipv6>         Source IPv6 (required for STM32 raw injection)
  --path <uri-path>    CoAP uri path (default: /cg/db/ct/c/AHA)
  --hex <payload-hex>  Payload bytes in hex
  --cbor <payload>     Payload as JSON/JSON-ish (e.g. '[107,{1:3}]')
  --empty              Send explicit empty payload (useful for method probing)
  --code <put|post|delete|n>
  --port <n>           UDP port (default: 5683)
  --con / --non        CoAP type (default: CON)
  --mid <n>            Message ID override
  --token <hex>        Token override (1-8 bytes)
  --repeat <n>         Retries (default: 1)
  --interval <ms>      Retry spacing (default: 120)
  --timeout-ms <ms>    Response timeout (default: 2000)
  --dry-run            Build and print packet, do not send

transport options:
  --stm32-host <ip>    Send via STM32+nRF using raw Spinel STREAM_NET over stream UDP
                       (default: NUCLEO_HOST env, if set)
  --stm32-port <n>     STM32 stream UDP port (default: 9433)
  --shell-timeout-ms   STM32 shell response timeout (default: 5000)
  --spinel-stream-prop Spinel stream prop (0x72=NET, 0x73=NET_INSECURE; default: 0x72)

aha options:
  --dst <ipv6>         Destination IPv6
  --k4 <n>             AHA key 4: activated status LED level (0..255)
  --k5 <n>             AHA key 5: deactivated status LED level (0..255)
  --op <n>             Opcode (default: 108)
  --bucket <id|token>  Bucket (default: AHA)

trim options:
  --dst <ipv6>         Destination IPv6
  --high16 <n>         AAI key 2: high trim level (0..65279 typical)
  --low16 <n>          AAI key 3: low trim level (optional)
  --k8 <n>             AAI key 8 metadata (default: 5)
  --op <n>             Opcode (default: 3)
  --bucket <id|token>  Bucket (default: AAI)
`);
}

async function main() {
  const pos = positionalArgs();
  const cmd = pos[0];

  if (!cmd) {
    usage();
    return;
  }

  if (cmd === "bucket") {
    const sub = pos[1];
    const val = pos[2];
    if (!sub || !val) {
      console.error("Usage: bucket <encode|decode> <value>");
      process.exit(1);
    }
    if (sub === "encode") {
      const id = parseIntLike(val, "bucket id");
      const token = bucketIdToToken(id);
      console.log(`${id} -> ${token}`);
      return;
    }
    if (sub === "decode") {
      const id = bucketTokenToId(val);
      console.log(`${val} -> 0x${id.toString(16).padStart(4, "0")} (${id})`);
      return;
    }
    console.error("Usage: bucket <encode|decode> <value>");
    process.exit(1);
  }

  const dst = getArg("--dst");
  if (!dst) {
    console.error("Missing --dst");
    process.exit(1);
  }
  const src = getArg("--src");
  if (dst.startsWith("::")) {
    console.warn(
      "WARNING: --dst uses :: prefix. Thread captures may hide mesh prefix; prefer full fdxx:: address.",
    );
  }
  if (src?.startsWith("::")) {
    console.warn(
      "WARNING: --src uses :: prefix. Prefer full mesh-local fdxx:: address.",
    );
  }

  const port = parseInt(getArg("--port") ?? "5683", 10);
  const repeat = parseInt(getArg("--repeat") ?? "1", 10);
  const intervalMs = parseInt(getArg("--interval") ?? "120", 10);
  const timeoutMs = parseInt(getArg("--timeout-ms") ?? "2000", 10);
  const dryRun = hasFlag("--dry-run");
  const stm32Host = getArg("--stm32-host") ?? process.env.NUCLEO_HOST;
  const stm32Port = parseInt(
    getArg("--stm32-port") ?? String(STREAM_DEFAULT_PORT),
    10,
  );
  const shellTimeoutMs = parseInt(getArg("--shell-timeout-ms") ?? "5000", 10);
  const spinelStreamProp = parseIntLike(
    getArg("--spinel-stream-prop") ?? "0x72",
    "spinel stream prop",
  );
  const transport: "udp6" | "stm32" = stm32Host ? "stm32" : "udp6";
  if (transport === "stm32" && !src) {
    throw new Error(
      "STM32 transport requires --src <full-mesh-local-ipv6>; captures that show ::<iid> are usually context-compressed",
    );
  }

  const type = hasFlag("--non") ? 1 : 0;
  const code = codeFromName(getArg("--code") ?? "put");
  const emptyPayload = hasFlag("--empty");
  const midArg = getArg("--mid");
  const tokenArg = getArg("--token");

  const mid = midArg ? parseIntLike(midArg, "mid") : undefined;
  const token = tokenArg ? hexToBuf(tokenArg, "token") : undefined;

  if (cmd === "send") {
    const path = getArg("--path") ?? "/cg/db/ct/c/AHA";
    const hex = getArg("--hex");
    const cbor = getArg("--cbor");
    if (
      (hex != null && cbor != null) ||
      (hex != null && emptyPayload) ||
      (cbor != null && emptyPayload)
    ) {
      console.error("Use exactly one of --hex, --cbor, or --empty");
      process.exit(1);
    }
    const payload =
      hex != null && hex.length > 0
        ? hexToBuf(hex, "payload hex")
        : cbor != null
          ? encodeCborValue(parseCborInput(cbor))
          : Buffer.alloc(0);
    if (payload.length === 0 && !emptyPayload && !(code === 1 || code === 4)) {
      console.error(
        "Missing --hex or --cbor for send command (required for PUT/POST)",
      );
      process.exit(1);
    }
    await sendCoap({
      dst,
      src,
      port,
      path,
      payload,
      code,
      type,
      mid,
      token,
      timeoutMs,
      repeat,
      intervalMs,
      dryRun,
      transport,
      stm32Host,
      stm32Port,
      shellTimeoutMs,
      spinelStreamProp,
    });
    return;
  }

  if (cmd === "aha") {
    const k4Arg = getArg("--k4");
    const k5Arg = getArg("--k5");
    if (!k4Arg || !k5Arg) {
      console.error("Missing --k4 or --k5 for aha command");
      process.exit(1);
    }

    const op = parseInt(getArg("--op") ?? "108", 10);
    const k4 = parseInt(k4Arg, 10);
    const k5 = parseInt(k5Arg, 10);

    if (![op, k4, k5].every(Number.isFinite)) {
      throw new Error("Invalid op/k4/k5");
    }

    const bucket = parseBucket(getArg("--bucket") ?? "AHA");
    const path = `/cg/db/ct/c/${bucket.token}`;

    const payload = encodeAhaPayload(op, k4, k5);

    console.log(
      `bucket=${bucket.token} (0x${bucket.id.toString(16).padStart(4, "0")})`,
    );

    await sendCoap({
      dst,
      src,
      port,
      path,
      payload,
      code,
      type,
      mid,
      token,
      timeoutMs,
      repeat,
      intervalMs,
      dryRun,
      transport,
      stm32Host,
      stm32Port,
      shellTimeoutMs,
      spinelStreamProp,
    });
    return;
  }

  if (cmd === "trim") {
    const high16Arg = getArg("--high16");
    const low16Arg = getArg("--low16");
    const op = parseInt(getArg("--op") ?? "3", 10);
    const k8Arg = getArg("--k8") ?? "5";
    const k8 = parseInt(k8Arg, 10);

    const high16 = high16Arg ? parseInt(high16Arg, 10) : undefined;
    const low16 = low16Arg ? parseInt(low16Arg, 10) : undefined;
    if (
      !Number.isFinite(op) ||
      !Number.isFinite(k8) ||
      (high16Arg != null && !Number.isFinite(high16)) ||
      (low16Arg != null && !Number.isFinite(low16))
    ) {
      throw new Error("Invalid trim op/high16/low16/k8");
    }
    if (high16 == null && low16 == null) {
      throw new Error("trim requires at least one of --high16 or --low16");
    }

    const bucket = parseBucket(getArg("--bucket") ?? "AAI");
    const path = `/cg/db/ct/c/${bucket.token}`;
    const payload = encodeTrimPayload(op, { k2: high16, k3: low16, k8 });

    console.log(
      `bucket=${bucket.token} (0x${bucket.id.toString(16).padStart(4, "0")})`,
    );

    await sendCoap({
      dst,
      src,
      port,
      path,
      payload,
      code,
      type,
      mid,
      token,
      timeoutMs,
      repeat,
      intervalMs,
      dryRun,
      transport,
      stm32Host,
      stm32Port,
      shellTimeoutMs,
      spinelStreamProp,
    });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
