#!/usr/bin/env bun
/**
 * CCX Sniffer - tshark-based capture and decode pipeline
 *
 * Bridges tshark's Thread/802.15.4 decryption with our CCX CBOR decoder.
 *
 * Usage:
 *   bun run tools/ccx-sniffer.ts --file capture.pcapng
 *   bun run tools/ccx-sniffer.ts --live [--channel 25] [--duration 60]
 *   bun run tools/ccx-sniffer.ts --file capture.pcapng --json
 *   bun run tools/ccx-sniffer.ts --live --relay
 *
 * Options:
 *   --file <path>       Process a pcapng capture file
 *   --live              Live capture from nRF 802.15.4 sniffer
 *   --channel <n>       802.15.4 channel (default: from config)
 *   --duration <secs>   Stop live capture after N seconds
 *   --key <hex>         Thread master key (default: from config)
 *   --json              Output JSON (one object per line)
 *   --relay             Forward decoded packets to backend via UDP
 *   --iface <name>      nRF sniffer interface name for tshark (auto-detected)
 */

import { spawn } from "child_process";
import { createSocket } from "dgram";
import { buildPacket, formatMessage, getMessageTypeName } from "../ccx/decoder";
import { CCX_CONFIG, getDeviceName, getZoneName } from "../ccx/config";
import type { CCXPacket } from "../ccx/types";

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
const ifaceName = getArg("--iface");

if (!fileMode && !liveMode) {
  console.log(`
CCX Sniffer - tshark-based Thread/802.15.4 capture & decode

Usage:
  bun run tools/ccx-sniffer.ts --file <capture.pcapng>   Process a capture file
  bun run tools/ccx-sniffer.ts --live                     Live capture from nRF sniffer

Options:
  --channel <n>       802.15.4 channel (default: ${CCX_CONFIG.channel})
  --duration <secs>   Stop live capture after N seconds
  --key <hex>         Thread master key (default: from config)
  --json              Output JSON (one object per line)
  --relay             Forward decoded packets to backend UDP
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
      const stat = Bun.file(path);
      if (stat) return path;
    } catch { /* skip */ }
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
    "-T", "fields",
    "-e", "frame.time_epoch",
    "-e", "ipv6.src",
    "-e", "ipv6.dst",
    "-e", "wpan.src64",
    "-e", "wpan.dst64",
    "-e", "udp.payload",
    "-E", "separator=\t"
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
      console.error(`  [decode error] ${(err as Error).message}: ${payloadHex}`);
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

/** Main: spawn tshark and process output */
async function main() {
  const tsharkArgs = buildTsharkArgs();

  if (!jsonOutput) {
    console.log(`CCX Sniffer - ${fileMode ? `Processing ${fileMode}` : "Live capture"}`);
    console.log(`  Channel: ${channel}`);
    console.log(`  Master key: ${masterKey.slice(0, 8)}...`);
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

      if (jsonOutput) {
        console.log(JSON.stringify(pkt));
      } else {
        console.log(formatPacket(pkt));
      }

      if (relayMode) {
        relayPacket(pkt);
      }
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
        if (jsonOutput) {
          console.log(JSON.stringify(pkt));
        } else {
          console.log(formatPacket(pkt));
        }
      }
    }

    if (!jsonOutput) {
      console.log(`\n${packetCount} CCX packets decoded.`);
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
      console.error("  macOS: brew install wireshark (or install Wireshark.app)");
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
