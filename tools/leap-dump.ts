#!/usr/bin/env bun
/**
 * LEAP API Dump - Enumerate all devices, buttons, presets, and zones
 *
 * Connects to the RadioRA3 processor via LEAP (port 8081) and walks the
 * full device hierarchy to build preset→button mappings needed for CCX decoding.
 *
 * Usage:
 *   bun run tools/leap-dump.ts                     # Full human-readable dump
 *   bun run tools/leap-dump.ts --json               # JSON output
 *   bun run tools/leap-dump.ts --config             # Generate ccx/config.ts updates
 *   bun run tools/leap-dump.ts --host 10.0.0.1    # Custom host
 *
 * Requires TLS certificates in the project root:
 *   lutron-ra3-cert.pem, lutron-ra3-key.pem, lutron-ra3-ca.pem
 */

import * as tls from "tls";
import * as fs from "fs";
import * as path from "path";

// --- CLI args ---

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

const HOST = getArg("--host") ?? "10.0.0.1";
const PORT = 8081;
const JSON_OUTPUT = hasFlag("--json");
const CONFIG_OUTPUT = hasFlag("--config");
const CERT_DIR = path.resolve(import.meta.dir, "..");

// --- Types ---

interface PresetMapping {
  presetId: number;
  buttonId: number;
  buttonNumber: number;
  buttonName: string;
  engraving?: string;
  programmingModelType: string;
  presetRole: "primary" | "secondary" | "single";
  deviceId: number;
  deviceName: string;
  deviceType: string;
  serialNumber: number;
  stationName: string;
  areaName: string;
}

interface DeviceInfo {
  id: number;
  name: string;
  type: string;
  serial: number;
  station: string;
  area: string;
}

interface ZoneInfo {
  id: number;
  name: string;
  controlType: string;
  area: string;
}

// --- LEAP Connection ---

class LeapConnection {
  private socket: tls.TLSSocket | null = null;
  private buffer = "";
  private pendingRequests: Map<
    string,
    { resolve: (value: any) => void; reject: (err: Error) => void }
  > = new Map();

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect(
        PORT,
        HOST,
        {
          cert: fs.readFileSync(path.join(CERT_DIR, "lutron-ra3-cert.pem")),
          key: fs.readFileSync(path.join(CERT_DIR, "lutron-ra3-key.pem")),
          ca: fs.readFileSync(path.join(CERT_DIR, "lutron-ra3-ca.pem")),
          rejectUnauthorized: false,
        },
        () => resolve()
      );

      this.socket.on("data", (data) => this.handleData(data.toString()));
      this.socket.on("error", (err) => {
        for (const [, req] of this.pendingRequests) {
          req.reject(err);
        }
        this.pendingRequests.clear();
        reject(err);
      });
    });
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line);
        const url = resp.Header?.Url ?? "";
        const pending = this.pendingRequests.get(url);
        if (pending) {
          this.pendingRequests.delete(url);
          pending.resolve(resp);
        }
      } catch {}
    }
  }

  async read(url: string): Promise<any> {
    if (!this.socket) throw new Error("Not connected");

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(url, { resolve, reject });

      const req = JSON.stringify({
        CommuniqueType: "ReadRequest",
        Header: { Url: url },
      });
      this.socket!.write(req + "\n");

      setTimeout(() => {
        if (this.pendingRequests.has(url)) {
          this.pendingRequests.delete(url);
          reject(new Error(`Timeout reading ${url}`));
        }
      }, 10000);
    });
  }

  async readBody(url: string): Promise<any | null> {
    try {
      const resp = await this.read(url);
      const status = resp.Header?.StatusCode ?? "";
      if (status.startsWith("204") || status.startsWith("404")) return null;
      return resp.Body ?? null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

// --- Helpers ---

function hrefId(href: string): number {
  const match = href.match(/\/(\d+)$/);
  return match ? parseInt(match[1]) : 0;
}

function log(msg: string): void {
  if (!JSON_OUTPUT && !CONFIG_OUTPUT) {
    process.stderr.write(msg + "\n");
  }
}

// --- Main ---

async function main() {
  const leap = new LeapConnection();
  log(`Connecting to ${HOST}:${PORT}...`);
  await leap.connect();
  log("Connected.\n");

  // Step 1: Get all areas
  log("Fetching areas...");
  const areasBody = await leap.readBody("/area");
  const areas: { href: string; Name: string; IsLeaf: boolean }[] =
    areasBody?.Areas ?? [];
  const areaNames = new Map<number, string>();
  for (const a of areas) areaNames.set(hrefId(a.href), a.Name);
  log(`  ${areas.length} areas`);

  // Step 2: Walk leaf areas → zones + control stations → devices
  const zones: ZoneInfo[] = [];
  const deviceMeta = new Map<number, { area: string; station: string }>();

  for (const area of areas) {
    if (!area.IsLeaf) continue;
    const areaId = hrefId(area.href);

    // Zones
    const zonesBody = await leap.readBody(`/area/${areaId}/associatedzone`);
    for (const z of zonesBody?.Zones ?? []) {
      zones.push({
        id: hrefId(z.href),
        name: z.Name,
        controlType: z.ControlType,
        area: area.Name,
      });
    }

    // Control stations → ganged devices
    const csBody = await leap.readBody(
      `/area/${areaId}/associatedcontrolstation`
    );
    for (const cs of csBody?.ControlStations ?? []) {
      for (const g of cs.AssociatedGangedDevices ?? []) {
        if (g.Device?.href) {
          deviceMeta.set(hrefId(g.Device.href), {
            area: area.Name,
            station: cs.Name ?? "",
          });
        }
      }
    }
  }

  log(`  ${zones.length} zones, ${deviceMeta.size} devices`);

  // Also add the processor
  const projBody = await leap.readBody("/project");
  for (const d of projBody?.Project?.MasterDeviceList?.Devices ?? []) {
    const id = hrefId(d.href);
    if (!deviceMeta.has(id)) deviceMeta.set(id, { area: "", station: "" });
  }

  // Step 3: Fetch each device details + buttons → presets
  log("Fetching buttons and presets...");
  const devices: DeviceInfo[] = [];
  const presets: PresetMapping[] = [];

  for (const [devId, meta] of deviceMeta) {
    const devBody = await leap.readBody(`/device/${devId}`);
    const dev = devBody?.Device;
    if (!dev) continue;

    devices.push({
      id: devId,
      name: dev.Name,
      type: dev.DeviceType,
      serial: dev.SerialNumber,
      station: meta.station,
      area: meta.area,
    });

    // Get button groups
    const bgBody = await leap.readBody(`/device/${devId}/buttongroup`);
    const buttonGroups = bgBody?.ButtonGroups ?? [];

    for (const bg of buttonGroups) {
      for (const btnRef of bg.Buttons ?? []) {
        const btnId = hrefId(btnRef.href);

        const btnBody = await leap.readBody(`/button/${btnId}`);
        const btn = btnBody?.Button;
        if (!btn?.ProgrammingModel) continue;

        const pmBody = await leap.readBody(
          `/programmingmodel/${hrefId(btn.ProgrammingModel.href)}`
        );
        const pm = pmBody?.ProgrammingModel;
        if (!pm) continue;

        // Extract presets — structure varies by PM type
        const refs: { href: string; role: "primary" | "secondary" | "single" }[] = [];

        const toggleProps = pm.AdvancedToggleProperties;
        if (toggleProps?.PrimaryPreset)
          refs.push({ href: toggleProps.PrimaryPreset.href, role: "primary" });
        if (toggleProps?.SecondaryPreset)
          refs.push({ href: toggleProps.SecondaryPreset.href, role: "secondary" });
        if (pm.Preset)
          refs.push({ href: pm.Preset.href, role: "single" });
        if (pm.Presets)
          for (const p of pm.Presets)
            refs.push({ href: p.href, role: "single" });

        for (const ref of refs) {
          presets.push({
            presetId: hrefId(ref.href),
            buttonId: btnId,
            buttonNumber: btn.ButtonNumber,
            buttonName: btn.Name,
            engraving: btn.Engraving?.Text,
            programmingModelType: pm.ProgrammingModelType,
            presetRole: ref.role,
            deviceId: devId,
            deviceName: dev.Name,
            deviceType: dev.DeviceType,
            serialNumber: dev.SerialNumber,
            stationName: meta.station,
            areaName: meta.area,
          });
        }
      }
    }
  }

  log(`  ${presets.length} presets from ${devices.length} devices\n`);
  leap.close();

  // --- Output ---
  if (JSON_OUTPUT) {
    printJsonOutput(zones, devices, presets);
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
  presets: PresetMapping[]
) {
  console.log("=".repeat(90));
  console.log("LEAP System Dump");
  console.log("=".repeat(90));

  // Zones
  console.log("\n## Zones\n");
  for (const z of zones.sort((a, b) => a.id - b.id)) {
    console.log(`  ${String(z.id).padStart(4)}: ${z.area} / ${z.name} (${z.controlType})`);
  }

  // Devices (only those with buttons)
  const devicesWithButtons = new Set(presets.map((p) => p.deviceId));
  console.log("\n## Devices with Buttons\n");
  for (const d of devices
    .filter((d) => devicesWithButtons.has(d.id))
    .sort((a, b) => a.id - b.id)) {
    const displayName = d.station ? `${d.area} ${d.station}` : d.name;
    console.log(
      `  ${String(d.id).padStart(4)}: ${displayName} (${d.type}) serial=${d.serial}`
    );
  }

  // Preset → CCX Mapping
  console.log("\n## Preset → CCX Button Mapping\n");
  console.log(
    "  Preset  CCX Bytes   Role       Button              Device                          Area"
  );
  console.log("  " + "-".repeat(100));

  for (const p of presets.sort((a, b) => a.presetId - b.presetId)) {
    const ccxHex = `${p.presetId.toString(16).padStart(4, "0")} EF20`;
    const name = (p.engraving ?? p.buttonName).padEnd(18);
    const role = p.presetRole.padEnd(10);
    const device = (p.stationName
      ? `${p.areaName} ${p.stationName}`
      : p.deviceName
    ).padEnd(30);
    console.log(
      `  ${String(p.presetId).padStart(5)}  ${ccxHex}  ${role} ${name}  ${device}  ${p.areaName}`
    );
  }

  // Summary
  const pmTypes = new Set(presets.map((p) => p.programmingModelType));
  console.log(`\n## Summary\n`);
  console.log(`  Zones:   ${zones.length}`);
  console.log(`  Devices: ${devices.length} (${devicesWithButtons.size} with buttons)`);
  console.log(`  Presets: ${presets.length}`);
  console.log(`  PM Types: ${[...pmTypes].join(", ")}`);
}

function printJsonOutput(
  zones: ZoneInfo[],
  devices: DeviceInfo[],
  presets: PresetMapping[]
) {
  const output = {
    timestamp: new Date().toISOString(),
    host: HOST,
    zones: Object.fromEntries(
      zones.map((z) => [z.id, { name: z.name, controlType: z.controlType, area: z.area }])
    ),
    devices: Object.fromEntries(
      devices.map((d) => [
        d.id,
        { name: d.name, type: d.type, serial: d.serial, station: d.station, area: d.area },
      ])
    ),
    presets: presets.map((p) => ({
      presetId: p.presetId,
      ccxDeviceId: `${p.presetId.toString(16).padStart(4, "0")}ef20`,
      buttonId: p.buttonId,
      buttonNumber: p.buttonNumber,
      name: p.engraving ?? p.buttonName,
      role: p.presetRole,
      pmType: p.programmingModelType,
      deviceId: p.deviceId,
      device: p.stationName ? `${p.areaName} ${p.stationName}` : p.deviceName,
      deviceType: p.deviceType,
      serial: p.serialNumber,
      area: p.areaName,
    })),
  };
  console.log(JSON.stringify(output, null, 2));
}

function printConfigOutput(
  zones: ZoneInfo[],
  devices: DeviceInfo[],
  presets: PresetMapping[]
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
    console.log(`  ${d.serial}: { name: ${JSON.stringify(name)}, leapId: ${d.id} },`);
  }
  console.log("},\n");

  // Preset mapping
  console.log("/** Preset ID → button mapping (for CCX BUTTON_PRESS decoding)");
  console.log(" *  CCX device_id bytes 0-1 = preset ID as big-endian uint16");
  console.log(" *  CCX device_id bytes 2-3 = 0xEF20 (constant) */");
  console.log("knownPresets: {");
  // Deduplicate presets (same preset can appear on multiple devices for shared scenes)
  const seen = new Set<number>();
  for (const p of presets.sort((a, b) => a.presetId - b.presetId)) {
    if (seen.has(p.presetId)) continue;
    seen.add(p.presetId);
    const label = p.engraving ?? p.buttonName;
    const device = p.stationName ? `${p.areaName} ${p.stationName}` : p.deviceName;
    console.log(
      `  ${p.presetId}: { name: ${JSON.stringify(label)}, role: ${JSON.stringify(p.presetRole)}, device: ${JSON.stringify(device)} },`
    );
  }
  console.log("},");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
