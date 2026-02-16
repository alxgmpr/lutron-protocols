#!/usr/bin/env bun
/**
 * LEAP Sub-resource Probe — follow href links to explore device rules,
 * link nodes, firmware images, dimmed level assignments, etc.
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

  // Get devices
  const devResp = await readFull(conn, "/device");
  const devices = devResp.body?.Devices ?? [];

  // Find first dimmer
  let dimmerId = 0;
  let dimmerDetail: any = null;
  for (const d of devices) {
    const id = hrefId(d.href);
    const detail = await readFull(conn, `/device/${id}`);
    const dev = detail.body?.Device;
    if (dev?.DeviceType?.includes("Dimmer")) {
      dimmerId = id;
      dimmerDetail = dev;
      break;
    }
  }

  if (!dimmerId) {
    console.log("No dimmer found!");
    conn.close();
    return;
  }

  console.log(`\nUsing dimmer ${dimmerId}: ${dimmerDetail.Name} (${dimmerDetail.DeviceType})`);

  // 1. Device rule
  if (dimmerDetail.DeviceRules?.[0]) {
    const ruleHref = dimmerDetail.DeviceRules[0].href;
    const rule = await readFull(conn, ruleHref);
    dump(`DeviceRule ${ruleHref}`, rule.body);
  }

  // 2. Link node
  if (dimmerDetail.LinkNodes?.[0]) {
    const lnHref = dimmerDetail.LinkNodes[0].href;
    const ln = await readFull(conn, lnHref);
    dump(`LinkNode ${lnHref}`, ln.body);
  }

  // 3. Firmware image
  if (dimmerDetail.FirmwareImage?.href) {
    const fwHref = dimmerDetail.FirmwareImage.href;
    const fw = await readFull(conn, fwHref);
    dump(`FirmwareImage ${fwHref}`, fw.body);
  }

  // 4. Zone detail for this dimmer
  if (dimmerDetail.LocalZones?.[0]) {
    const zoneHref = dimmerDetail.LocalZones[0].href;
    const zoneId = hrefId(zoneHref);
    const zone = await readFull(conn, zoneHref);
    dump(`Zone ${zoneHref}`, zone.body);

    // Zone status
    const zs = await readFull(conn, `/zone/${zoneId}/status`);
    dump(`/zone/${zoneId}/status`, zs.body);

    // Zone command processor (read, not create)
    const cp = await readFull(conn, `/zone/${zoneId}/commandprocessor`);
    if (cp.body) dump(`/zone/${zoneId}/commandprocessor`, cp.body);
  }

  // 5. Explore sub-paths we haven't tried yet
  console.log("\n\n=== Unexplored Routes ===");

  const newRoutes = [
    // Device config sub-resources
    `/device/${dimmerId}/buttongroup`,

    // Dimmed level assignments
    "/dimmedlevelassignment/274",

    // Switched level assignments
    "/switchedlevelassignment/304",

    // Device rules listing
    "/devicerule",
    "/devicerule/146",
    "/devicerule/147",
    "/devicerule/160",

    // Programming model
    "/programmingmodel",

    // Link details
    "/link/1",

    // Network interface
    "/networkinterface",
    "/networkinterface/1",

    // Try some guessed config paths
    "/tuningsettings",
    "/phasesettings",
    `/device/${dimmerId}/tuningsettings`,
    `/device/${dimmerId}/phasesettings`,
    `/device/${dimmerId}/dimmingcurve`,

    // Firmware
    "/firmwareimage",
    "/firmwareupdate",

    // Other RA3-ish things
    "/groupscene",
    "/areascene",
    "/sceneassignment",
    "/timedschedule",
    "/conditionalschedule",
  ];

  for (const route of newRoutes) {
    const resp = await readFull(conn, route);
    if (resp.body && !resp.body.Message) {
      dump(route, resp.body);
    } else {
      const msg = resp.body?.Message ?? resp.status;
      console.log(`  ${route.padEnd(50)} → ${msg}`);
    }
  }

  conn.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
