#!/usr/bin/env npx tsx

/**
 * Decode preset assignment messages from a transfer capture.
 * Reads tshark output (ipv6.dst + hex data) and decodes CBOR payloads.
 *
 * Format: /cg/db/pr/c/AAI CoAP PUT
 *   CBOR: {<4-byte key>: [72, {0: <level16>, 3?: <fade_qs>}]}
 *   Key bytes 0-1 = preset ID (BE uint16), bytes 2-3 = 0xEF20
 */

import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

// Load presets from LEAP dump files
const dataDir = join(__dir, "../data");
const presets: Record<string, { name: string; role: string; device: string }> =
  {};
for (const file of readdirSync(dataDir).filter(
  (f) => f.startsWith("leap-") && f.endsWith(".json"),
)) {
  try {
    const data = JSON.parse(readFileSync(join(dataDir, file), "utf-8"));
    Object.assign(presets, data.presets ?? {});
  } catch {}
}

// Load device map for ML-EID → device resolution
interface CCXDevice {
  serial: number;
  secondaryMleid: string;
  name: string;
  area: string;
  station: string;
  deviceType: string;
}
const deviceMap: CCXDevice[] = (() => {
  try {
    const data = JSON.parse(
      readFileSync(join(dataDir, "ccx-device-map.json"), "utf-8"),
    );
    return data.devices ?? [];
  } catch {
    return [];
  }
})();

// Load known zones from LEAP dumps
const knownZones = new Map<number, string>();
for (const file of readdirSync(dataDir).filter(
  (f) => f.startsWith("leap-") && f.endsWith(".json"),
)) {
  try {
    const data = JSON.parse(readFileSync(join(dataDir, file), "utf-8"));
    for (const [zid, z] of Object.entries(data.zones ?? {})) {
      const zone = z as any;
      knownZones.set(Number(zid), `${zone.area} ${zone.name}`);
    }
  } catch {}
}

// Build ML-EID suffix → device lookup
const mleidToDevice = new Map<string, CCXDevice>();
for (const dev of deviceMap) {
  const iid = dev.secondaryMleid.replace(/^.*::/, "::");
  mleidToDevice.set(iid, dev);
}

// ML-EID → zone mapping: populated from mc/AAI multicast group data
// (passed via second TSV file argument or loaded from capture)
const mleidToZone = new Map<string, { id: number; name: string }>();

// Load mc/AAI data if available
const mcFile = process.argv[2] ?? "/tmp/mc-assignments.tsv";
try {
  const mcLines = readFileSync(mcFile, "utf-8").trim().split("\n");
  const byDevice = new Map<string, number[]>();
  for (const line of mcLines) {
    const [mleid, hex] = line.split("\t");
    if (!hex || hex.length < 14) continue;
    const id = parseInt(hex.slice(4, 12), 16);
    if (!byDevice.has(mleid)) byDevice.set(mleid, []);
    if (!byDevice.get(mleid)!.includes(id)) byDevice.get(mleid)!.push(id);
  }
  for (const [mleid, ids] of byDevice) {
    for (const id of ids) {
      const zoneName = knownZones.get(id);
      if (zoneName) {
        mleidToZone.set(mleid, { id, name: zoneName });
        break;
      }
    }
  }
} catch {}

function resolveDevice(mleid: string): {
  device: CCXDevice | null;
  zone: { id: number; name: string } | null;
} {
  const iid = "::" + mleid.replace(/^::/, "");
  const dev = mleidToDevice.get(iid);
  const zone = mleidToZone.get(mleid) ?? null;
  return { device: dev ?? null, zone };
}

function eui64FromMleid(mleid: string): string {
  const parts = mleid.replace(/^::/, "").split(":");
  if (parts.length !== 4) return "";
  const full = parts.map((p) => p.padStart(4, "0")).join("");
  const firstByte = parseInt(full.slice(0, 2), 16) ^ 0x02;
  return firstByte.toString(16).padStart(2, "0") + full.slice(2);
}

// Read tshark TSV output
const lines = readFileSync("/tmp/preset-assignments.tsv", "utf-8")
  .trim()
  .split("\n");

interface Assignment {
  presetId: number;
  mleid: string;
  eui64: string;
  level16: number;
  levelPercent: number;
  fadeQs?: number;
}

const assignments: Assignment[] = [];
const seen = new Set<string>();

for (const line of lines) {
  const [mleid, hex] = line.split("\t");
  if (!hex) continue;

  // Dedup (each message sent twice for reliability)
  const key = `${mleid}:${hex}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const buf = Buffer.from(hex, "hex");

  // Parse CBOR manually:
  // a1 = map(1)
  // 44 = bytes(4) = key
  // 82 = array(2)
  // 18 48 = uint(72)
  // a1/a2 = map(1 or 2)
  //   00 = key 0 (level)
  //   19 XXXX or 18 XX or 00 = value
  //   03 = key 3 (fade) [optional]

  if (buf[0] !== 0xa1 || buf[1] !== 0x44) continue;

  const deviceId = buf.slice(2, 6);
  const presetId = (deviceId[0] << 8) | deviceId[1];

  // Find type 72 marker
  let pos = 6;
  if (buf[pos] !== 0x82) continue;
  pos++;

  // Read type (should be 72 = 0x48)
  let msgType: number;
  if (buf[pos] === 0x18) {
    msgType = buf[pos + 1];
    pos += 2;
  } else {
    msgType = buf[pos];
    pos++;
  }
  if (msgType !== 72) continue;

  // Read inner map
  const mapSize = buf[pos] & 0x0f;
  pos++;

  let level16 = 0;
  let fadeQs: number | undefined;

  for (let i = 0; i < mapSize; i++) {
    const k = buf[pos];
    pos++;

    let v: number;
    if (buf[pos] === 0x19) {
      v = (buf[pos + 1] << 8) | buf[pos + 2];
      pos += 3;
    } else if (buf[pos] === 0x18) {
      v = buf[pos + 1];
      pos += 2;
    } else {
      v = buf[pos];
      pos++;
    }

    if (k === 0) level16 = v;
    if (k === 3) fadeQs = v;
  }

  const levelPercent = Math.round((level16 / 0xfeff) * 10000) / 100;
  const eui64 = eui64FromMleid(mleid);

  assignments.push({ presetId, mleid, eui64, level16, levelPercent, fadeQs });
}

// Group by preset ID
const byPreset = new Map<number, Assignment[]>();
for (const a of assignments) {
  if (!byPreset.has(a.presetId)) byPreset.set(a.presetId, []);
  byPreset.get(a.presetId)!.push(a);
}

// Get preset names from config
const presetNames = new Map<number, string>();
for (const [id, info] of Object.entries(presets ?? {})) {
  presetNames.set(Number(id), `${info.name} [${info.device}]`);
}

// Build bridge-ready data structure: preset → zone → level
const bridgeData: Record<
  string,
  {
    name: string;
    zones: Record<string, { level: number; fade?: number }>;
  }
> = {};

for (const [presetId, assigns] of [...byPreset].sort((a, b) => a[0] - b[0])) {
  const name = presetNames.get(presetId) ?? "(unknown)";
  const zoneAssigns: {
    zoneId: number;
    zoneName: string;
    level: number;
    fade?: number;
  }[] = [];

  for (const a of assigns) {
    const { zone } = resolveDevice(a.mleid);
    if (zone) {
      zoneAssigns.push({
        zoneId: zone.id,
        zoneName: zone.name,
        level: a.levelPercent,
        fade: a.fadeQs,
      });
    }
  }

  if (zoneAssigns.length === 0) continue;

  const zonesMap: Record<string, { level: number; fade?: number }> = {};
  for (const za of zoneAssigns.sort((a, b) => a.zoneId - b.zoneId)) {
    const entry: { level: number; fade?: number } = { level: za.level };
    if (za.fade !== undefined) entry.fade = za.fade;
    zonesMap[za.zoneId] = entry;
  }
  bridgeData[presetId] = { name, zones: zonesMap };
}

// JSON output mode: write lookup table
const jsonOut = process.argv.includes("--json");
const saveOut = process.argv.includes("--save");

if (jsonOut || saveOut) {
  const json = JSON.stringify(bridgeData, null, 2);
  if (saveOut) {
    const outPath = join(dataDir, "preset-zones.json");
    require("fs").writeFileSync(outPath, json + "\n");
    console.error(
      `Saved ${Object.keys(bridgeData).length} presets to ${outPath}`,
    );
  }
  if (jsonOut) {
    console.log(json);
  }
} else {
  // Human-readable output
  console.log(
    `=== ${assignments.length} unique preset assignments across ${byPreset.size} presets ===\n`,
  );

  const allMleids = new Set(assignments.map((a) => a.mleid));
  console.log(`=== ${allMleids.size} unique destination devices ===`);
  for (const mleid of [...allMleids].sort()) {
    const { device, zone } = resolveDevice(mleid);
    const name = device
      ? `${device.area} ${device.station} ${device.deviceType}`
      : "(unknown)";
    const zoneStr = zone ? ` → zone ${zone.id}: ${zone.name}` : " → NO ZONE";
    console.log(`  ${mleid}  ${name}${zoneStr}`);
  }

  console.log("\n=== BRIDGE-READY: Preset → Zone → Level ===\n");
  for (const [pid, data] of Object.entries(bridgeData)) {
    console.log(`Preset ${pid} "${data.name}":`);
    for (const [zid, z] of Object.entries(data.zones)) {
      const zoneName = knownZones.get(Number(zid)) ?? "";
      const fade = z.fade !== undefined ? ` fade=${z.fade / 4}s` : "";
      console.log(`  zone ${zid} (${zoneName}): ${z.level}%${fade}`);
    }
  }
}
