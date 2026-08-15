#!/usr/bin/env npx tsx

/**
 * IPL probe / sweep harness.
 *
 * Complements `ipl-cmd.ts`: holds ONE TLS session open, sends a scripted list
 * of frames back-to-back, and dumps every received frame with the FULL body hex
 * (ipl-cmd.ts truncates at 80 chars). Built for fuzzing an opcode's parameter
 * space against the processor's `/var/log/core` as an oracle.
 *
 * Modes:
 *   capture <seconds>                        listen only
 *   send <opId> <bodyHex> [<opId> <bodyHex>…] send raw frames, then listen
 *   rpc <Name> <jsonArgs> [<Name> <json>…]    opId 349 named-RPC (zlib JSON)
 *   file <jobs.json>                          batch; entries are either
 *                                               {"op":N,"hex":"…","note":"…"}
 *                                             or {"rpc":"Name","args":{…}}
 *
 * Flags:
 *   --host <ip>     default from config.json
 *   --port <n>      default 8902
 *   --listen <sec>  extra listen time after the last frame (default 6)
 *   --gap <ms>      delay between frames (default 400)
 *   --system/--sender/--receiver <n>, --no-ack
 *
 * NOTE on reachability: on some processors the integration port is only opened
 * to specific VLANs. If TCP 8902 times out from your workstation but SSH works,
 * tunnel it — the port is bound on the processor itself:
 *
 *   ssh -f -L 18902:127.0.0.1:8902 root@<proc> "sleep 90"
 *   npx tsx tools/ipl/ipl-probe.ts capture 30 --host 127.0.0.1 --port 18902
 *
 * Pairing the sweep with the processor log is what makes this useful:
 *   MARK=$(ssh root@<proc> "wc -l < /var/log/core")
 *   …run sweep…
 *   ssh root@<proc> "tail -n +$((MARK+1)) /var/log/core"
 * Most handlers name the rejected property/command in the log line, so results
 * can be classified without timing correlation.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { connect } from "tls";
import { fileURLToPath } from "url";
import { defaultHost } from "../../lib/config";
import {
  bodyNamedRPC,
  buildCommandFrame,
  MsgType,
  MsgTypeName,
  type ParsedFrame,
  parseAllFrames,
  resolveOpName,
} from "../../lib/ipl";

const argv = process.argv.slice(2);
const FLAGS = new Set([
  "--host",
  "--port",
  "--listen",
  "--gap",
  "--sender",
  "--receiver",
  "--system",
]);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i !== -1 ? argv[i + 1] : d;
};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS.has(a)) {
    i++;
    continue;
  }
  if (a.startsWith("--")) continue;
  pos.push(a);
}

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const HOST = flag("--host") ?? defaultHost ?? "10.1.1.133";
const PORT = Number(flag("--port", "8902"));
const LISTEN = Number(flag("--listen", "6"));
const GAP = Number(flag("--gap", "400"));
const SENDER = Number(flag("--sender", "1"));
const RECEIVER = Number(flag("--receiver", "255"));
const SYSTEM = Number(flag("--system", "1"));
const NOACK = argv.includes("--no-ack");

const CERT_DIR = join(__dir, "..", "..", "certs", "designer");
const clientCert = readFileSync(join(CERT_DIR, "ipl_client_cert.pem"));
const clientKey = readFileSync(join(CERT_DIR, "ipl_client_key.pem"));
const caCert = readFileSync(join(CERT_DIR, "radioRa3_products.crt"));

interface Job {
  op: number;
  hex: string;
  note?: string;
}

const mode = pos[0];
const jobs: Job[] = [];
let listenSec = LISTEN;

const rpcJob = (name: string, args: unknown, note?: string): Job => ({
  op: 349,
  hex: bodyNamedRPC(name, args).toString("hex"),
  note: note ?? `${name} ${JSON.stringify(args)}`,
});

switch (mode) {
  case "capture":
    listenSec = Number(pos[1] ?? LISTEN);
    break;
  case "send":
    for (let i = 1; i < pos.length; i += 2)
      jobs.push({ op: Number(pos[i]), hex: (pos[i + 1] ?? "").replace(/\s/g, "") });
    break;
  case "rpc":
    for (let i = 1; i < pos.length; i += 2)
      jobs.push(rpcJob(pos[i], JSON.parse(pos[i + 1] ?? "{}")));
    break;
  case "file": {
    const raw = JSON.parse(readFileSync(pos[1], "utf8")) as Array<
      Job & { rpc?: string; args?: unknown }
    >;
    for (const j of raw) {
      if (j.rpc) jobs.push(rpcJob(j.rpc, j.args ?? {}, j.note));
      else jobs.push({ ...j, hex: j.hex.replace(/\s/g, "") });
    }
    break;
  }
  default:
    console.error(
      "usage: ipl-probe.ts capture <sec> | send <op> <hex>… | rpc <Name> <json>… | file <jobs.json>",
    );
    process.exit(2);
}

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

function fmt(f: ParsedFrame): string {
  const op = f.operationId;
  const opName = op === undefined ? "" : (resolveOpName(f.msgType, op) ?? "?");
  let line =
    `${ts()} LEI${String.fromCharCode(0x40 + f.msgType)} ${MsgTypeName[f.msgType]}` +
    ` sys=${f.systemId} s=${f.senderId}->r=${f.receiverId} seq=${f.messageId}` +
    `${op !== undefined ? ` op=${op}(${opName})` : ""} len=${f.body.length}`;
  if (f.body.length) line += `\n      hex=${f.body.toString("hex")}`;
  // opId 349 bodies are `<name>\0<5 id bytes><zlib json>` — show the name.
  const ascii = f.body.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
  if (f.body.length && /[A-Za-z]{4}/.test(ascii)) line += `\n      asc=${ascii}`;
  return line;
}

const sock = connect({
  host: HOST,
  port: PORT,
  cert: clientCert,
  key: clientKey,
  ca: caCert,
  rejectUnauthorized: false,
});
let rx: Buffer = Buffer.alloc(0);
let msgId = 1;

sock.on("secureConnect", async () => {
  console.log(`${ts()} connected ${HOST}:${PORT} [${sock.getCipher()?.name ?? "?"}]`);
  for (const j of jobs) {
    const body = Buffer.from(j.hex, "hex");
    const frame = buildCommandFrame(j.op, body, {
      systemId: SYSTEM,
      senderId: SENDER,
      receiverId: RECEIVER,
      messageId: msgId++,
      wantAck: !NOACK,
    });
    console.log(
      `${ts()} TX op=${j.op} len=${body.length}${j.note ? ` [${j.note}]` : ""} body=${j.hex}`,
    );
    sock.write(frame);
    await new Promise((r) => setTimeout(r, GAP));
  }
});

sock.on("data", (chunk: Buffer) => {
  rx = Buffer.concat([rx, chunk]);
  const { frames, remainder } = parseAllFrames(rx);
  rx = remainder;
  for (const f of frames) console.log(fmt(f));
});
sock.on("error", (e) => {
  console.error(`${ts()} socket error: ${e.message}`);
  process.exit(1);
});
sock.on("close", () => console.log(`${ts()} (closed by peer)`));

setTimeout(
  () => {
    console.log(`${ts()} --- done ---`);
    sock.end();
    process.exit(0);
  },
  jobs.length * GAP + listenSec * 1000,
);
