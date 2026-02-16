#!/usr/bin/env bun
/**
 * LEAP RA3 Deep Probe — explore RA3-specific device config paths
 */

import { LeapConnection, hrefId } from "./leap-client";

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
  const conn = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });
  await conn.connect();
  console.log("Connected to RA3");

  // Get areas
  const areasResp = await readFull(conn, "/area");
  const areas = areasResp.body?.Areas ?? [];
  console.log(`${areas.length} areas`);

  // Find first leaf area with a dimmer
  for (const area of areas) {
    if (!area.IsLeaf) continue;
    const areaId = hrefId(area.href);

    // Get zones in this area
    const azResp = await readFull(conn, `/area/${areaId}/associatedzone`);
    const zones = azResp.body?.Zones ?? [];
    if (zones.length === 0) continue;

    console.log(`\nArea ${areaId}: ${area.Name} — ${zones.length} zones`);

    for (const z of zones) {
      const zid = hrefId(z.href);
      console.log(`  Zone ${zid}: ${z.Name} (${z.ControlType})`);
      // Dump full zone object from area walk (more fields than /zone/{id})
      if (z.ControlType === "Dimmed") {
        dump(`Zone ${zid} from area walk`, z);

        // Try zone config paths
        for (const path of [
          `/zone/${zid}/tuningsettings`,
          `/zone/${zid}/phasesettings`,
          `/zone/${zid}/dimmingcurve`,
          `/zone/${zid}/countdowntimer`,
        ]) {
          const resp = await readFull(conn, path);
          if (resp.body && !resp.body.Message) {
            dump(path, resp.body);
          } else {
            console.log(`    ${path} → ${resp.body?.Message ?? resp.status}`);
          }
        }
        break; // just first dimmer
      }
    }

    // Get control stations / devices in this area
    const csResp = await readFull(conn, `/area/${areaId}/associatedcontrolstation`);
    const stations = csResp.body?.ControlStations ?? [];
    if (stations.length > 0) {
      console.log(`  ${stations.length} control stations`);
      for (const cs of stations) {
        for (const g of cs.AssociatedGangedDevices ?? []) {
          if (g.Device?.href) {
            const devId = hrefId(g.Device.href);
            const devResp = await readFull(conn, `/device/${devId}`);
            const dev = devResp.body?.Device;
            if (dev && (dev.DeviceType?.includes("Dimmer") || dev.DeviceType?.includes("SunnataKeypad"))) {
              dump(`Device ${devId} (${dev.DeviceType})`, dev);

              // Try device config paths
              for (const path of [
                `/device/${devId}/tuningsettings`,
                `/device/${devId}/phasesettings`,
                `/device/${devId}/dimmingcurve`,
                `/device/${devId}/led/status`,
              ]) {
                const resp = await readFull(conn, path);
                if (resp.body && !resp.body.Message) {
                  dump(path, resp.body);
                } else {
                  console.log(`    ${path} → ${resp.body?.Message ?? resp.status}`);
                }
              }

              // Link node
              if (dev.LinkNodes?.[0]?.href) {
                const ln = await readFull(conn, dev.LinkNodes[0].href);
                if (ln.body && !ln.body.Message) dump(dev.LinkNodes[0].href, ln.body);
              }

              break; // just first device
            }
          }
        }
      }
    }

    // Only check first few areas
    if (areaId > 100) break;
  }

  // Try some RA3-specific routes
  console.log("\n\n=== RA3-Specific Routes ===");
  const ra3Routes = [
    "/server/leap/pairinglist",
    "/link/236",
    "/link/237",
    "/programmingmodel",
    "/groupscene",
    "/detectiongroup",
    "/fadefighterproperties",
  ];

  for (const route of ra3Routes) {
    const resp = await readFull(conn, route);
    if (resp.body && !resp.body.Message) {
      dump(route, resp.body);
    } else {
      console.log(`  ${route} → ${resp.body?.Message ?? resp.status}`);
    }
  }

  conn.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
