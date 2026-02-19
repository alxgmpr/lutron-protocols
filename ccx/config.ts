/**
 * CCX Network Configuration
 *
 * Auto-loads from LEAP dump files in data/leap-*.json.
 * Generate with: bun run tools/leap-dump.ts
 * Or refresh from CLI: bun run cli/nucleo.ts --update-leap
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { LeapDumpData } from "../tools/leap-client";

const LUTRON_UDP_PORT = 9190;

function base64ToHex(base64: string, separator = ""): string {
  const hex = Buffer.from(base64, "base64").toString("hex");
  if (!separator) return hex;
  return hex.replace(/(.{2})(?!$)/g, `$1${separator}`);
}

function loadLeapFromDisk(): LeapDumpData | null {
  const dataDir = join((import.meta as any).dir, "../data");
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

/** Look up a device name by IPv6 address */
export function getDeviceName(_ipv6: string): string | undefined {
  return undefined;
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

/** Get all known zones as a flat list (for enumeration and name search) */
export function getAllZones(): { id: number; name: string }[] {
  const data = getLeapData();
  if (!data) return [];
  return Object.entries(data.zones).map(([id, zone]) => ({
    id: Number(id),
    name: formatZoneName(zone),
  }));
}
