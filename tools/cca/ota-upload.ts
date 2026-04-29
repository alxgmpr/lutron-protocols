#!/usr/bin/env npx tsx

/**
 * Upload an LDF body to the Nucleo's OTA session buffer via the stream
 * protocol. After upload completes, run `cca ota-tx <subnet> <serial>` on
 * the Nucleo to start the firmware-side full-OTA transmit.
 *
 * Track 1 of the Phase 2b PowPak conversion plan — see
 * docs/firmware-re/powpak-conversion-attack.md.
 *
 * Usage:
 *   npx tsx tools/cca/ota-upload.ts \
 *     --ldf data/firmware-re/powpak/PowPakRelay434_1-49.bin \
 *     [--host 10.1.1.114] [--dry-run]
 */

import { createSocket, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../../lib/config";
import { stripLdfHeader } from "../../lib/ldf";

const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_OTA_UPLOAD_START = 0x18;
const STREAM_CMD_OTA_UPLOAD_CHUNK = 0x19;
const STREAM_CMD_OTA_UPLOAD_END = 0x1a;
const PORT = 9433;
const CHUNK_BYTES = 240;

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(name);

function sendStream(
  sock: Socket,
  host: string,
  cmd: number,
  data: Uint8Array,
): void {
  const frame = Buffer.alloc(2 + data.length);
  frame[0] = cmd;
  frame[1] = data.length;
  if (data.length > 0) Buffer.from(data).copy(frame, 2);
  sock.send(frame, 0, frame.length, PORT, host);
}

async function main(): Promise<void> {
  const ldfPath = getArg("--ldf");
  const host = getArg("--host") ?? config.openBridge;
  const dryRun = hasFlag("--dry-run");

  if (!ldfPath) {
    console.error(
      "Usage: npx tsx tools/cca/ota-upload.ts --ldf <path> [--host <ip>] [--dry-run]",
    );
    process.exit(1);
  }

  const file = readFileSync(ldfPath);
  const fileBytes = new Uint8Array(
    file.buffer,
    file.byteOffset,
    file.byteLength,
  );
  const body = stripLdfHeader(fileBytes);
  const numChunks = Math.ceil(body.length / CHUNK_BYTES);
  console.log(
    `[ota-upload] body: ${body.length} bytes, ${numChunks} chunks of ${CHUNK_BYTES} bytes each`,
  );
  console.log(
    `[ota-upload] mode=${dryRun ? "dry-run (no UDP)" : `live (host=${host})`}`,
  );

  if (dryRun) {
    console.log(
      `[dry] START expected_len=${body.length} (cmd 0x18, 4-byte LE u32)`,
    );
    for (let i = 0; i < Math.min(3, numChunks); i++) {
      const off = i * CHUNK_BYTES;
      const slice = body.subarray(
        off,
        Math.min(off + CHUNK_BYTES, body.length),
      );
      console.log(
        `[dry] CHUNK idx=${i} off=${off} len=${slice.length} (cmd 0x19)`,
      );
    }
    if (numChunks > 3) console.log(`[dry] ... ${numChunks - 3} more chunks`);
    console.log(`[dry] END (cmd 0x1A)`);
    return;
  }

  const sock = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(0, () => resolve());
  });

  // Register as a stream client.
  sendStream(sock, host, STREAM_CMD_KEEPALIVE, new Uint8Array(0));
  await sleep(100);

  // START
  const startData = new Uint8Array(4);
  new DataView(startData.buffer).setUint32(0, body.length, true);
  sendStream(sock, host, STREAM_CMD_OTA_UPLOAD_START, startData);
  await sleep(50);

  // CHUNKS
  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    const off = chunkIdx * CHUNK_BYTES;
    const slice = body.subarray(off, Math.min(off + CHUNK_BYTES, body.length));
    const data = new Uint8Array(2 + slice.length);
    data[0] = (chunkIdx >> 8) & 0xff;
    data[1] = chunkIdx & 0xff;
    data.set(slice, 2);
    sendStream(sock, host, STREAM_CMD_OTA_UPLOAD_CHUNK, data);
    /* Brief breather every 16 chunks to stay under any UDP RX bursting limits. */
    if ((chunkIdx & 0x0f) === 0x0f) await sleep(5);
  }
  await sleep(100);

  // END
  sendStream(sock, host, STREAM_CMD_OTA_UPLOAD_END, new Uint8Array(0));
  await sleep(200);
  sock.close();
  console.log(
    `[ota-upload] uploaded ${body.length} bytes in ${numChunks} chunks`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
