#!/usr/bin/env npx tsx
/**
 * Stage a firmware image into the Nucleo's OTA slot over Ethernet (GLAB-106).
 *
 * This stages and verifies the image. To actually run it, trigger the install
 * (shell: `ota install`), which reboots into the bootloader — it copies the
 * staged image over the application and jumps.
 *
 * Usage:
 *   npx tsx tools/nucleo/fw-ota.ts firmware/build/nucleo-firmware.bin [--host 10.1.10.114]
 *   npx tsx tools/nucleo/fw-ota.ts --info
 */

import { createSocket, type Socket } from "dgram";
import { readFileSync } from "fs";
import { defaultHost } from "../../lib/config";

const UDP_PORT = 9433;

const CMD_FW_OTA_START = 0x1b;
const CMD_FW_OTA_CHUNK = 0x1c;
const CMD_FW_OTA_END = 0x1d;
const CMD_FW_OTA_INFO = 0x1e;
const RESP_FW_OTA = 0xfc;

/** Payload cap is the [LEN:1] byte: 255 total, 4 of which are the offset. */
const CHUNK_BYTES = 240;

const OTA_STATUS: Record<number, string> = {
  0: "ok",
  [-1 & 0xff]: "bad argument",
  [-2 & 0xff]: "image too large for slot",
  [-3 & 0xff]: "no session active",
  [-4 & 0xff]: "out of order",
  [-5 & 0xff]: "write past declared length",
  [-6 & 0xff]: "flash error",
  [-7 & 0xff]: "crc mismatch",
  [-8 & 0xff]: "incomplete image",
};

interface OtaReply {
  status: number;
  statusText: string;
  written: number;
  capacity: number;
  stagedValid: boolean;
  stagedLen: number;
  stagedVersion: number;
}

function parseReply(msg: Buffer): OtaReply | null {
  if (msg[0] !== RESP_FW_OTA || msg.length < 20) return null;
  const raw = msg.readInt8(2);
  return {
    status: raw,
    statusText: OTA_STATUS[raw & 0xff] ?? `unknown(${raw})`,
    written: msg.readUInt32LE(3),
    capacity: msg.readUInt32LE(7),
    stagedValid: msg[11] === 1,
    stagedLen: msg.readUInt32LE(12),
    stagedVersion: msg.readUInt32LE(16),
  };
}

/** CRC-32 (IEEE 802.3) — must match firmware/src/storage/crc32.c. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}

class OtaClient {
  private sock: Socket;
  private pending: ((r: OtaReply) => void) | null = null;

  constructor(private host: string) {
    this.sock = createSocket("udp4");
    this.sock.on("message", (msg) => {
      const r = parseReply(msg);
      // Ignore the packet stream the Nucleo mirrors to every registered client.
      if (!r || !this.pending) return;
      const cb = this.pending;
      this.pending = null;
      cb(r);
    });
  }

  bind(): Promise<void> {
    return new Promise((res) => this.sock.bind(() => res()));
  }

  close(): void {
    this.sock.close();
  }

  /** Send a command and await its ack, retrying on timeout (UDP has none). */
  private request(
    cmd: number,
    payload: Buffer,
    timeoutMs = 2000,
    retries = 4,
  ): Promise<OtaReply> {
    const frame = Buffer.concat([Buffer.from([cmd, payload.length]), payload]);
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const attempt = () => {
        attempts++;
        this.pending = (r) => {
          clearTimeout(timer);
          resolve(r);
        };
        this.sock.send(frame, UDP_PORT, this.host);
        const timer = setTimeout(() => {
          this.pending = null;
          if (attempts > retries) {
            reject(
              new Error(
                `no reply to cmd 0x${cmd.toString(16)} after ${attempts} attempts`,
              ),
            );
          } else {
            attempt();
          }
        }, timeoutMs);
      };
      attempt();
    });
  }

  info(): Promise<OtaReply> {
    return this.request(CMD_FW_OTA_INFO, Buffer.alloc(0));
  }

  start(len: number, crc: number, version: number): Promise<OtaReply> {
    const p = Buffer.alloc(12);
    p.writeUInt32LE(len, 0);
    p.writeUInt32LE(crc, 4);
    p.writeUInt32LE(version, 8);
    // The erase blocks the firmware for a second or two; wait longer for this one.
    return this.request(CMD_FW_OTA_START, p, 15000, 1);
  }

  chunk(offset: number, data: Buffer): Promise<OtaReply> {
    const p = Buffer.alloc(4 + data.length);
    p.writeUInt32LE(offset, 0);
    data.copy(p, 4);
    return this.request(CMD_FW_OTA_CHUNK, p);
  }

  end(): Promise<OtaReply> {
    return this.request(CMD_FW_OTA_END, Buffer.alloc(0), 10000, 1);
  }
}

function describe(r: OtaReply): string {
  const staged = r.stagedValid
    ? `${r.stagedLen} bytes, version ${r.stagedVersion}`
    : "none";
  return `capacity=${r.capacity} written=${r.written} staged=${staged}`;
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n: string) => {
    const i = args.indexOf(n);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const host = getArg("--host") ?? process.env.NUCLEO_HOST ?? defaultHost;
  const client = new OtaClient(host);
  await client.bind();

  if (args.includes("--info")) {
    const r = await client.info();
    console.log(`OTA slot @ ${host}: ${describe(r)}`);
    client.close();
    return;
  }

  const file = args.find((a) => !a.startsWith("--") && a !== host);
  if (!file) {
    console.error("usage: fw-ota.ts <image.bin> [--host IP] | --info");
    process.exit(1);
  }

  const image = readFileSync(file);
  const crc = crc32(image);
  const version = Math.floor(Date.now() / 1000) >>> 0;

  console.log(`Image:   ${file}`);
  console.log(`Size:    ${image.length} bytes`);
  console.log(`CRC-32:  0x${crc.toString(16).padStart(8, "0")}`);
  console.log(`Host:    ${host}`);

  const started = await client.start(image.length, crc, version);
  if (started.status !== 0) {
    console.error(
      `START rejected: ${started.statusText} (${describe(started)})`,
    );
    process.exit(1);
  }
  console.log(`Slot erased (capacity ${started.capacity} bytes), uploading...`);

  let offset = 0;
  let resyncs = 0;
  const t0 = Date.now();
  while (offset < image.length) {
    const slice = image.subarray(
      offset,
      Math.min(offset + CHUNK_BYTES, image.length),
    );
    const r = await client.chunk(offset, slice);

    if (r.status === 0) {
      offset += slice.length;
    } else if (r.status === -4) {
      // Device and host disagree on position — a datagram was lost in one
      // direction. The device's high-water mark is authoritative; resume there.
      resyncs++;
      offset = r.written;
    } else {
      console.error(`\nCHUNK at ${offset} failed: ${r.statusText}`);
      process.exit(1);
    }

    if (offset % (CHUNK_BYTES * 100) < CHUNK_BYTES || offset === image.length) {
      const pct = ((offset / image.length) * 100).toFixed(1);
      process.stdout.write(
        `\r  ${pct}%  ${offset}/${image.length}  resyncs=${resyncs}   `,
      );
    }
  }
  const secs = (Date.now() - t0) / 1000;
  process.stdout.write("\n");

  const done = await client.end();
  if (done.status !== 0) {
    console.error(`END failed: ${done.statusText}`);
    process.exit(1);
  }

  console.log(
    `Staged and verified in ${secs.toFixed(1)}s ` +
      `(${(image.length / 1024 / secs).toFixed(0)} KB/s, ${resyncs} resyncs)`,
  );
  console.log(`Slot now holds: ${describe(done)}`);
  console.log("Run it with: nucleo> ota install   (reboots and installs)");
  client.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
