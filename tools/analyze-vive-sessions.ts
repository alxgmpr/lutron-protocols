#!/usr/bin/env bun
/**
 * Vive Pairing Session Analyzer
 *
 * Compares multiple pairing session recordings to identify:
 * - Fixed vs variable bytes in each packet type
 * - Sequence patterns and timing
 * - Device ID assignments
 * - Protocol handshake structure
 *
 * Usage:
 *   bun run tools/analyze-vive-sessions.ts                    # Analyze all sessions
 *   bun run tools/analyze-vive-sessions.ts compare            # Side-by-side comparison
 *   bun run tools/analyze-vive-sessions.ts timeline           # Show packet timeline
 *   bun run tools/analyze-vive-sessions.ts diff               # Byte-level diff
 *   bun run tools/analyze-vive-sessions.ts handshake          # Extract handshake sequence
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const SESSIONS_DIR = join(import.meta.dir, "../captures/vive-sessions");

interface PacketRecord {
  _type: "packet" | "session_start" | "session_end" | "marker";
  session?: string;
  elapsed_ms?: number;
  direction?: "rx" | "tx";
  type?: string;
  device_id?: string;
  raw_hex?: string;
  details?: Record<string, string | number | boolean>;
  rssi?: number;
  label?: string;
  // session_end fields
  packet_count?: number;
  devices_seen?: string[];
  markers?: { time: string; elapsed_ms: number; label: string }[];
}

interface Session {
  label: string;
  packets: PacketRecord[];
  markers: { elapsed_ms: number; label: string }[];
  meta?: PacketRecord;
}

function loadSessions(filter?: string[]): Session[] {
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  const sessions: Session[] = [];

  for (const file of files) {
    const label = file.replace(".jsonl", "");
    if (filter && filter.length > 0 && !filter.some((f) => label.includes(f)))
      continue;

    const lines = readFileSync(join(SESSIONS_DIR, file), "utf-8")
      .trim()
      .split("\n");

    const packets: PacketRecord[] = [];
    const markers: { elapsed_ms: number; label: string }[] = [];
    let meta: PacketRecord | undefined;

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as PacketRecord;
        if (record._type === "packet") {
          packets.push(record);
        } else if (record._type === "marker") {
          markers.push({
            elapsed_ms: record.elapsed_ms || 0,
            label: record.label || "",
          });
        } else if (record._type === "session_end") {
          meta = record;
        }
      } catch {
        // skip malformed lines
      }
    }

    sessions.push({ label, packets, markers, meta });
  }

  return sessions;
}

function parseHex(hex: string): number[] {
  return hex.split(" ").map((b) => parseInt(b, 16));
}

// --- Commands ---

function cmdOverview(sessions: Session[]) {
  console.log(
    `\n=== Vive Session Overview (${sessions.length} sessions) ===\n`,
  );

  for (const session of sessions) {
    const types: Record<string, number> = {};
    const devices = new Set<string>();
    let minElapsed = Infinity;
    let maxElapsed = 0;

    for (const p of session.packets) {
      const t = p.type || "?";
      types[t] = (types[t] || 0) + 1;
      if (p.device_id) devices.add(p.device_id);
      if (p.elapsed_ms !== undefined) {
        minElapsed = Math.min(minElapsed, p.elapsed_ms);
        maxElapsed = Math.max(maxElapsed, p.elapsed_ms);
      }
    }

    const duration =
      maxElapsed > 0 ? ((maxElapsed - minElapsed) / 1000).toFixed(1) : "?";
    console.log(`--- ${session.label} ---`);
    console.log(`  Packets: ${session.packets.length}  Duration: ${duration}s`);
    console.log(`  Devices: ${Array.from(devices).join(", ") || "none"}`);
    console.log(
      `  Types:   ${Object.entries(types)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${t}(${c})`)
        .join(" ")}`,
    );
    if (session.markers.length > 0) {
      console.log(
        `  Markers: ${session.markers.map((m) => `${(m.elapsed_ms / 1000).toFixed(1)}s:${m.label}`).join(", ")}`,
      );
    }
    console.log();
  }
}

function cmdTimeline(sessions: Session[]) {
  console.log(`\n=== Packet Timeline ===\n`);

  for (const session of sessions) {
    console.log(`--- ${session.label} ---`);

    // Interleave packets and markers
    const events: { elapsed_ms: number; text: string }[] = [];

    for (const p of session.packets) {
      const dir = p.direction === "tx" ? "TX" : "RX";
      const elapsed = ((p.elapsed_ms || 0) / 1000).toFixed(3);
      const hex = p.raw_hex || "";
      events.push({
        elapsed_ms: p.elapsed_ms || 0,
        text: `  ${elapsed.padStart(8)}s  ${dir} ${(p.type || "?").padEnd(18)} ${(p.device_id || "").padEnd(10)} seq:${String(p.details?.seq ?? "?").padEnd(4)} ${hex}`,
      });
    }

    for (const m of session.markers) {
      events.push({
        elapsed_ms: m.elapsed_ms,
        text: `  ${(m.elapsed_ms / 1000).toFixed(3).padStart(8)}s  ** MARKER: ${m.label} **`,
      });
    }

    events.sort((a, b) => a.elapsed_ms - b.elapsed_ms);
    for (const e of events) {
      console.log(e.text);
    }
    console.log();
  }
}

function cmdCompare(sessions: Session[]) {
  if (sessions.length < 2) {
    console.log("Need at least 2 sessions to compare.");
    return;
  }

  console.log(`\n=== Cross-Session Comparison ===\n`);

  // Group packets by type across all sessions
  const typesBySession: Map<string, PacketRecord[][]> = new Map();

  for (let i = 0; i < sessions.length; i++) {
    for (const p of sessions[i].packets) {
      const t = p.type || "?";
      if (!typesBySession.has(t)) {
        typesBySession.set(
          t,
          sessions.map(() => []),
        );
      }
      typesBySession.get(t)![i].push(p);
    }
  }

  for (const [type, perSession] of typesBySession) {
    const counts = perSession.map((s) => s.length);
    if (counts.every((c) => c === 0)) continue;

    console.log(`--- ${type} ---`);
    console.log(
      `  Counts per session: ${sessions.map((s, i) => `${s.label}=${counts[i]}`).join(", ")}`,
    );

    // Byte-level diff for first occurrence in each session
    const firstPackets = perSession
      .map((arr) => (arr.length > 0 ? arr[0] : null))
      .filter((p): p is PacketRecord => p !== null);

    if (firstPackets.length >= 2 && firstPackets[0].raw_hex) {
      const bytes = firstPackets.map((p) => parseHex(p.raw_hex!));
      const maxLen = Math.max(...bytes.map((b) => b.length));

      const fixedBytes: number[] = [];
      const varBytes: number[] = [];

      for (let i = 0; i < maxLen; i++) {
        const vals = bytes.map((b) => b[i]).filter((v) => v !== undefined);
        if (vals.every((v) => v === vals[0])) {
          fixedBytes.push(i);
        } else {
          varBytes.push(i);
        }
      }

      if (varBytes.length > 0) {
        console.log(`  Fixed bytes: [${fixedBytes.join(",")}]`);
        console.log(`  Variable bytes: [${varBytes.join(",")}]`);
        console.log(`  Values at variable positions:`);
        for (const pos of varBytes) {
          const vals = bytes.map((b) =>
            b[pos] !== undefined
              ? `0x${b[pos].toString(16).padStart(2, "0")}`
              : "---",
          );
          console.log(
            `    byte[${pos.toString().padStart(2)}]: ${vals.join(" | ")}`,
          );
        }
      } else {
        console.log(`  All bytes identical across sessions`);
      }
    }
    console.log();
  }
}

function cmdDiff(sessions: Session[]) {
  if (sessions.length < 2) {
    console.log("Need at least 2 sessions for byte diff.");
    return;
  }

  console.log(`\n=== Byte-Level Diff ===\n`);

  // For each packet type, align packets by sequence order and diff
  const allTypes = new Set<string>();
  for (const s of sessions) {
    for (const p of s.packets) {
      if (p.type) allTypes.add(p.type);
    }
  }

  for (const type of allTypes) {
    const perSession = sessions.map((s) =>
      s.packets.filter((p) => p.type === type),
    );

    const maxCount = Math.max(...perSession.map((a) => a.length));
    if (maxCount === 0) continue;

    console.log(`=== ${type} (max ${maxCount} packets/session) ===`);

    for (let idx = 0; idx < Math.min(maxCount, 5); idx++) {
      const pkts = perSession
        .map((a) => a[idx])
        .filter(
          (p): p is PacketRecord => p !== undefined && p.raw_hex !== undefined,
        );

      if (pkts.length < 2) continue;

      const bytes = pkts.map((p) => parseHex(p.raw_hex!));

      console.log(`  --- Instance #${idx} ---`);

      // Print hex with highlighting of differences
      for (let si = 0; si < pkts.length; si++) {
        const sessionIdx = perSession.findIndex((a) => a[idx] === pkts[si]);
        const hexParts = bytes[si].map((b, bi) => {
          const hex = b.toString(16).padStart(2, "0");
          // Check if this byte differs from first session
          if (si > 0 && bytes[0][bi] !== undefined && bytes[0][bi] !== b) {
            return `[${hex}]`;
          }
          return ` ${hex} `;
        });
        console.log(
          `    ${sessions[sessionIdx].label.padEnd(20)} ${hexParts.join("")}`,
        );
      }
    }
    console.log();
  }
}

function cmdHandshake(sessions: Session[]) {
  console.log(`\n=== Pairing Handshake Sequence ===\n`);

  // Vive-relevant packet types
  const pairingTypes = new Set([
    "VIVE_BEACON",
    "VIVE_DEVICE_REQ",
    "VIVE_ACCEPT",
    "PAIRING_B9",
    "PAIRING_B1",
    "PAIRING_B2",
  ]);

  for (const session of sessions) {
    console.log(`--- ${session.label} ---`);

    // Filter to pairing-relevant packets + any unknowns during pairing window
    const pairingPackets = session.packets.filter((p) => {
      if (!p.type) return false;
      // Include known pairing types
      if (pairingTypes.has(p.type)) return true;
      // Include any 0xNN hex type (unknown packet types)
      if (p.type.startsWith("0x")) return true;
      // Include button presses (confirmation)
      if (p.type.startsWith("BTN_")) return true;
      return false;
    });

    if (pairingPackets.length === 0) {
      console.log("  No pairing packets found\n");
      continue;
    }

    let prevElapsed = 0;
    for (const p of pairingPackets) {
      const elapsed = p.elapsed_ms || 0;
      const delta = elapsed - prevElapsed;
      prevElapsed = elapsed;

      const dir = p.direction === "tx" ? "TX" : "RX";
      const deltaStr = delta > 0 ? `+${delta}ms` : "";
      console.log(
        `  ${(elapsed / 1000).toFixed(3).padStart(8)}s ${deltaStr.padStart(8)} ${dir} ${(p.type || "?").padEnd(18)} dev:${(p.device_id || "???").padEnd(10)} ${p.raw_hex || ""}`,
      );
    }
    console.log();
  }
}

// --- Main ---

const command = process.argv[2] || "overview";
const sessionFilters = process.argv.slice(3);

const sessions = loadSessions(sessionFilters);

if (sessions.length === 0) {
  console.log(`No sessions found in ${SESSIONS_DIR}`);
  console.log(
    "Record some sessions first with: bun run tools/record-vive-sse.ts <label>",
  );
  process.exit(1);
}

switch (command) {
  case "overview":
    cmdOverview(sessions);
    break;
  case "timeline":
    cmdTimeline(sessions);
    break;
  case "compare":
    cmdCompare(sessions);
    break;
  case "diff":
    cmdDiff(sessions);
    break;
  case "handshake":
    cmdHandshake(sessions);
    break;
  default:
    console.log(`Unknown command: ${command}`);
    console.log("Commands: overview, timeline, compare, diff, handshake");
    process.exit(1);
}
