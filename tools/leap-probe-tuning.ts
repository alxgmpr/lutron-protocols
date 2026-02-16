#!/usr/bin/env bun
/**
 * LEAP Tuning/Config Probe — specifically explore tuning settings,
 * phase settings, countdown timers, and zone-level config for every zone
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
    return { status: resp.Header?.StatusCode ?? "???", body: resp.Body };
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
  console.log(`Connected to ${values.host}`);

  // Get all zones
  let zoneIds: number[] = [];

  // Try Caseta-style direct
  const zonesResp = await readFull(conn, "/zone");
  if (zonesResp.body?.Zones) {
    zoneIds = zonesResp.body.Zones.map((z: any) => hrefId(z.href));
  } else {
    // RA3-style via zone/status
    const zsResp = await readFull(conn, "/zone/status");
    if (zsResp.body?.ZoneStatuses) {
      zoneIds = zsResp.body.ZoneStatuses.map((z: any) => hrefId(z.Zone?.href ?? ""));
    }
  }

  console.log(`${zoneIds.length} zones: ${zoneIds.join(", ")}`);

  // For each zone, get full detail and follow config hrefs
  for (const zoneId of zoneIds) {
    const zoneResp = await readFull(conn, `/zone/${zoneId}`);
    const zone = zoneResp.body?.Zone;
    if (!zone) continue;

    const type = zone.ControlType ?? zone.Category?.Type ?? "?";
    console.log(`\n  Zone ${zoneId}: ${zone.Name} (${type})`);

    // TuningSettings
    if (zone.TuningSettings?.href) {
      const ts = await readFull(conn, zone.TuningSettings.href);
      if (ts.body && !ts.body.Message) {
        dump(`${zone.TuningSettings.href} — ${zone.Name}`, ts.body);
      } else {
        console.log(`    TuningSettings → ${ts.body?.Message ?? ts.status}`);
      }
    }

    // CountdownTimer
    if (zone.CountdownTimer?.href) {
      const ct = await readFull(conn, zone.CountdownTimer.href);
      if (ct.body && !ct.body.Message) {
        dump(`${zone.CountdownTimer.href} — ${zone.Name}`, ct.body);
      }
    }

    // Try zone-specific paths
    const subPaths = [
      `/zone/${zoneId}/phasesettings`,
      `/zone/${zoneId}/dimmingcurve`,
      `/zone/${zoneId}/associateddevice`,
    ];
    for (const sp of subPaths) {
      const resp = await readFull(conn, sp);
      if (resp.body && !resp.body.Message) {
        dump(sp, resp.body);
      }
    }
  }

  // Also try RA3-style area-based zone discovery
  if (!zonesResp.body?.Zones) {
    const areasResp = await readFull(conn, "/area");
    const areas = areasResp.body?.Areas ?? [];
    for (const area of areas) {
      if (!area.IsLeaf) continue;
      const areaId = hrefId(area.href);
      const azResp = await readFull(conn, `/area/${areaId}/associatedzone`);
      for (const z of azResp.body?.Zones ?? []) {
        const zoneId = hrefId(z.href);
        if (z.TuningSettings?.href) {
          const ts = await readFull(conn, z.TuningSettings.href);
          if (ts.body && !ts.body.Message) {
            dump(`RA3 ${z.TuningSettings.href} — ${z.Name}`, ts.body);
          }
        }
      }
    }
  }

  conn.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
