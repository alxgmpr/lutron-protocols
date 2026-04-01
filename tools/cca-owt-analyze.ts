#!/usr/bin/env npx tsx

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { identifyPacket, parseLux16bit } from "../protocol/protocol-ui";

interface CaptureRow {
  timestamp: string;
  direction: string;
  protocol: string;
  csvType: string;
  deviceId: string;
  rssi: number;
  rawHex: string;
}

interface MatchedPacket extends CaptureRow {
  bytes: number[];
  typeName: string;
  formatByte: number | null;
  matchOffsetsBe: number[];
  matchOffsetsLe: number[];
}

interface GroupSummary {
  key: string;
  direction: string;
  typeName: string;
  formatByte: number | null;
  length: number;
  packets: MatchedPacket[];
}

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const DEFAULT_CAPTURE_DIR = join(__dir, "../captures/cca-sessions");
const DEFAULT_SHOW = 8;

function usage(): never {
  console.log(`CCA OWT Capture Analyzer

Usage:
  bun run tools/cca-owt-analyze.ts [capture.csv] --serial <8-hex> [--show N]

Examples:
  bun run tools/cca-owt-analyze.ts --serial 00c7e498
  bun run tools/cca-owt-analyze.ts captures/cca-sessions/daylight.csv --serial 00c7e498 --show 12

Notes:
  - If no capture path is provided, the newest file in captures/cca-sessions/ is used.
  - Matching checks both big-endian (00 C7 E4 98) and little-endian (98 E4 C7 00) forms.
`);
  process.exit(1);
}

function normalizeSerial(input: string): string {
  const clean = input.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (clean.length !== 8) {
    throw new Error(`Serial must be exactly 8 hex digits, got "${input}"`);
  }
  return clean;
}

function serialToBytes(serial: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < serial.length; i += 2) {
    bytes.push(Number.parseInt(serial.slice(i, i + 2), 16));
  }
  return bytes;
}

function hexToBytes(rawHex: string): number[] {
  const clean = rawHex.replace(/[^0-9a-f]/gi, "");
  if (clean.length === 0 || clean.length % 2 !== 0) return [];
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

function findNeedleOffsets(haystack: number[], needle: number[]): number[] {
  const offsets: number[] = [];
  if (needle.length === 0 || haystack.length < needle.length) return offsets;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) offsets.push(i);
  }
  return offsets;
}

function parseCaptureRow(line: string): CaptureRow | null {
  const parts = line.split(",");
  if (parts.length < 7) return null;
  const [timestamp, direction, protocol, csvType, deviceId, rssiText, ...rest] =
    parts;
  return {
    timestamp,
    direction,
    protocol,
    csvType,
    deviceId: deviceId.toUpperCase(),
    rssi: Number.parseInt(rssiText, 10) || 0,
    rawHex: rest.join(",").trim(),
  };
}

function getLatestCaptureFile(dir: string): string {
  if (!existsSync(dir)) {
    throw new Error(`Capture directory does not exist: ${dir}`);
  }
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith(".csv"))
    .map((name) => {
      const fullPath = join(dir, name);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (entries.length === 0) {
    throw new Error(`No capture CSV files found in ${dir}`);
  }
  return entries[0].fullPath;
}

function formatByte(value: number | null): string {
  return value === null
    ? "--"
    : `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function formatOffsets(offsets: number[]): string {
  return offsets.length > 0 ? offsets.join(", ") : "none";
}

function headerDeviceId(bytes: number[]): string {
  return bytes.length >= 6
    ? bytes
        .slice(2, 6)
        .map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
        .join("")
    : "";
}

function summarizeIntervals(packets: MatchedPacket[]): string {
  if (packets.length < 2) return "n/a";
  const times = packets
    .map((pkt) => Date.parse(pkt.timestamp))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    deltas.push(times[i] - times[i - 1]);
  }
  if (deltas.length === 0) return "n/a";
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return `min=${sorted[0]}ms median=${median}ms max=${sorted[sorted.length - 1]}ms`;
}

function summarizeVariablePositions(packets: MatchedPacket[]): string[] {
  if (packets.length < 2) return [];
  const maxLength = Math.max(...packets.map((pkt) => pkt.bytes.length));
  const lines: string[] = [];

  for (let pos = 0; pos < maxLength; pos++) {
    if (pos === 1 || pos >= maxLength - 2) continue;

    const values = packets
      .map((pkt) => pkt.bytes[pos])
      .filter((value): value is number => value !== undefined);
    const uniqueValues = [...new Set(values)].sort((a, b) => a - b);
    if (uniqueValues.length <= 1) continue;
    const label = `byte ${pos}`;

    const preview = uniqueValues
      .slice(0, 8)
      .map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
    const suffix = uniqueValues.length > 8 ? " ..." : "";
    lines.push(`${label}: ${preview}${suffix}`);
  }

  return lines;
}

/** Decode sensor-specific payload for format 0x0B (light level) and 0x09 (test) */
function decodeSensorPayload(bytes: number[]): string | null {
  if (bytes.length < 19) return null;
  const fmt = bytes[7];
  if (fmt === 0x0b) {
    const frame = bytes[8];
    const subtype = bytes[10];
    // Occupancy sensor: frame=0x03, subtype=0x04
    if (frame === 0x03 && subtype === 0x04) {
      const event = bytes[11];
      return event === 0x01
        ? "OCCUPIED"
        : `occupancy event=0x${event.toString(16).padStart(2, "0")}`;
    }
    // Daylight sensor: frame=0x00 (normal reading) or 0x03 with subtype=0x01 (calibration)
    const luxHi =
      bytes[16]?.toString(16).toUpperCase().padStart(2, "0") ?? "00";
    const luxLo =
      bytes[17]?.toString(16).toUpperCase().padStart(2, "0") ?? "00";
    const lux = parseLux16bit([luxHi, luxLo]);
    const flags = bytes[18] ?? 0;
    const parts = [lux];
    if (frame === 0x03) parts.push("calibration");
    if (flags === 0x03) parts.push("post-test");
    return parts.join(" ");
  }
  if (fmt === 0x0c) {
    const subtype = bytes[8];
    if (subtype === 0x04) {
      const timeout = bytes[18] ?? 0;
      return `VACANT (timeout param=0x${timeout.toString(16).padStart(2, "0")})`;
    }
    return null; // Don't decode non-sensor 0x0C packets
  }
  if (fmt === 0x09) {
    const btnId = bytes[15];
    const action = bytes[16];
    const btnName =
      btnId === 0x11
        ? "TEST"
        : `0x${btnId.toString(16).toUpperCase().padStart(2, "0")}`;
    const actName =
      action === 0x01
        ? "PRESS"
        : action === 0x00
          ? "RELEASE"
          : `0x${action.toString(16).toUpperCase().padStart(2, "0")}`;
    return `${btnName} ${actName}`;
  }
  return null;
}

function buildGroups(packets: MatchedPacket[]): GroupSummary[] {
  const groups = new Map<string, GroupSummary>();

  for (const pkt of packets) {
    const key = [
      pkt.direction.toUpperCase(),
      pkt.typeName,
      pkt.bytes.length,
      pkt.formatByte ?? -1,
    ].join(":");
    const existing = groups.get(key);
    if (existing) {
      existing.packets.push(pkt);
    } else {
      groups.set(key, {
        key,
        direction: pkt.direction.toUpperCase(),
        typeName: pkt.typeName,
        formatByte: pkt.formatByte,
        length: pkt.bytes.length,
        packets: [pkt],
      });
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.packets.length - a.packets.length,
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();

  let capturePath = "";
  let serial = "";
  let showCount = DEFAULT_SHOW;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--serial") {
      serial = args[++i] || "";
    } else if (arg === "--show") {
      showCount = Number.parseInt(args[++i] || "", 10) || DEFAULT_SHOW;
    } else if (!arg.startsWith("--") && !capturePath) {
      capturePath = arg;
    } else {
      usage();
    }
  }

  if (!serial) usage();

  const normalizedSerial = normalizeSerial(serial);
  const serialBe = serialToBytes(normalizedSerial);
  const serialLe = [...serialBe].reverse();
  const resolvedPath = capturePath
    ? resolve(capturePath)
    : getLatestCaptureFile(DEFAULT_CAPTURE_DIR);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Capture file not found: ${resolvedPath}`);
  }

  const rows = readFileSync(resolvedPath, "utf-8")
    .split(/\r?\n/)
    .slice(1)
    .map(parseCaptureRow)
    .filter((row): row is CaptureRow => row !== null)
    .filter((row) => row.protocol.toLowerCase() === "cca");

  const matched: MatchedPacket[] = rows
    .map((row) => {
      const bytes = hexToBytes(row.rawHex);
      const matchOffsetsBe = findNeedleOffsets(bytes, serialBe);
      const matchOffsetsLe = findNeedleOffsets(bytes, serialLe);
      if (matchOffsetsBe.length === 0 && matchOffsetsLe.length === 0)
        return null;

      const identified = identifyPacket(new Uint8Array(bytes));
      return {
        ...row,
        bytes,
        typeName: identified.typeName,
        formatByte: bytes.length > 7 ? bytes[7] : null,
        matchOffsetsBe,
        matchOffsetsLe,
      };
    })
    .filter((row): row is MatchedPacket => row !== null);

  console.log(`Capture: ${resolvedPath}`);
  console.log(
    `Serial: ${normalizedSerial} (BE ${serialBe.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")}, LE ${serialLe.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")})`,
  );
  console.log(`Matched packets: ${matched.length} / ${rows.length}`);

  if (matched.length === 0) {
    console.log("\nNo packets contained that serial in either byte order.");
    console.log(
      "If the sensor is not on the default CCA channel, retune the CC1101 and capture again.",
    );
    process.exit(0);
  }

  const beOffsetCounts = new Map<number, number>();
  const leOffsetCounts = new Map<number, number>();
  for (const pkt of matched) {
    for (const off of pkt.matchOffsetsBe) {
      beOffsetCounts.set(off, (beOffsetCounts.get(off) || 0) + 1);
    }
    for (const off of pkt.matchOffsetsLe) {
      leOffsetCounts.set(off, (leOffsetCounts.get(off) || 0) + 1);
    }
  }

  console.log("\nObserved serial locations:");
  console.log(
    `  BE offsets: ${[...beOffsetCounts.entries()].map(([off, count]) => `${off}(${count})`).join(", ") || "none"}`,
  );
  console.log(
    `  LE offsets: ${[...leOffsetCounts.entries()].map(([off, count]) => `${off}(${count})`).join(", ") || "none"}`,
  );

  const groups = buildGroups(matched);
  console.log("\nGroups:");
  groups.forEach((group, index) => {
    const variableLines = summarizeVariablePositions(group.packets);
    const sample = group.packets[0];
    const sensorInfo = decodeSensorPayload(sample.bytes);
    console.log(
      `${index + 1}. ${group.direction} ${group.typeName} len=${group.length} fmt=${formatByte(group.formatByte)} count=${group.packets.length} intervals=${summarizeIntervals(group.packets)}`,
    );
    if (sensorInfo) {
      console.log(`   decoded: ${sensorInfo}`);
      // Show lux range for sensor level groups
      if (sample.bytes[7] === 0x0b) {
        const luxValues = group.packets
          .map((p) => {
            const h = p.bytes[16].toString(16).toUpperCase().padStart(2, "0");
            const l = p.bytes[17].toString(16).toUpperCase().padStart(2, "0");
            return parseLux16bit([h, l]);
          })
          .filter((v, i, a) => a.indexOf(v) === i);
        if (luxValues.length > 1) {
          console.log(`   lux range: ${luxValues.join(", ")}`);
        }
      }
    }
    console.log(
      `   serial offsets: BE ${formatOffsets(sample.matchOffsetsBe)} | LE ${formatOffsets(sample.matchOffsetsLe)}`,
    );
    console.log(`   sample: ${sample.rawHex}`);
    if (variableLines.length === 0) {
      console.log("   payload bytes: stable across matches");
    } else {
      console.log(`   payload bytes: ${variableLines.slice(0, 6).join(" | ")}`);
    }
  });

  console.log("\nRecent matches:");
  for (const pkt of matched.slice(-showCount)) {
    const time = pkt.timestamp.includes("T")
      ? pkt.timestamp.slice(11, 23)
      : pkt.timestamp;
    const dev = pkt.deviceId || headerDeviceId(pkt.bytes) || "--";
    const sensor = decodeSensorPayload(pkt.bytes);
    const sensorSuffix = sensor ? ` [${sensor}]` : "";
    console.log(
      `${time} ${pkt.direction.toUpperCase()} ${pkt.typeName.padEnd(14)} fmt=${formatByte(pkt.formatByte)} rssi=${pkt.rssi} dev=${dev}${sensorSuffix}`,
    );
  }
}

main();
