#!/usr/bin/env -S npx tsx
/**
 * CCX Sniffer - tshark-based capture and decode pipeline
 *
 * Bridges tshark's Thread/802.15.4 decryption with our CCX CBOR decoder.
 *
 * Usage:
 *   npx tsx tools/ccx-sniffer.ts --file capture.pcapng
 *   npx tsx tools/ccx-sniffer.ts --live [--channel 25] [--duration 60]
 *   npx tsx tools/ccx-sniffer.ts --file capture.pcapng --json
 *   npx tsx tools/ccx-sniffer.ts --live --relay
 *   npx tsx tools/ccx-sniffer.ts --file capture.pcapng --decrypt
 *
 * Options:
 *   --file <path>       Process a pcapng capture file
 *   --live              Live capture from nRF 802.15.4 sniffer
 *   --channel <n>       802.15.4 channel (default: from config)
 *   --duration <secs>   Stop live capture after N seconds
 *   --key <hex>         Thread master key (default: from config)
 *   --json              Output JSON (one object per line)
 *   --relay             Forward decoded packets to backend via UDP
 *   --decrypt           Native decrypt MAC-encrypted frames tshark can't handle
 *   --iface <name>      nRF sniffer interface name for tshark (auto-detected)
 */

import { execSync, spawn } from "child_process";
import { createSocket } from "dgram";
import { existsSync } from "fs";
import {
  CCX_CONFIG,
  getAllDevices,
  getDeviceName,
  getZoneName,
} from "../ccx/config";
import { buildPacket, formatMessage, getMessageTypeName } from "../ccx/decoder";
import type { CCXPacket } from "../ccx/types";
import { formatAddr, parseFrame } from "../lib/ieee802154";
import { decryptMacFrame, deriveThreadKeys } from "../lib/thread-crypto";

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

const fileMode = getArg("--file");
const liveMode = hasFlag("--live");
const channel = getArg("--channel") ?? String(CCX_CONFIG.channel);
const duration = getArg("--duration");
const masterKey = getArg("--key") ?? CCX_CONFIG.masterKey;
const jsonOutput = hasFlag("--json");
const relayMode = hasFlag("--relay");
const decryptMode = hasFlag("--decrypt");
const ifaceName = getArg("--iface");

if (!fileMode && !liveMode) {
  console.log(`
CCX Sniffer - tshark-based Thread/802.15.4 capture & decode

Usage:
  npx tsx tools/ccx-sniffer.ts --file <capture.pcapng>   Process a capture file
  npx tsx tools/ccx-sniffer.ts --live                     Live capture from nRF sniffer

Options:
  --channel <n>       802.15.4 channel (default: ${CCX_CONFIG.channel})
  --duration <secs>   Stop live capture after N seconds
  --key <hex>         Thread master key (default: from config)
  --json              Output JSON (one object per line)
  --relay             Forward decoded packets to backend UDP
  --decrypt           Native decrypt MAC-encrypted frames (--file only)
  --iface <name>      tshark interface name (auto-detected from nRF sniffer)

Requirements:
  - tshark (Wireshark CLI) must be installed
  - For live capture: nRF 802.15.4 sniffer extcap plugin installed in Wireshark
  - Thread master key must be configured (config or --key flag)
`);
  process.exit(0);
}

/** Relay socket for forwarding to backend */
const relaySocket = relayMode ? createSocket("udp4") : null;
const RELAY_PORT = 9435; // Dedicated CCX relay port

/** Auto-detect nRF sniffer serial device */
function detectSnifferInterface(): string {
  // Check common macOS paths for nRF52840 dongle
  const candidates = [
    "/dev/cu.usbmodem201401",
    "/dev/cu.usbmodem0004401800001",
  ];
  for (const path of candidates) {
    try {
      if (existsSync(path)) return path;
    } catch {
      /* skip */
    }
  }
  return "/dev/cu.usbmodem201401";
}

/** Build tshark command arguments */
function buildTsharkArgs(): string[] {
  const tsharkArgs: string[] = [];

  if (fileMode) {
    tsharkArgs.push("-r", fileMode);
  } else {
    // Live capture — interface is the serial device path
    const iface = ifaceName ?? detectSnifferInterface();
    tsharkArgs.push("-i", iface);
    // Channel is configured in Wireshark preferences (default saved from GUI)
    if (duration) {
      tsharkArgs.push("-a", `duration:${duration}`);
    }
  }

  // Line-buffered output so packets appear in real-time (not buffered until exit)
  tsharkArgs.push("-l");

  // Thread key is read from Wireshark's ieee802154_keys UAT file automatically
  // Filter to Lutron UDP port
  tsharkArgs.push("-Y", `udp.port == ${CCX_CONFIG.udpPort}`);

  // Output fields as tab-separated values
  tsharkArgs.push(
    "-T",
    "fields",
    "-e",
    "frame.time_epoch",
    "-e",
    "ipv6.src",
    "-e",
    "ipv6.dst",
    "-e",
    "wpan.src64",
    "-e",
    "wpan.dst64",
    "-e",
    "udp.payload",
    "-E",
    "separator=\t",
  );

  return tsharkArgs;
}

/** Process a single tshark output line */
function processLine(line: string): CCXPacket | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const fields = trimmed.split("\t");
  if (fields.length < 6) return null;

  const [epochStr, srcAddr, dstAddr, srcEui64, dstEui64, dataHex] = fields;

  // Skip if no payload data
  if (!dataHex) return null;

  // tshark outputs data.data as colon-separated hex
  const payloadHex = dataHex.replace(/:/g, "");
  if (!payloadHex) return null;

  try {
    const epoch = parseFloat(epochStr);
    const timestamp = new Date(epoch * 1000).toISOString();

    return buildPacket({
      timestamp,
      srcAddr: srcAddr ?? "",
      dstAddr: dstAddr ?? "",
      srcEui64: srcEui64 ?? "",
      dstEui64: dstEui64 ?? "",
      payloadHex,
    });
  } catch (err) {
    if (!jsonOutput) {
      console.error(
        `  [decode error] ${(err as Error).message}: ${payloadHex}`,
      );
    }
    return null;
  }
}

/** Format a packet for human-readable output */
function formatPacket(pkt: CCXPacket): string {
  const time = pkt.timestamp.slice(11, 23); // HH:MM:SS.mmm
  const typeName = getMessageTypeName(pkt.msgType).padEnd(14);
  const src = getDeviceName(pkt.srcAddr) ?? pkt.srcAddr;
  const msgStr = formatMessage(pkt.parsed);

  // Add zone name annotation if applicable
  let annotation = "";
  if (pkt.parsed.type === "LEVEL_CONTROL") {
    const zoneName = getZoneName(pkt.parsed.zoneId);
    if (zoneName) annotation = ` [${zoneName}]`;
  }

  return `${time} ${typeName} ${src} → ${msgStr}${annotation}`;
}

/** Relay a packet to the backend */
function relayPacket(pkt: CCXPacket) {
  if (!relaySocket) return;
  const json = JSON.stringify(pkt);
  const buf = Buffer.from(json);
  relaySocket.send(buf, RELAY_PORT, "127.0.0.1", (err) => {
    if (err) console.error("Relay error:", err.message);
  });
}

/** Output a decoded packet via the appropriate channel */
function outputPacket(pkt: CCXPacket): void {
  if (relayMode) {
    relayPacket(pkt);
  } else if (jsonOutput) {
    console.log(JSON.stringify(pkt));
  } else {
    console.log(formatPacket(pkt));
  }
}

// ── Native decrypt post-pass (--file --decrypt) ───────────────────

function runDecryptPass(file: string): number {
  const MASTER_KEY = Buffer.from(masterKey, "hex");
  let decryptedCount = 0;

  // Build short→EUI-64 address table from MLE exchanges
  const addrTable = new Map<number, Buffer>();
  const addrRaw = execSync(
    `tshark -r "${file}" -T fields -e wpan.src16 -e wpan.src64 -Y "wpan.src64" 2>/dev/null`,
  )
    .toString()
    .trim();

  if (addrRaw) {
    for (const line of addrRaw.split("\n")) {
      const [shortHex, eui64Str] = line.split("\t");
      if (!shortHex || !eui64Str?.includes(":")) continue;
      const shortAddr = parseInt(shortHex.replace("0x", ""), 16);
      if (Number.isNaN(shortAddr)) continue;
      const eui64 = Buffer.from(eui64Str.replace(/:/g, ""), "hex");
      if (eui64.length === 8) addrTable.set(shortAddr, eui64);
    }
  }

  // Add device map EUI-64s as brute-force fallback
  for (const dev of getAllDevices()) {
    if (dev.eui64) {
      const eui64 = Buffer.from(dev.eui64.replace(/:/g, ""), "hex");
      if (eui64.length === 8) addrTable.set(-dev.serial, eui64);
    }
  }

  // Get frame numbers of MAC-encrypted frames
  const filter = "wpan.security == 1 and not ipv6 and not mle";
  const fieldsRaw = execSync(
    `tshark -r "${file}" -T fields -e frame.number -e frame.time_epoch -e wpan.src64 -Y "${filter}" 2>/dev/null`,
  )
    .toString()
    .trim();

  if (!fieldsRaw) return 0;

  const metaMap = new Map<number, { epoch: number; srcEui64: string }>();
  for (const line of fieldsRaw.split("\n")) {
    const [numStr, epochStr, srcEui64] = line.split("\t");
    metaMap.set(parseInt(numStr, 10), {
      epoch: parseFloat(epochStr),
      srcEui64: srcEui64 || "",
    });
  }

  const frameNums = [...metaMap.keys()];
  if (frameNums.length === 0) return 0;

  // Get raw hex dumps for these frames
  const frameFilter = frameNums.map((n) => `frame.number == ${n}`).join(" or ");
  const hexRaw = execSync(
    `tshark -r "${file}" -x -Y "${frameFilter}" 2>/dev/null`,
  ).toString();

  const packetBlocks = hexRaw.split(/\n(?=Packet \()/);

  let blockIdx = 0;
  for (const block of packetBlocks) {
    if (!block.trim()) continue;
    if (blockIdx >= frameNums.length) break;

    const frameNum = frameNums[blockIdx];
    blockIdx++;
    const meta = metaMap.get(frameNum);
    if (!meta) continue;

    // Extract "IEEE 802.15.4 Data" hex section
    const dataMatch = block.match(
      /IEEE 802\.15\.4 Data \(\d+ bytes\):\n([\s\S]+?)(?:\n\n|\n$|$)/,
    );
    if (!dataMatch) continue;

    let hexStr = "";
    for (const line of dataMatch[1].split("\n")) {
      if (/^[0-9a-f]{4}\s/.test(line)) {
        hexStr += line.substring(6, 53).trim().replace(/\s+/g, "");
      }
    }
    if (!hexStr) continue;

    const rawBytes = Buffer.from(hexStr, "hex");
    const parsed = parseFrame(rawBytes);
    if (!parsed.securityEnabled) continue;

    const keySeq = parsed.keyIndex > 0 ? parsed.keyIndex - 1 : 0;
    const { macKey } = deriveThreadKeys(MASTER_KEY, keySeq);

    const tryWith = (eui64: Buffer) =>
      decryptMacFrame({
        frame: rawBytes,
        headerEnd: parsed.headerEnd,
        secLevel: parsed.secLevel,
        frameCounter: parsed.frameCounter,
        macKey,
        eui64,
      });

    // Try EUI-64 sources: tshark MLE > address table > brute-force
    let plaintext: Buffer | null = null;
    let matchedEui64 = Buffer.alloc(8);

    if (meta.srcEui64.includes(":")) {
      const eui64 = Buffer.from(meta.srcEui64.replace(/:/g, ""), "hex");
      if (eui64.length === 8) {
        plaintext = tryWith(eui64);
        if (plaintext) matchedEui64 = eui64;
      }
    }

    if (!plaintext && parsed.srcAddrMode === 2 && parsed.srcAddr.length === 2) {
      const srcShort = parsed.srcAddr.readUInt16LE(0);
      const eui64 = addrTable.get(srcShort);
      if (eui64) {
        plaintext = tryWith(eui64);
        if (plaintext) matchedEui64 = eui64;
      }
    }

    if (!plaintext) {
      for (const [, eui64] of addrTable) {
        plaintext = tryWith(eui64);
        if (plaintext) {
          matchedEui64 = eui64;
          break;
        }
      }
    }

    if (!plaintext) continue;

    // Scan for CBOR array marker
    for (let i = 0; i < plaintext.length - 2; i++) {
      if (plaintext[i] !== 0x82) continue;
      try {
        const eui64Hex = matchedEui64
          .toString("hex")
          .replace(/(.{2})/g, "$1:")
          .slice(0, -1);
        const pkt = buildPacket({
          timestamp: new Date(meta.epoch * 1000).toISOString(),
          srcAddr: formatAddr(parsed.srcAddr),
          dstAddr: formatAddr(parsed.dstAddr),
          srcEui64: eui64Hex,
          dstEui64: "",
          payloadHex: plaintext.subarray(i).toString("hex"),
        });
        outputPacket(pkt);
        decryptedCount++;
        break;
      } catch {}
    }
  }

  return decryptedCount;
}

/** Main: spawn tshark and process output */
async function main() {
  const tsharkArgs = buildTsharkArgs();

  if (!jsonOutput) {
    console.log(
      `CCX Sniffer - ${fileMode ? `Processing ${fileMode}` : "Live capture"}`,
    );
    console.log(`  Channel: ${channel}`);
    console.log(`  Master key: ${masterKey.slice(0, 8)}...`);
    if (decryptMode) console.log("  Native decrypt: enabled");
    if (relayMode) console.log(`  Relaying to localhost:${RELAY_PORT}`);
    console.log("");
  }

  const tshark = spawn("tshark", tsharkArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let packetCount = 0;
  let buffer = "";

  tshark.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const pkt = processLine(line);
      if (!pkt) continue;

      packetCount++;
      outputPacket(pkt);
    }
  });

  tshark.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    // Filter out tshark's informational messages
    if (msg.includes("Capturing on") || msg.includes("packets captured")) {
      if (!jsonOutput) console.error(`  [tshark] ${msg}`);
    } else if (msg) {
      console.error(`  [tshark error] ${msg}`);
    }
  });

  tshark.on("close", (code) => {
    // Process any remaining buffer
    if (buffer.trim()) {
      const pkt = processLine(buffer);
      if (pkt) {
        packetCount++;
        outputPacket(pkt);
      }
    }

    // Run decrypt post-pass for --file --decrypt mode
    let decryptedCount = 0;
    if (decryptMode && fileMode) {
      decryptedCount = runDecryptPass(fileMode);
    }

    if (!jsonOutput && !relayMode) {
      const extra =
        decryptedCount > 0 ? ` + ${decryptedCount} natively decrypted` : "";
      console.log(`\n${packetCount} CCX packets decoded${extra}.`);
    }

    if (relaySocket) relaySocket.close();

    if (code !== 0 && code !== null) {
      console.error(`tshark exited with code ${code}`);
      process.exit(1);
    }
  });

  tshark.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: tshark not found. Install Wireshark CLI tools.");
      console.error(
        "  macOS: brew install wireshark (or install Wireshark.app)",
      );
    } else {
      console.error("Error spawning tshark:", err.message);
    }
    process.exit(1);
  });

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    if (!jsonOutput) console.log("\nStopping capture...");
    tshark.kill("SIGINT");
  });
}

main();
