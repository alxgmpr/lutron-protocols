#!/usr/bin/env npx tsx

/**
 * IPL write-path tester using the *operationId-based* Command framing
 * reversed from Designer 26.0.2.100 DLLs (see docs/protocols/ipl.md §2–§4).
 *
 * Unlike tools/ipl-send.ts (which uses the speculative zlib-JSON named-RPC
 * wrapper), this tool builds a proper Version3 LEI Command frame with a
 * big-endian binary body.
 *
 * Commands implemented:
 *   ping                            -> opId 11, empty body
 *   gotolevel <zoneId> <pct> [fade] [delay]
 *                                   -> opId 13 (OUTPUT path, fade/delay in sec)
 *   setoutput <proc> <link> <serialHex> <comp> <pct>
 *                                   -> opId 44 (DEVICE path, no fade)
 *   raw <opId> <bodyHex>            -> escape hatch for arbitrary opId
 *
 * Usage:
 *   npx tsx tools/ipl-cmd.ts ping
 *   npx tsx tools/ipl-cmd.ts gotolevel 546 50 1 0
 *   npx tsx tools/ipl-cmd.ts --host 10.1.1.133 gotolevel 546 0
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { connect } from "tls";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const HOST = getArg("--host") ?? "10.1.1.133";
const PORT = Number.parseInt(getArg("--port") ?? "8902", 10);
const LISTEN_SECONDS = Number.parseFloat(getArg("--listen") ?? "4");
const SYSTEM_ID = Number.parseInt(getArg("--system") ?? "1", 10);
const SENDER_ID = Number.parseInt(getArg("--sender") ?? "1", 10);
const RECEIVER_ID = Number.parseInt(getArg("--receiver") ?? "255", 10);
const NO_ACK = args.includes("--no-ack");

const CERT_DIR = join(__dir, "..", "certs", "designer");
const clientCert = readFileSync(join(CERT_DIR, "ipl_client_cert.pem"));
const clientKey = readFileSync(join(CERT_DIR, "ipl_client_key.pem"));
const caCert = readFileSync(join(CERT_DIR, "radioRa3_products.crt"));

// --- Frame builder (Version3) ---

const MAGIC = Buffer.from("LEI", "ascii");

enum MsgType {
  Command = 0,
  Acknowledgement = 1,
  Response = 2,
  Event = 3,
  Control = 4,
  Telemetry = 5,
}

const MT_NAMES = ["Cmd", "Ack", "Rsp", "Evt", "Ctrl", "Tlm"];

// Byte 3: [Version:3][RP:1][Attempt:1][MsgType:3]
//   Version3 = 0x40 in top 3 bits
//   ReceiverProcessing.Normal = 0x10 (expect acks); NoAck = 0x00
//   Attempt.Original = 0; Resend = 0x08
function packHeaderByte(msgType: MsgType, opts: { normal: boolean }): number {
  const version = 0x40;
  const rp = opts.normal ? 0x10 : 0x00;
  return version | rp | msgType;
}

function buildCommandFrame(
  operationId: number,
  body: Buffer,
  messageId = 0,
): Buffer {
  // Header: magic(3) + packed(1) + systemId(2 BE) + sender(1) + receiver(1) + messageId(2 BE) + operationId(2 BE)
  const header = Buffer.alloc(12);
  MAGIC.copy(header, 0);
  header[3] = packHeaderByte(MsgType.Command, { normal: !NO_ACK });
  header.writeUInt16BE(SYSTEM_ID, 4);
  header[6] = SENDER_ID;
  header[7] = RECEIVER_ID;
  header.writeUInt16BE(messageId, 8);
  header.writeUInt16BE(operationId, 10);
  // Payload length prefix (uint16 BE), per MessageFactorylet.ReadPayload
  const lenPrefix = Buffer.alloc(2);
  lenPrefix.writeUInt16BE(body.length, 0);
  return Buffer.concat([header, lenPrefix, body]);
}

// --- Body encoders (all big-endian) ---

function bodyPing(): Buffer {
  return Buffer.alloc(0);
}

// ObjectType.Zone = 15 per Lutron.Gulliver.Infrastructure.DomainObjectFramework.ObjectType
const OBJECT_TYPE_ZONE = 15;

// level16 = percent * 0xFEFF / 100; MAX_LEVEL const from GoToLevelCommand
function pctToLevel16(pct: number): number {
  const v = Math.round((pct * 0xfeff) / 100);
  return Math.max(0, Math.min(0xfeff, v));
}

function bodyGoToLevel(
  objectId: number,
  objectType: number,
  pct: number,
  fadeSec: number,
  delaySec: number,
): Buffer {
  const body = Buffer.alloc(14);
  body.writeUInt32BE(objectId, 0);
  body.writeUInt16BE(objectType, 4);
  body.writeUInt16BE(pctToLevel16(pct), 6);
  body.writeUInt16BE(9, 8); // OriginatorFeature.GUI = 9 (from RuntimeDomainObjectFramework.OriginatorFeature)
  body.writeUInt16BE(Math.round(fadeSec * 4), 10); // quarter-seconds
  body.writeUInt16BE(Math.round(delaySec * 4), 12); // quarter-seconds
  return body;
}

function bodyDeviceSetOutputLevel(
  procNum: number,
  linkNum: number,
  serial: number,
  component: number,
  pct: number,
): Buffer {
  const body = Buffer.alloc(10);
  body[0] = procNum;
  body[1] = linkNum;
  body.writeUInt32BE(serial, 2);
  body.writeUInt16BE(component, 6);
  body.writeUInt16BE(pctToLevel16(pct), 8);
  return body;
}

// --- Response parser (minimal, prints one line per frame) ---

function parseFrames(buf: Buffer): void {
  let pos = 0;
  while (pos + 12 <= buf.length) {
    const i = buf.indexOf("LEI", pos);
    if (i === -1 || i + 12 > buf.length) break;
    const typeByte = buf[i + 3];
    const mt = typeByte & 0x07;
    const ver = (typeByte & 0xe0) >> 5;
    const rp = typeByte & 0x10 ? "Normal" : "NoAck";
    const sysId = buf.readUInt16BE(i + 4);
    const sender = buf[i + 6];
    const receiver = buf[i + 7];
    const seq = buf.readUInt16BE(i + 8);
    const op = buf.readUInt16BE(i + 10);
    // Payload length prefix (uint16 BE) before body bytes
    const hasPayload = mt !== MsgType.Acknowledgement;
    let body: Buffer = Buffer.alloc(0);
    let end = i + 12;
    if (hasPayload && i + 14 <= buf.length) {
      const payloadLen = buf.readUInt16BE(i + 12);
      const bodyEnd = i + 14 + payloadLen;
      if (bodyEnd <= buf.length) {
        body = Buffer.from(buf.subarray(i + 14, bodyEnd));
        end = bodyEnd;
      } else {
        end = buf.length;
      }
    }
    const mtName = MT_NAMES[mt] ?? `?${mt}`;
    console.log(
      `  LEI${String.fromCharCode(0x40 + mt)} v${ver + 1} ${mtName}/${rp} sys=${sysId} s=${sender}->r=${receiver} seq=${seq} op=${op} body(${body.length}B)=${body.toString("hex").slice(0, 80)}`,
    );
    pos = end;
  }
}

// --- Main ---

async function main() {
  // Strip out known flag-with-value options before picking the command.
  const flagKeys = new Set([
    "--host",
    "--port",
    "--listen",
    "--system",
    "--sender",
    "--receiver",
  ]);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flagKeys.has(a)) {
      i++; // skip value
      continue;
    }
    if (a.startsWith("--")) continue; // boolean flags like --no-ack
    positional.push(a);
  }

  const cmd = positional[0];
  if (!cmd) {
    console.error(
      "commands: ping | gotolevel <zoneId> <pct> [fade] [delay] | setoutput <proc> <link> <serialHex> <comp> <pct> | raw <opId> <bodyHex>",
    );
    process.exit(2);
  }

  let opId: number;
  let body: Buffer;
  const rest = positional.slice(1);

  switch (cmd) {
    case "ping":
      opId = 11;
      body = bodyPing();
      break;
    case "gotolevel": {
      const zoneId = Number.parseInt(rest[0] ?? "", 10);
      const pct = Number.parseFloat(rest[1] ?? "");
      const fade = Number.parseFloat(rest[2] ?? "1");
      const delay = Number.parseFloat(rest[3] ?? "0");
      if (!Number.isFinite(zoneId) || !Number.isFinite(pct)) {
        console.error("usage: gotolevel <zoneId> <pct> [fadeSec] [delaySec]");
        process.exit(2);
      }
      opId = 13;
      body = bodyGoToLevel(zoneId, OBJECT_TYPE_ZONE, pct, fade, delay);
      break;
    }
    case "setoutput": {
      const pnum = Number.parseInt(rest[0] ?? "", 10);
      const lnum = Number.parseInt(rest[1] ?? "", 10);
      const serial = Number.parseInt(rest[2] ?? "", 16);
      const comp = Number.parseInt(rest[3] ?? "", 10);
      const pct = Number.parseFloat(rest[4] ?? "");
      if ([pnum, lnum, serial, comp, pct].some((v) => !Number.isFinite(v))) {
        console.error(
          "usage: setoutput <procNum> <linkNum> <serialHex> <component> <pct>",
        );
        process.exit(2);
      }
      opId = 44;
      body = bodyDeviceSetOutputLevel(pnum, lnum, serial, comp, pct);
      break;
    }
    case "raw": {
      opId = Number.parseInt(rest[0] ?? "", 10);
      body = Buffer.from(rest[1] ?? "", "hex");
      if (!Number.isFinite(opId)) {
        console.error("usage: raw <opId> <bodyHex>");
        process.exit(2);
      }
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }

  const frame = buildCommandFrame(opId, body, 1);
  console.log(
    `TX op=${opId} body=${body.length}B frame=${frame.length}B hex=${frame.toString("hex")}`,
  );
  console.log(
    `   header: LEI ${frame.subarray(3, 4).toString("hex")} sys=${frame.readUInt16BE(4)} s=${frame[6]}->r=${frame[7]} seq=${frame.readUInt16BE(8)} op=${frame.readUInt16BE(10)}`,
  );

  const sock = connect({
    host: HOST,
    port: PORT,
    cert: clientCert,
    key: clientKey,
    ca: caCert,
    rejectUnauthorized: false,
  });

  sock.on("secureConnect", () => {
    console.log(
      `Connected ${HOST}:${PORT} [${sock.getCipher()?.name ?? "?"}]; listening ${LISTEN_SECONDS}s\n`,
    );
    sock.write(frame);
  });

  sock.on("data", (chunk: Buffer) => {
    console.log(`RX ${chunk.length}B:`);
    parseFrames(chunk);
  });

  sock.on("error", (err) => {
    console.error("socket error:", err.message);
    process.exit(1);
  });

  sock.on("close", () => {
    console.log("(socket closed by peer)");
  });

  setTimeout(() => {
    console.log("\n--- done ---");
    sock.end();
    process.exit(0);
  }, LISTEN_SECONDS * 1000);
}

main();
