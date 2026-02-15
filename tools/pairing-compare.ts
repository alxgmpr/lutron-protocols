#!/usr/bin/env bun
/**
 * Compare real pico 5-button pairing captures against our firmware's pairing sequence.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const dir = "captures/cca-sessions";
const files = readdirSync(dir).filter(
  (f) => f.startsWith("5btn-pairing") && f.endsWith(".csv"),
);

// Parse all pairing packets from recordings
const allPackets: string[][] = [];
for (const f of files) {
  const lines = readFileSync(join(dir, f), "utf-8").trim().split("\n").slice(1);
  for (const line of lines) {
    const hex = line.split(",").slice(3).join(",").trim();
    if (hex) allPackets.push(hex.split(" "));
  }
}

// Group by type byte
const byType = new Map<string, string[][]>();
for (const pkt of allPackets) {
  const t = pkt[0].toUpperCase();
  if (!byType.has(t)) byType.set(t, []);
  byType.get(t)!.push(pkt);
}

console.log(`Total packets: ${allPackets.length}`);
console.log(`Types: ${[...byType.keys()].sort().join(", ")}\n`);

for (const [type, pkts] of [...byType.entries()].sort()) {
  console.log(`${"=".repeat(80)}`);
  console.log(
    `TYPE 0x${type} — ${pkts.length} packets, length ${pkts[0].length} bytes`,
  );
  console.log(`${"=".repeat(80)}`);

  // Find first unique packet of this type
  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const p of pkts) {
    // Ignore seq (byte 1) and CRC (last 2 bytes) for uniqueness
    const key = [...p.slice(0, 1), ...p.slice(2, -2)].join(" ");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
  }

  console.log(`  Unique (ignoring seq/crc): ${unique.length}\n`);

  for (let u = 0; u < unique.length; u++) {
    const pkt = unique[u];
    console.log(`  --- Variant ${u + 1} ---`);
    // Print in groups of labeled bytes
    const labels: [string, number, number][] = [
      ["type", 0, 1],
      ["seq", 1, 1],
      ["device_id", 2, 4],
      ["proto", 6, 1],
      ["format", 7, 1],
      ["b8-9", 8, 2],
      ["btn_scheme", 10, 1],
      ["b11-12", 11, 2],
      ["target", 13, 5],
      ["b18-19", 18, 2],
      ["device_id_2", 20, 4],
      ["device_id_3", 24, 4],
      ["b28", 28, 1],
      ["b29", 29, 1],
      ["b30", 30, 1],
      ["b31", 31, 1],
      ["b32-36", 32, 5],
      ["b37", 37, 1],
      ["b38", 38, 1],
      ["b39-40", 39, 2],
      ["b41-44", 41, 4],
      ["b45-50", 45, 6],
      ["crc", pkt.length - 2, 2],
    ];

    for (const [label, offset, size] of labels) {
      if (offset >= pkt.length) continue;
      const bytes = pkt
        .slice(offset, offset + size)
        .map((b) => b.toUpperCase())
        .join(" ");
      console.log(
        `    [${String(offset).padStart(2)}] ${label.padEnd(14)} = ${bytes}`,
      );
    }
    console.log();
  }
}

// Now show what our firmware sends
console.log(`\n${"=".repeat(80)}`);
console.log(
  "OUR FIRMWARE PAIRING SEQUENCE (from send_pairing_5button / send_pairing_advanced)",
);
console.log(`${"=".repeat(80)}\n`);
console.log("Need to check cc1101_cca.cpp for the pairing function...\n");
