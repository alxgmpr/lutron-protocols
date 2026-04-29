#!/usr/bin/env npx tsx

/**
 * IPL command sender — sends LEI@ commands to lutron-core via TLS:8902
 *
 * Usage:
 *   npx tsx tools/ipl-send.ts RequestIPLProtocolVersion
 *   npx tsx tools/ipl-send.ts RequestSchemaVersion
 *   npx tsx tools/ipl-send.ts RequestDatabaseSyncInfo
 *   npx tsx tools/ipl-send.ts RequestTelnetDiagnosticUser
 *   npx tsx tools/ipl-send.ts RequestObjectTweaks '{"ObjectId":1,"Property":"TimeZone","Value":"America/Denver"}'
 *   npx tsx tools/ipl-send.ts --raw '#OUTPUT,73,1,50\r\n'
 *   npx tsx tools/ipl-send.ts --list   # try all known commands
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { connect } from "tls";
import { fileURLToPath } from "url";
import { deflateSync, inflateSync } from "zlib";
import { defaultHost } from "../../lib/config";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const HOST = getArg("--host") ?? defaultHost;
const PORT = Number.parseInt(getArg("--port") ?? "8902", 10);
const CERT_DIR = join(__dir, "..", "certs", "designer");
const LIST_MODE = args.includes("--list");

const command = args.find(
  (a) => !a.startsWith("-") && a !== HOST && a !== String(PORT),
);
const jsonArg = args[args.indexOf(command!) + 1];

let seq = 0;

function buildLEIAt(cmdName: string, jsonPayload?: any): Buffer {
  seq++;
  // Header: LEI@ + version(00 01) + flags(00 FF) + seq(u16) + subtype(01 5D)
  const header = Buffer.alloc(12);
  header.write("LEI@", 0);
  header.writeUInt16BE(0x0001, 4); // version
  header.writeUInt16BE(0x00ff, 6); // flags
  header.writeUInt16BE(seq, 8); // sequence
  header.writeUInt16BE(0x015d, 10); // subtype for commands

  // Body: 00 3B <cmdName> <null padding to 6-byte alignment> <zlib JSON>
  const nameBytes = Buffer.from(cmdName, "ascii");
  const padLen = (6 - ((2 + nameBytes.length) % 6)) % 6;
  const prefix = Buffer.alloc(2 + nameBytes.length + padLen);
  prefix[0] = 0x00;
  prefix[1] = 0x3b;
  nameBytes.copy(prefix, 2);
  // Rest is null padding (already zeroed)

  let body: Buffer;
  if (jsonPayload !== undefined) {
    const jsonStr =
      typeof jsonPayload === "string"
        ? jsonPayload
        : JSON.stringify(jsonPayload);
    const compressed = deflateSync(Buffer.from(jsonStr, "utf-8"));
    body = Buffer.concat([prefix, compressed]);
  } else {
    body = prefix;
  }

  return Buffer.concat([header, body]);
}

function buildRawText(text: string): Buffer {
  seq++;
  const header = Buffer.alloc(12);
  header.write("LEI@", 0);
  header.writeUInt16BE(0x0001, 4);
  header.writeUInt16BE(0x00ff, 6);
  header.writeUInt16BE(seq, 8);
  header.writeUInt16BE(0x015d, 10);

  const body = Buffer.from(
    text.replace(/\\r/g, "\r").replace(/\\n/g, "\n"),
    "ascii",
  );
  return Buffer.concat([header, body]);
}

function parseResponse(buf: Buffer): void {
  let pos = 0;
  while (pos < buf.length - 4) {
    const leiIdx = buf.indexOf("LEI", pos);
    if (leiIdx === -1) break;

    const typeChar = String.fromCharCode(buf[leiIdx + 3]);
    if (leiIdx + 12 > buf.length) break;

    const marker = `LEI${typeChar}`;
    const rSeq = buf.readUInt16BE(leiIdx + 8);
    const subtype = buf.readUInt16BE(leiIdx + 10);

    // Find next LEI
    let nextLei = buf.length;
    for (let s = leiIdx + 12; s < buf.length - 3; s++) {
      if (buf[s] === 0x4c && buf[s + 1] === 0x45 && buf[s + 2] === 0x49) {
        const nt = buf[s + 3];
        if (nt >= 0x40 && nt <= 0x5a) {
          nextLei = s;
          break;
        }
      }
    }

    const body = buf.subarray(leiIdx + 12, nextLei);

    // Try to find command name
    if (
      typeChar === "@" &&
      body.length > 2 &&
      body[0] === 0x00 &&
      body[1] === 0x3b
    ) {
      const nameEnd = body.indexOf(0x00, 2);
      if (nameEnd > 2) {
        const cmdName = body.subarray(2, nameEnd).toString("ascii");
        // Try decompress
        for (let i = nameEnd; i < body.length - 2; i++) {
          if (
            body[i] === 0x78 &&
            (body[i + 1] === 0xda || body[i + 1] === 0x9c)
          ) {
            try {
              const dec = inflateSync(body.subarray(i)).toString("utf-8");
              console.log(`  ${marker} #${rSeq} ${cmdName}: ${dec}`);
            } catch {
              console.log(
                `  ${marker} #${rSeq} ${cmdName}: (zlib decode failed) ${body.subarray(i).toString("hex").slice(0, 60)}`,
              );
            }
            break;
          }
        }
        if (
          nameEnd === body.length - 1 ||
          body.subarray(nameEnd).every((b) => b === 0)
        ) {
          console.log(`  ${marker} #${rSeq} ${cmdName} (no payload)`);
        }
      }
    } else if (typeChar === "E") {
      if (body.length <= 2) {
        // heartbeat
      } else if (body.length >= 8) {
        const payloadLen = body.readUInt16BE(0);
        const objId = body.readUInt16BE(4);
        const prop = body.readUInt16BE(6);
        console.log(
          `  ${marker} #${rSeq} obj=${objId} prop=0x${prop.toString(16)} len=${payloadLen} ${body.toString("hex").slice(0, 40)}`,
        );
      }
    } else if (typeChar === "C") {
      // keepalive, skip
    } else {
      console.log(
        `  ${marker} #${rSeq} sub=0x${subtype.toString(16)} body(${body.length}b): ${body.toString("hex").slice(0, 60)}`,
      );
    }

    pos = nextLei;
  }
}

const KNOWN_COMMANDS = [
  "RequestIPLProtocolVersion",
  "RequestSchemaVersion",
  "RequestDatabaseSyncInfo",
  "RequestDatabaseSync",
  "RequestTelnetDiagnosticUser",
  "RequestObjectTweaks",
  "RequestTweakChanges",
  "RequestResendOne",
  "RequestDeviceNotInDatabase",
  "RequestDeviceTransferStatus",
  "DeviceSetOutputLevel",
  "EndTweakedDataExtraction",
];

async function main() {
  const clientCert = readFileSync(join(CERT_DIR, "ipl_client_cert.pem"));
  const clientKey = readFileSync(join(CERT_DIR, "ipl_client_key.pem"));
  const caCert = readFileSync(join(CERT_DIR, "radioRa3_products.crt"));

  console.log(`Connecting to ${HOST}:${PORT}...`);

  const socket = connect(
    {
      host: HOST,
      port: PORT,
      cert: clientCert,
      key: clientKey,
      ca: caCert,
      rejectUnauthorized: false,
    },
    async () => {
      console.log(`Connected! Cipher: ${socket.getCipher()?.name}\n`);

      // Collect responses for a period
      let responseBuf = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        responseBuf = Buffer.concat([responseBuf, chunk]);
      });

      // Wait a moment to receive init messages
      await sleep(1000);
      console.log(`Received ${responseBuf.length} bytes of init data\n`);
      responseBuf = Buffer.alloc(0);

      if (LIST_MODE) {
        console.log("=== Trying all known commands ===\n");
        for (const cmd of KNOWN_COMMANDS) {
          console.log(`--- Sending: ${cmd} ---`);
          const msg = buildLEIAt(cmd);
          socket.write(msg);
          await sleep(1500);
          if (responseBuf.length > 0) {
            console.log(`  Response (${responseBuf.length} bytes):`);
            parseResponse(responseBuf);
            responseBuf = Buffer.alloc(0);
          } else {
            console.log("  (no response)");
          }
          console.log();
        }
      } else if (command) {
        if (args.includes("--raw")) {
          console.log(`Sending raw text: ${command}`);
          const msg = buildRawText(command);
          socket.write(msg);
        } else {
          let payload: any;
          if (jsonArg) {
            try {
              payload = JSON.parse(jsonArg);
            } catch {
              payload = jsonArg;
            }
          }
          console.log(
            `Sending: ${command}${payload ? " " + JSON.stringify(payload) : ""}`,
          );
          const msg = buildLEIAt(command, payload);
          console.log(`  Packet: ${msg.toString("hex")}`);
          socket.write(msg);
        }

        // Wait for responses
        await sleep(3000);
        if (responseBuf.length > 0) {
          console.log(`\nResponse (${responseBuf.length} bytes):`);
          parseResponse(responseBuf);
        } else {
          console.log("\n(no response beyond normal traffic)");
        }
      }

      socket.destroy();
      process.exit(0);
    },
  );

  socket.on("error", (err) => {
    console.error(`TLS error: ${err.message}`);
    process.exit(1);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main();
