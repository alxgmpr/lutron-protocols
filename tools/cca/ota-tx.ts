#!/usr/bin/env npx tsx

/**
 * Host-side PowPak OTA driver — streams an LDF body to a target device via
 * the Nucleo's CC1101, using STREAM_CMD_TX_RAW_CCA UDP datagrams.
 *
 * Mirrors the firmware-side `cca ota-tx` orchestration but in TypeScript,
 * so the packet format is fast to iterate during Phase 2 debugging. See
 * docs/firmware-re/powpak-conversion-attack.md.
 *
 * Usage:
 *   npx tsx tools/cca/ota-tx.ts \
 *     --ldf data/firmware-re/powpak/PowPakRelay434_1-49.bin \
 *     --subnet 0xffff --serial 00BC2107 \
 *     [--host 10.1.1.114] [--dry-run] [--max-chunks N] [--cadence-ms 75]
 *
 * --dry-run: build + log every packet but never open the UDP socket.
 *            Tested via SDR loopback or unit tests, not against live hardware.
 */

import { createSocket, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildBeginTransfer,
  buildChangeAddressOffset,
  buildTransferData,
  OtaChunkIter,
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
  const maxChunks = Number.parseInt(getArg("--max-chunks") ?? "0", 10);
  const cadenceMs = Number.parseInt(
    getArg("--cadence-ms") ?? `${DEFAULT_CADENCE_MS}`,
    10,
  );

  if (!ldfPath || !subnetStr || !serialStr) {
    console.error(
      "Usage: npx tsx tools/cca/ota-tx.ts --ldf <path> --subnet <hex> --serial <hex> [--host <ip>] [--dry-run] [--max-chunks N] [--cadence-ms 75]",
    );
    process.exit(1);
  }

  const subnet = parseHex(subnetStr);
  const targetSerial = parseHex(serialStr);
  if (Number.isNaN(subnet) || Number.isNaN(targetSerial)) {
    console.error("subnet and serial must be hex (e.g. 0xffff or 00BC2107)");
    process.exit(1);
  }

  const file = readFileSync(ldfPath);
  const fileBytes = new Uint8Array(
    file.buffer,
    file.byteOffset,
    file.byteLength,
  );
  const body = stripLdfHeader(fileBytes);
  console.log(
    `[ota-tx] LDF: ${file.length} bytes -> body ${body.length} bytes (header stripped)`,
  );
  console.log(
    `[ota-tx] target subnet=0x${subnet.toString(16).padStart(4, "0")} serial=0x${targetSerial.toString(16).padStart(8, "0")}`,
  );
  console.log(
    `[ota-tx] mode=${dryRun ? "dry-run (no UDP)" : `live (host=${host})`} cadence=${cadenceMs}ms`,
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

  const sendPacket = async (pkt: Uint8Array, label: string): Promise<void> => {
    if (dryRun || !sock) {
      console.log(`[dry] ${label.padEnd(18)} ${hex(pkt)}`);
    } else {
      sendStream(sock, host, STREAM_CMD_TX_RAW_CCA, pkt);
    }
    await sleep(cadenceMs);
  };

  // 1× BeginTransfer
  await sendPacket(buildBeginTransfer(subnet, targetSerial), "BeginTransfer");

  // TransferData stream + ChangeAddrOff at every page wrap
  const carriers = [0xb1, 0xb2, 0xb3];
  const it = new OtaChunkIter(body);
  let chunkCount = 0;
  while (!it.done()) {
    if (maxChunks > 0 && chunkCount >= maxChunks) {
      console.log(`[ota-tx] stopping early: --max-chunks=${maxChunks} reached`);
      break;
    }
    const carrier = carriers[chunkCount % carriers.length];
    const chunk = it.fill();
    const td = buildTransferData(
      carrier,
      subnet,
      targetSerial,
      it.subCounter,
      it.addrLo,
      chunk,
    );
    await sendPacket(td, `TransferData[${chunkCount}]`);
    const wrapped = it.advance();
    if (wrapped && !it.done()) {
      const cao = buildChangeAddressOffset(
        subnet,
        targetSerial,
        it.page - 1,
        it.page,
      );
      await sendPacket(cao, "ChangeAddrOff");
    }
    chunkCount++;
    if (chunkCount % 100 === 0) {
      console.log(
        `[ota-tx] sent ${chunkCount} chunks (page=${it.page} addrLo=0x${it.addrLo.toString(16).padStart(4, "0")})`,
      );
    }
  }

  console.log(
    `[ota-tx] complete: ${chunkCount} chunks, ended at page=${it.page} addrLo=0x${it.addrLo.toString(16).padStart(4, "0")}`,
  );
  if (sock) sock.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
