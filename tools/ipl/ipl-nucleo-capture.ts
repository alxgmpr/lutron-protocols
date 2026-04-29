#!/usr/bin/env npx tsx

/**
 * Combined multi-source Lutron capture → timestamped NDJSON.
 *
 * Opens up to four streams in parallel and emits one NDJSON line per event:
 *   - ipl   — TLS :8902 decoded LEI frames from RA3 processor
 *   - cca   — UDP :9433 raw 433 MHz packets from STM32 (CC1101)
 *   - ccx   — UDP :9433 decoded CCX packets from STM32 (NCP-handled)
 *   - sniff — spawned `ccx-sniffer --live --json` (nRF52840 USB promisc)
 *   - leap  — LEAP /zone, /device, /area, etc. subscription events
 *
 * Every line carries:
 *   - ts      — wall-clock epoch ms (Date.now at dispatch)
 *   - mono_ns — monotonic ns since capture start (process.hrtime.bigint, as string)
 *   - src     — one of the sources above
 *
 * Sniffer events additionally carry `hw_ts` — the hardware timestamp from the
 * pcap frame, which is the most accurate source of truth for RF ordering.
 *
 * Usage:
 *   npx tsx tools/ipl-nucleo-capture.ts --out capture.ndjson
 *   npx tsx tools/ipl-nucleo-capture.ts --no-sniff --no-leap
 *   npx tsx tools/ipl-nucleo-capture.ts --ipl-host 10.1.1.133 --nucleo-host 10.0.0.3
 */

import { spawn } from "child_process";
import { createSocket } from "dgram";
import { createWriteStream, readFileSync } from "fs";
import { dirname, join } from "path";
import { createInterface } from "readline";
import { connect } from "tls";
import { fileURLToPath } from "url";
import { config, defaultHost } from "../../lib/config";
import {
  MsgTypeName,
  type ParsedFrame,
  parseAllFrames,
  resolveOpName,
} from "../../lib/ipl";
import { LeapConnection } from "../../lib/leap-client";

const args = process.argv.slice(2);
const getArg = (n: string) => {
  const i = args.indexOf(n);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (n: string) => args.includes(n);

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const IPL_HOST = getArg("--ipl-host") ?? defaultHost ?? "10.1.1.133";
const IPL_PORT = Number.parseInt(getArg("--ipl-port") ?? "8902", 10);
const NUCLEO_HOST = getArg("--nucleo-host") ?? config.openBridge;
const NUCLEO_PORT = Number.parseInt(getArg("--nucleo-port") ?? "9433", 10);
const LEAP_HOST = getArg("--leap-host") ?? defaultHost ?? "10.1.1.133";
const OUT_PATH = getArg("--out");

const NO_IPL = hasFlag("--no-ipl");
const NO_NUCLEO = hasFlag("--no-nucleo");
const NO_SNIFF = hasFlag("--no-sniff");
const NO_LEAP = hasFlag("--no-leap");

// ---------- Output sink ----------

const outStream = OUT_PATH ? createWriteStream(OUT_PATH, { flags: "a" }) : null;
const startNs = process.hrtime.bigint();

function emit(obj: Record<string, unknown>): void {
  const ts = Date.now();
  const mono_ns = (process.hrtime.bigint() - startNs).toString();
  const line = `${JSON.stringify({ ts, mono_ns, ...obj })}\n`;
  if (outStream) outStream.write(line);
  else process.stdout.write(line);
}

// ---------- Stats (stderr) ----------

const counts = { ipl: 0, cca: 0, ccx: 0, ccx_raw: 0, sniff: 0, leap: 0 };
const statsTimer = setInterval(() => {
  process.stderr.write(
    `[${new Date().toISOString()}] ipl=${counts.ipl} cca=${counts.cca} ccx=${counts.ccx} ccx_raw=${counts.ccx_raw} sniff=${counts.sniff} leap=${counts.leap}\r`,
  );
}, 1000);

// ---------- IPL stream ----------

function startIpl(): void {
  const CERT_DIR = join(__dir, "..", "certs", "designer");
  const clientCert = readFileSync(join(CERT_DIR, "ipl_client_cert.pem"));
  const clientKey = readFileSync(join(CERT_DIR, "ipl_client_key.pem"));
  const caCert = readFileSync(join(CERT_DIR, "radioRa3_products.crt"));

  const sock = connect({
    host: IPL_HOST,
    port: IPL_PORT,
    cert: clientCert,
    key: clientKey,
    ca: caCert,
    rejectUnauthorized: false,
  });

  let rxBuf: Buffer = Buffer.alloc(0);
  sock.on("secureConnect", () =>
    process.stderr.write(`[ipl] connected to ${IPL_HOST}:${IPL_PORT}\n`),
  );
  sock.on("data", (chunk: Buffer) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    const { frames, remainder } = parseAllFrames(rxBuf);
    rxBuf = remainder;
    for (const f of frames) emitIpl(f);
  });
  sock.on("error", (err) => {
    process.stderr.write(`[ipl] socket error: ${err.message}\n`);
  });
  sock.on("close", () => {
    process.stderr.write(`[ipl] connection closed\n`);
  });
}

function emitIpl(f: ParsedFrame): void {
  counts.ipl++;
  const op = f.operationId;
  emit({
    src: "ipl",
    msgType: MsgTypeName[f.msgType],
    msgTypeId: f.msgType,
    op,
    opName: op !== undefined ? resolveOpName(f.msgType, op) : undefined,
    systemId: f.systemId,
    senderId: f.senderId,
    receiverId: f.receiverId,
    receiverProcessing: f.receiverProcessing,
    messageId: f.messageId,
    body_hex: f.body.toString("hex"),
    body_len: f.body.length,
  });
}

// ---------- Nucleo UDP stream ----------

const CMD_KEEPALIVE = 0x00;
const FLAG_TX = 0x80;
const FLAG_CCX = 0x40;
const FLAG_RAW = 0x20; // promiscuous 802.15.4 sniff (only w/ CCX)
const FLAG_RSSI_MASK = 0x1f; // firmware uses 5 bits
const RESP_TEXT = 0xfd;

function startNucleo(): void {
  const sock = createSocket("udp4");

  sock.on("message", (msg: Buffer) => {
    if (msg.length < 2) return;
    const flags = msg[0];
    const len = msg[1];

    // Skip heartbeat / text / status — only radio packets here
    if (flags === 0xff && len === 0x00) return;
    if (flags === RESP_TEXT) return;
    if (flags === 0xfe) return;
    /* Wire format: FLAGS(1) LEN(1) TS_MS(4) TS_CYC(4) DATA(N) */
    if (msg.length < 10 + len) return;

    const radioTs = msg.readUInt32LE(2);
    const radioCyc = msg.readUInt32LE(6);
    const data = msg.subarray(10, 10 + len);
    const isCcx = !!(flags & FLAG_CCX);
    const isRaw = !!(flags & FLAG_RAW);
    const isTx = !!(flags & FLAG_TX);
    const rssi = flags & FLAG_RSSI_MASK;

    const src = isCcx ? (isRaw ? "ccx_raw" : "ccx") : "cca";
    if (src === "cca") counts.cca++;
    else if (src === "ccx") counts.ccx++;
    else counts.ccx_raw++;

    emit({
      src,
      tx: isTx,
      rssi: isCcx ? undefined : rssi,
      flags,
      radioTs,
      radioCyc,
      data_hex: data.toString("hex"),
      data_len: data.length,
    });
  });

  sock.on("error", (err) => {
    process.stderr.write(`[nucleo] socket error: ${err.message}\n`);
  });

  sock.bind(() => {
    const keepaliveFrame = Buffer.from([CMD_KEEPALIVE, 0]);
    const send = () =>
      sock.send(keepaliveFrame, 0, 2, NUCLEO_PORT, NUCLEO_HOST);
    send();
    setInterval(send, 5000);
    process.stderr.write(
      `[nucleo] bound, streaming from ${NUCLEO_HOST}:${NUCLEO_PORT}\n`,
    );
  });
}

// ---------- nRF sniffer (via ccx-sniffer --live --json) ----------

function startSniffer(): void {
  const snifferArgs = ["tsx", "tools/ccx-sniffer.ts", "--live", "--json"];
  const channel = getArg("--sniff-channel");
  if (channel) {
    snifferArgs.push("--channel", channel);
  }
  const iface = getArg("--sniff-iface");
  if (iface) {
    snifferArgs.push("--iface", iface);
  }

  process.stderr.write(`[sniff] spawning: npx ${snifferArgs.join(" ")}\n`);
  const child = spawn("npx", snifferArgs, {
    cwd: join(__dir, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return;
    try {
      const obj = JSON.parse(trimmed);
      counts.sniff++;
      emit({ src: "sniff", hw_ts: obj.timestamp, ...obj });
    } catch {
      /* non-JSON line — ignore */
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    // ccx-sniffer emits tshark diagnostics to stderr; pass through with prefix
    const text = chunk.toString("utf8").trimEnd();
    for (const l of text.split("\n")) {
      if (l) process.stderr.write(`[sniff] ${l}\n`);
    }
  });

  child.on("exit", (code) => {
    process.stderr.write(`[sniff] exited (code=${code})\n`);
  });
}

// ---------- LEAP subscriptions ----------

const LEAP_SUBS = ["/zone/status", "/device/status"];

async function startLeap(): Promise<void> {
  const conn = new LeapConnection({ host: LEAP_HOST });
  try {
    await conn.connect();
    process.stderr.write(`[leap] connected to ${LEAP_HOST}\n`);
  } catch (err) {
    process.stderr.write(`[leap] connect failed: ${(err as Error).message}\n`);
    return;
  }

  conn.onEvent = (msg: any) => {
    counts.leap++;
    emit({
      src: "leap",
      communiqueType: msg.CommuniqueType,
      url: msg.Header?.Url,
      statusCode: msg.Header?.StatusCode,
      body: msg.Body,
    });
  };

  for (const url of LEAP_SUBS) {
    try {
      const resp = await conn.subscribe(url);
      const status = resp.Header?.StatusCode ?? "?";
      process.stderr.write(`[leap] subscribed ${url} (${status})\n`);
      // Emit initial snapshot response as a leap event too
      if (resp.Body) {
        counts.leap++;
        emit({
          src: "leap",
          communiqueType: resp.CommuniqueType,
          url,
          statusCode: status,
          body: resp.Body,
          initial: true,
        });
      }
    } catch (err) {
      process.stderr.write(
        `[leap] sub ${url} failed: ${(err as Error).message}\n`,
      );
    }
  }
}

// ---------- Main ----------

process.stderr.write(
  `capture → ${OUT_PATH ?? "stdout"}\n` +
    `  ipl=${NO_IPL ? "off" : IPL_HOST}\n` +
    `  nucleo=${NO_NUCLEO ? "off" : NUCLEO_HOST}\n` +
    `  sniff=${NO_SNIFF ? "off" : "ccx-sniffer --live --json"}\n` +
    `  leap=${NO_LEAP ? "off" : LEAP_HOST}\n`,
);

if (!NO_IPL) startIpl();
if (!NO_NUCLEO) startNucleo();
if (!NO_SNIFF) startSniffer();
if (!NO_LEAP) startLeap();

process.on("SIGINT", () => {
  clearInterval(statsTimer);
  process.stderr.write(
    `\ndone: ipl=${counts.ipl} cca=${counts.cca} ccx=${counts.ccx} ccx_raw=${counts.ccx_raw} sniff=${counts.sniff} leap=${counts.leap}\n`,
  );
  if (outStream) outStream.end(() => process.exit(0));
  else process.exit(0);
});
