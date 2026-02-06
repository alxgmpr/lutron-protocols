#!/usr/bin/env bun
/**
 * CCX Packet Analyzer - Reverse engineering helper for CCX (Thread/CBOR) traffic
 *
 * Usage:
 *   bun run tools/ccx-analyzer.ts decode <hex>
 *   bun run tools/ccx-analyzer.ts types --file <pcapng>
 *   bun run tools/ccx-analyzer.ts fields <type> --file <pcapng>
 *   bun run tools/ccx-analyzer.ts timeline --file <pcapng>
 *   bun run tools/ccx-analyzer.ts devices --file <pcapng>
 *   bun run tools/ccx-analyzer.ts compare <type> --file <pcapng>
 *   bun run tools/ccx-analyzer.ts unknown --file <pcapng>
 *   bun run tools/ccx-analyzer.ts stats --file <pcapng>
 */

import { spawn } from "child_process";
import { decode as cborDecode } from "cbor-x";
import {
  decodeAndParse,
  decodeHex,
  formatMessage,
  getMessageTypeName,
  buildPacket,
} from "../ccx/decoder";
import { CCX_CONFIG, getDeviceName, getZoneName } from "../ccx/config";
import { CCXMessageTypeName } from "../ccx/constants";
import type { CCXPacket } from "../ccx/types";

// ── CLI argument parsing ────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const pcapFile = getArg("--file");
const masterKey = getArg("--key") ?? CCX_CONFIG.masterKey;

// ── tshark integration ──────────────────────────────────────────────

/** Run tshark on a pcapng file and return decoded CCX packets */
async function loadPacketsFromPcap(file: string): Promise<CCXPacket[]> {
  return new Promise((resolve, reject) => {
    const tsharkArgs = [
      "-r", file,
      // Thread key is read from Wireshark's ieee802154_keys UAT file automatically
      "-Y", `udp.port == ${CCX_CONFIG.udpPort}`,
      "-T", "fields",
      "-e", "frame.time_epoch",
      "-e", "ipv6.src",
      "-e", "ipv6.dst",
      "-e", "wpan.src64",
      "-e", "wpan.dst64",
      "-e", "udp.payload",
      "-E", "separator=\t",
    ];

    const tshark = spawn("tshark", tsharkArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    tshark.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    tshark.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    tshark.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tshark exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      const packets: CCXPacket[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const fields = trimmed.split("\t");
        if (fields.length < 6 || !fields[5]) continue;

        try {
          const epoch = parseFloat(fields[0]);
          const payloadHex = fields[5].replace(/:/g, "");
          if (!payloadHex) continue;

          packets.push(buildPacket({
            timestamp: new Date(epoch * 1000).toISOString(),
            srcAddr: fields[1] ?? "",
            dstAddr: fields[2] ?? "",
            srcEui64: fields[3] ?? "",
            dstEui64: fields[4] ?? "",
            payloadHex,
          }));
        } catch {
          // Skip malformed packets
        }
      }

      resolve(packets);
    });

    tshark.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("tshark not found. Install Wireshark CLI tools."));
      } else {
        reject(err);
      }
    });
  });
}

// ── Hex utility ─────────────────────────────────────────────────────

function bytesToHex(data: Uint8Array): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, "0")).join(" ");
}

// ── Commands ────────────────────────────────────────────────────────

/** Decode a single CBOR hex string with annotated dump */
function cmdDecode(hex: string) {
  const clean = hex.replace(/[\s:,]/g, "").replace(/^0x/i, "");
  const raw = new Uint8Array(clean.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));

  console.log("\nCCX Message Decode:");
  console.log("===================");
  console.log(`Raw hex: ${clean}`);
  console.log(`Length: ${raw.length} bytes`);

  // Show raw CBOR structure
  try {
    const decoded = cborDecode(raw);
    console.log(`\nCBOR structure:`);
    console.log(JSON.stringify(decoded, (_, v) => {
      if (v instanceof Uint8Array) return `<bytes:${bytesToHex(v)}>`;
      return v;
    }, 2));
  } catch (err) {
    console.error(`CBOR decode error: ${(err as Error).message}`);
    return;
  }

  // Parse into typed message
  const msg = decodeAndParse(hex);
  console.log(`\nParsed: ${formatMessage(msg)}`);

  // Type-specific details
  if (msg.type === "LEVEL_CONTROL") {
    const zoneName = getZoneName(msg.zoneId);
    console.log(`\nDetails:`);
    console.log(`  Level: 0x${msg.level.toString(16).padStart(4, "0")} (${msg.levelPercent.toFixed(1)}%)`);
    console.log(`  Zone: ${msg.zoneId}${zoneName ? ` (${zoneName})` : ""}`);
    console.log(`  Zone type: ${msg.zoneType}`);
    console.log(`  Sequence: ${msg.sequence}`);
  } else if (msg.type === "BUTTON_PRESS") {
    console.log(`\nDetails:`);
    console.log(`  Device ID: ${bytesToHex(msg.deviceId)}`);
    console.log(`  Command type: 0x${msg.cmdType.toString(16).padStart(2, "0")}`);
    console.log(`  Button zone: ${msg.buttonZone}`);
    console.log(`  Counters: [${msg.counters.join(", ")}]`);
    console.log(`  Sequence: ${msg.sequence}`);
  } else if (msg.type === "ACK") {
    console.log(`\nDetails:`);
    console.log(`  Response: ${bytesToHex(msg.response)} (0x${msg.responseCode.toString(16).padStart(2, "0")} = '${String.fromCharCode(msg.responseCode)}')`);
    console.log(`  Sequence: ${msg.sequence}`);
  } else if (msg.type === "STATUS") {
    console.log(`\nDetails:`);
    console.log(`  Device type: ${msg.deviceType}`);
    console.log(`  Device ID: 0x${msg.deviceId.toString(16).padStart(8, "0")}`);
    console.log(`  Inner data: ${bytesToHex(msg.innerData)}`);
    if (Object.keys(msg.extra).length > 0) {
      console.log(`  Extra fields: ${JSON.stringify(msg.extra)}`);
    }
    console.log(`  Sequence: ${msg.sequence}`);
  }
}

/** Catalog all unique message types from a capture */
async function cmdTypes() {
  if (!pcapFile) {
    console.error("Error: --file <pcapng> required");
    process.exit(1);
  }

  const packets = await loadPacketsFromPcap(pcapFile);
  const typeCounts = new Map<number, number>();

  for (const pkt of packets) {
    typeCounts.set(pkt.msgType, (typeCounts.get(pkt.msgType) ?? 0) + 1);
  }

  console.log("\nMessage Type Catalog:");
  console.log("=====================");
  console.log("Type ID  | Name            | Count");
  console.log("---------|-----------------|------");

  for (const [typeId, count] of [...typeCounts.entries()].sort((a, b) => a[0] - b[0])) {
    const name = getMessageTypeName(typeId).padEnd(15);
    const idStr = typeId <= 255
      ? `0x${typeId.toString(16).padStart(2, "0").toUpperCase()}`.padEnd(7)
      : String(typeId).padEnd(7);
    console.log(`${idStr}  | ${name} | ${count}`);
  }

  console.log(`\nTotal: ${packets.length} packets, ${typeCounts.size} unique types`);
}

/** Analyze field patterns for a specific message type */
async function cmdFields(typeStr: string) {
  if (!pcapFile) {
    console.error("Error: --file <pcapng> required");
    process.exit(1);
  }

  // Resolve type name to ID
  const typeId = resolveTypeId(typeStr);
  if (typeId === undefined) {
    console.error(`Unknown type: ${typeStr}`);
    console.error(`Known types: ${Object.entries(CCXMessageTypeName).map(([id, name]) => `${name}(${id})`).join(", ")}`);
    process.exit(1);
  }

  const packets = await loadPacketsFromPcap(pcapFile);
  const matched = packets.filter(p => p.msgType === typeId);

  if (matched.length === 0) {
    console.log(`No packets of type ${typeStr} (${typeId}) found.`);
    return;
  }

  console.log(`\nField Analysis for ${getMessageTypeName(typeId)} (${matched.length} packets):`);
  console.log("=".repeat(60));

  // Collect all top-level body keys
  const allKeys = new Set<number>();
  for (const pkt of matched) {
    for (const key of Object.keys(pkt.body)) {
      allKeys.add(Number(key));
    }
  }

  console.log(`\nTop-level keys: [${[...allKeys].sort((a, b) => a - b).join(", ")}]`);

  for (const key of [...allKeys].sort((a, b) => a - b)) {
    console.log(`\n  Key ${key}:`);
    const values = matched.map(p => p.body[key]).filter(v => v !== undefined);
    const types = [...new Set(values.map(v => typeof v))];
    console.log(`    Types: ${types.join(", ")}`);
    console.log(`    Present in: ${values.length}/${matched.length} packets`);

    if (types.includes("number")) {
      const nums = values.filter(v => typeof v === "number") as number[];
      console.log(`    Range: ${Math.min(...nums)} - ${Math.max(...nums)}`);
      const unique = [...new Set(nums)];
      if (unique.length <= 10) {
        console.log(`    Unique values: [${unique.sort((a, b) => a - b).join(", ")}]`);
      } else {
        console.log(`    Unique values: ${unique.length}`);
      }
    }
  }
}

/** Show timeline with timing deltas */
async function cmdTimeline() {
  if (!pcapFile) {
    console.error("Error: --file <pcapng> required");
    process.exit(1);
  }

  const packets = await loadPacketsFromPcap(pcapFile);

  console.log("\nPacket Timeline:");
  console.log("================");

  let lastTime: number | null = null;

  for (const pkt of packets) {
    const time = new Date(pkt.timestamp).getTime();
    const delta = lastTime !== null ? time - lastTime : 0;
    lastTime = time;

    const timeStr = pkt.timestamp.slice(11, 23);
    const deltaStr = delta > 0 ? `+${delta}ms` : "";
    const src = getDeviceName(pkt.srcAddr) ?? pkt.srcAddr;
    const msgStr = formatMessage(pkt.parsed);

    let annotation = "";
    if (pkt.parsed.type === "LEVEL_CONTROL") {
      const zoneName = getZoneName(pkt.parsed.zoneId);
      if (zoneName) annotation = ` [${zoneName}]`;
    }

    console.log(`${timeStr} ${deltaStr.padStart(8)} ${src} ${msgStr}${annotation}`);
  }

  console.log(`\n${packets.length} packets total`);
}

/** List unique IPv6 addresses / devices */
async function cmdDevices() {
  if (!pcapFile) {
    console.error("Error: --file <pcapng> required");
    process.exit(1);
  }

  const packets = await loadPacketsFromPcap(pcapFile);

  const devices = new Map<string, { count: number; types: Set<string>; lastSeen: string; eui64: string }>();

  for (const pkt of packets) {
    for (const addr of [pkt.srcAddr, pkt.dstAddr]) {
      if (!addr) continue;
      const existing = devices.get(addr);
      if (existing) {
        existing.count++;
        existing.types.add(getMessageTypeName(pkt.msgType));
        existing.lastSeen = pkt.timestamp;
        if (addr === pkt.srcAddr && pkt.srcEui64) existing.eui64 = pkt.srcEui64;
      } else {
        devices.set(addr, {
          count: 1,
          types: new Set([getMessageTypeName(pkt.msgType)]),
          lastSeen: pkt.timestamp,
          eui64: addr === pkt.srcAddr ? (pkt.srcEui64 ?? "") : (pkt.dstEui64 ?? ""),
        });
      }
    }
  }

  console.log("\nDevices Seen:");
  console.log("=============");
  console.log("IPv6 Address                              | Name         | EUI-64           | Packets | Types");
  console.log("------------------------------------------|--------------|------------------|---------|------");

  for (const [addr, info] of [...devices.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const name = (getDeviceName(addr) ?? "").padEnd(12);
    const eui64 = info.eui64.padEnd(16);
    const types = [...info.types].join(", ");
    console.log(`${addr.padEnd(41)} | ${name} | ${eui64} | ${info.count.toString().padStart(7)} | ${types}`);
  }
}

/** Compare packets of same type to find variable fields */
async function cmdCompare(typeStr: string) {
  if (!pcapFile) {
    console.error("Error: --file <pcapng> required");
    process.exit(1);
  }

  const typeId = resolveTypeId(typeStr);
  if (typeId === undefined) {
    console.error(`Unknown type: ${typeStr}`);
    process.exit(1);
  }

  const packets = await loadPacketsFromPcap(pcapFile);
  const matched = packets.filter(p => p.msgType === typeId);

  if (matched.length < 2) {
    console.log(`Not enough ${typeStr} packets to compare (found ${matched.length})`);
    return;
  }

  console.log(`\nComparing ${matched.length} ${getMessageTypeName(typeId)} packets:`);
  console.log("=".repeat(50));

  // Compare raw hex bytes
  const hexArrays = matched.map(p => {
    const clean = p.rawHex.replace(/\s/g, "");
    return clean.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) ?? [];
  });

  const maxLen = Math.max(...hexArrays.map(a => a.length));
  const variablePositions = new Set<number>();

  for (let i = 0; i < maxLen; i++) {
    const firstVal = hexArrays[0]?.[i];
    for (let j = 1; j < hexArrays.length; j++) {
      if (hexArrays[j]?.[i] !== firstVal) {
        variablePositions.add(i);
        break;
      }
    }
  }

  if (hexArrays[0]) {
    console.log("\nConstant vs variable CBOR bytes:");
    const first = hexArrays[0];
    const display = first.map((b, i) =>
      variablePositions.has(i) ? ".." : b.toString(16).padStart(2, "0").toUpperCase()
    );
    console.log("Pos: " + first.map((_, i) => i.toString().padStart(2, "0")).join(" "));
    console.log("Val: " + display.join(" "));
  }

  console.log(`\nVariable byte positions: [${[...variablePositions].sort((a, b) => a - b).join(", ")}]`);

  // Compare parsed field values
  console.log("\nParsed field comparison:");
  for (const pkt of matched.slice(0, 5)) {
    console.log(`  ${formatMessage(pkt.parsed)}`);
  }
  if (matched.length > 5) {
    console.log(`  ... and ${matched.length - 5} more`);
  }
}

/** Find messages with unrecognized types or unexpected fields */
async function cmdUnknown() {
  if (!pcapFile) {
    console.error("Error: --file <pcapng> required");
    process.exit(1);
  }

  const packets = await loadPacketsFromPcap(pcapFile);
  const unknowns = packets.filter(p => p.parsed.type === "UNKNOWN");

  if (unknowns.length === 0) {
    console.log("\nNo unknown message types found.");
    console.log(`All ${packets.length} packets matched known types.`);
    return;
  }

  // Group by message type
  const byType = new Map<number, CCXPacket[]>();
  for (const pkt of unknowns) {
    const typeId = pkt.msgType;
    const list = byType.get(typeId) ?? [];
    list.push(pkt);
    byType.set(typeId, list);
  }

  console.log(`\nUnknown Message Types (${unknowns.length} packets):`);
  console.log("=".repeat(50));

  for (const [typeId, pkts] of [...byType.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`\nType ${typeId} (0x${typeId.toString(16)}): ${pkts.length} packets`);

    // Show CBOR structure of first example
    console.log("  Example CBOR:");
    const raw = new Uint8Array(
      pkts[0].rawHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16))
    );
    try {
      const decoded = cborDecode(raw);
      console.log("  " + JSON.stringify(decoded, (_, v) => {
        if (v instanceof Uint8Array) return `<bytes:${bytesToHex(v)}>`;
        return v;
      }, 2).replace(/\n/g, "\n  "));
    } catch {
      console.log(`  Raw hex: ${pkts[0].rawHex}`);
    }

    // Show all unique body keys
    const allKeys = new Set<number>();
    for (const pkt of pkts) {
      for (const key of Object.keys(pkt.body)) allKeys.add(Number(key));
    }
    console.log(`  Body keys: [${[...allKeys].sort((a, b) => a - b).join(", ")}]`);
  }
}

/** Summary statistics */
async function cmdStats() {
  if (!pcapFile) {
    console.error("Error: --file <pcapng> required");
    process.exit(1);
  }

  const packets = await loadPacketsFromPcap(pcapFile);

  if (packets.length === 0) {
    console.log("No CCX packets found in capture.");
    return;
  }

  // Type distribution
  const typeCounts = new Map<number, number>();
  for (const pkt of packets) {
    typeCounts.set(pkt.msgType, (typeCounts.get(pkt.msgType) ?? 0) + 1);
  }

  // Unique addresses
  const srcAddrs = new Set(packets.map(p => p.srcAddr).filter(Boolean));
  const dstAddrs = new Set(packets.map(p => p.dstAddr).filter(Boolean));
  const allAddrs = new Set([...srcAddrs, ...dstAddrs]);

  // Time range
  const times = packets.map(p => new Date(p.timestamp).getTime());
  const firstTime = Math.min(...times);
  const lastTime = Math.max(...times);
  const durationMs = lastTime - firstTime;

  // Zone stats
  const zones = new Set<number>();
  for (const pkt of packets) {
    if (pkt.parsed.type === "LEVEL_CONTROL") zones.add(pkt.parsed.zoneId);
  }

  console.log("\nCCX Capture Statistics:");
  console.log("=======================");
  console.log(`Total packets: ${packets.length}`);
  console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Packet rate: ${(packets.length / (durationMs / 1000)).toFixed(1)} pkt/s`);
  console.log(`Unique addresses: ${allAddrs.size} (${srcAddrs.size} sources, ${dstAddrs.size} destinations)`);
  console.log(`Unique zones: ${zones.size}${zones.size > 0 ? ` (${[...zones].join(", ")})` : ""}`);
  console.log(`\nMessage type distribution:`);

  for (const [typeId, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const name = getMessageTypeName(typeId);
    const pct = ((count / packets.length) * 100).toFixed(1);
    const bar = "#".repeat(Math.round(count / packets.length * 40));
    console.log(`  ${name.padEnd(16)} ${count.toString().padStart(5)} (${pct.padStart(5)}%) ${bar}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Resolve a type name or numeric ID to a message type ID */
function resolveTypeId(typeStr: string): number | undefined {
  // Try numeric
  const num = parseInt(typeStr, 10);
  if (!isNaN(num)) return num;

  // Try hex
  if (typeStr.startsWith("0x")) {
    const hex = parseInt(typeStr, 16);
    if (!isNaN(hex)) return hex;
  }

  // Try name lookup
  const upper = typeStr.toUpperCase();
  for (const [id, name] of Object.entries(CCXMessageTypeName)) {
    if (name === upper) return Number(id);
  }

  return undefined;
}

// ── Main CLI ────────────────────────────────────────────────────────

async function main() {
  try {
    switch (command) {
      case "decode": {
        const hex = args.slice(1).filter(a => !a.startsWith("--")).join("");
        if (!hex) {
          console.log("Usage: ccx-analyzer.ts decode <hex>");
          console.log('Example: ccx-analyzer.ts decode "8200a300a20019feff03010182101903c105185c"');
          process.exit(1);
        }
        cmdDecode(hex);
        break;
      }

      case "types":
        await cmdTypes();
        break;

      case "fields": {
        const typeStr = args[1];
        if (!typeStr || typeStr.startsWith("--")) {
          console.log("Usage: ccx-analyzer.ts fields <type> --file <pcapng>");
          process.exit(1);
        }
        await cmdFields(typeStr);
        break;
      }

      case "timeline":
        await cmdTimeline();
        break;

      case "devices":
        await cmdDevices();
        break;

      case "compare": {
        const typeStr = args[1];
        if (!typeStr || typeStr.startsWith("--")) {
          console.log("Usage: ccx-analyzer.ts compare <type> --file <pcapng>");
          process.exit(1);
        }
        await cmdCompare(typeStr);
        break;
      }

      case "unknown":
        await cmdUnknown();
        break;

      case "stats":
        await cmdStats();
        break;

      default:
        console.log(`
CCX Packet Analyzer - Reverse Engineering Helper

Commands:
  decode <hex>                     Decode a single CBOR message with annotated dump
  types --file <pcapng>            Catalog all unique message types from a capture
  fields <type> --file <pcapng>    Analyze field patterns for a specific message type
  timeline --file <pcapng>         Show packet timeline with timing analysis
  devices --file <pcapng>          List unique IPv6 addresses / devices
  compare <type> --file <pcapng>   Find constant vs variable fields across messages
  unknown --file <pcapng>          Highlight unrecognized message types
  stats --file <pcapng>            Summary statistics

Options:
  --file <pcapng>   Input capture file (processed via tshark)
  --key <hex>       Thread master key (default: from config)

Type names: ${Object.values(CCXMessageTypeName).join(", ")}

Examples:
  bun run tools/ccx-analyzer.ts decode "8200a300a20019feff03010182101903c105185c"
  bun run tools/ccx-analyzer.ts types --file captures/ccx-onoff.pcapng
  bun run tools/ccx-analyzer.ts fields LEVEL_CONTROL --file captures/ccx-onoff.pcapng
  bun run tools/ccx-analyzer.ts stats --file captures/ccx-full.pcapng
`);
    }
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

main();
