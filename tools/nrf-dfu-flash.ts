#!/usr/bin/env bun

/**
 * nRF52840 DFU Flasher — upload firmware via STM32 stream protocol.
 *
 * The nRF52840 dongle is connected to the STM32 via UART (Spinel).
 * When the nRF is in MCUboot bootloader mode, this tool sends the
 * firmware binary through the STM32's stream protocol:
 *
 *   1. STREAM_CMD_NRF_DFU_START (0x03) with image size
 *   2. STREAM_CMD_NRF_DFU_DATA (0x04) in 200-byte chunks
 *
 * The STM32 handles baud switching (460800 → 115200), SMP framing,
 * and bootloader communication internally.
 *
 * Usage:
 *   bun run tools/nrf-dfu-flash.ts /tmp/ot-ncp-ftd.bin
 *   bun run tools/nrf-dfu-flash.ts /tmp/ot-ncp-ftd.bin --host $NUCLEO_HOST
 */

import { createSocket } from "dgram";
import { readFileSync } from "fs";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_NRF_DFU_START = 0x03;
const STREAM_CMD_NRF_DFU_DATA = 0x04;
const STREAM_HEARTBEAT = 0xff;
const DEFAULT_PORT = 9433;
const CHUNK_SIZE = 200; // Stay under 255 limit with margin

const firmwarePath = args.find((a) => !a.startsWith("--"));

import { NUCLEO_HOST as DEFAULT_NUCLEO_HOST } from "../lib/env";

const host = getArg("--host") ?? process.env.NUCLEO_HOST ?? DEFAULT_NUCLEO_HOST;
const port = parseInt(getArg("--port") ?? String(DEFAULT_PORT), 10);
const chunkDelay = parseInt(getArg("--delay") ?? "250", 10);

if (!firmwarePath) {
  console.log(`
nRF52840 DFU Flasher — upload firmware via STM32 stream protocol

Usage:
  bun run tools/nrf-dfu-flash.ts <firmware.bin> [options]

Options:
  --host <ip>      STM32 IP address (default: NUCLEO_HOST from .env)
  --port <n>       Stream UDP port (default: 9433)
  --delay <ms>     Delay between chunks in ms (default: 250)

Example:
  bun run tools/nrf-dfu-flash.ts /tmp/ot-ncp-ftd.bin --host $NUCLEO_HOST
`);
  process.exit(1);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const firmware = readFileSync(firmwarePath!);
  const imageSize = firmware.length;
  const totalChunks = Math.ceil(imageSize / CHUNK_SIZE);

  console.log(`nRF52840 DFU Flash`);
  console.log(`==================`);
  console.log(`Firmware: ${firmwarePath} (${imageSize} bytes)`);
  console.log(`Target:   ${host}:${port}`);
  console.log(
    `Chunks:   ${totalChunks} × ${CHUNK_SIZE} bytes (${chunkDelay}ms interval)`,
  );
  console.log(`ETA:      ~${Math.ceil((totalChunks * chunkDelay) / 1000)}s`);
  console.log();

  const sock = createSocket("udp4");

  const sendFrame = (frame: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      sock.send(frame, port, host, (err) => (err ? reject(err) : resolve()));
    });

  // Keep-alive timer to stay registered as a client
  const keepalive = buildStreamCommand(STREAM_CMD_KEEPALIVE, Buffer.alloc(0));
  const keepaliveTimer = setInterval(() => {
    sendFrame(keepalive).catch(() => {});
  }, 2000);

  // Listen for heartbeats and text responses from STM32
  let _lastHeartbeat = 0;
  const STREAM_RESP_TEXT = 0xfd;
  sock.on("message", (msg) => {
    if (msg.length >= 2 && msg[0] === STREAM_HEARTBEAT) {
      _lastHeartbeat = Date.now();
    } else if (msg.length >= 1 && msg[0] === STREAM_RESP_TEXT) {
      // STM32 shell output (DFU progress goes here via text passthrough)
      const text = msg.subarray(1).toString("utf8").trim();
      if (text) console.log(`  [stm32] ${text}`);
    }
  });

  try {
    // Step 0: Register as client
    console.log("Registering as stream client...");
    await sendFrame(keepalive);
    await sleep(500);

    // Step 1: Send DFU_START with image size (4 bytes LE)
    const sizeLE = Buffer.alloc(4);
    sizeLE.writeUInt32LE(imageSize, 0);
    const startCmd = buildStreamCommand(STREAM_CMD_NRF_DFU_START, sizeLE);
    console.log(`Sending DFU_START (image_size=${imageSize})...`);
    await sendFrame(startCmd);

    // Wait for STM32 to enter bootloader mode:
    //   - 2s Spinel reset wait
    //   - 1s baud switch to 115200
    //   - ~1-2s SMP probe + response
    console.log(
      "Waiting for STM32 to enter bootloader mode (baud switch + SMP probe)...",
    );
    await sleep(6000);

    // Step 2: Send firmware in chunks
    console.log("Uploading firmware...");
    let offset = 0;
    let chunkNum = 0;

    while (offset < imageSize) {
      const end = Math.min(offset + CHUNK_SIZE, imageSize);
      const chunk = firmware.subarray(offset, end);
      const dataCmd = buildStreamCommand(STREAM_CMD_NRF_DFU_DATA, chunk);

      await sendFrame(dataCmd);
      offset = end;
      chunkNum++;

      const pct = ((offset / imageSize) * 100).toFixed(1);
      const bar = "=".repeat(Math.floor((offset / imageSize) * 40)).padEnd(40);
      process.stdout.write(`\r  [${bar}] ${pct}% (${offset}/${imageSize})`);

      await sleep(chunkDelay);
    }

    console.log();
    console.log(`Upload complete: ${imageSize} bytes in ${chunkNum} chunks`);
    console.log("Waiting for MCUboot validation and reboot...");
    await sleep(5000);

    console.log("Done. The nRF should now boot into NCP firmware.");
    console.log(
      "Verify with: connect to the STM32 CLI and run 'spinel get ncp-version'",
    );
  } catch (err) {
    console.error(`\nDFU error: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    clearInterval(keepaliveTimer);
    sock.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
