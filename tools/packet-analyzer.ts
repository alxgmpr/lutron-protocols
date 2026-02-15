#!/usr/bin/env bun
/**
 * CCA Packet Analyzer - Helper tool for reverse engineering
 *
 * Usage:
 *   bun run tools/packet-analyzer.ts fetch [--limit N] [--type TYPE]
 *   bun run tools/packet-analyzer.ts compare <type>
 *   bun run tools/packet-analyzer.ts diff <packet1_hex> <packet2_hex>
 *   bun run tools/packet-analyzer.ts decode <hex>
 *   bun run tools/packet-analyzer.ts timeline [--limit N]
 *   bun run tools/packet-analyzer.ts devices
 *   bun run tools/packet-analyzer.ts unknown
 */

const API_BASE = process.env.CCA_API || "http://localhost:5001";

interface Packet {
  time: string;
  type: string;
  summary: string;
  details: string[];
  rawBytes?: string;
  direction: "tx" | "rx";
  fields?: Array<{ name: string; offset: number; size: number; value: string }>;
  crcOk?: boolean;
}

// Known packet types for reference
const KNOWN_TYPES: Record<number, string> = {
  0x80: "STATE_80",
  0x81: "STATE_RPT_81",
  0x82: "STATE_RPT_82",
  0x83: "STATE_RPT_83",
  0x88: "BTN_PRESS_A",
  0x89: "BTN_RELEASE_A",
  0x8a: "BTN_PRESS_B",
  0x8b: "BTN_RELEASE_B",
  0x91: "BEACON_91",
  0x92: "BEACON_92",
  0x93: "BEACON_93",
  0xa1: "CONFIG_A1",
  0xa2: "SET_LEVEL",
  0xb0: "PAIR_B0",
  0xb8: "PAIR_B8",
  0xb9: "PAIR_B9",
  0xba: "PAIR_BA",
  0xbb: "PAIR_BB",
  0xc0: "PAIR_RESP",
  0xc1: "HS_C1",
  0xc2: "HS_C2",
  0xc7: "HS_C7",
  0xc8: "HS_C8",
  0xcd: "HS_CD",
  0xce: "HS_CE",
  0xd3: "HS_D3",
  0xd4: "HS_D4",
  0xd9: "HS_D9",
  0xda: "HS_DA",
  0xdf: "HS_DF",
  0xe0: "HS_E0",
};

async function fetchPackets(
  limit: number = 100,
  type?: string,
): Promise<Packet[]> {
  const url = new URL(`${API_BASE}/api/packets`);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Failed to fetch packets: ${res.status}`);

  let packets: Packet[] = await res.json();

  if (type) {
    packets = packets.filter((p) =>
      p.type.toLowerCase().includes(type.toLowerCase()),
    );
  }

  return packets;
}

function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/\s+/g, "").replace(/0x/gi, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substr(i, 2), 16));
  }
  return bytes;
}

function bytesToHex(bytes: number[]): string {
  return bytes
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function formatDeviceId(
  bytes: number[],
  littleEndian: boolean = false,
): string {
  if (littleEndian) {
    return (
      "0x" +
      [...bytes]
        .reverse()
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase()
    );
  }
  return (
    "0x" +
    bytes
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

// Compare two hex strings and highlight differences
function diffPackets(hex1: string, hex2: string): void {
  const bytes1 = hexToBytes(hex1);
  const bytes2 = hexToBytes(hex2);
  const maxLen = Math.max(bytes1.length, bytes2.length);

  console.log("\nPacket Comparison:");
  console.log("==================");
  console.log("Offset | Packet 1 | Packet 2 | Diff");
  console.log("-------|----------|----------|------");

  const diffs: number[] = [];
  for (let i = 0; i < maxLen; i++) {
    const b1 = bytes1[i] ?? null;
    const b2 = bytes2[i] ?? null;
    const isDiff = b1 !== b2;

    if (isDiff) diffs.push(i);

    const b1Str =
      b1 !== null ? b1.toString(16).padStart(2, "0").toUpperCase() : "--";
    const b2Str =
      b2 !== null ? b2.toString(16).padStart(2, "0").toUpperCase() : "--";
    const diffMarker = isDiff ? " <--" : "";

    console.log(
      `  ${i.toString().padStart(2, "0")}   |    ${b1Str}    |    ${b2Str}    |${diffMarker}`,
    );
  }

  console.log("\nDifferent bytes at offsets:", diffs.join(", "));

  // Analyze common difference patterns
  if (diffs.includes(1)) {
    console.log("  - Offset 1: Likely sequence number");
  }
  if (diffs.some((d) => d >= 2 && d <= 5)) {
    console.log("  - Offsets 2-5: Likely device ID");
  }
}

// Decode a single packet with annotations
function decodePacket(hex: string): void {
  const bytes = hexToBytes(hex);

  console.log("\nPacket Decode:");
  console.log("==============");
  console.log(
    `Length: ${bytes.length} bytes (${bytes.length === 24 ? "short" : bytes.length === 53 ? "long" : "unusual"})`,
  );

  if (bytes.length < 6) {
    console.log("Packet too short to decode");
    return;
  }

  const typeCode = bytes[0];
  const typeName = KNOWN_TYPES[typeCode] || "UNKNOWN";
  const seq = bytes[1];
  const deviceIdBytes = bytes.slice(2, 6);

  console.log(`\nType: 0x${typeCode.toString(16).toUpperCase()} (${typeName})`);
  console.log(`Sequence: 0x${seq.toString(16).toUpperCase()} (${seq})`);
  console.log(`Device ID (BE): ${formatDeviceId(deviceIdBytes, false)}`);
  console.log(`Device ID (LE): ${formatDeviceId(deviceIdBytes, true)}`);

  // Check if this looks like a bridge/dimmer ID
  if (deviceIdBytes[0] === 0x00) {
    const zone = deviceIdBytes.slice(1, 3).reverse();
    console.log(
      `  -> Bridge format: Zone ${zone.map((b) => b.toString(16).padStart(2, "0")).join("")}, Suffix ${deviceIdBytes[3].toString(16).padStart(2, "0")}`,
    );
  } else if (deviceIdBytes[0] === 0x06) {
    const zone = deviceIdBytes.slice(1, 3).reverse();
    console.log(
      `  -> Dimmer format: Zone ${zone.map((b) => b.toString(16).padStart(2, "0")).join("")}, Suffix ${deviceIdBytes[3].toString(16).padStart(2, "0")}`,
    );
  }

  // Type-specific decoding
  if (typeCode >= 0x88 && typeCode <= 0x8b) {
    // Button packet
    if (bytes.length > 6) {
      const buttonByte = bytes[6];
      const buttons: Record<number, string> = {
        0x02: "ON",
        0x03: "FAV",
        0x04: "OFF",
        0x05: "RAISE",
        0x06: "LOWER",
        0x08: "SCENE1",
        0x09: "SCENE2",
        0x0a: "SCENE3",
        0x0b: "SCENE4",
      };
      const actions: Record<number, string> = {
        0x00: "PRESS",
        0x01: "RELEASE",
        0x02: "HOLD",
        0x03: "SAVE",
      };
      const button = buttonByte & 0x0f;
      const action = (buttonByte >> 4) & 0x0f;
      console.log(
        `Button: ${buttons[button] || `0x${button.toString(16)}`} (${actions[action] || `0x${action.toString(16)}`})`,
      );
    }
  } else if (typeCode >= 0x80 && typeCode <= 0x83) {
    // State report - may contain level
    if (bytes.length > 8) {
      const level = bytes[8];
      const pct = Math.round((level / 254) * 100);
      console.log(
        `Level byte at offset 8: 0x${level.toString(16).toUpperCase()} (${pct}%)`,
      );
    }
  } else if (typeCode === 0xa2) {
    // SET_LEVEL
    console.log("\nSET_LEVEL packet fields:");
    if (bytes.length > 10) {
      console.log(`  Target ID: ${formatDeviceId(bytes.slice(6, 10), true)}`);
      if (bytes.length > 12) {
        const level16 = (bytes[10] << 8) | bytes[11];
        const pct = Math.round((level16 / 65279) * 100);
        console.log(
          `  Level (16-bit): 0x${level16.toString(16).toUpperCase()} (${pct}%)`,
        );
      }
    }
  }

  // Raw hex with byte positions
  console.log("\nRaw bytes with positions:");
  console.log(
    "Pos: " + bytes.map((_, i) => i.toString().padStart(2, "0")).join(" "),
  );
  console.log("Hex: " + bytesToHex(bytes));
}

// Show packet timeline with timing analysis
async function showTimeline(limit: number): Promise<void> {
  const packets = await fetchPackets(limit);

  console.log("\nPacket Timeline:");
  console.log("================");

  let lastTime: Date | null = null;

  for (const pkt of packets.reverse()) {
    const time = new Date(pkt.time);
    const delta = lastTime ? time.getTime() - lastTime.getTime() : 0;
    lastTime = time;

    const dir = pkt.direction === "tx" ? ">>>" : "<<<";
    const timeStr = time.toISOString().substr(11, 12);
    const deltaStr = delta > 0 ? `+${delta}ms` : "";

    console.log(
      `${timeStr} ${deltaStr.padStart(8)} ${dir} ${pkt.type.padEnd(12)} ${pkt.summary}`,
    );
  }
}

// List unique devices seen
async function listDevices(): Promise<void> {
  const packets = await fetchPackets(500);

  const devices = new Map<
    string,
    { type: string; count: number; lastSeen: string }
  >();

  for (const pkt of packets) {
    // Extract device ID from summary or fields
    const match = pkt.summary.match(/0x[0-9A-Fa-f]{8}/);
    if (match) {
      const id = match[0].toUpperCase();
      const existing = devices.get(id);
      if (existing) {
        existing.count++;
        existing.lastSeen = pkt.time;
      } else {
        devices.set(id, { type: pkt.type, count: 1, lastSeen: pkt.time });
      }
    }
  }

  console.log("\nDevices Seen:");
  console.log("=============");
  console.log("Device ID    | Type         | Packets | Last Seen");
  console.log("-------------|--------------|---------|----------");

  for (const [id, info] of devices) {
    console.log(
      `${id} | ${info.type.padEnd(12)} | ${info.count.toString().padStart(7)} | ${new Date(info.lastSeen).toISOString().substr(11, 12)}`,
    );
  }
}

// Find unknown/unrecognized packet types
async function findUnknown(): Promise<void> {
  const packets = await fetchPackets(500);

  const unknownTypes = new Map<string, number>();

  for (const pkt of packets) {
    if (pkt.type === "UNKNOWN" || pkt.type.includes("?")) {
      const bytes = pkt.rawBytes ? hexToBytes(pkt.rawBytes) : [];
      const typeCode =
        bytes[0]?.toString(16).toUpperCase().padStart(2, "0") || "??";
      const key = `0x${typeCode}`;
      unknownTypes.set(key, (unknownTypes.get(key) || 0) + 1);
    }
  }

  if (unknownTypes.size === 0) {
    console.log("\nNo unknown packet types found in recent history.");
    return;
  }

  console.log("\nUnknown Packet Types:");
  console.log("=====================");
  for (const [type, count] of unknownTypes) {
    console.log(`${type}: ${count} packets`);
  }

  // Show examples
  console.log("\nExamples of unknown packets:");
  const unknownPackets = packets
    .filter((p) => p.type === "UNKNOWN" || p.type.includes("?"))
    .slice(0, 5);
  for (const pkt of unknownPackets) {
    console.log(`\n${pkt.direction.toUpperCase()} at ${pkt.time}:`);
    console.log(`  ${pkt.rawBytes}`);
  }
}

// Compare packets of the same type to find variable fields
async function compareByType(type: string): Promise<void> {
  const packets = await fetchPackets(200, type);

  if (packets.length < 2) {
    console.log(
      `Not enough ${type} packets to compare (found ${packets.length})`,
    );
    return;
  }

  console.log(`\nComparing ${packets.length} ${type} packets:`);
  console.log("=".repeat(40));

  // Find constant vs variable bytes
  const firstBytes = hexToBytes(packets[0].rawBytes || "");
  const variablePositions = new Set<number>();

  for (const pkt of packets.slice(1)) {
    const bytes = hexToBytes(pkt.rawBytes || "");
    for (let i = 0; i < Math.max(firstBytes.length, bytes.length); i++) {
      if (firstBytes[i] !== bytes[i]) {
        variablePositions.add(i);
      }
    }
  }

  console.log("\nConstant bytes (same in all packets):");
  const constantBytes = firstBytes.map((b, i) =>
    variablePositions.has(i)
      ? ".."
      : b.toString(16).padStart(2, "0").toUpperCase(),
  );
  console.log(
    "Pos: " + firstBytes.map((_, i) => i.toString().padStart(2, "0")).join(" "),
  );
  console.log("Val: " + constantBytes.join(" "));

  console.log(
    "\nVariable positions:",
    [...variablePositions].sort((a, b) => a - b).join(", "),
  );

  // Show range of values at variable positions
  console.log("\nValue ranges at variable positions:");
  for (const pos of [...variablePositions].sort((a, b) => a - b)) {
    const values = packets
      .map((p) => hexToBytes(p.rawBytes || "")[pos])
      .filter((v) => v !== undefined);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const unique = [...new Set(values)].sort((a, b) => a - b);
    console.log(
      `  Offset ${pos}: min=0x${min.toString(16).toUpperCase().padStart(2, "0")}, max=0x${max.toString(16).toUpperCase().padStart(2, "0")}, unique=${unique.length}`,
    );
  }
}

// Main CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case "fetch": {
        const limitIdx = args.indexOf("--limit");
        const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 50;
        const typeIdx = args.indexOf("--type");
        const type = typeIdx !== -1 ? args[typeIdx + 1] : undefined;

        const packets = await fetchPackets(limit, type);
        console.log(JSON.stringify(packets, null, 2));
        break;
      }

      case "compare": {
        const type = args[1];
        if (!type) {
          console.log("Usage: packet-analyzer.ts compare <type>");
          console.log("Example: packet-analyzer.ts compare BTN_SHORT");
          process.exit(1);
        }
        await compareByType(type);
        break;
      }

      case "diff": {
        const hex1 = args[1];
        const hex2 = args[2];
        if (!hex1 || !hex2) {
          console.log("Usage: packet-analyzer.ts diff <hex1> <hex2>");
          process.exit(1);
        }
        diffPackets(hex1, hex2);
        break;
      }

      case "decode": {
        const hex = args.slice(1).join(" ");
        if (!hex) {
          console.log("Usage: packet-analyzer.ts decode <hex>");
          process.exit(1);
        }
        decodePacket(hex);
        break;
      }

      case "timeline": {
        const limitIdx = args.indexOf("--limit");
        const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 50;
        await showTimeline(limit);
        break;
      }

      case "devices": {
        await listDevices();
        break;
      }

      case "unknown": {
        await findUnknown();
        break;
      }

      default:
        console.log(`
CCA Packet Analyzer - Reverse Engineering Helper

Commands:
  fetch [--limit N] [--type TYPE]  Fetch recent packets (JSON output)
  compare <type>                   Compare packets of same type to find variable fields
  diff <hex1> <hex2>               Compare two packet hex strings byte-by-byte
  decode <hex>                     Decode a single packet with annotations
  timeline [--limit N]             Show packet timeline with timing analysis
  devices                          List unique devices seen in recent packets
  unknown                          Find and display unknown packet types

Environment:
  CCA_API                          Backend API URL (default: http://localhost:5001)

Examples:
  bun run tools/packet-analyzer.ts fetch --limit 20 --type BTN
  bun run tools/packet-analyzer.ts compare STATE_RPT
  bun run tools/packet-analyzer.ts decode "88 0C 05 95 E6 8D 02 00 00..."
  bun run tools/packet-analyzer.ts timeline --limit 100
`);
    }
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
