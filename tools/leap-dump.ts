#!/usr/bin/env npx tsx

/**
 * LEAP API Dump - Enumerate all devices, buttons, presets, and zones
 *
 * Connects to a Lutron processor via LEAP (port 8081) and walks the
 * full device hierarchy to build preset→button mappings needed for CCX decoding.
 * Auto-detects RA3 vs Caseta LEAP endpoint style.
 *
 * Usage:
 *   bun run tools/leap-dump.ts                          # Full human-readable dump (RA3)
 *   bun run tools/leap-dump.ts --json                   # JSON output
 *   bun run tools/leap-dump.ts --config                 # Generate ccx/config.ts updates
 *   bun run tools/leap-dump.ts --host 10.x.x.x       # Specific processor
 *   bun run tools/leap-dump.ts --save                   # Save to data/leap-<host>.json
 *
 * TLS certificates resolved from config.json per processor IP.
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  buildDumpData,
  type DeviceInfo,
  fetchLeapData,
  LEAP_REGISTRY,
  LeapConnection,
  type PresetMapping,
  walkEndpoints,
  type ZoneInfo,
} from "../lib/leap-client";

// --- CLI args ---

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

import { defaultHost } from "../lib/config";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const HOST = getArg("--host") ?? defaultHost;
const JSON_OUTPUT = hasFlag("--json");
const CONFIG_OUTPUT = hasFlag("--config");
const SAVE_OUTPUT = hasFlag("--save");
const FULL_OUTPUT = hasFlag("--full");
const DATA_DIR = join(__dir, "../data");

function log(msg: string): void {
  if (!JSON_OUTPUT && !CONFIG_OUTPUT) {
    process.stderr.write(msg + "\n");
  }
}

// --- Main ---

async function main() {
  const leap = new LeapConnection({ host: HOST });
  log(`Connecting to ${HOST}:8081...`);
  await leap.connect();
  log("Connected.\n");

  if (FULL_OUTPUT) {
    await runFullDump(leap);
  } else {
    await runStandardDump(leap);
  }

  leap.close();
}

async function runFullDump(leap: LeapConnection) {
  const startTime = Date.now();

  // Fetch server info for output envelope
  const serverBody = await leap.readBody("/server");
  const servers = serverBody?.Servers ?? [];
  const leapServer =
    servers.find((s: any) => s.Type === "LEAP") ?? servers[0] ?? {};
  const protocolVersion: string = leapServer.ProtocolVersion ?? "";
  let productType = "";
  if (protocolVersion.startsWith("03.")) productType = "RadioRA3";
  else if (protocolVersion.startsWith("01.")) productType = "Caseta";
  else if (protocolVersion.startsWith("02.")) productType = "HomeWorks";
  const leapVersion = protocolVersion || "unknown";

  const data = await walkEndpoints(leap, LEAP_REGISTRY, { full: true, log });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const output = {
    timestamp: new Date().toISOString(),
    host: HOST,
    leapVersion,
    productType,
    data,
  };

  if (SAVE_OUTPUT) {
    mkdirSync(DATA_DIR, { recursive: true });
    const filePath = join(DATA_DIR, `leap-${HOST}-full.json`);
    writeFileSync(filePath, JSON.stringify(output, null, 2) + "\n");
    log(`Saved to ${filePath}`);
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    log(
      `\nFull LEAP dump: ${Object.keys(data).length} endpoints in ${elapsed}s`,
    );
    for (const [key, value] of Object.entries(data)) {
      const count = Array.isArray(value) ? value.length : 1;
      log(`  ${key}: ${count} item${count !== 1 ? "s" : ""}`);
    }
  }
}

async function runStandardDump(leap: LeapConnection) {
  const result = await fetchLeapData(leap, log);

  log("");
  const { zones, devices, presets } = result;

  // Save to JSON file
  if (SAVE_OUTPUT) {
    const dumpData = buildDumpData(HOST, result);
    mkdirSync(DATA_DIR, { recursive: true });
    const filePath = join(DATA_DIR, `leap-${HOST}.json`);
    writeFileSync(filePath, JSON.stringify(dumpData, null, 2) + "\n");
    log(`Saved to ${filePath}`);
  }

  // --- Output ---
  if (JSON_OUTPUT) {
    const dumpData = buildDumpData(HOST, result);
    console.log(JSON.stringify(dumpData, null, 2));
  } else if (CONFIG_OUTPUT) {
    printConfigOutput(zones, devices, presets);
  } else {
    printHumanOutput(zones, devices, presets);
  }
}

// --- Output formatters ---

function printHumanOutput(
  zones: ZoneInfo[],
  devices: DeviceInfo[],
  presets: PresetMapping[],
) {
  console.log("=".repeat(90));
  console.log("LEAP System Dump");
  console.log("=".repeat(90));

  // Zones
  console.log("\n## Zones\n");
  for (const z of zones.sort((a, b) => a.id - b.id)) {
    console.log(
      `  ${String(z.id).padStart(4)}: ${z.area} / ${z.name} (${z.controlType})`,
    );
  }

  // Devices (only those with buttons)
  const devicesWithButtons = new Set(presets.map((p) => p.deviceId));
  console.log("\n## Devices with Buttons\n");
  for (const d of devices
    .filter((d) => devicesWithButtons.has(d.id))
    .sort((a, b) => a.id - b.id)) {
    const displayName = d.station ? `${d.area} ${d.station}` : d.name;
    console.log(
      `  ${String(d.id).padStart(4)}: ${displayName} (${d.type}) serial=${d.serial}`,
    );
  }

  // Preset → CCX Mapping
  console.log("\n## Preset → CCX Button Mapping\n");
  console.log(
    "  Preset  CCX Bytes   Role       Button              Device                          Area",
  );
  console.log("  " + "-".repeat(100));

  for (const p of presets.sort((a, b) => a.presetId - b.presetId)) {
    const ccxHex = `${p.presetId.toString(16).padStart(4, "0")} EF20`;
    const name = (p.engraving ?? p.buttonName).padEnd(18);
    const role = p.presetRole.padEnd(10);
    const device = (
      p.stationName ? `${p.areaName} ${p.stationName}` : p.deviceName
    ).padEnd(30);
    console.log(
      `  ${String(p.presetId).padStart(5)}  ${ccxHex}  ${role} ${name}  ${device}  ${p.areaName}`,
    );
  }

  // Summary
  const pmTypes = new Set(presets.map((p) => p.programmingModelType));
  console.log(`\n## Summary\n`);
  console.log(`  Zones:   ${zones.length}`);
  console.log(
    `  Devices: ${devices.length} (${devicesWithButtons.size} with buttons)`,
  );
  console.log(`  Presets: ${presets.length}`);
  console.log(`  PM Types: ${[...pmTypes].join(", ")}`);
}

function printConfigOutput(
  zones: ZoneInfo[],
  devices: DeviceInfo[],
  presets: PresetMapping[],
) {
  console.log("// Generated by: bun run tools/leap-dump.ts --config");
  console.log(`// Date: ${new Date().toISOString()}`);
  console.log(`// Host: ${HOST}\n`);

  // Known zones
  console.log("knownZones: {");
  for (const z of zones.sort((a, b) => a.id - b.id)) {
    const name = z.area === z.name ? z.name : `${z.area} ${z.name}`;
    console.log(`  ${z.id}: { name: ${JSON.stringify(name)} },`);
  }
  console.log("},\n");

  // Known serials (only devices with valid serials)
  console.log("knownSerials: {");
  for (const d of devices
    .filter((d) => d.serial && d.serial < 0xffffffff)
    .sort((a, b) => a.serial - b.serial)) {
    const name = d.station ? `${d.area} ${d.station} ${d.type}` : d.name;
    console.log(
      `  ${d.serial}: { name: ${JSON.stringify(name)}, leapId: ${d.id} },`,
    );
  }
  console.log("},\n");

  // Preset mapping
  console.log("/** Preset ID → button mapping (for CCX BUTTON_PRESS decoding)");
  console.log(" *  CCX device_id bytes 0-1 = preset ID as big-endian uint16");
  console.log(" *  CCX device_id bytes 2-3 = 0xEF20 (constant) */");
  console.log("knownPresets: {");
  const seen = new Set<number>();
  for (const p of presets.sort((a, b) => a.presetId - b.presetId)) {
    if (seen.has(p.presetId)) continue;
    seen.add(p.presetId);
    const label = p.engraving ?? p.buttonName;
    const device = p.stationName
      ? `${p.areaName} ${p.stationName}`
      : p.deviceName;
    console.log(
      `  ${p.presetId}: { name: ${JSON.stringify(label)}, role: ${JSON.stringify(p.presetRole)}, device: ${JSON.stringify(device)} },`,
    );
  }
  console.log("},");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
