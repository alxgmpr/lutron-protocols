#!/usr/bin/env npx tsx

/**
 * LEAP API Explorer — systematically probe every endpoint on the processor.
 *
 * Discovers all capabilities including device management, commissioning,
 * settings, and undocumented endpoints.
 *
 * Usage:
 *   bun run tools/leap-explore.ts                           # RA3 processor
 *   bun run tools/leap-explore.ts --host 10.x.x.x       # Specific processor
 *   bun run tools/leap-explore.ts --save                    # Save full dump to file
 *   bun run tools/leap-explore.ts --section devices         # Only probe devices section
 */

import { mkdirSync, writeFileSync } from "fs";
import { hrefId, LeapConnection } from "../../lib/leap-client";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

import { defaultHost } from "../../lib/config";

const HOST = getArg("--host") ?? defaultHost;
const SAVE = hasFlag("--save");
const SECTION = getArg("--section");

// Collect all results
const results: Record<string, any> = {};
let conn: LeapConnection;

// --- Helpers ---

async function probe(url: string, label?: string): Promise<any> {
  const tag = label ?? url;
  try {
    const resp = await conn.read(url);
    const status = resp.Header?.StatusCode ?? "";
    const body = resp.Body;

    if (status.startsWith("2") && body) {
      results[url] = { status, body };
      const keys = Object.keys(body);
      const count = keys.length === 1 ? bodyCount(body[keys[0]]) : "";
      console.log(`  \x1b[32m✓\x1b[0m ${tag} → ${status}${count}`);
      return body;
    } else if (status.startsWith("4") || status.startsWith("5")) {
      results[url] = { status, error: body?.Message ?? status };
      console.log(`  \x1b[90m✗ ${tag} → ${status}\x1b[0m`);
      return null;
    }
    results[url] = { status };
    return body ?? null;
  } catch (e: any) {
    results[url] = { error: e.message };
    console.log(`  \x1b[31m✗ ${tag} → ${e.message}\x1b[0m`);
    return null;
  }
}

function bodyCount(val: any): string {
  if (Array.isArray(val)) return ` (${val.length} items)`;
  return "";
}

/** Probe a URL and follow all hrefs in the response */
async function _probeAndFollow(url: string, depth = 0): Promise<any> {
  if (depth > 2) return null;
  const body = await probe(url);
  return body;
}

/** Extract all IDs from a collection response */
function extractIds(body: any, key: string): number[] {
  const items = body?.[key] ?? [];
  return items
    .map((item: any) => hrefId(item.href))
    .filter((id: number) => id > 0);
}

// --- Section probers ---

async function probeSystem() {
  console.log("\n\x1b[1m=== System & Server ===\x1b[0m");
  await probe("/server");
  await probe("/system");
  await probe("/system/status/daynightstate");
  await probe("/system/away");
  await probe("/system/action");
  await probe("/system/loadshedding/status");
  await probe("/system/naturallightoptimization");
  await probe("/system/naturallightoptimization/status");
  await probe("/project");
  await probe("/project/contactinfo");
  await probe("/project/masterdevicelist/devices");
  await probe("/database");
  await probe("/daynightmode");
  await probe("/homekitdata");
  await probe("/associatedalias");
  await probe("/household");
  await probe("/favorite");
  await probe("/networkinterface");
  await probe("/service");
  await probe("/firmware");
  await probe("/firmware/status");
  await probe("/operatingstatus");
  await probe("/softwareupdate");
  await probe("/softwareupdate/status");
  await probe("/log");
  await probe("/certificate/root");
}

async function probeLinks() {
  console.log("\n\x1b[1m=== Links (Radios) ===\x1b[0m");
  const body = await probe("/link");
  const links = body?.Links ?? [];
  for (const link of links) {
    const id = hrefId(link.href);
    await probe(`/link/${id}`);
    await probe(`/link/${id}/status`);
    await probe(`/link/${id}/associatedlinknode`);
    await probe(`/link/${id}/associatedlinknode/expanded`);
    // This is the big one — all devices + firmware in one call
  }
}

async function probeAreas() {
  console.log("\n\x1b[1m=== Areas ===\x1b[0m");
  const body = await probe("/area");
  await probe("/area/summary");
  const areas = body?.Areas ?? [];
  for (const area of areas) {
    const id = hrefId(area.href);
    await probe(`/area/${id}`);
    await probe(`/area/${id}/associatedzone`);
    await probe(`/area/${id}/associatedcontrolstation`);
    await probe(`/area/${id}/associatedareascene`);
    await probe(`/area/${id}/associatedoccupancygroup`);
  }
}

async function probeZones() {
  console.log("\n\x1b[1m=== Zones ===\x1b[0m");
  const body = await probe("/zone");
  await probe("/zone/status");

  // Collect zone IDs from either /zone (Caseta) or area walk (RA3)
  let zoneIds: number[] = [];
  if (body?.Zones) {
    zoneIds = extractIds(body, "Zones");
  } else {
    // RA3: get from area walk
    const areaBody = results["/area"]?.body;
    const areas = areaBody?.Areas ?? [];
    for (const area of areas) {
      const areaId = hrefId(area.href);
      const azBody = results[`/area/${areaId}/associatedzone`]?.body;
      for (const z of azBody?.Zones ?? []) {
        zoneIds.push(hrefId(z.href));
      }
    }
  }

  console.log(`  Found ${zoneIds.length} zones, probing each...`);
  for (const id of zoneIds) {
    await probe(`/zone/${id}`);
    await probe(`/zone/${id}/status`);
    await probe(`/zone/${id}/status/expanded`);
    await probe(`/zone/${id}/commandprocessor`);
    // Settings
    await probe(`/zone/${id}/tuningsettings`);
    await probe(`/zone/${id}/phasesettings`);
    await probe(`/zone/${id}/fadesettings`);
    await probe(`/zone/${id}/countdowntimer`);
    // Undocumented / speculative
    await probe(`/zone/${id}/facade`);
    await probe(`/zone/${id}/loadcontroller`);
    await probe(`/zone/${id}/curvedimming`);
    await probe(`/zone/${id}/naturalshow`);
    await probe(`/zone/${id}/associatedareascene`);
    await probe(`/zone/${id}/ledsettings`);
  }
}

async function probeDevices() {
  console.log("\n\x1b[1m=== Devices ===\x1b[0m");
  const body = await probe("/device");
  await probe("/device/status");
  await probe("/device/status/deviceheard");
  await probe("/device/commandprocessor");

  // Collect device IDs
  let deviceIds: number[] = [];
  if (body?.Devices) {
    deviceIds = extractIds(body, "Devices");
  } else {
    // RA3: from project master device list
    const projBody = results["/project/masterdevicelist/devices"]?.body;
    if (projBody?.Devices) {
      deviceIds = extractIds(projBody, "Devices");
    }
    // Also from area walk control stations
    const areaBody = results["/area"]?.body;
    for (const area of areaBody?.Areas ?? []) {
      const areaId = hrefId(area.href);
      const csBody = results[`/area/${areaId}/associatedcontrolstation`]?.body;
      for (const cs of csBody?.ControlStations ?? []) {
        for (const g of cs.AssociatedGangedDevices ?? []) {
          if (g.Device?.href) deviceIds.push(hrefId(g.Device.href));
        }
      }
    }
    deviceIds = [...new Set(deviceIds)];
  }

  console.log(`  Found ${deviceIds.length} devices, probing each...`);
  for (const id of deviceIds) {
    await probe(`/device/${id}`);
    await probe(`/device/${id}/status`);
    // Settings & config
    await probe(`/device/${id}/ledsettings`);
    await probe(`/device/${id}/led/status`);
    await probe(`/device/${id}/buttongroup`);
    await probe(`/device/${id}/buttongroup/expanded`);
    await probe(`/device/${id}/fadesettings`);
    await probe(`/device/${id}/tuningsettings`);
    await probe(`/device/${id}/phasesettings`);
    // Undocumented / speculative
    await probe(`/device/${id}/firmwareimage`);
    await probe(`/device/${id}/networkinterface`);
    await probe(`/device/${id}/associatedzone`);
    await probe(`/device/${id}/associatedarea`);
    await probe(`/device/${id}/componentstatus`);
    await probe(`/device/${id}/loadcontroller`);
    await probe(`/device/${id}/databaseproperties`);
    await probe(`/device/${id}/addressedstate`);
  }
}

async function probeControlStations() {
  console.log("\n\x1b[1m=== Control Stations ===\x1b[0m");
  const body = await probe("/controlstation");
  const ids = extractIds(body ?? {}, "ControlStations");
  for (const id of ids) {
    await probe(`/controlstation/${id}`);
    await probe(`/controlstation/${id}/associatedcontrolstation`);
  }
}

async function probeButtons() {
  console.log("\n\x1b[1m=== Buttons & Presets ===\x1b[0m");
  await probe("/button");
  await probe("/buttongroup");
  await probe("/buttongroup/expanded");
  await probe("/preset");
  await probe("/presetassignment");
  await probe("/areascene");
  await probe("/areasceneassignment");
  await probe("/virtualbutton");
  await probe("/programmingmodel");
  await probe("/fadefighterproperties/programmingmodel/preset");
}

async function probeOccupancy() {
  console.log("\n\x1b[1m=== Occupancy ===\x1b[0m");
  const body = await probe("/occupancygroup");
  await probe("/occupancygroup/status");
  const ids = extractIds(body ?? {}, "OccupancyGroups");
  for (const id of ids) {
    await probe(`/occupancygroup/${id}`);
    await probe(`/occupancygroup/${id}/status`);
    await probe(`/occupancygroup/${id}/associatedzone`);
    await probe(`/occupancygroup/${id}/associatedsensor`);
  }
}

async function probeTimeclocks() {
  console.log("\n\x1b[1m=== Time Clocks ===\x1b[0m");
  const body = await probe("/timeclock");
  await probe("/timeclock/status");
  const ids = extractIds(body ?? {}, "TimeClocks");
  for (const id of ids) {
    await probe(`/timeclock/${id}`);
    await probe(`/timeclock/${id}/status`);
    await probe(`/timeclock/${id}/associatedevent`);
  }
  await probe("/timeclockevent");
}

async function probeIntegrations() {
  console.log("\n\x1b[1m=== Integrations ===\x1b[0m");
  await probe("/homekitdata");
  await probe("/associatedalias");
  await probe("/household");
  await probe("/favorite");
  await probe("/detectiongroup");
  await probe("/facade");
}

async function probeSpeculative() {
  console.log("\n\x1b[1m=== Speculative / Undocumented ===\x1b[0m");
  const speculative = [
    "/loadcontroller",
    "/naturalshow",
    "/curvedimming",
    "/spectrum",
    "/whitetuning",
    "/warmdim",
    "/fanspeedconfiguration",
    "/cco",
    "/receptacle",
    "/sensor",
    "/motionsensor",
    "/photosensor",
    "/temperaturesensor",
    "/devicediscovery",
    "/deviceactivation",
    "/deviceextraction",
    "/unpaireddevice",
    "/pairing",
    "/commissioning",
    "/addressing",
    "/migration",
    "/transfer",
    "/diagnostics",
    "/debug",
    "/logging",
    "/crash",
    "/reset",
    "/factory",
    "/backup",
    "/restore",
    "/export",
    "/import",
    "/schedule",
    "/automation",
    "/rule",
    "/trigger",
    "/condition",
    "/action",
    "/notification",
    "/alert",
    "/user",
    "/client",
    "/session",
    "/permission",
    "/role",
    "/access",
    "/security",
    "/network",
    "/wifi",
    "/ethernet",
    "/bluetooth",
    "/thread",
    "/zigbee",
    "/rf",
    "/radio",
    "/antenna",
    "/channel",
    "/firmware",
    "/update",
    "/version",
    "/status",
    "/health",
    "/info",
    "/config",
    "/settings",
    "/preferences",
    "/telemetry",
    "/metrics",
    "/counters",
    "/statistics",
    "/performance",
    "/power",
    "/energy",
    "/loadshedding",
    "/peak",
    "/demand",
    "/cloudprovision",
    "/crosssign",
    "/system/status/crosssign",
    "/api/v1/provisioning/client",
    "/api/v2/provisioning/client",
    "/api/v2/remotepairing/application/association",
  ];

  for (const url of speculative) {
    await probe(url);
  }
}

// --- Main ---

async function main() {
  conn = new LeapConnection({ host: HOST });
  console.log(`Connecting to ${HOST}:8081...`);
  await conn.connect();
  console.log("Connected.\n");

  const sections: Record<string, () => Promise<void>> = {
    system: probeSystem,
    links: probeLinks,
    areas: probeAreas,
    zones: probeZones,
    devices: probeDevices,
    controlstations: probeControlStations,
    buttons: probeButtons,
    occupancy: probeOccupancy,
    timeclocks: probeTimeclocks,
    integrations: probeIntegrations,
    speculative: probeSpeculative,
  };

  if (SECTION) {
    const fn = sections[SECTION.toLowerCase()];
    if (!fn) {
      console.error(`Unknown section: ${SECTION}`);
      console.error(`Available: ${Object.keys(sections).join(", ")}`);
      process.exit(1);
    }
    await fn();
  } else {
    for (const [_name, fn] of Object.entries(sections)) {
      await fn();
    }
  }

  conn.close();

  // Summary
  const ok = Object.values(results).filter((r) =>
    r.status?.startsWith("2"),
  ).length;
  const fail = Object.values(results).filter(
    (r) => !r.status?.startsWith("2"),
  ).length;
  console.log(`\n\x1b[1m=== Summary ===\x1b[0m`);
  console.log(`  ${ok} successful, ${fail} failed/unsupported`);

  // Print all successful endpoints grouped
  console.log(`\n\x1b[1m=== All Successful Endpoints ===\x1b[0m`);
  for (const [url, result] of Object.entries(results).sort()) {
    if (result.status?.startsWith("2")) {
      const body = result.body;
      const keys = body ? Object.keys(body) : [];
      console.log(`  ${url} → ${keys.join(", ")}`);
    }
  }

  if (SAVE) {
    mkdirSync("data", { recursive: true });
    const filename = `data/leap-explore-${HOST}-${new Date().toISOString().slice(0, 10)}.json`;
    writeFileSync(filename, JSON.stringify(results, null, 2) + "\n");
    console.log(`\nSaved full results to ${filename}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
