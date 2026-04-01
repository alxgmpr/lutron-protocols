#!/usr/bin/env node --import tsx

/**
 * coap-fuzz — rapidly probe CoAP paths on a device.
 *
 * Usage: npx tsx tools/coap-fuzz.ts <rloc> [--wordlist paths|buckets|deep]
 */

import { createSocket } from "dgram";

const args = process.argv.slice(2);
const rloc = args.find((a) => !a.startsWith("--")) ?? "4800";
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const wordlist = getArg("--wordlist") ?? "all";

const host = process.env.NUCLEO_HOST ?? "10.0.0.3";
const PORT = 9433;
const CMD_TEXT = 0x20;
const RESP_TEXT = 0xfd;

const sock = createSocket("udp4");

function send(cmd: number, data?: Buffer) {
  const d = data ?? Buffer.alloc(0);
  const frame = Buffer.alloc(2 + d.length);
  frame[0] = cmd;
  frame[1] = d.length;
  d.copy(frame, 2);
  sock.send(frame, 0, frame.length, PORT, host);
}

function sendText(text: string) {
  send(CMD_TEXT, Buffer.from(text, "utf-8"));
}

// Generate path lists
function generatePaths(): string[] {
  const paths: string[] = [];

  if (wordlist === "buckets" || wordlist === "all") {
    // 3-letter bucket names: AA? through AZ?, plus some longer combos
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    // Systematically: A[A-Z][A-Z]
    for (const b of alpha) {
      for (const c of alpha) {
        paths.push(`cg/db/ct/c/A${b}${c}`);
      }
    }
    // Also try non-A prefixes for common ones
    for (const a of "BCDFGHKLMNOPRSTUVW") {
      for (const c of alpha) {
        paths.push(`cg/db/ct/c/${a}A${c}`);
      }
    }
  }

  if (wordlist === "paths" || wordlist === "all") {
    // Single-segment paths
    const segs1 = [
      "cg", "fw", "lg", "em", "lut", "ot", "rd", "rt", "sd", "st",
      "db", "ct", "mc", "ns", "pr", "ac", "ra", "tc", "it",
      "diag", "test", "debug", "info", "status", "config",
      "reset", "factory", "boot", "dfu", "ota", "smp",
      "led", "dim", "fan", "btn", "occ", "pir", "temp",
      "net", "mesh", "thread", "coap", "dtls",
      "a", "b", "c", "d", "e", "f", "i", "l", "n", "p", "r", "s", "t",
    ];
    for (const s of segs1) paths.push(s);

    // Two-segment paths
    const prefixes = ["cg", "fw", "lg", "em", "lut", "a", "d"];
    const suffixes = [
      "ac", "ra", "db", "ct", "mc", "ns", "pr", "nt", "tc",
      "f", "i", "ia", "ib", "ic", "ip", "it",
      "all", "lim", "cfg", "sta", "ver", "id",
      "able", "info", "data", "list", "set", "get",
      "md", "st", "log", "diag",
    ];
    for (const p of prefixes) {
      for (const s of suffixes) {
        paths.push(`${p}/${s}`);
      }
    }

    // Three-segment paths for known containers
    const containers = ["cg/db/ct", "cg/db/mc", "cg/db/ns", "cg/db/pr"];
    for (const c of containers) {
      paths.push(`${c}/c`);
      paths.push(`${c}/l`);
      paths.push(`${c}/s`);
    }

    // fw sub-paths
    for (const slot of ["ia", "ib", "ic", "ip", "it", "f"]) {
      paths.push(`fw/${slot}`);
      paths.push(`fw/${slot}/md`);
      paths.push(`fw/${slot}/st`);
    }

    // em sub-paths
    paths.push("em/tc");
    paths.push("em/tc/cfg");
    paths.push("em/tc/st");
    paths.push("em/tc/led");
    paths.push("em/tc/btn");
    paths.push("em/tc/dim");
  }

  if (wordlist === "deep") {
    // More bucket combos: try all 2-letter and 3-letter combos more broadly
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const a of alpha) {
      for (const b of alpha) {
        paths.push(`cg/db/ct/c/${a}${b}`);
        for (const c of alpha) {
          paths.push(`cg/db/ct/c/${a}${b}${c}`);
        }
      }
    }
  }

  // Deduplicate
  return [...new Set(paths)];
}

async function main() {
  const paths = generatePaths();
  console.error(`Fuzzing ${paths.length} paths on rloc:${rloc}`);

  // Collect responses
  const hits = new Map<string, string>(); // path → code
  let responseCount = 0;

  sock.on("message", (msg: Buffer) => {
    if (msg[0] !== RESP_TEXT) return;
    const text = msg.subarray(1).toString("utf-8").trim();
    // Parse "[coap] X.XX <path> mid=0xXXXX len=N" or "[coap] X.XX mid=0xXXXX len=N"
    const m = text.match(/\[coap\] (\d+\.\d+) (.+?) mid=/) ||
              text.match(/\[coap\] (\d+\.\d+) (mid=.*)/);
    if (m) {
      const [, code, path] = m;
      if (code !== "4.04") {
        hits.set(path, code);
      }
      responseCount++;
      if (responseCount % 50 === 0) {
        process.stderr.write(`  ${responseCount}/${paths.length} responses, ${hits.size} hits\r`);
      }
    }
    // Also catch "OK" / "FAIL" from probe command
  });

  // Register as client
  await new Promise<void>((resolve) => {
    sock.bind(0, () => {
      send(0x00, Buffer.alloc(0)); // keepalive to register
      setTimeout(resolve, 200);
    });
  });

  // Wait for Thread to be ready
  console.error("Waiting for Thread...");
  await new Promise((r) => setTimeout(r, 15000));

  // Fire probes in rapid bursts
  const BATCH = 2;
  const DELAY_MS = 350; // slow enough for reliable response

  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    for (const path of batch) {
      sendText(`ccx coap probe rloc:${rloc} ${path}`);
    }
    // Wait for responses
    await new Promise((r) => setTimeout(r, DELAY_MS * BATCH));

    if ((i + BATCH) % 200 < BATCH) {
      process.stderr.write(
        `  Sent ${Math.min(i + BATCH, paths.length)}/${paths.length}, ${responseCount} responses, ${hits.size} hits\n`
      );
    }
  }

  // Wait for stragglers
  console.error("Waiting for remaining responses...");
  await new Promise((r) => setTimeout(r, 5000));

  // Print results
  console.log(`\n=== HITS (${hits.size} non-4.04 responses) ===`);
  const sorted = [...hits.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, code] of sorted) {
    console.log(`  ${code.padEnd(6)} ${path}`);
  }
  console.log(`\nTotal: ${responseCount} responses from ${paths.length} probes`);

  sock.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
