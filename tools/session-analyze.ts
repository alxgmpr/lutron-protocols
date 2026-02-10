#!/usr/bin/env bun
/**
 * Analyze CCA recording sessions — byte-by-byte comparison across captures.
 * Usage: bun run tools/session-analyze.ts [captures/cca-sessions/]
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const dir = process.argv[2] || "captures/cca-sessions";

// Group files by session name (strip timestamp suffix)
const files = readdirSync(dir).filter(f => f.endsWith(".csv"));
const groups = new Map<string, string[]>();
for (const f of files) {
  const name = f.replace(/_\d{4}-\d{2}-\d{2}T[\d-]+\.csv$/, "");
  if (!groups.has(name)) groups.set(name, []);
  groups.get(name)!.push(f);
}

// Parse a CSV file into unique raw_hex lines (deduplicated)
function parseSession(file: string): string[] {
  const lines = readFileSync(join(dir, file), "utf-8").trim().split("\n").slice(1); // skip header
  const hexLines = lines.map(l => {
    const parts = l.split(",");
    return parts.slice(3).join(",").trim(); // raw_hex (may contain commas in theory, but shouldn't)
  }).filter(h => h.length > 0);
  return hexLines;
}

// Get unique packets per session (preserving order of first appearance)
function uniquePackets(hexLines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const h of hexLines) {
    if (!seen.has(h)) {
      seen.add(h);
      result.push(h);
    }
  }
  return result;
}

console.log(`\n${"=".repeat(80)}`);
console.log(`CCA SESSION ANALYSIS — ${files.length} files in ${groups.size} groups`);
console.log(`${"=".repeat(80)}\n`);

// Collect all unique packets per group
const groupData = new Map<string, string[][]>();
for (const [name, groupFiles] of [...groups.entries()].sort()) {
  const allUnique: string[][] = [];
  for (const f of groupFiles) {
    const raw = parseSession(f);
    const uniq = uniquePackets(raw);
    // Split each hex string into byte array
    allUnique.push(...uniq.map(h => h.split(" ")));
  }
  groupData.set(name, allUnique);
}

// Print per-group summary
for (const [name, packets] of [...groupData.entries()].sort()) {
  console.log(`\n--- ${name} (${packets.length} unique packets across all recordings) ---`);

  // Group by type byte (byte 0)
  const byType = new Map<string, string[][]>();
  for (const pkt of packets) {
    const t = pkt[0]?.toUpperCase() || "??";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(pkt);
  }

  for (const [type, pkts] of [...byType.entries()].sort()) {
    console.log(`  Type 0x${type}: ${pkts.length} packets, len=${pkts[0].length}`);
    // Show first packet
    console.log(`    [0] ${pkts[0].map(b => b.toUpperCase()).join(" ")}`);
    if (pkts.length > 1) {
      // Show which bytes differ across packets of this type
      const diffBytes: number[] = [];
      for (let i = 0; i < pkts[0].length; i++) {
        const vals = new Set(pkts.map(p => p[i]?.toLowerCase()));
        if (vals.size > 1) diffBytes.push(i);
      }
      if (diffBytes.length > 0) {
        console.log(`    Varying bytes: [${diffBytes.join(", ")}]`);
        // Show the values at varying positions
        for (const idx of diffBytes) {
          const vals = [...new Set(pkts.map(p => p[idx]?.toUpperCase()))];
          console.log(`      byte[${idx}]: ${vals.join(", ")}`);
        }
      } else {
        console.log(`    All ${pkts.length} packets identical`);
      }
    }
  }
}

// Cross-group comparison: for each type byte, compare the "distinguishing byte"
console.log(`\n${"=".repeat(80)}`);
console.log("CROSS-GROUP COMPARISON — Finding button-distinguishing bytes");
console.log(`${"=".repeat(80)}\n`);

// Collect representative packets per group (first unique packet of each type byte)
const pressGroups = ["5btn-on-press", "5btn-off-press", "5btn-fav-press", "5btn-raise-press", "5btn-lower-press"];
const holdGroups = ["5btn-raise-hold", "5btn-lower-hold"];
const dtapGroups = ["5btn-on-double-tap", "5btn-off-double-tap"];

function getRepresentative(name: string, typeByte?: string): string[] | null {
  const pkts = groupData.get(name);
  if (!pkts || pkts.length === 0) return null;
  if (typeByte) {
    const match = pkts.find(p => p[0]?.toLowerCase() === typeByte.toLowerCase());
    return match || null;
  }
  return pkts[0];
}

// Find the most common type byte across press groups
const allTypeCounts = new Map<string, number>();
for (const name of pressGroups) {
  const pkts = groupData.get(name) || [];
  for (const p of pkts) {
    const t = p[0]?.toUpperCase() || "??";
    allTypeCounts.set(t, (allTypeCounts.get(t) || 0) + 1);
  }
}
console.log("Type byte distribution across press groups:");
for (const [t, c] of [...allTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  0x${t}: ${c} packets`);
}

// For the dominant type byte, compare across all press groups byte by byte
const dominantType = [...allTypeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
if (dominantType) {
  console.log(`\nComparing byte-by-byte for type 0x${dominantType} across button actions:\n`);

  const reps: [string, string[]][] = [];
  for (const name of [...pressGroups, ...holdGroups, ...dtapGroups]) {
    const rep = getRepresentative(name, dominantType);
    if (rep) reps.push([name, rep]);
  }

  if (reps.length > 0) {
    const maxLen = Math.max(...reps.map(([, p]) => p.length));

    // Header
    const label = (s: string) => s.replace("5btn-", "").padEnd(14);
    console.log(`${"Byte".padEnd(6)} ${reps.map(([n]) => label(n)).join(" ")}`);
    console.log(`${"----".padEnd(6)} ${reps.map(() => "-".repeat(14)).join(" ")}`);

    for (let i = 0; i < maxLen; i++) {
      const vals = reps.map(([, p]) => (p[i] || "--").toUpperCase().padEnd(14));
      const allSame = new Set(vals.map(v => v.trim())).size === 1;
      const marker = allSame ? " " : "*";
      console.log(`[${String(i).padStart(2)}]${marker}  ${vals.join(" ")}`);
    }
  }
}

// Special: compare hold packets to see the sequence structure
console.log(`\n${"=".repeat(80)}`);
console.log("HOLD SEQUENCE ANALYSIS");
console.log(`${"=".repeat(80)}\n`);

for (const name of holdGroups) {
  const files = groups.get(name) || [];
  if (files.length === 0) continue;
  console.log(`\n--- ${name} (first recording) ---`);
  const raw = parseSession(files[0]);
  for (let i = 0; i < raw.length; i++) {
    const bytes = raw[i].split(" ");
    console.log(`  pkt[${String(i).padStart(2)}] type=0x${bytes[0]?.toUpperCase()} seq=${parseInt(bytes[1], 16).toString().padStart(3)} | ${bytes.map(b => b.toUpperCase()).join(" ")}`);
  }
}

// Double-tap analysis
console.log(`\n${"=".repeat(80)}`);
console.log("DOUBLE-TAP SEQUENCE ANALYSIS");
console.log(`${"=".repeat(80)}\n`);

for (const name of dtapGroups) {
  const files = groups.get(name) || [];
  if (files.length === 0) continue;
  console.log(`\n--- ${name} (first recording) ---`);
  const raw = parseSession(files[0]);
  for (let i = 0; i < raw.length; i++) {
    const bytes = raw[i].split(" ");
    console.log(`  pkt[${String(i).padStart(2)}] type=0x${bytes[0]?.toUpperCase()} seq=${parseInt(bytes[1], 16).toString().padStart(3)} | ${bytes.map(b => b.toUpperCase()).join(" ")}`);
  }
}
