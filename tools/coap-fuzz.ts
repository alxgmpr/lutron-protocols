#!/usr/bin/env node --import tsx

/**
 * coap-fuzz — rapidly probe CoAP paths on a device.
 *
 * Usage: npx tsx tools/coap-fuzz.ts <rloc> [--wordlist paths|buckets|deep]
 */

import { createCcxCoapClient } from "../lib/ccx-coap";
import { config } from "../lib/config";

const args = process.argv.slice(2);
const rloc = args.find((a) => !a.startsWith("--")) ?? "4800";
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const wordlist = getArg("--wordlist") ?? "all";
const host = config.openBridge;

// Generate path lists
function generatePaths(): string[] {
  const paths: string[] = [];

  if (wordlist === "buckets" || wordlist === "all") {
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (const b of alpha) {
      for (const c of alpha) {
        paths.push(`cg/db/ct/c/A${b}${c}`);
      }
    }
    for (const a of "BCDFGHKLMNOPRSTUVW") {
      for (const c of alpha) {
        paths.push(`cg/db/ct/c/${a}A${c}`);
      }
    }
  }

  if (wordlist === "paths" || wordlist === "all") {
    const segs1 = [
      "cg",
      "fw",
      "lg",
      "em",
      "lut",
      "ot",
      "rd",
      "rt",
      "sd",
      "st",
      "db",
      "ct",
      "mc",
      "ns",
      "pr",
      "ac",
      "ra",
      "tc",
      "it",
      "diag",
      "test",
      "debug",
      "info",
      "status",
      "config",
      "reset",
      "factory",
      "boot",
      "dfu",
      "ota",
      "smp",
      "led",
      "dim",
      "fan",
      "btn",
      "occ",
      "pir",
      "temp",
      "net",
      "mesh",
      "thread",
      "coap",
      "dtls",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "i",
      "l",
      "n",
      "p",
      "r",
      "s",
      "t",
    ];
    for (const s of segs1) paths.push(s);

    const prefixes = ["cg", "fw", "lg", "em", "lut", "a", "d"];
    const suffixes = [
      "ac",
      "ra",
      "db",
      "ct",
      "mc",
      "ns",
      "pr",
      "nt",
      "tc",
      "f",
      "i",
      "ia",
      "ib",
      "ic",
      "ip",
      "it",
      "all",
      "lim",
      "cfg",
      "sta",
      "ver",
      "id",
      "able",
      "info",
      "data",
      "list",
      "set",
      "get",
      "md",
      "st",
      "log",
      "diag",
    ];
    for (const p of prefixes) {
      for (const s of suffixes) {
        paths.push(`${p}/${s}`);
      }
    }

    const containers = ["cg/db/ct", "cg/db/mc", "cg/db/ns", "cg/db/pr"];
    for (const c of containers) {
      paths.push(`${c}/c`);
      paths.push(`${c}/l`);
      paths.push(`${c}/s`);
    }

    for (const slot of ["ia", "ib", "ic", "ip", "it", "f"]) {
      paths.push(`fw/${slot}`);
      paths.push(`fw/${slot}/md`);
      paths.push(`fw/${slot}/st`);
    }

    paths.push("em/tc");
    paths.push("em/tc/cfg");
    paths.push("em/tc/st");
    paths.push("em/tc/led");
    paths.push("em/tc/btn");
    paths.push("em/tc/dim");
  }

  if (wordlist === "deep") {
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

  return [...new Set(paths)];
}

async function main() {
  const paths = generatePaths();
  console.error(`Fuzzing ${paths.length} paths on rloc:${rloc}`);

  const client = createCcxCoapClient({ host });
  await client.connect();

  const target = { kind: "rloc" as const, rloc };
  const hits = new Map<string, string>();
  let responseCount = 0;

  client.onBroadcast((notif) => {
    if (notif.code !== "4.04") {
      const label =
        notif.path || `mid=0x${notif.mid.toString(16).padStart(4, "0")}`;
      hits.set(label, notif.code);
    }
    responseCount++;
    if (responseCount % 50 === 0) {
      process.stderr.write(
        `  ${responseCount}/${paths.length} responses, ${hits.size} hits\r`,
      );
    }
  });

  console.error("Waiting for Thread...");
  await new Promise((r) => setTimeout(r, 15000));

  const BATCH = 2;
  const DELAY_MS = 350;

  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    await Promise.all(
      batch.map((path) => client.probe(target, path).catch(() => {})),
    );
    await new Promise((r) => setTimeout(r, DELAY_MS * BATCH));

    if ((i + BATCH) % 200 < BATCH) {
      process.stderr.write(
        `  Sent ${Math.min(i + BATCH, paths.length)}/${paths.length}, ${responseCount} responses, ${hits.size} hits\n`,
      );
    }
  }

  console.error("Waiting for remaining responses...");
  await new Promise((r) => setTimeout(r, 5000));

  console.log(`\n=== HITS (${hits.size} non-4.04 responses) ===`);
  const sorted = [...hits.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [path, code] of sorted) {
    console.log(`  ${code.padEnd(6)} ${path}`);
  }
  console.log(
    `\nTotal: ${responseCount} responses from ${paths.length} probes`,
  );

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
