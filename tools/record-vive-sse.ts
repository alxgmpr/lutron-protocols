#!/usr/bin/env bun
/**
 * Vive Pairing Session Recorder (SSE-based)
 *
 * Real-time packet recorder using Server-Sent Events for high-fidelity captures.
 * Records all packets during a pairing session with precise timestamps and
 * session metadata for later comparative analysis.
 *
 * Usage:
 *   bun run tools/record-vive-sse.ts [session-label]
 *   bun run tools/record-vive-sse.ts "pairing-1"
 *   bun run tools/record-vive-sse.ts "pairing-2-after-reset"
 *
 * Output: captures/vive-sessions/<session-label>.jsonl
 *
 * Controls:
 *   Press Enter to mark events (e.g., "reset pressed", "pairing started")
 *   Ctrl+C to stop recording
 */

import { mkdirSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

const API_BASE = process.env.API_BASE || "http://localhost:5001";
const SSE_URL = `${API_BASE}/api/packets/stream`;
const OUTPUT_DIR = join(import.meta.dir, "../captures/vive-sessions");

// Session label from CLI arg or timestamp
const sessionLabel = process.argv[2] || `session-${Date.now()}`;
const outputFile = join(OUTPUT_DIR, `${sessionLabel}.jsonl`);
const summaryFile = join(OUTPUT_DIR, `${sessionLabel}.summary.json`);

// Ensure output directory exists
mkdirSync(OUTPUT_DIR, { recursive: true });

// Session state
let packetCount = 0;
let startTime = Date.now();
const markers: { time: string; elapsed_ms: number; label: string }[] = [];
const packetTypeCounts: Record<string, number> = {};
const devicesSeen = new Set<string>();

// Write session header
const sessionHeader = {
  _type: "session_start",
  session: sessionLabel,
  start_time: new Date().toISOString(),
  sse_url: SSE_URL,
};
appendFileSync(outputFile, JSON.stringify(sessionHeader) + "\n");

console.log(`\n=== Vive Pairing Recorder (SSE) ===`);
console.log(`Session:  ${sessionLabel}`);
console.log(`Output:   ${outputFile}`);
console.log(`SSE URL:  ${SSE_URL}`);
console.log(`\nControls:`);
console.log(`  Type a label + Enter to mark an event (e.g., "pairing started")`);
console.log(`  Ctrl+C to stop recording\n`);

// Set up stdin for event markers
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (input) => {
  const label = input.trim();
  if (label) {
    const marker = {
      _type: "marker",
      time: new Date().toISOString(),
      elapsed_ms: Date.now() - startTime,
      label,
    };
    markers.push(marker);
    appendFileSync(outputFile, JSON.stringify(marker) + "\n");
    console.log(`  [MARKER] ${marker.elapsed_ms}ms: ${label}`);
  }
});

// Connect to SSE stream
async function connectSSE() {
  console.log("Connecting to SSE stream...");

  while (true) {
    try {
      const response = await fetch(SSE_URL, {
        headers: { Accept: "text/event-stream" },
      });

      if (!response.ok) {
        console.error(`SSE connection failed: ${response.status}`);
        await Bun.sleep(2000);
        continue;
      }

      console.log("Connected! Waiting for packets...\n");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6);
          try {
            const pkt = JSON.parse(jsonStr);

            // Skip connection messages
            if (pkt.type === "connected") {
              console.log(`  SSE connected (${pkt.clients} clients)`);
              continue;
            }

            // Add recording metadata
            const record = {
              _type: "packet",
              session: sessionLabel,
              capture_time: new Date().toISOString(),
              elapsed_ms: Date.now() - startTime,
              ...pkt,
            };

            // Write to file
            appendFileSync(outputFile, JSON.stringify(record) + "\n");

            // Track stats
            packetCount++;
            const typeName = pkt.type || "UNKNOWN";
            packetTypeCounts[typeName] = (packetTypeCounts[typeName] || 0) + 1;
            if (pkt.device_id) devicesSeen.add(pkt.device_id);

            // Print packet summary
            const dir = pkt.direction === "tx" ? "TX" : "RX";
            const elapsed = (record.elapsed_ms / 1000).toFixed(1);
            const rssiStr = pkt.rssi !== undefined ? ` rssi:${pkt.rssi}` : "";
            console.log(
              `  [${elapsed}s] ${dir} ${typeName.padEnd(18)} dev:${pkt.device_id || "???"}${rssiStr}  seq:${pkt.details?.seq ?? "?"}  ${pkt.raw_hex || ""}`
            );
          } catch {
            // Skip non-JSON data lines
          }
        }
      }

      console.log("\nSSE connection closed, reconnecting...");
    } catch (err) {
      console.error(`Connection error: ${err}`);
      await Bun.sleep(2000);
    }
  }
}

// Graceful shutdown
function shutdown() {
  const endTime = Date.now();
  const duration = endTime - startTime;

  // Write session footer
  const footer = {
    _type: "session_end",
    session: sessionLabel,
    end_time: new Date().toISOString(),
    duration_ms: duration,
    packet_count: packetCount,
    packet_types: packetTypeCounts,
    devices_seen: Array.from(devicesSeen),
    markers,
  };
  appendFileSync(outputFile, JSON.stringify(footer) + "\n");

  // Write summary file
  writeFileSync(summaryFile, JSON.stringify(footer, null, 2) + "\n");

  console.log(`\n\n=== Session Summary ===`);
  console.log(`Duration:     ${(duration / 1000).toFixed(1)}s`);
  console.log(`Packets:      ${packetCount}`);
  console.log(`Devices seen: ${Array.from(devicesSeen).join(", ") || "none"}`);
  console.log(`Types:`);
  for (const [type, count] of Object.entries(packetTypeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(20)} ${count}`);
  }
  if (markers.length > 0) {
    console.log(`Markers:`);
    for (const m of markers) {
      console.log(`  ${(m.elapsed_ms / 1000).toFixed(1)}s: ${m.label}`);
    }
  }
  console.log(`\nSaved to: ${outputFile}`);
  console.log(`Summary:  ${summaryFile}`);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start
connectSSE();
