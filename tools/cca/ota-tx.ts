#!/usr/bin/env npx tsx

/**
 * Host-side PowPak OTA driver — streams an LDF body to a target device via
 * the Nucleo's CC1101, using STREAM_CMD_TX_RAW_CCA UDP datagrams.
 *
 * Mirrors the firmware-side `cca ota-tx` orchestration but in TypeScript,
 * so the packet format is fast to iterate during Phase 2 debugging. See
 * docs/firmware-re/powpak-conversion-attack.md and docs/firmware-re/cca-ota-hcs08.md.
 *
 * Usage:
 *   npx tsx tools/cca/ota-tx.ts \
 *     --ldf <path>.LDF \
 *     --subnet 0x82d7 --serial 009A36E3 \
 *     [--host 10.1.1.114] [--dry-run] [--max-chunks N] [--cadence-ms 75] \
 *     [--mcu efr32|hcs08] [--begin-payload "02 20 00 00 00 1F"] [--begin-only]
 *
 * --dry-run: build + log every packet but never open the UDP socket.
 *            Tested via SDR loopback or unit tests, not against live hardware.
 * --mcu: target MCU family. Default `efr32` (calibrated against captured
 *        Caseta REP2 → DVRF-6L OTA). Use `hcs08` for HW-CCA dimmers
 *        (HQR/HWQS/MRF2 family, DeviceClass 0x04xxxxxx) and PowPak (0x16xxxxxx).
 *        Same on-air protocol; differs only in BeginTransfer payload defaults
 *        (currently identical pending HCS08 ground-truth capture).
 * --begin-payload: 6 hex bytes (with or without spaces) overriding the
 *        BeginTransfer payload — for iterating against a live device when
 *        the MCU-default payload doesn't elicit an ACK.
 * --begin-only: emit just BeginTransfer and stop. Useful for non-destructive
 *        reachability probing (note: BeginTransfer itself may be destructive
 *        on HCS08 — see docs/firmware-re/powpak-conversion-attack.md
 *        §"Brick incident").
 */

import { createSocket, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  defaultBeginTransferPayload,
  type McuFamily,
  OTA_BEGIN_PAYLOAD_LEN,
  walkOtaPackets,
} from "../../lib/cca-ota-tx-builder";
import { config } from "../../lib/config";
import { stripLdfHeader } from "../../lib/ldf";

const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_TX_RAW_CCA = 0x01;
const PORT = 9433;
const DEFAULT_CADENCE_MS = 75;

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string): boolean => args.includes(name);

function parseHex(s: string): number {
  return Number.parseInt(s.replace(/^0x/i, ""), 16);
}

function parseHexBytes(s: string): Uint8Array {
  const stripped = s.replace(/^0x/i, "").replace(/[\s,_-]/g, "");
  if (stripped.length === 0 || stripped.length % 2 !== 0) {
    throw new Error(
      `expected even-length hex string, got ${stripped.length} chars: "${s}"`,
    );
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte))
      throw new Error(`bad hex byte at index ${i}: "${s}"`);
    out[i] = byte;
  }
  return out;
}

function parseMcu(s: string | undefined): McuFamily {
  if (s === undefined || s === "efr32") return "efr32";
  if (s === "hcs08") return "hcs08";
  throw new Error(`unknown --mcu value "${s}" (expected efr32 or hcs08)`);
}

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join(" ");
}

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
  const subnetStr = getArg("--subnet");
  const serialStr = getArg("--serial");
  const host = getArg("--host") ?? config.openBridge;
  const dryRun = hasFlag("--dry-run");
  const beginOnly = hasFlag("--begin-only");
  const maxChunks = Number.parseInt(getArg("--max-chunks") ?? "0", 10);
  const cadenceMs = Number.parseInt(
    getArg("--cadence-ms") ?? `${DEFAULT_CADENCE_MS}`,
    10,
  );
  const mcu = parseMcu(getArg("--mcu"));
  const beginPayloadOverride = getArg("--begin-payload");

  if (!ldfPath || !subnetStr || !serialStr) {
    console.error(
      "Usage: npx tsx tools/cca/ota-tx.ts --ldf <path> --subnet <hex> --serial <hex>\n" +
        "  [--host <ip>] [--dry-run] [--max-chunks N] [--cadence-ms 75]\n" +
        '  [--mcu efr32|hcs08] [--begin-payload "02 20 00 00 00 1F"] [--begin-only]',
    );
    process.exit(1);
  }

  const subnet = parseHex(subnetStr);
  const targetSerial = parseHex(serialStr);
  if (Number.isNaN(subnet) || Number.isNaN(targetSerial)) {
    console.error("subnet and serial must be hex (e.g. 0xffff or 00BC2107)");
    process.exit(1);
  }

  const beginTransferPayload = beginPayloadOverride
    ? parseHexBytes(beginPayloadOverride)
    : defaultBeginTransferPayload(mcu);
  if (beginTransferPayload.length !== OTA_BEGIN_PAYLOAD_LEN) {
    console.error(
      `--begin-payload must be ${OTA_BEGIN_PAYLOAD_LEN} bytes; got ${beginTransferPayload.length}`,
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
  const payloadHex = Array.from(beginTransferPayload)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  console.log(
    `[ota-tx] LDF: ${file.length} bytes -> body ${body.length} bytes (header stripped)`,
  );
  console.log(
    `[ota-tx] target subnet=0x${subnet.toString(16).padStart(4, "0")} serial=0x${targetSerial.toString(16).padStart(8, "0")} mcu=${mcu}`,
  );
  console.log(
    `[ota-tx] BeginTransfer payload: ${payloadHex}${beginPayloadOverride ? " (overridden)" : ` (default for ${mcu})`}`,
  );
  console.log(
    `[ota-tx] mode=${dryRun ? "dry-run (no UDP)" : `live (host=${host})`} cadence=${cadenceMs}ms${beginOnly ? " begin-only" : ""}`,
  );

  let sock: Socket | null = null;
  if (!dryRun) {
    sock = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      sock!.once("error", reject);
      sock!.bind(0, () => resolve());
    });
    sendStream(sock, host, STREAM_CMD_KEEPALIVE, new Uint8Array(0));
    await sleep(100);
  }

  let chunkCount = 0;
  let totalCount = 0;
  for (const { label, pkt } of walkOtaPackets(body, subnet, targetSerial, {
    beginTransferPayload,
  })) {
    if (beginOnly && label !== "BeginTransfer") {
      console.log("[ota-tx] stopping early: --begin-only");
      break;
    }
    if (
      label.startsWith("TransferData") &&
      maxChunks > 0 &&
      chunkCount >= maxChunks
    ) {
      console.log(`[ota-tx] stopping early: --max-chunks=${maxChunks} reached`);
      break;
    }
    if (dryRun || !sock) {
      console.log(`[dry] ${label.padEnd(18)} ${hex(pkt)}`);
    } else {
      sendStream(sock, host, STREAM_CMD_TX_RAW_CCA, pkt);
    }
    await sleep(cadenceMs);
    if (label.startsWith("TransferData")) chunkCount++;
    totalCount++;
    if (
      chunkCount > 0 &&
      chunkCount % 100 === 0 &&
      label.startsWith("TransferData")
    ) {
      console.log(`[ota-tx] sent ${chunkCount} chunks`);
    }
  }

  console.log(
    `[ota-tx] complete: ${chunkCount} chunks (${totalCount} packets total)`,
  );
  if (sock) sock.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
