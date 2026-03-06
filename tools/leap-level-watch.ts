#!/usr/bin/env bun

/**
 * LEAP Zone Level Watcher
 *
 * Subscribes to zone status events via LEAP and prints real-time level changes.
 * Catches ALL level changes regardless of source: app, physical dimmer, scene, etc.
 * Uses both subscription (push) and fast polling (fallback) for reliability.
 *
 * Usage:
 *   bun run tools/leap-level-watch.ts                    # Watch all zones
 *   bun run tools/leap-level-watch.ts --zone 3663        # Watch specific zone
 *   bun run tools/leap-level-watch.ts --host $RA3_HOST  # Specify processor
 *   bun run tools/leap-level-watch.ts --poll 100         # Poll interval in ms
 */

import { LeapConnection } from "./leap-client";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function getAllArgs(name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) results.push(args[i + 1]);
  }
  return results;
}

import { RA3_HOST } from "../lib/env";
const host = getArg("--host") ?? RA3_HOST;
const certName = getArg("--cert") ?? "ra3";
const zoneArgs = getAllArgs("--zone");
const pollMs = parseInt(getArg("--poll") ?? "200", 10);

interface ZoneInfo {
  id: number;
  name: string;
  area: string;
  lastLevel: number | null;
}

async function main() {
  const conn = new LeapConnection({ host, certName });
  await conn.connect();
  console.log(`Connected to LEAP at ${host}`);

  // Discover all zones through areas
  const zones = new Map<number, ZoneInfo>();
  const areaResp = await conn.read("/area");
  const areas = areaResp?.Body?.Areas ?? [];

  for (const area of areas) {
    try {
      const zResp = await conn.read(area.href + "/associatedzone");
      for (const z of zResp?.Body?.Zones ?? []) {
        const id = parseInt(z.href.split("/").pop() ?? "0", 10);
        zones.set(id, { id, name: z.Name, area: area.Name, lastLevel: null });
      }
    } catch {}
  }

  // Filter to requested zones, or watch all
  const watchIds: number[] =
    zoneArgs.length > 0
      ? zoneArgs.map((z) => parseInt(z, 10))
      : [...zones.keys()];

  console.log(`Watching ${watchIds.length} zones (polling every ${pollMs}ms)`);
  for (const id of watchIds) {
    const z = zones.get(id);
    console.log(`  ${id}: ${z ? `${z.area} ${z.name}` : "unknown"}`);
  }

  // Handle subscription events (may or may not fire on RA3)
  conn.onEvent = (msg) => {
    const zoneStatus = msg.Body?.ZoneStatus;
    if (!zoneStatus) return;
    const zoneUrl = zoneStatus.Zone?.href ?? "";
    const zoneId = parseInt(zoneUrl.split("/").pop() ?? "0", 10);
    if (!watchIds.includes(zoneId)) return;
    const level = zoneStatus.Level;
    const z = zones.get(zoneId);
    if (z && z.lastLevel !== level) {
      z.lastLevel = level;
      const time = new Date().toISOString().slice(11, 23);
      console.log(`${time} [event] ${z.area} ${z.name} → ${level}%`);
    }
  };

  // Subscribe
  try {
    await conn.subscribe("/zone/status");
  } catch {}
  for (const id of watchIds) {
    try {
      await conn.subscribe(`/zone/${id}/status`);
    } catch {}
  }

  // Read initial levels
  console.log("\nCurrent levels:");
  for (const id of watchIds) {
    try {
      const resp = await conn.read(`/zone/${id}/status`);
      const level = resp?.Body?.ZoneStatus?.Level;
      const z = zones.get(id);
      if (z) {
        z.lastLevel = level ?? null;
        console.log(`  ${z.area} ${z.name}: ${level}%`);
      }
    } catch {}
  }

  console.log("\nWatching... (Ctrl+C to stop)\n");

  // Fast polling loop — guaranteed to catch changes
  let pollIndex = 0;
  const poll = setInterval(async () => {
    // Round-robin through watched zones
    const id = watchIds[pollIndex % watchIds.length];
    pollIndex++;

    try {
      const resp = await conn.read(`/zone/${id}/status`);
      const level = resp?.Body?.ZoneStatus?.Level;
      if (level === undefined) return;
      const z = zones.get(id);
      if (z && z.lastLevel !== level) {
        const time = new Date().toISOString().slice(11, 23);
        const delta = z.lastLevel !== null ? ` (was ${z.lastLevel}%)` : "";
        console.log(`${time} ${z.area} ${z.name} → ${level}%${delta}`);
        z.lastLevel = level;
      }
    } catch {}
  }, pollMs);

  process.on("SIGINT", () => {
    clearInterval(poll);
    console.log("\nStopping...");
    conn.close();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
