/**
 * CCX Network Configuration
 *
 * Auto-loads from LEAP dump files in data/leap-*.json.
 * Generate with: npx tsx tools/leap-dump.ts
 * Or refresh from CLI: npx tsx cli/nucleo.ts --update-leap
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { LeapDumpData } from "../lib/leap-client";
import { eui64ToSecondaryMleid } from "./addressing";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const LUTRON_UDP_PORT = 9190;

function base64ToHex(base64: string, separator = ""): string {
  const hex = Buffer.from(base64, "base64").toString("hex");
  if (!separator) return hex;
  return hex.replace(/(.{2})(?!$)/g, `$1${separator}`);
}

/** Resolve data directory: CCX_DATA_DIR env var, or ../data relative to this file */
export function resolveDataDir(): string {
  return process.env.CCX_DATA_DIR ?? join(__dir, "../data");
}

function loadLeapFromDisk(): LeapDumpData | null {
  const dataDir = resolveDataDir();
  if (!existsSync(dataDir)) return null;

  const files = readdirSync(dataDir)
    .filter((f) => f.startsWith("leap-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) return null;

  const merged: Pick<
    LeapDumpData,
    "zones" | "devices" | "serials" | "presets"
  > & {
    link?: LeapDumpData["link"];
  } = {
    zones: {},
    devices: {},
    serials: {},
    presets: {},
  };

  for (const file of files) {
    try {
      const data: LeapDumpData = JSON.parse(
        readFileSync(join(dataDir, file), "utf-8"),
      );
      Object.assign(merged.zones, data.zones ?? {});
      Object.assign(merged.devices, data.devices ?? {});
      Object.assign(merged.serials, data.serials ?? {});
      Object.assign(merged.presets, data.presets ?? {});
      if (data.link) {
        if (!merged.link) merged.link = {} as LeapDumpData["link"];
        if (data.link.rf) merged.link!.rf = data.link.rf;
        if (data.link.ccx) merged.link!.ccx = data.link.ccx;
      }
    } catch {
      // Skip malformed files
    }
  }

  return merged as LeapDumpData;
}

// ---------------------------------------------------------------------------
// Device map (ccx-device-map.json) — merged Designer DB + LEAP + manual map
// ---------------------------------------------------------------------------

interface CCXDeviceEntry {
  serial: number;
  eui64: string;
  /** Stable fd00::<modified-EUI-64>. Preferred for writes. */
  secondaryMleid: string;
  /** Legacy rotating fd0d:…-prefixed address. Kept only as an RX-identification alias. */
  primaryMleid?: string;
  name: string;
  area: string;
  station: string;
  deviceType: string;
  zones: { id: number; name: string }[];
  leapDeviceId?: number;
}

interface DeviceMapData {
  meshLocalPrefix: string;
  devices: CCXDeviceEntry[];
}

function loadDeviceMap(): DeviceMapData | null {
  const mapFile = join(resolveDataDir(), "ccx-device-map.json");
  if (!existsSync(mapFile)) return null;
  try {
    return JSON.parse(readFileSync(mapFile, "utf-8"));
  } catch {
    return null;
  }
}

const _deviceMap = loadDeviceMap();

// Build lookup indices — address → device is keyed by BOTH the stable
// secondary ML-EID and the legacy primary ML-EID, so RX packets seen on
// either address path resolve to the same device entry.
const _addrToDevice = new Map<string, CCXDeviceEntry>();
const _serialToDevice = new Map<number, CCXDeviceEntry>();
if (_deviceMap) {
  for (const dev of _deviceMap.devices) {
    // Fill secondaryMleid if the file is an older version that only stored eui64
    if (!dev.secondaryMleid && dev.eui64) {
      dev.secondaryMleid = eui64ToSecondaryMleid(dev.eui64);
    }
    if (dev.secondaryMleid) _addrToDevice.set(dev.secondaryMleid, dev);
    if (dev.primaryMleid) _addrToDevice.set(dev.primaryMleid, dev);
    _serialToDevice.set(dev.serial, dev);
  }
}

const _diskData = loadLeapFromDisk();
let _leapOverride: LeapDumpData | null = null;

function getLeapData(): LeapDumpData | null {
  return _leapOverride ?? _diskData;
}

const ccxLink = _diskData?.link?.ccx;

export const CCX_CONFIG = {
  channel: ccxLink?.channel ?? 0,
  panId: ccxLink?.panId ?? 0,
  extPanId: ccxLink?.extPanId
    ? base64ToHex(ccxLink.extPanId, ":").toUpperCase()
    : "",
  masterKey: ccxLink?.masterKey
    ? base64ToHex(ccxLink.masterKey).toUpperCase()
    : "",
  udpPort: LUTRON_UDP_PORT,
};

/** Override config with live LEAP data (called by CLI on fresh fetch) */
export function setLeapData(data: LeapDumpData): void {
  _leapOverride = data;
}

/** Format a zone's display name from LEAP data (area + zone name) */
function formatZoneName(zone: { name: string; area?: string }): string {
  return zone.area ? `${zone.area} ${zone.name}` : zone.name;
}

/** Look up a device name by IPv6 address (primary ML-EID) */
export function getDeviceName(ipv6: string): string | undefined {
  const dev = _addrToDevice.get(ipv6);
  return dev?.name;
}

/**
 * Look up a device's preferred CoAP destination address by serial number.
 * Returns the stable `fd00::` secondary ML-EID derived from the device's
 * EUI-64 — NOT the rotating primary ML-EID.
 */
export function getDeviceAddress(serial: number): string | undefined {
  return _serialToDevice.get(serial)?.secondaryMleid;
}

/** Get full device info by serial number */
export function getDeviceBySerial(serial: number): CCXDeviceEntry | undefined {
  return _serialToDevice.get(serial);
}

/** Get all CCX devices from the device map */
export function getAllDevices(): CCXDeviceEntry[] {
  return _deviceMap?.devices ?? [];
}

/** Look up a zone name by zone ID */
export function getZoneName(zoneId: number): string | undefined {
  const data = getLeapData();
  const zone = data?.zones[zoneId];
  if (!zone) return undefined;
  return formatZoneName(zone);
}

/** Look up a device name by serial number */
export function getSerialName(serial: number): string | undefined {
  const data = getLeapData();
  return data?.serials[serial]?.name;
}

/** Look up a device's area by serial number (zone proxy for CCA packets without zone_id) */
export function getSerialArea(serial: number): string | undefined {
  const data = getLeapData();
  return data?.serials[serial]?.area;
}

/** Look up a preset by ID (extracted from CCX BUTTON_PRESS device_id bytes 0-1) */
export function getPresetInfo(
  presetId: number,
): { name: string; role: string; device: string } | undefined {
  const data = getLeapData();
  return data?.presets[presetId];
}

/** Extract preset ID from CCX device_id (4-byte Uint8Array: [presetHi, presetLo, 0xEF, 0x20]) */
export function presetIdFromDeviceId(deviceId: Uint8Array): number {
  return (deviceId[0] << 8) | deviceId[1];
}

// ---------------------------------------------------------------------------
// Scene/group names (from preset-zones.json)
// ---------------------------------------------------------------------------

interface PresetZoneEntry {
  name: string;
  zones: Record<string, { level: number; fade: number }>;
}

function loadPresetZones(): Map<number, string> | null {
  const presetFile = join(resolveDataDir(), "preset-zones.json");
  if (!existsSync(presetFile)) return null;
  try {
    const data: Record<string, PresetZoneEntry> = JSON.parse(
      readFileSync(presetFile, "utf-8"),
    );
    const map = new Map<number, string>();
    for (const [id, entry] of Object.entries(data)) {
      map.set(Number(id), entry.name);
    }
    return map;
  } catch {
    return null;
  }
}

const _sceneNames = loadPresetZones();

/** Look up a scene/group name by its ID (from preset-zones.json) */
export function getSceneName(sceneId: number): string | undefined {
  return _sceneNames?.get(sceneId);
}

/** Get all known zones as a flat list (for enumeration and name search) */
export function getAllZones(): { id: number; name: string }[] {
  const data = getLeapData();
  if (!data) return [];
  return Object.entries(data.zones).map(([id, zone]) => ({
    id: Number(id),
    name: formatZoneName(zone),
  }));
}

/** Get all zones with controlType (for filtering dimmable/switched zones) */
export function getAllZonesWithControlType(): {
  id: number;
  name: string;
  controlType: string;
}[] {
  const data = getLeapData();
  if (!data) return [];
  return Object.entries(data.zones).map(([id, zone]) => ({
    id: Number(id),
    name: formatZoneName(zone),
    controlType: zone.controlType,
  }));
}
