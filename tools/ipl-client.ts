#!/usr/bin/env bun

/**
 * IPL (Integration Protocol Lutron) client for RA3 processors.
 *
 * Connects to the Designer/IPL TLS server on port 8902 using
 * project-specific certs extracted from Lutron Designer.
 *
 * Protocol: Binary framing with "LEI" + type byte markers,
 * zlib-compressed JSON payloads for LEI@ commands,
 * binary status reports for LEIE messages.
 *
 * Usage:
 *   bun run tools/ipl-client.ts                    # Connect and dump traffic
 *   bun run tools/ipl-client.ts --host $RA3_HOST  # Specify host
 *   bun run tools/ipl-client.ts --save             # Save raw capture to file
 *   bun run tools/ipl-client.ts --quiet            # Only show non-heartbeat messages
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { connect, type TLSSocket } from "tls";
import { inflateSync } from "zlib";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

import { RA3_HOST } from "../lib/env";

const HOST = getArg("--host") ?? RA3_HOST;
const PORT = Number.parseInt(getArg("--port") ?? "8902", 10);
const SAVE = hasFlag("--save");
const QUIET = hasFlag("--quiet");
const CERT_DIR = join(import.meta.dir, "..", "certs", "designer");

// Load certs
const clientCert = readFileSync(join(CERT_DIR, "ipl_client_cert.pem"));
const clientKey = readFileSync(join(CERT_DIR, "ipl_client_key.pem"));
const caCert = readFileSync(join(CERT_DIR, "radioRa3_products.crt"));

// --- IPL Protocol ---

// Property types observed in LEIE messages
const PROP_NAMES: Record<number, string> = {
  0x000f: "level(dimmer)",
  0x0003: "level(switch)",
  0x0005: "button",
  0x025b: "occupancy",
  0x0243: "state",
  0x006b: "led",
  0x0225: "config40",
  0x0202: "config47",
};

interface IPLMessage {
  marker: string; // "LEI@", "LEIC", "LEIE", etc.
  typeChar: string;
  seq: number;
  subtype: number;
  command?: string;
  json?: any;
  body: Buffer;
}

/**
 * Parse IPL messages from a buffer.
 * Messages are delimited by "LEI" + type byte (0x40-0x5A).
 * Header: LEI<type> + 00 01 00 FF + <seq:u16> + <subtype:u16>
 * Body follows the 12-byte header until the next LEI marker.
 */
function parseMessages(buf: Buffer): {
  messages: IPLMessage[];
  remainder: Buffer;
} {
  const messages: IPLMessage[] = [];
  let pos = 0;

  while (pos < buf.length - 4) {
    const leiIdx = buf.indexOf("LEI", pos);
    if (leiIdx === -1 || leiIdx + 12 > buf.length) break;

    const typeChar = String.fromCharCode(buf[leiIdx + 3]);
    if (typeChar < "@" || typeChar > "Z") {
      pos = leiIdx + 1;
      continue;
    }

    const marker = `LEI${typeChar}`;
    const seq = buf.readUInt16BE(leiIdx + 8);
    const subtype = buf.readUInt16BE(leiIdx + 10);

    // Find next LEI marker for message boundary
    let nextLei = -1;
    for (let s = leiIdx + 12; s < buf.length - 3; s++) {
      if (buf[s] === 0x4c && buf[s + 1] === 0x45 && buf[s + 2] === 0x49) {
        const nt = buf[s + 3];
        if (nt >= 0x40 && nt <= 0x5a) {
          nextLei = s;
          break;
        }
      }
    }

    if (nextLei === -1) {
      // Might be last complete message or incomplete data
      // If we have a reasonable amount of data, treat as complete
      if (buf.length - leiIdx > 12) {
        nextLei = buf.length;
      } else {
        break; // keep as remainder
      }
    }

    const body = buf.subarray(leiIdx + 12, nextLei);
    const msg: IPLMessage = { marker, typeChar, seq, subtype, body };

    // LEI@ with command name: body starts with 00 3B <name> <nulls> <zlib>
    if (
      typeChar === "@" &&
      body.length > 2 &&
      body[0] === 0x00 &&
      body[1] === 0x3b
    ) {
      const nameEnd = body.indexOf(0x00, 2);
      if (nameEnd > 2) {
        msg.command = body.subarray(2, nameEnd).toString("ascii");
      }
      // Find and decompress zlib payload
      for (let i = nameEnd; i < body.length - 2; i++) {
        if (
          body[i] === 0x78 &&
          (body[i + 1] === 0xda || body[i + 1] === 0x9c)
        ) {
          try {
            const dec = inflateSync(body.subarray(i));
            const text = dec.toString("utf-8");
            try {
              msg.json = JSON.parse(text);
            } catch {
              msg.json = text;
            }
          } catch {
            /* not zlib */
          }
          break;
        }
      }
    }

    // LEI@ init message: body starts with 00 31
    if (
      typeChar === "@" &&
      body.length > 2 &&
      body[0] === 0x00 &&
      body[1] === 0x31
    ) {
      msg.command = "(init)";
    }

    // LEIE status: body = <len:u16> 00 00 <obj_id:u16> <prop:u16> [value]
    if (typeChar === "E" && body.length >= 8) {
      const payloadLen = body.readUInt16BE(0);
      if (payloadLen > 1 && body.length >= 8) {
        const objId = body.readUInt16BE(4);
        const prop = body.readUInt16BE(6);
        const propName =
          PROP_NAMES[prop] ?? `0x${prop.toString(16).padStart(4, "0")}`;
        const valueBytes = body.subarray(8);

        if (payloadLen <= 9 && valueBytes.length >= 2) {
          // Short value: decode level16
          const lastTwo =
            valueBytes.length >= 2
              ? valueBytes.readUInt16BE(valueBytes.length - 2)
              : 0;
          const pct = lastTwo <= 0xfeff ? (lastTwo * 100) / 0xfeff : -1;
          const pctStr =
            pct >= 0 ? `${pct.toFixed(0)}%` : valueBytes.toString("hex");
          msg.json = {
            objId,
            prop: propName,
            value: pctStr,
            raw: valueBytes.toString("hex"),
          };
        } else if (payloadLen > 9) {
          msg.json = {
            objId,
            prop: propName,
            data: body.subarray(6).toString("hex"),
          };
        }
      } else if (payloadLen <= 1) {
        // Heartbeat (body = 00)
        msg.command = "(heartbeat)";
      }
    }

    // LEIC keepalive: body = 00 06 00 00 <obj_id:u16> 00 39
    if (typeChar === "C" && body.length >= 8) {
      const objId = body.readUInt16BE(4);
      msg.json = { keepalive: objId };
    }

    messages.push(msg);
    pos = nextLei === buf.length ? nextLei : nextLei;
  }

  const remainder = pos < buf.length ? buf.subarray(pos) : Buffer.alloc(0);
  return { messages, remainder };
}

// --- Pretty printer ---

function formatMessage(msg: IPLMessage): string {
  const seqStr = `#${msg.seq.toString().padStart(3)}`;
  const markerColor =
    msg.typeChar === "@"
      ? "\x1b[33m"
      : msg.typeChar === "E"
        ? "\x1b[36m"
        : "\x1b[35m";

  if (msg.command === "(heartbeat)") {
    return QUIET
      ? ""
      : `  ${markerColor}${msg.marker}\x1b[0m ${seqStr} heartbeat`;
  }

  const parts: string[] = [];

  if (msg.command) {
    parts.push(
      `${markerColor}${msg.marker}\x1b[0m ${seqStr} \x1b[1m${msg.command}\x1b[0m`,
    );
  } else {
    parts.push(`${markerColor}${msg.marker}\x1b[0m ${seqStr}`);
  }

  if (msg.json) {
    parts.push(`  ${JSON.stringify(msg.json)}`);
  } else if (msg.body.length > 0) {
    parts.push(
      `  body: ${msg.body.toString("hex").slice(0, 80)}${msg.body.length > 40 ? "..." : ""}`,
    );
  }

  return parts.join("\n");
}

// --- Main ---

const allMessages: IPLMessage[] = [];
const rawChunks: Buffer[] = [];
const lastObjStates = new Map<string, string>(); // track state changes

console.log(`Connecting to ${HOST}:${PORT}...`);

const socket: TLSSocket = connect(
  {
    host: HOST,
    port: PORT,
    cert: clientCert,
    key: clientKey,
    ca: caCert,
    rejectUnauthorized: false, // processor uses its own CA chain
  },
  () => {
    console.log(`Connected! Cipher: ${socket.getCipher()?.name}\n`);
    console.log("Listening for IPL messages... (Ctrl+C to stop)\n");
  },
);

let remainder = Buffer.alloc(0);

socket.on("data", (chunk: Buffer) => {
  if (SAVE) rawChunks.push(Buffer.from(chunk));

  const combined = Buffer.concat([remainder, chunk]);
  const { messages, remainder: rem } = parseMessages(combined);
  remainder = rem;

  for (const msg of messages) {
    allMessages.push(msg);

    // In quiet mode, only show state changes and commands
    if (QUIET) {
      if (msg.command === "(heartbeat)") continue;
      if (msg.typeChar === "E" && msg.json?.objId) {
        const key = `${msg.json.objId}:${msg.json.prop}`;
        const val = msg.json.value ?? msg.json.data ?? "";
        if (lastObjStates.get(key) === val) continue;
        lastObjStates.set(key, val);
      }
      if (msg.typeChar === "C") continue;
    }

    const formatted = formatMessage(msg);
    if (formatted) console.log(formatted);
  }
});

socket.on("error", (err) => {
  console.error(`\nTLS error: ${err.message}`);
});

socket.on("close", () => {
  console.log("\nConnection closed.");
  if (SAVE) saveDump();
});

process.on("SIGINT", () => {
  console.log(`\n\nReceived ${allMessages.length} messages total.`);
  if (SAVE) saveDump();
  socket.destroy();
  process.exit(0);
});

function saveDump() {
  mkdirSync("data", { recursive: true });
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "");
  const rawFile = `data/ipl-raw-${HOST}-${ts}.bin`;
  const jsonFile = `data/ipl-messages-${HOST}-${ts}.json`;

  if (rawChunks.length > 0) {
    writeFileSync(rawFile, Buffer.concat(rawChunks));
    console.log(`Saved raw data to ${rawFile}`);
  }

  const jsonData = allMessages.map((m) => ({
    marker: m.marker,
    seq: m.seq,
    subtype: m.subtype,
    command: m.command,
    json: m.json,
    bodyHex: m.body.toString("hex"),
  }));
  writeFileSync(jsonFile, JSON.stringify(jsonData, null, 2) + "\n");
  console.log(`Saved ${allMessages.length} parsed messages to ${jsonFile}`);
}
