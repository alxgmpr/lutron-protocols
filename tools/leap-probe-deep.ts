#!/usr/bin/env bun
/**
 * LEAP Deep Probe — follow hrefs from initial results to explore
 * device config, zone details, presets, dimming curves, tuning, etc.
 */

import { LeapConnection, hrefId } from "./leap-client";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    host: { type: "string", default: "10.0.0.1" },
    cert: { type: "string", default: "ra3" },
  },
});

const host = values.host!;
const certName = values.cert!;

async function readFull(conn: LeapConnection, url: string): Promise<any> {
  try {
    const resp = await conn.read(url);
    const status = resp.Header?.StatusCode ?? "???";
    return { status, body: resp.Body, url };
  } catch (e: any) {
    return { status: e.message, body: null, url };
  }
}

function dump(label: string, data: any) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const conn = new LeapConnection({ host, certName });
  await conn.connect();
  console.log(`Connected to ${host} (cert: ${certName})`);

  // 1. Server info (full)
  const server = await readFull(conn, "/server/1");
  dump("/server/1", server.body);

  // 2. Get all devices
  let deviceIds: number[] = [];
  const devicesResp = await readFull(conn, "/device");
  if (devicesResp.body?.Devices) {
    deviceIds = devicesResp.body.Devices.map((d: any) => hrefId(d.href));
    console.log(`\nDevices: ${deviceIds.join(", ")}`);
  } else {
    // RA3 style - get from project master device list
    const projResp = await readFull(conn, "/project/masterdevicelist/devices");
    if (projResp.body?.Devices) {
      deviceIds = projResp.body.Devices.map((d: any) => hrefId(d.href));
      console.log(`\nDevices (from project): ${deviceIds.join(", ")}`);
    }
  }

  // 3. Fetch first few devices in detail
  const maxDevices = Math.min(deviceIds.length, 8);
  for (let i = 0; i < maxDevices; i++) {
    const id = deviceIds[i];
    const dev = await readFull(conn, `/device/${id}`);
    if (dev.body?.Device) {
      const d = dev.body.Device;
      console.log(`\n  Device ${id}: ${d.Name} (${d.DeviceType}) serial=${d.SerialNumber}`);
      if (d.LocalZones) console.log(`    LocalZones: ${JSON.stringify(d.LocalZones)}`);
      if (d.PhaseSettings) console.log(`    PhaseSettings: ${JSON.stringify(d.PhaseSettings)}`);
      if (d.TuningSettings) console.log(`    TuningSettings: ${JSON.stringify(d.TuningSettings)}`);
      if (d.AdvancedToggleProperties) console.log(`    AdvancedToggle: ${JSON.stringify(d.AdvancedToggleProperties)}`);

      // Dump full device object for first dimmer/switch we find
      if (d.DeviceType?.includes("Dimmer") || d.DeviceType?.includes("Switch") ||
          d.DeviceType?.includes("Lamp") || d.DeviceType?.includes("Plug")) {
        dump(`Full device ${id} (${d.DeviceType})`, dev.body);
      }
    }

    // Try device status
    const status = await readFull(conn, `/device/${id}/status`);
    if (status.body?.DeviceStatus) {
      const s = status.body.DeviceStatus;
      if (s.Conditions || s.OperatingMode || s.FailedTransfers) {
        console.log(`    Status: ${JSON.stringify(s).slice(0, 200)}`);
      }
    }

    // Try device heard status
    const heard = await readFull(conn, `/device/status/deviceheard`);
    if (i === 0 && heard.body) {
      dump("Device heard status", heard.body);
    }
  }

  // 4. Get zones and check zone details
  let zoneIds: number[] = [];
  const zonesResp = await readFull(conn, "/zone");
  if (zonesResp.body?.Zones) {
    zoneIds = zonesResp.body.Zones.map((z: any) => hrefId(z.href));
  } else {
    // RA3: get from zone/status
    const zsResp = await readFull(conn, "/zone/status");
    if (zsResp.body?.ZoneStatuses) {
      zoneIds = zsResp.body.ZoneStatuses.map((z: any) => hrefId(z.Zone?.href ?? ""));
    }
  }
  console.log(`\nZones: ${zoneIds.join(", ")}`);

  // Fetch first few zones in detail
  const maxZones = Math.min(zoneIds.length, 6);
  for (let i = 0; i < maxZones; i++) {
    const id = zoneIds[i];
    const zone = await readFull(conn, `/zone/${id}`);
    if (zone.body?.Zone) {
      const z = zone.body.Zone;
      console.log(`\n  Zone ${id}: ${z.Name} (${z.ControlType ?? z.Category?.Type ?? "?"})`);
      // Dump first zone fully
      if (i === 0) dump(`Full zone ${id}`, zone.body);
    }

    const zoneStatus = await readFull(conn, `/zone/${id}/status`);
    if (zoneStatus.body?.ZoneStatus) {
      const s = zoneStatus.body.ZoneStatus;
      console.log(`    Status: Level=${s.Level} SwitchedLevel=${s.SwitchedLevel ?? "n/a"}`);
    }
  }

  // 5. Probe config-related routes
  console.log("\n\n=== Config-Related Routes ===");

  // Network interface
  const netif = await readFull(conn, "/networkinterface/1");
  dump("/networkinterface/1", netif.body);

  // Programming model (try a few IDs)
  for (const pmId of [1, 2, 3, 4, 5]) {
    const pm = await readFull(conn, `/programmingmodel/${pmId}`);
    if (pm.status.toString().startsWith("200")) {
      dump(`/programmingmodel/${pmId}`, pm.body);
      break; // just show the first valid one
    }
  }

  // Try zone expanded status for a specific zone
  if (zoneIds.length > 0) {
    const zexp = await readFull(conn, `/zone/${zoneIds[0]}/status/expanded`);
    dump(`/zone/${zoneIds[0]}/status/expanded`, { status: zexp.status, body: zexp.body });
  }

  // Try dimming curve endpoints
  const dimmingPaths = [
    "/dimmingcurve",
    "/curvetype",
    "/zone/dimmingcurve",
  ];
  for (const p of dimmingPaths) {
    const resp = await readFull(conn, p);
    if (resp.body) dump(p, resp.body);
    else console.log(`  ${p} → ${resp.status}`);
  }

  // Try preset details
  const presetResp = await readFull(conn, "/preset");
  if (presetResp.body?.Presets) {
    const presetIds = presetResp.body.Presets.slice(0, 3).map((p: any) => hrefId(p.href));
    for (const pid of presetIds) {
      const preset = await readFull(conn, `/preset/${pid}`);
      if (preset.body) dump(`/preset/${pid}`, preset.body);
    }
  } else {
    console.log(`  /preset → ${presetResp.status}`);
    // Try finding presets from buttongroup
    const bgResp = await readFull(conn, "/buttongroup");
    if (bgResp.body?.ButtonGroups) {
      const firstBg = bgResp.body.ButtonGroups[0];
      if (firstBg?.Buttons?.[0]) {
        const btnId = hrefId(firstBg.Buttons[0].href);
        const btn = await readFull(conn, `/button/${btnId}`);
        if (btn.body?.Button?.ProgrammingModel) {
          const pmId = hrefId(btn.body.Button.ProgrammingModel.href);
          const pm = await readFull(conn, `/programmingmodel/${pmId}`);
          dump(`Button ${btnId} → ProgrammingModel ${pmId}`, pm.body);

          // Follow preset href
          const presetHref = pm.body?.ProgrammingModel?.Preset?.href ??
            pm.body?.ProgrammingModel?.AdvancedToggleProperties?.PrimaryPreset?.href;
          if (presetHref) {
            const preset = await readFull(conn, presetHref);
            dump(`Preset ${presetHref}`, preset.body);

            // Try preset assignment for this preset
            const pid = hrefId(presetHref);
            const pa = await readFull(conn, `/preset/${pid}/presetassignment`);
            if (pa.body) dump(`/preset/${pid}/presetassignment`, pa.body);
          }
        }
      }
    }
  }

  // Try LED status for first device
  if (deviceIds.length > 0) {
    const ledStatus = await readFull(conn, `/device/${deviceIds[0]}/led/status`);
    if (ledStatus.body) dump(`/device/${deviceIds[0]}/led/status`, ledStatus.body);
    else console.log(`  /device/${deviceIds[0]}/led/status → ${ledStatus.status}`);
  }

  conn.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
