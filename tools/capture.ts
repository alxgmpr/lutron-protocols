#!/usr/bin/env bun
/**
 * Long-running packet capture tool for CCA reverse engineering.
 * Uses polling instead of SSE for reliability.
 *
 * Usage:
 *   bun run tools/capture.ts [duration_seconds] [output_file]
 *
 * Examples:
 *   bun run tools/capture.ts 120                    # Capture for 2 minutes
 *   bun run tools/capture.ts 300 vive_pairing.jsonl # Capture for 5 minutes to file
 *   bun run tools/capture.ts 0                      # Capture indefinitely (Ctrl+C to stop)
 */

const API_BASE = process.env.API_URL || "http://localhost:5001";
const POLL_INTERVAL_MS = 200; // Poll every 200ms

interface Packet {
  id?: number;
  type: string;
  raw_hex: string;
  time: string;
  direction: string;
  rssi?: number;
  device_id?: string;
  summary?: string;
  details?: Record<string, unknown>;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let duration = 60;
  let outputFile = `capture_${Date.now()}.jsonl`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--duration" || arg === "-d") {
      duration = parseInt(args[++i] || "60", 10);
    } else if (arg === "--output" || arg === "-o") {
      outputFile = args[++i] || outputFile;
    } else if (!arg.startsWith("-")) {
      // Positional args: first is duration, second is output
      if (i === 0 || (i === 1 && !args[0].startsWith("-"))) {
        const num = parseInt(arg, 10);
        if (!Number.isNaN(num) && i === 0) {
          duration = num;
        } else if (i === 1 || (i === 0 && Number.isNaN(num))) {
          outputFile = arg;
        }
      } else if (!outputFile.includes("capture_")) {
        // Already have output, this might be duration
      } else {
        outputFile = arg;
      }
    }
  }

  return { duration, outputFile };
}

async function main() {
  const { duration, outputFile } = parseArgs();

  console.log(`Starting capture (polling mode)...`);
  console.log(
    `  Duration: ${duration === 0 ? "indefinite (Ctrl+C to stop)" : `${duration} seconds`}`,
  );
  console.log(`  Output: ${outputFile}`);
  console.log(`  Server: ${API_BASE}`);
  console.log("");

  const file = Bun.file(outputFile);
  const writer = file.writer();

  let packetCount = 0;
  let lastType = "";
  let lastTimestamp = 0;
  const typeCounts: Record<string, number> = {};
  const seenTimes = new Set<string>();

  const startTime = Date.now();
  const endTime = duration === 0 ? Infinity : startTime + duration * 1000;

  let running = true;

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    running = false;
    console.log("\n\nCapture stopping...");
  });

  function printSummary() {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Capture Summary ===`);
    console.log(`Duration: ${elapsed}s`);
    console.log(`Total packets: ${packetCount}`);
    if (Object.keys(typeCounts).length > 0) {
      console.log(`Packets by type:`);
      for (const [type, count] of Object.entries(typeCounts).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`  ${type}: ${count}`);
      }
    }
    console.log(`Output file: ${outputFile}`);
  }

  console.log("Polling for packets... (Ctrl+C to stop)\n");

  // Clear existing packets first
  try {
    await fetch(`${API_BASE}/api/packets`, { method: "DELETE" });
    console.log("Cleared packet buffer. Ready for fresh capture.\n");
  } catch {
    // Ignore clear errors
  }

  while (running && Date.now() < endTime) {
    try {
      const resp = await fetch(`${API_BASE}/api/packets?limit=100`);
      if (!resp.ok) {
        await Bun.sleep(POLL_INTERVAL_MS);
        continue;
      }

      const packets: Packet[] = await resp.json();

      for (const pkt of packets) {
        // Skip if we've seen this packet (by time string as ID)
        const pktTime = pkt.time;
        const pktTimeMs = new Date(pktTime).getTime();
        if (seenTimes.has(pktTime) || pktTimeMs <= lastTimestamp) continue;

        seenTimes.add(pktTime);
        lastTimestamp = Math.max(lastTimestamp, pktTimeMs);

        // Keep seenTimes from growing unbounded
        if (seenTimes.size > 10000) {
          const arr = Array.from(seenTimes);
          for (let i = 0; i < 5000; i++) seenTimes.delete(arr[i]);
        }

        packetCount++;
        const pktType = pkt.type || "UNKNOWN";
        typeCounts[pktType] = (typeCounts[pktType] || 0) + 1;

        // Write to file
        writer.write(JSON.stringify(pkt) + "\n");

        // Live display
        const dir = pkt.direction === "rx" ? "<<<" : ">>>";
        const rssi = pkt.rssi ? ` (${pkt.rssi}dBm)` : "";
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const hexPreview = pkt.raw_hex ? pkt.raw_hex.substring(0, 50) : "";

        // Compact display - show type changes prominently
        if (pktType !== lastType) {
          if (lastType) console.log(""); // Newline after repeated type
          console.log(
            `[${elapsed}s] ${dir} ${pktType}${rssi}: ${hexPreview}...`,
          );
          lastType = pktType;
        } else {
          // Same type - just show count on same line
          process.stdout.write(
            `\r[${elapsed}s] ${dir} ${pktType} x${typeCounts[pktType]}${rssi}      `,
          );
        }
      }
    } catch {
      // Network error - just retry
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  printSummary();
  await writer.end();
}

main().catch(console.error);
