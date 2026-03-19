#!/usr/bin/env -S npx tsx

/**
 * CCX Packet Analyzer - Reverse engineering helper for CCX (Thread/CBOR) traffic
 *
 * Usage:
 *   npx tsx tools/ccx-analyzer.ts decode <hex>
 *   npx tsx tools/ccx-analyzer.ts types --file <pcapng>
 *   npx tsx tools/ccx-analyzer.ts fields <type> --file <pcapng>
 *   npx tsx tools/ccx-analyzer.ts timeline --file <pcapng>
 *   npx tsx tools/ccx-analyzer.ts devices --file <pcapng>
 *   npx tsx tools/ccx-analyzer.ts compare <type> --file <pcapng>
 *   npx tsx tools/ccx-analyzer.ts unknown --file <pcapng>
 *   npx tsx tools/ccx-analyzer.ts stats --file <pcapng>
 *   npx tsx tools/ccx-analyzer.ts inner <type> --file <pcapng>
 *   npx tsx tools/ccx-analyzer.ts crossref
 */

import { decode as cborDecode } from "cbor-x";
import { spawn } from "child_process";
import {
  CCX_CONFIG,
  getDeviceName,
  getSceneName,
  getSerialName,
  getZoneName,
} from "../ccx/config";
import { CCXMessageTypeName } from "../ccx/constants";
import {
  buildPacket,
  decodeAndParse,
  formatMessage,
  formatRawBody,
  getMessageTypeName,
} from "../ccx/decoder";
import type { CCXPacket } from "../ccx/types";
import { CCX } from "../protocol/ccx.protocol";

// ── CLI argument parsing ────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const pcapFile = getArg("--file");
const _masterKey = getArg("--key") ?? CCX_CONFIG.masterKey;

// ── tshark integration ──────────────────────────────────────────────

/** Run tshark on a pcapng file and return decoded CCX packets */
async function loadPacketsFromPcap(file: string): Promise<CCXPacket[]> {
  return new Promise((resolve, reject) => {
    const tsharkArgs = [
      "-r",
      file,
      "-Y",
      `udp.port == ${CCX_CONFIG.udpPort}`,
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
    ];

    const tshark = spawn("tshark", tsharkArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    tshark.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    tshark.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

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

          packets.push(
            buildPacket({
              timestamp: new Date(epoch * 1000).toISOString(),
              srcAddr: fields[1] ?? "",
              dstAddr: fields[2] ?? "",
              srcEui64: fields[3] ?? "",
              dstEui64: fields[4] ?? "",
              payloadHex,
            }),
          );
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
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

// ── Commands ────────────────────────────────────────────────────────

/** Decode a single CBOR hex string with annotated dump */
function cmdDecode(hex: string) {
  const clean = hex.replace(/[\s:,]/g, "").replace(/^0x/i, "");
  const raw = new Uint8Array(
    clean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
  );

  console.log("\nCCX Message Decode:");
  console.log("===================");
  console.log(`Raw hex: ${clean}`);
  console.log(`Length: ${raw.length} bytes`);

  // Show raw CBOR structure
  let decoded: unknown;
  try {
    decoded = cborDecode(raw);
    console.log(`\nCBOR structure:`);
    console.log(
      JSON.stringify(
        decoded,
        (_, v) => {
          if (v instanceof Uint8Array) return `<bytes:${bytesToHex(v)}>`;
          return v;
        },
        2,
      ),
    );
  } catch (err) {
    console.error(`CBOR decode error: ${(err as Error).message}`);
    return;
  }

  // Parse into typed message
  const msg = decodeAndParse(hex);
  console.log(`\nParsed: ${formatMessage(msg)}`);

  // Annotated CBOR tree using protocol schema
  if (Array.isArray(decoded) && decoded.length >= 2) {
    const msgType = decoded[0] as number;
    const typeName = getMessageTypeName(msgType);
    const typeDef = CCX.messageTypes[typeName];

    console.log(`\nAnnotated CBOR:`);
    console.log(`  [0] = ${msgType} (${typeName})`);
    console.log(`  [1] = Map:`);

    const body = decoded[1] as Record<number, unknown>;
    if (body && typeof body === "object") {
      for (const [k, v] of Object.entries(body)) {
        const key = Number(k);
        // Look up body key name
        const bodyKeyDef = Object.entries(CCX.bodyKeys).find(
          ([, def]) => def.key === key,
        );
        const bodyKeyName = bodyKeyDef ? bodyKeyDef[0] : `UNKNOWN_${key}`;

        if (key === 0 && typeDef?.commandSchema) {
          // Annotate inner command map
          console.log(`    key ${key} (${bodyKeyName}) = Map:`);
          const inner = v as Record<number, unknown>;
          if (inner && typeof inner === "object") {
            for (const [ik, iv] of Object.entries(inner)) {
              const innerKey = Number(ik);
              const fieldDef = typeDef.commandSchema.find(
                (f) => f.key === innerKey,
              );
              const annotation = annotateValue(innerKey, iv, fieldDef);
              console.log(
                `      key ${innerKey}${fieldDef ? ` (${fieldDef.name})` : ""} = ${annotation}`,
              );
            }
          }
        } else if (key === 3 && typeDef?.extraSchema) {
          // Annotate extra map
          console.log(`    key ${key} (${bodyKeyName}) = Map:`);
          const extra = v as Record<number, unknown>;
          if (extra && typeof extra === "object") {
            for (const [ek, ev] of Object.entries(extra)) {
              const extraKey = Number(ek);
              const fieldDef = typeDef.extraSchema.find(
                (f) => f.key === extraKey,
              );
              const annotation = annotateValue(extraKey, ev, fieldDef);
              console.log(
                `      key ${extraKey}${fieldDef ? ` (${fieldDef.name})` : ""} = ${annotation}`,
              );
            }
          }
        } else if (key === 1 && Array.isArray(v) && v.length === 2) {
          // Zone info
          const zoneName = getZoneName(v[1] as number);
          const zoneAnnotation = zoneName ? ` "${zoneName}"` : "";
          console.log(
            `    key ${key} (${bodyKeyName}) = [${v[0]}, ${v[1]}] → zone_type=${v[0]}, zone_id=${v[1]}${zoneAnnotation}`,
          );
        } else if (key === 2 && Array.isArray(v) && v.length === 2) {
          // Device info
          const serialName = getSerialName(v[1] as number);
          const nameAnnotation = serialName ? ` "${serialName}"` : "";
          console.log(
            `    key ${key} (${bodyKeyName}) = [${v[0]}, ${v[1]}]${nameAnnotation}`,
          );
        } else if (key === 5) {
          console.log(`    key ${key} (${bodyKeyName}) = ${v}`);
        } else {
          console.log(
            `    key ${key} (${bodyKeyName}) = ${formatAnnotatedValue(v)}`,
          );
        }
      }
    }
  }

  // Show unknown keys if any
  if (msg.unknownKeys && Object.keys(msg.unknownKeys).length > 0) {
    console.log(
      `\nUnknown keys: ${formatRawBody(msg.unknownKeys as Record<number, unknown>)}`,
    );
  }

  // Type-specific details
  if (msg.type === "LEVEL_CONTROL") {
    const zoneName = getZoneName(msg.zoneId);
    console.log(`\nDetails:`);
    console.log(
      `  Level: 0x${msg.level.toString(16).padStart(4, "0")} (${msg.levelPercent.toFixed(1)}%)`,
    );
    console.log(`  Zone: ${msg.zoneId}${zoneName ? ` (${zoneName})` : ""}`);
    console.log(`  Zone type: ${msg.zoneType}`);
    console.log(`  Fade: ${msg.fade} (${msg.fade / 4}s)`);
    if (msg.delay > 0) console.log(`  Delay: ${msg.delay} (${msg.delay / 4}s)`);
    console.log(`  Sequence: ${msg.sequence}`);
  } else if (msg.type === "BUTTON_PRESS") {
    console.log(`\nDetails:`);
    console.log(`  Device ID: ${bytesToHex(msg.deviceId)}`);
    console.log(
      `  Command type: 0x${msg.cmdType.toString(16).padStart(2, "0")}`,
    );
    console.log(`  Button zone: ${msg.buttonZone}`);
    console.log(`  Counters: [${msg.counters.join(", ")}]`);
    console.log(`  Sequence: ${msg.sequence}`);
  } else if (msg.type === "ACK") {
    console.log(`\nDetails:`);
    console.log(
      `  Response: ${bytesToHex(msg.response)} (0x${msg.responseCode.toString(16).padStart(2, "0")} = '${String.fromCharCode(msg.responseCode)}')`,
    );
    if (msg.responseLabel) console.log(`  Label: ${msg.responseLabel}`);
    console.log(`  Sequence: ${msg.sequence}`);
  } else if (msg.type === "STATUS") {
    const serialName = getSerialName(msg.deviceId);
    console.log(`\nDetails:`);
    console.log(`  Device type: ${msg.deviceType}`);
    console.log(
      `  Device ID: 0x${msg.deviceId.toString(16).padStart(8, "0")}${serialName ? ` (${serialName})` : ""}`,
    );
    console.log(`  Inner data: ${bytesToHex(msg.innerData)}`);
    if (Object.keys(msg.extra).length > 0) {
      console.log(`  Extra fields: ${JSON.stringify(msg.extra)}`);
    }
    console.log(`  Sequence: ${msg.sequence}`);
  } else if (msg.type === "DIM_HOLD" || msg.type === "DIM_STEP") {
    const zoneName = msg.zoneId ? getZoneName(msg.zoneId) : undefined;
    console.log(`\nDetails:`);
    console.log(`  Device ID: ${bytesToHex(msg.deviceId)}`);
    console.log(`  Direction: ${msg.direction ?? `action=${msg.action}`}`);
    if (msg.zoneId)
      console.log(`  Zone: ${msg.zoneId}${zoneName ? ` (${zoneName})` : ""}`);
    if (msg.type === "DIM_STEP") console.log(`  Step value: ${msg.stepValue}`);
    console.log(`  Sequence: ${msg.sequence}`);
  } else if (msg.type === "DEVICE_REPORT") {
    const serialName = getSerialName(msg.deviceSerial);
    console.log(`\nDetails:`);
    console.log(
      `  Serial: ${msg.deviceSerial}${serialName ? ` (${serialName})` : ""}`,
    );
    if (msg.levelPercent !== undefined)
      console.log(`  Level: ${msg.levelPercent.toFixed(1)}%`);
    if (msg.groupId) {
      const sceneName = getSceneName(msg.groupId);
      console.log(
        `  Group: ${msg.groupId}${sceneName ? ` (${sceneName})` : ""}`,
      );
    }
    console.log(`  Sequence: ${msg.sequence}`);
  } else if (msg.type === "SCENE_RECALL") {
    const sceneName = getSceneName(msg.sceneId);
    console.log(`\nDetails:`);
    console.log(`  Scene: ${msg.sceneId}${sceneName ? ` (${sceneName})` : ""}`);
    console.log(`  Command: ${JSON.stringify(msg.command)}`);
    console.log(`  Targets: [${msg.targets.join(", ")}]`);
    console.log(`  Params: [${msg.params.join(", ")}]`);
    console.log(`  Sequence: ${msg.sequence}`);
  }
}

/** Annotate a value with type info from schema */
function annotateValue(
  _key: number,
  value: unknown,
  fieldDef?: { name: string; type: string; unit?: string },
): string {
  let base = formatAnnotatedValue(value);
  if (!fieldDef) return base;

  // Add semantic annotation
  if (fieldDef.name === "level" && typeof value === "number") {
    const pct = ((value / 0xfeff) * 100).toFixed(1);
    base += ` (${pct}%)`;
  } else if (fieldDef.unit === "quarter-seconds" && typeof value === "number") {
    base += ` (${value / 4} seconds)`;
  } else if (fieldDef.name === "device_id" && value instanceof Uint8Array) {
    // Already formatted as hex
  }

  return base;
}

/** Format a single value for annotated display */
function formatAnnotatedValue(v: unknown): string {
  if (v instanceof Uint8Array) {
    return `h'${Array.from(v)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}'`;
  }
  if (typeof v === "number") {
    if (v >= 256) return `${v} (0x${v.toString(16).toUpperCase()})`;
    return String(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map(formatAnnotatedValue).join(", ")}]`;
  }
  if (v !== null && v !== undefined && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${formatAnnotatedValue(val)}`)
      .join(", ");
    return `{${entries}}`;
  }
  return String(v);
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

  for (const [typeId, count] of [...typeCounts.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const name = getMessageTypeName(typeId).padEnd(15);
    const idStr =
      typeId <= 255
        ? `0x${typeId.toString(16).padStart(2, "0").toUpperCase()}`.padEnd(7)
        : String(typeId).padEnd(7);
    console.log(`${idStr}  | ${name} | ${count}`);
  }

  console.log(
    `\nTotal: ${packets.length} packets, ${typeCounts.size} unique types`,
  );
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
    console.error(
      `Known types: ${Object.entries(CCXMessageTypeName)
        .map(([id, name]) => `${name}(${id})`)
        .join(", ")}`,
    );
    process.exit(1);
  }

  const packets = await loadPacketsFromPcap(pcapFile);
  const matched = packets.filter((p) => p.msgType === typeId);

  if (matched.length === 0) {
    console.log(`No packets of type ${typeStr} (${typeId}) found.`);
    return;
  }

  console.log(
    `\nField Analysis for ${getMessageTypeName(typeId)} (${matched.length} packets):`,
  );
  console.log("=".repeat(60));

  // Collect all top-level body keys
  const allKeys = new Set<number>();
  for (const pkt of matched) {
    for (const key of Object.keys(pkt.body)) {
      allKeys.add(Number(key));
    }
  }

  console.log(
    `\nTop-level keys: [${[...allKeys].sort((a, b) => a - b).join(", ")}]`,
  );

  for (const key of [...allKeys].sort((a, b) => a - b)) {
    console.log(`\n  Key ${key}:`);
    const values = matched
      .map((p) => p.body[key])
      .filter((v) => v !== undefined);
    const types = [...new Set(values.map((v) => typeof v))];
    console.log(`    Types: ${types.join(", ")}`);
    console.log(`    Present in: ${values.length}/${matched.length} packets`);

    if (types.includes("number")) {
      const nums = values.filter((v) => typeof v === "number") as number[];
      console.log(`    Range: ${Math.min(...nums)} - ${Math.max(...nums)}`);
      const unique = [...new Set(nums)];
      if (unique.length <= 10) {
        console.log(
          `    Unique values: [${unique.sort((a, b) => a - b).join(", ")}]`,
        );
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

    console.log(`${timeStr} ${deltaStr.padStart(8)} ${src} ${msgStr}`);
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

  const devices = new Map<
    string,
    { count: number; types: Set<string>; lastSeen: string; eui64: string }
  >();

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
          eui64:
            addr === pkt.srcAddr ? (pkt.srcEui64 ?? "") : (pkt.dstEui64 ?? ""),
        });
      }
    }
  }

  console.log("\nDevices Seen:");
  console.log("=============");
  console.log(
    "IPv6 Address                              | Name         | EUI-64           | Packets | Types",
  );
  console.log(
    "------------------------------------------|--------------|------------------|---------|------",
  );

  for (const [addr, info] of [...devices.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    const name = (getDeviceName(addr) ?? "").padEnd(12);
    const eui64 = info.eui64.padEnd(16);
    const types = [...info.types].join(", ");
    console.log(
      `${addr.padEnd(41)} | ${name} | ${eui64} | ${info.count.toString().padStart(7)} | ${types}`,
    );
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
  const matched = packets.filter((p) => p.msgType === typeId);

  if (matched.length < 2) {
    console.log(
      `Not enough ${typeStr} packets to compare (found ${matched.length})`,
    );
    return;
  }

  console.log(
    `\nComparing ${matched.length} ${getMessageTypeName(typeId)} packets:`,
  );
  console.log("=".repeat(50));

  // Compare raw hex bytes
  const hexArrays = matched.map((p) => {
    const clean = p.rawHex.replace(/\s/g, "");
    return clean.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [];
  });

  const maxLen = Math.max(...hexArrays.map((a) => a.length));
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
      variablePositions.has(i)
        ? ".."
        : b.toString(16).padStart(2, "0").toUpperCase(),
    );
    console.log(
      "Pos: " + first.map((_, i) => i.toString().padStart(2, "0")).join(" "),
    );
    console.log("Val: " + display.join(" "));
  }

  console.log(
    `\nVariable byte positions: [${[...variablePositions].sort((a, b) => a - b).join(", ")}]`,
  );

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

  // Find truly unknown types
  const unknowns = packets.filter((p) => p.parsed.type === "UNKNOWN");

  // Find messages with unknown keys (known types but unexpected fields)
  const withUnknownKeys = packets.filter(
    (p) =>
      p.parsed.type !== "UNKNOWN" &&
      p.parsed.unknownKeys &&
      Object.keys(p.parsed.unknownKeys).length > 0,
  );

  if (unknowns.length === 0 && withUnknownKeys.length === 0) {
    console.log("\nNo unknown message types or fields found.");
    console.log(
      `All ${packets.length} packets matched known types with no extra keys.`,
    );
    return;
  }

  if (unknowns.length > 0) {
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

    for (const [typeId, pkts] of [...byType.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      console.log(
        `\nType ${typeId} (0x${typeId.toString(16)}): ${pkts.length} packets`,
      );

      // Show CBOR structure of first example
      console.log("  Example CBOR:");
      const raw = new Uint8Array(
        pkts[0].rawHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
      );
      try {
        const decoded = cborDecode(raw);
        console.log(
          "  " +
            JSON.stringify(
              decoded,
              (_, v) => {
                if (v instanceof Uint8Array) return `<bytes:${bytesToHex(v)}>`;
                return v;
              },
              2,
            ).replace(/\n/g, "\n  "),
        );
      } catch {
        console.log(`  Raw hex: ${pkts[0].rawHex}`);
      }

      // Show all unique body keys
      const allKeys = new Set<number>();
      for (const pkt of pkts) {
        for (const key of Object.keys(pkt.body)) allKeys.add(Number(key));
      }
      console.log(
        `  Body keys: [${[...allKeys].sort((a, b) => a - b).join(", ")}]`,
      );
    }
  }

  if (withUnknownKeys.length > 0) {
    console.log(
      `\nKnown types with unknown body keys (${withUnknownKeys.length} packets):`,
    );
    console.log("=".repeat(50));

    // Group by type
    const byType = new Map<string, { count: number; keys: Set<string> }>();
    for (const pkt of withUnknownKeys) {
      const type = pkt.parsed.type;
      const existing = byType.get(type);
      const keySet = new Set(Object.keys(pkt.parsed.unknownKeys!).map(String));
      if (existing) {
        existing.count++;
        for (const k of keySet) existing.keys.add(k);
      } else {
        byType.set(type, { count: 1, keys: keySet });
      }
    }

    for (const [type, info] of byType) {
      console.log(
        `  ${type}: ${info.count} packets, unknown keys: [${[...info.keys].join(", ")}]`,
      );
    }
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
  const srcAddrs = new Set(packets.map((p) => p.srcAddr).filter(Boolean));
  const dstAddrs = new Set(packets.map((p) => p.dstAddr).filter(Boolean));
  const allAddrs = new Set([...srcAddrs, ...dstAddrs]);

  // Time range
  const times = packets.map((p) => new Date(p.timestamp).getTime());
  const firstTime = Math.min(...times);
  const lastTime = Math.max(...times);
  const durationMs = lastTime - firstTime;

  // Zone stats
  const zones = new Set<number>();
  for (const pkt of packets) {
    if (pkt.parsed.type === "LEVEL_CONTROL") zones.add(pkt.parsed.zoneId);
    if (pkt.parsed.type === "DIM_HOLD" && pkt.parsed.zoneId)
      zones.add(pkt.parsed.zoneId);
    if (pkt.parsed.type === "DIM_STEP" && pkt.parsed.zoneId)
      zones.add(pkt.parsed.zoneId);
  }

  console.log("\nCCX Capture Statistics:");
  console.log("=======================");
  console.log(`Total packets: ${packets.length}`);
  console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(
    `Packet rate: ${(packets.length / (durationMs / 1000)).toFixed(1)} pkt/s`,
  );
  console.log(
    `Unique addresses: ${allAddrs.size} (${srcAddrs.size} sources, ${dstAddrs.size} destinations)`,
  );
  console.log(
    `Unique zones: ${zones.size}${zones.size > 0 ? ` (${[...zones].join(", ")})` : ""}`,
  );
  console.log(`\nMessage type distribution:`);

  for (const [typeId, count] of [...typeCounts.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    const name = getMessageTypeName(typeId);
    const pct = ((count / packets.length) * 100).toFixed(1);
    const bar = "#".repeat(Math.round((count / packets.length) * 40));
    console.log(
      `  ${name.padEnd(16)} ${count.toString().padStart(5)} (${pct.padStart(5)}%) ${bar}`,
    );
  }
}

// ── Phase 4A: inner command map explorer ────────────────────────────

/** Analyze inner command maps for a given message type */
async function cmdInner(typeStr: string) {
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
  const matched = packets.filter((p) => p.msgType === typeId);

  if (matched.length === 0) {
    console.log(`No packets of type ${typeStr} (${typeId}) found.`);
    return;
  }

  console.log(
    `\nInner Command Map Analysis for ${getMessageTypeName(typeId)} (${matched.length} packets):`,
  );
  console.log("=".repeat(60));

  // Catalog inner keys
  const innerStats = new Map<
    number,
    {
      count: number;
      types: Set<string>;
      values: unknown[];
      subKeys?: Map<
        number,
        { count: number; types: Set<string>; values: unknown[] }
      >;
    }
  >();

  for (const pkt of matched) {
    const inner = pkt.body[0]; // BodyKey.COMMAND = 0
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) continue;

    for (const [k, v] of Object.entries(inner as Record<number, unknown>)) {
      const key = Number(k);
      let stat = innerStats.get(key);
      if (!stat) {
        stat = { count: 0, types: new Set(), values: [] };
        innerStats.set(key, stat);
      }
      stat.count++;
      stat.types.add(typeOfValue(v));
      if (stat.values.length < 20) stat.values.push(v);

      // Recurse into nested maps
      if (
        v !== null &&
        v !== undefined &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        !(v instanceof Uint8Array)
      ) {
        if (!stat.subKeys) stat.subKeys = new Map();
        for (const [sk, sv] of Object.entries(v as Record<number, unknown>)) {
          const subKey = Number(sk);
          let sub = stat.subKeys.get(subKey);
          if (!sub) {
            sub = { count: 0, types: new Set(), values: [] };
            stat.subKeys.set(subKey, sub);
          }
          sub.count++;
          sub.types.add(typeOfValue(sv));
          if (sub.values.length < 20) sub.values.push(sv);
        }
      }
    }
  }

  // Show schema reference if available
  const typeName = getMessageTypeName(typeId);
  const typeDef = CCX.messageTypes[typeName];
  if (typeDef?.commandSchema) {
    console.log(`\nDocumented command schema:`);
    for (const f of typeDef.commandSchema) {
      console.log(
        `  key ${f.key} (${f.name}): ${f.type}${f.description ? ` — ${f.description}` : ""}`,
      );
    }
  }

  console.log(
    `\nObserved inner keys: [${[...innerStats.keys()].sort((a, b) => a - b).join(", ")}]`,
  );

  for (const [key, stat] of [...innerStats.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const schemaField = typeDef?.commandSchema?.find((f) => f.key === key);
    const nameStr = schemaField ? ` (${schemaField.name})` : "";

    console.log(`\n  Key ${key}${nameStr}:`);
    console.log(
      `    Present: ${stat.count}/${matched.length} (${((stat.count / matched.length) * 100).toFixed(0)}%)`,
    );
    console.log(`    Types: ${[...stat.types].join(", ")}`);

    // Show value summary
    const uniqueRepr = new Set(stat.values.map((v) => formatAnnotatedValue(v)));
    if (uniqueRepr.size <= 10) {
      console.log(`    Values: ${[...uniqueRepr].join(", ")}`);
    } else {
      console.log(`    Unique values: ${uniqueRepr.size}`);
      console.log(`    Examples: ${[...uniqueRepr].slice(0, 5).join(", ")}`);
    }

    // Show sub-keys
    if (stat.subKeys && stat.subKeys.size > 0) {
      console.log(`    Sub-keys:`);
      for (const [sk, sub] of [...stat.subKeys.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        const subUnique = new Set(
          sub.values.map((v) => formatAnnotatedValue(v)),
        );
        const valStr =
          subUnique.size <= 5
            ? [...subUnique].join(", ")
            : `${subUnique.size} unique`;
        console.log(
          `      [${sk}]: ${[...sub.types].join("/")} (${sub.count}x) — ${valStr}`,
        );
      }
    }
  }
}

/** Get type description for a value */
function typeOfValue(v: unknown): string {
  if (v instanceof Uint8Array) return `bytes(${v.length})`;
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v !== null && v !== undefined && typeof v === "object")
    return `map(${Object.keys(v).length})`;
  return typeof v;
}

// ── Phase 4B: crossref command ──────────────────────────────────────

/** Print known CCA↔CCX structural parallels */
function cmdCrossref() {
  console.log("\nCCA ↔ CCX Protocol Cross-Reference:");
  console.log("====================================");
  console.log("");
  console.log(
    "Concept              │ CCA (433 MHz FSK)              │ CCX (Thread/CBOR)",
  );
  console.log(
    "─────────────────────┼────────────────────────────────┼────────────────────────────────",
  );
  console.log(
    "Zone level set       │ Type 0x0E, format byte         │ Type 0 (LEVEL_CONTROL)",
  );
  console.log(
    "  level              │   byte 11-12: level16 BE       │   body[0][0]: uint16",
  );
  console.log(
    "  fade               │   byte 19: quarter-seconds     │   body[0][3]: quarter-seconds",
  );
  console.log(
    "  delay              │   byte 20: quarter-seconds     │   body[0][4]: quarter-seconds",
  );
  console.log(
    "  zone id            │   byte 9-10: BE                │   body[1][1]: zone_id",
  );
  console.log(
    "─────────────────────┼────────────────────────────────┼────────────────────────────────",
  );
  console.log(
    "Button press         │ Pico type 0x80                 │ Type 1 (BUTTON_PRESS)",
  );
  console.log(
    "  device id          │   byte 1-3: device_id LE      │   body[0][0]: bytes(4)",
  );
  console.log(
    "  counters           │   —                            │   body[0][1]: array[uint]",
  );
  console.log(
    "─────────────────────┼────────────────────────────────┼────────────────────────────────",
  );
  console.log(
    "Dim hold / raise     │ —                              │ Type 2 (DIM_HOLD)",
  );
  console.log(
    "Dim step / release   │ —                              │ Type 3 (DIM_STEP)",
  );
  console.log(
    "  direction          │   —                            │   body[0][1]: 2=lower, 3=raise",
  );
  console.log(
    "─────────────────────┼────────────────────────────────┼────────────────────────────────",
  );
  console.log(
    "ACK                  │ Type 0x0E dimmer ACK format    │ Type 7 (ACK)",
  );
  console.log(
    "  response           │   —                            │   body[0][1][0]: 0x50/0x55",
  );
  console.log(
    "─────────────────────┼────────────────────────────────┼────────────────────────────────",
  );
  console.log(
    "Device report        │ —                              │ Type 27 (DEVICE_REPORT)",
  );
  console.log(
    "  device serial      │   —                            │   body[2][1]: serial number",
  );
  console.log(
    "  group/scene        │   —                            │   body[3][1]: group_id",
  );
  console.log(
    "─────────────────────┼────────────────────────────────┼────────────────────────────────",
  );
  console.log(
    "Scene recall         │ —                              │ Type 36 (SCENE_RECALL)",
  );
  console.log(
    "  recall vector      │   —                            │   body[0][0]: fixed-length byte vector in transfer captures",
  );
  console.log(
    "  scene family/id    │   —                            │   body[3][0]/body[3][1]: shared scene/group namespace",
  );
  console.log(
    "─────────────────────┼────────────────────────────────┼────────────────────────────────",
  );
  console.log(
    "Status               │ —                              │ Type 41 (STATUS)",
  );
  console.log(
    "  scene family       │   —                            │   body[3][1]: recurring scene/group-family ID",
  );
  console.log(
    "─────────────────────┼────────────────────────────────┼────────────────────────────────",
  );
  console.log(
    "Level encoding       │ level16 = pct * 0xFEFF / 100  │ Same (0x0000-0xFEFF)",
  );
  console.log(
    "Fade encoding        │ byte = seconds * 4             │ Same (quarter-seconds)",
  );
  console.log(
    "Sequence             │ —                              │ body[5]: 8-bit wrap",
  );
  console.log(
    "OUTPUT vs DEVICE     │ format-byte split              │ type-code split",
  );
  console.log("");
  console.log(
    "Key insight: CCA's QS Link design (2009) is reused in CCX with CBOR framing.",
  );
  console.log(
    "Level encoding, fade encoding, and the OUTPUT/DEVICE split are identical.",
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Resolve a type name or numeric ID to a message type ID */
function resolveTypeId(typeStr: string): number | undefined {
  // Try numeric
  const num = parseInt(typeStr, 10);
  if (!Number.isNaN(num)) return num;

  // Try hex
  if (typeStr.startsWith("0x")) {
    const hex = parseInt(typeStr, 16);
    if (!Number.isNaN(hex)) return hex;
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
        const hex = args
          .slice(1)
          .filter((a) => !a.startsWith("--"))
          .join("");
        if (!hex) {
          console.log("Usage: ccx-analyzer.ts decode <hex>");
          console.log(
            'Example: ccx-analyzer.ts decode "8200a300a20019feff03010182101903c105185c"',
          );
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

      case "inner": {
        const typeStr = args[1];
        if (!typeStr || typeStr.startsWith("--")) {
          console.log("Usage: ccx-analyzer.ts inner <type> --file <pcapng>");
          process.exit(1);
        }
        await cmdInner(typeStr);
        break;
      }

      case "crossref":
        cmdCrossref();
        break;

      default:
        console.log(`
CCX Packet Analyzer - Reverse Engineering Helper

Commands:
  decode <hex>                     Decode a single CBOR message with annotated CBOR tree
  types --file <pcapng>            Catalog all unique message types from a capture
  fields <type> --file <pcapng>    Analyze field patterns for a specific message type
  timeline --file <pcapng>         Show packet timeline with timing analysis
  devices --file <pcapng>          List unique IPv6 addresses / devices
  compare <type> --file <pcapng>   Find constant vs variable fields across messages
  unknown --file <pcapng>          Highlight unrecognized types + unexpected body keys
  stats --file <pcapng>            Summary statistics
  inner <type> --file <pcapng>     Explore inner command maps (body key 0) across packets
  crossref                         Print known CCA↔CCX structural parallels

Options:
  --file <pcapng>   Input capture file (processed via tshark)
  --key <hex>       Thread master key (default: from config)

Type names: ${Object.values(CCXMessageTypeName).join(", ")}

Examples:
  npx tsx tools/ccx-analyzer.ts decode "8200a300a20019feff03010182101903c105185c"
  npx tsx tools/ccx-analyzer.ts types --file captures/ccx-onoff.pcapng
  npx tsx tools/ccx-analyzer.ts inner DEVICE_REPORT --file captures/ccx-full.pcapng
  npx tsx tools/ccx-analyzer.ts crossref
`);
    }
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

main();
