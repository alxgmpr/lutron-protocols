#!/usr/bin/env bun
/**
 * LEAP Config Probe — explore device config endpoints (trim, phase, tuning)
 * Focuses on finding the actual device configuration data
 */

import { LeapConnection, hrefId } from "./leap-client";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    host: { type: "string", default: "10.0.0.2" },
    cert: { type: "string", default: "caseta" },
  },
});

async function readFull(conn: LeapConnection, url: string): Promise<any> {
  try {
    const resp = await conn.read(url);
    return { status: resp.Header?.StatusCode ?? "???", body: resp.Body, header: resp.Header };
  } catch (e: any) {
    return { status: e.message, body: null };
  }
}

function dump(label: string, data: any) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const conn = new LeapConnection({ host: values.host!, certName: values.cert! });
  await conn.connect();
  console.log(`Connected to ${values.host} (cert: ${values.cert})`);

  // Get all devices with full details
  const devResp = await readFull(conn, "/device");
  const devices = devResp.body?.Devices ?? [];
  console.log(`\n${devices.length} devices`);

  for (const d of devices) {
    const id = hrefId(d.href);
    const detail = await readFull(conn, `/device/${id}`);
    const dev = detail.body?.Device;
    if (!dev) continue;

    const type = dev.DeviceType ?? "";
    const interesting = type.includes("Dimmer") || type.includes("Switch") ||
      type.includes("Lamp") || type.includes("Plug") || type.includes("Fan") ||
      type.includes("Shade") || type.includes("Pico");

    console.log(`\n  Device ${id}: ${dev.Name} (${type}) serial=${dev.SerialNumber}${dev.ModelNumber ? ` model=${dev.ModelNumber}` : ""}`);

    if (interesting || devices.length <= 10) {
      // Dump full device for interesting ones
      dump(`Device ${id} (${type})`, dev);

      // Try device-specific sub-resources
      const subPaths = [
        `/device/${id}/status`,
        `/device/${id}/led/status`,
        `/device/${id}/buttongroup`,
        `/device/${id}/commandprocessor`,
      ];

      for (const sp of subPaths) {
        const resp = await readFull(conn, sp);
        if (resp.body && !resp.body.Message) {
          dump(sp, resp.body);
        }
      }
    }
  }

  // Get zones with full detail
  const zoneResp = await readFull(conn, "/zone");
  const zones = zoneResp.body?.Zones ?? [];
  console.log(`\n\n${zones.length} zones`);

  for (const z of zones) {
    const id = hrefId(z.href);
    const detail = await readFull(conn, `/zone/${id}`);
    const zone = detail.body?.Zone;
    if (!zone) continue;

    console.log(`\n  Zone ${id}: ${zone.Name} (${zone.ControlType ?? zone.Category?.Type ?? "?"})`);
    dump(`Zone ${id}`, zone);

    // Zone status expanded
    const expanded = await readFull(conn, `/zone/${id}/status/expanded`);
    if (expanded.body && !expanded.body.Message) {
      dump(`/zone/${id}/status/expanded`, expanded.body);
    }

    // Zone command processor
    const cp = await readFull(conn, `/zone/${id}/commandprocessor`);
    if (cp.body && !cp.body.Message) {
      dump(`/zone/${id}/commandprocessor`, cp.body);
    }
  }

  // Presets and preset assignments in detail
  console.log("\n\n=== Presets ===");
  const paResp = await readFull(conn, "/presetassignment");
  if (paResp.body?.PresetAssignments) {
    const pas = paResp.body.PresetAssignments;
    console.log(`${pas.length} preset assignments`);
    // Show first 5
    for (const pa of pas.slice(0, 5)) {
      dump(`PresetAssignment ${hrefId(pa.href)}`, pa);
    }

    // Follow a preset href to see full detail
    if (pas.length > 0 && pas[0].Parent?.href) {
      const presetHref = pas[0].Parent.href;
      const preset = await readFull(conn, presetHref);
      if (preset.body) dump(`Preset ${presetHref}`, preset.body);
    }
  }

  // Virtual buttons (scenes)
  console.log("\n\n=== Virtual Buttons / Scenes ===");
  const vbResp = await readFull(conn, "/virtualbutton");
  if (vbResp.body?.VirtualButtons) {
    for (const vb of vbResp.body.VirtualButtons.slice(0, 5)) {
      dump(`VirtualButton ${hrefId(vb.href)}`, vb);
    }
  }

  // System actions
  console.log("\n\n=== System Actions ===");
  const actResp = await readFull(conn, "/system/action");
  if (actResp.body?.Actions) {
    for (const act of actResp.body.Actions) {
      dump(`Action ${hrefId(act.href)}`, act);
    }
  }

  // Server pairing list
  console.log("\n\n=== LEAP Pairing List ===");
  const plResp = await readFull(conn, "/server/leap/pairinglist");
  if (plResp.body) dump("/server/leap/pairinglist", plResp.body);
  else console.log(`  /server/leap/pairinglist → ${plResp.status}`);

  // Occupancy groups
  console.log("\n\n=== Occupancy ===");
  const ogResp = await readFull(conn, "/occupancygroup");
  if (ogResp.body?.OccupancyGroups) {
    for (const og of ogResp.body.OccupancyGroups.slice(0, 3)) {
      const ogId = hrefId(og.href);
      dump(`OccupancyGroup ${ogId}`, og);
    }
  }

  // Away mode
  console.log("\n\n=== Away Mode ===");
  const awayResp = await readFull(conn, "/system/away");
  if (awayResp.body) dump("/system/away", awayResp.body);

  conn.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
