#!/usr/bin/env bun

/**
 * CCX Device Map — build a unified device inventory from Designer DB + LEAP + manual map
 *
 * Combines three data sources:
 *   1. Designer DB (tblPegasusLinkNode) — EUI-64 + serial number for every CCX device
 *   2. LEAP dump (data/leap-*.json) — device names, types, areas, zones
 *   3. Manual primary ML-EID map (data/ccx-device-map.json) — known reachable addresses
 *
 * Usage:
 *   bun run tools/ccx-device-map.ts                 # show full device inventory
 *   bun run tools/ccx-device-map.ts --save           # save to data/ccx-device-map.json
 *   bun run tools/ccx-device-map.ts --discover       # active discovery via CoAP (requires Nucleo)
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CCXDevice {
  serial: number;
  eui64: string; // from Designer DB secondary ML-EID
  secondaryMleid: string; // full fd00:: address from Designer DB
  primaryMleid?: string; // reachable address (from manual map or discovery)
  name: string; // e.g. "Kitchen Entrance SunnataDimmer"
  area: string;
  station: string;
  deviceType: string;
  modelInfoId?: number;
  zones: { id: number; name: string }[];
  leapDeviceId?: number;
}

interface DeviceMap {
  timestamp: string;
  meshLocalPrefix: string;
  devices: CCXDevice[];
}

// ---------------------------------------------------------------------------
// EUI-64 extraction from secondary ML-EID
// ---------------------------------------------------------------------------

/**
 * Extract EUI-64 from a secondary ML-EID (contains ff:fe pattern).
 * e.g. fd00::3c2e:f5ff:fef9:73f9 → 3e:2e:f5:f9:73:f9
 * The EUI-64 is in the last 8 bytes of the IPv6 IID, with bit 6 flipped.
 */
function eui64FromSecondaryMleid(addr: string): string {
  // Parse the IPv6 address to get last 8 bytes (IID)
  const parts = expandIPv6(addr).split(":");
  // IID is last 4 groups (bytes 8-15)
  const iidHex = parts[4] + parts[5] + parts[6] + parts[7];
  const iidBytes = Buffer.from(iidHex, "hex");

  // Flip bit 6 of byte 0 to recover original MAC/EUI-64
  iidBytes[0] ^= 0x02;

  return Array.from(iidBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

/**
 * Expand an IPv6 address to full 8-group notation.
 * Handles :: shorthand.
 */
function expandIPv6(addr: string): string {
  // Remove zone ID if present
  addr = addr.replace(/%.*$/, "");

  if (addr.includes("::")) {
    const [left, right] = addr.split("::");
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const middle = Array(missing).fill("0000");
    const all = [
      ...leftParts.map((p) => p.padStart(4, "0")),
      ...middle,
      ...rightParts.map((p) => p.padStart(4, "0")),
    ];
    return all.join(":");
  }

  return addr
    .split(":")
    .map((p) => p.padStart(4, "0"))
    .join(":");
}

// ---------------------------------------------------------------------------
// Load Designer DB data (via pre-fetched query or live MCP)
// ---------------------------------------------------------------------------

interface DesignerDevice {
  serial: number;
  secondaryMleid: string;
  eui64: string;
  stationName: string;
  areaName: string;
  modelInfoId: number;
  parentDeviceId: number;
}

async function loadDesignerData(): Promise<DesignerDevice[]> {
  // Try loading from cached file first
  const cacheFile = join(import.meta.dir, "../data/designer-ccx-devices.json");
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf-8"));
  }
  console.error(
    "No cached Designer data found. Run with --fetch-designer to query the database.",
  );
  console.error(`  Expected: ${cacheFile}`);
  return [];
}

// ---------------------------------------------------------------------------
// Load LEAP data
// ---------------------------------------------------------------------------

interface LeapSerial {
  name: string;
  leapId: number;
  type: string;
  area: string;
}

interface LeapData {
  serials: Record<string, LeapSerial>;
  zones: Record<
    string,
    { name: string; controlType: string; area: string; deviceSerial?: number }
  >;
  devices: Record<
    string,
    {
      name: string;
      type: string;
      serial: number;
      model?: string;
      station: string;
      area: string;
    }
  >;
}

function loadLeapData(): LeapData {
  const dataDir = join(import.meta.dir, "../data");
  const merged: LeapData = { serials: {}, zones: {}, devices: {} };

  if (!existsSync(dataDir)) return merged;

  const { readdirSync: readdir } = require("fs");
  const files = readdir(dataDir)
    .filter((f) => f.startsWith("leap-") && f.endsWith(".json"))
    .sort();

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dataDir, file), "utf-8"));
      Object.assign(merged.serials, data.serials ?? {});
      Object.assign(merged.zones, data.zones ?? {});
      Object.assign(merged.devices, data.devices ?? {});
    } catch {
      // skip
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Load manual primary ML-EID map
// ---------------------------------------------------------------------------

interface ManualEntry {
  area: string;
  station: string;
  primaryMleid: string;
}

function loadManualMap(): ManualEntry[] {
  // Parse from docs/ccx-device-map.md (the markdown table)
  const mdFile = join(import.meta.dir, "../docs/ccx-device-map.md");
  if (!existsSync(mdFile)) return [];

  const content = readFileSync(mdFile, "utf-8");
  const entries: ManualEntry[] = [];

  for (const line of content.split("\n")) {
    // Match table rows: | Area | Station | IID | Full Address |
    const match = line.match(
      /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*`(.+?)`\s*\|\s*`(.+?)`\s*\|$/,
    );
    if (match && !match[1].includes("---") && !match[1].includes("Area")) {
      entries.push({
        area: match[1].trim(),
        station: match[2].trim(),
        primaryMleid: match[4].trim(),
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Load saved device map (with previously discovered primary ML-EIDs)
// ---------------------------------------------------------------------------

function loadSavedMap(): DeviceMap | null {
  const file = join(import.meta.dir, "../data/ccx-device-map.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Merge all data sources
// ---------------------------------------------------------------------------

/** Map Designer ModelInfoID to human-readable device type */
function modelToType(modelInfoId: number): string {
  const models: Record<number, string> = {
    5056: "SunnataDimmer", // HRST-PRO-N-XX
    5062: "SunnataKeypad", // HRST-W4B-XX (4-button)
    5063: "SunnataKeypad", // HRST-W3RL-XX (3-button raise/lower)
    5194: "SunnataHybridKeypad", // HRST-HN3RL-XX (hybrid 3-button R/L)
    5195: "SunnataHybridKeypad", // HRST-HN4B-XX (hybrid 4-button)
    5248: "SunnataFanControl", // HRST-ANF-XX
  };
  return models[modelInfoId] ?? "Unknown";
}

function buildDeviceMap(
  designerDevices: DesignerDevice[],
  leap: LeapData,
  manualMap: ManualEntry[],
  savedMap: DeviceMap | null,
): DeviceMap {
  const devices: CCXDevice[] = [];

  for (const dd of designerDevices) {
    const serialInfo = leap.serials[dd.serial];

    // Find zones associated with this device serial
    const zones: { id: number; name: string }[] = [];
    for (const [zoneId, zone] of Object.entries(leap.zones)) {
      if (zone.deviceSerial === dd.serial) {
        const name = zone.area ? `${zone.area} ${zone.name}` : zone.name;
        zones.push({ id: Number(zoneId), name });
      }
    }

    // Find LEAP device entry
    let leapDeviceId: number | undefined;
    let deviceName = `${dd.areaName} ${dd.stationName}`;
    let deviceType = modelToType(dd.modelInfoId);

    if (serialInfo) {
      deviceName = serialInfo.name;
      deviceType = serialInfo.type;
      leapDeviceId = serialInfo.leapId;
    }

    // Match manual ML-EID by area + station
    let primaryMleid: string | undefined;

    // Check manual map
    const manualMatch = manualMap.find(
      (m) =>
        m.area.toLowerCase() === dd.areaName.toLowerCase() &&
        matchStation(m.station, dd.stationName),
    );
    if (manualMatch) {
      primaryMleid = manualMatch.primaryMleid;
    }

    // Check saved map (may have discovered addresses from previous runs)
    if (!primaryMleid && savedMap) {
      const savedDevice = savedMap.devices.find(
        (d) => d.serial === dd.serial && d.primaryMleid,
      );
      if (savedDevice) {
        primaryMleid = savedDevice.primaryMleid;
      }
    }

    devices.push({
      serial: dd.serial,
      eui64: dd.eui64,
      secondaryMleid: dd.secondaryMleid,
      primaryMleid,
      name: deviceName,
      area: dd.areaName,
      station: dd.stationName,
      deviceType,
      modelInfoId: dd.modelInfoId,
      zones,
      leapDeviceId,
    });
  }

  // Sort by area then station
  devices.sort((a, b) => {
    const areaComp = a.area.localeCompare(b.area);
    if (areaComp !== 0) return areaComp;
    return a.station.localeCompare(b.station);
  });

  return {
    timestamp: new Date().toISOString(),
    meshLocalPrefix: "fd0d:2ef:a82c:0",
    devices,
  };
}

function matchStation(manualStation: string, dbStation: string): boolean {
  const a = manualStation.toLowerCase();
  const b = dbStation.toLowerCase();
  if (a === b) return true;
  // Handle partial matches like "Entry" vs "Entryway", "End" vs "End of Hallway"
  if (a.startsWith(b) || b.startsWith(a)) return true;
  // "Entrance" vs "Doorway" type mismatches need manual intervention
  return false;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function displayDeviceMap(map: DeviceMap): void {
  const total = map.devices.length;
  const mapped = map.devices.filter((d) => d.primaryMleid).length;

  console.log(
    `\n${BOLD}CCX Device Inventory${RESET}  ${DIM}(${mapped}/${total} addresses known)${RESET}\n`,
  );

  let lastArea = "";
  for (const dev of map.devices) {
    if (dev.area !== lastArea) {
      lastArea = dev.area;
      console.log(`${BOLD}${dev.area}${RESET}`);
    }

    const addrStatus = dev.primaryMleid
      ? `${GREEN}${dev.primaryMleid}${RESET}`
      : `${RED}unknown${RESET}`;

    const typeShort = dev.deviceType
      .replace("Sunnata", "")
      .replace("Hybrid", "")
      .replace("Keypad", "KP")
      .replace("Dimmer", "Dim");

    console.log(
      `  ${dev.station.padEnd(20)} ${CYAN}${typeShort.padEnd(10)}${RESET} ` +
        `${DIM}serial=${dev.serial}${RESET}  ${addrStatus}`,
    );

    if (dev.zones.length > 0) {
      for (const z of dev.zones) {
        console.log(`    ${DIM}zone ${z.id}: ${z.name}${RESET}`);
      }
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Fetch Designer DB data (requires MCP or SSH access)
// ---------------------------------------------------------------------------

async function fetchDesignerData(): Promise<DesignerDevice[]> {
  // This generates the SQL query output. In practice, this is called via
  // the designer-db MCP tool. We'll generate the cache file format here.
  console.log("To fetch Designer data, run this SQL via designer-db MCP:\n");
  console.log(`SELECT
    pln.IPv6Address,
    csd.SerialNumber,
    cs.Name AS StationName,
    a.Name AS AreaName,
    csd.ModelInfoID,
    ln.ParentDeviceID
FROM tblPegasusLinkNode pln
JOIN tblLinkNode ln ON ln.LinkNodeID = pln.LinkNodeID
JOIN tblControlStationDevice csd ON csd.ControlStationDeviceID = ln.ParentDeviceID AND ln.ParentDeviceType = 5
JOIN tblControlStation cs ON cs.ControlStationID = csd.ParentControlStationID
JOIN tblArea a ON a.AreaID = cs.ParentId
ORDER BY a.Name, cs.Name`);
  console.log("\nThen save the result as data/designer-ccx-devices.json");
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const doSave = args.includes("--save");
const doFetchDesigner = args.includes("--fetch-designer");

if (doFetchDesigner) {
  await fetchDesignerData();
  process.exit(0);
}

// Load all data sources
const designerDevices = await loadDesignerData();
const leap = loadLeapData();
const manualMap = loadManualMap();
const savedMap = loadSavedMap();

if (designerDevices.length === 0) {
  console.error(
    "No Designer device data available. Generate with --fetch-designer first.",
  );
  process.exit(1);
}

const deviceMap = buildDeviceMap(designerDevices, leap, manualMap, savedMap);

displayDeviceMap(deviceMap);

if (doSave) {
  const outFile = join(import.meta.dir, "../data/ccx-device-map.json");
  writeFileSync(outFile, JSON.stringify(deviceMap, null, 2) + "\n");
  console.log(`Saved to ${outFile}`);
}
