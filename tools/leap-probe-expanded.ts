#!/usr/bin/env bun
/**
 * LEAP Expanded & Create Probe — check expanded endpoints for extra data,
 * test what Create/Update operations are available, find firmware URLs
 */

import { LeapConnection, hrefId } from "./leap-client";

async function readRaw(conn: LeapConnection, url: string): Promise<any> {
  try {
    const resp = await conn.read(url);
    return resp;
  } catch (e: any) {
    return { Header: { StatusCode: e.message }, Body: null };
  }
}

function dump(label: string, data: any) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  // ===== CASETA =====
  const caseta = new LeapConnection({ host: "10.0.0.2", certName: "caseta" });
  await caseta.connect();
  console.log("=== CASETA ===\n");

  // 1. Compare zone/status vs zone/status/expanded for a specific zone
  console.log("--- Zone Status: Regular vs Expanded ---");
  const zs = await readRaw(caseta, "/zone/12/status");
  dump("/zone/12/status", zs.Body);

  const zse = await readRaw(caseta, "/zone/12/status/expanded");
  dump("/zone/12/status/expanded", zse.Body);

  // 2. Device status expanded?
  const ds = await readRaw(caseta, "/device/15/status");
  dump("/device/15/status", ds.Body);

  // Try device status expanded
  const dse = await readRaw(caseta, "/device/15/status/expanded");
  dump("/device/15/status/expanded", { status: dse.Header?.StatusCode, body: dse.Body });

  // 3. Device status deviceheard
  const dh = await readRaw(caseta, "/device/status/deviceheard");
  dump("/device/status/deviceheard", { status: dh.Header?.StatusCode, body: dh.Body });

  // 4. Buttongroup expanded — try with a specific ID
  const bge = await readRaw(caseta, "/buttongroup/15/expanded");
  dump("/buttongroup/15/expanded (specific)", { status: bge.Header?.StatusCode, body: bge.Body });

  // 5. Try various expanded paths
  const expandedPaths = [
    "/device/15/status/expanded",
    "/occupancygroup/1/status",
    "/preset/210",
    "/preset/210/presetassignment",
    "/programmingmodel/193",
  ];
  for (const p of expandedPaths) {
    const r = await readRaw(caseta, p);
    if (r.Body && !r.Body.Message) {
      dump(p, r.Body);
    } else {
      console.log(`  ${p} → ${r.Header?.StatusCode} ${r.Body?.Message ?? ""}`);
    }
  }

  // 6. Firmware image details — try to find download URLs
  console.log("\n\n--- Firmware Images ---");
  const fwPaths = [
    "/firmwareimage/15",
    "/firmwareimage/15/contents",
    "/firmwareimage/15/status",
    "/firmwareupdate",
    "/firmwareupdate/status",
    "/device/15/firmwareimage",
    "/device/15/firmwareupdate",
  ];
  for (const p of fwPaths) {
    const r = await readRaw(caseta, p);
    if (r.Body && !r.Body.Message) {
      dump(p, r.Body);
    } else {
      console.log(`  ${p} → ${r.Header?.StatusCode} ${r.Body?.Message ?? ""}`);
    }
  }

  // 7. Try subscribe to see what events exist
  console.log("\n\n--- Subscribe Capabilities ---");
  // We won't actually subscribe, but try reading subscribe-able endpoints
  const subscribePaths = [
    "/device/status/deviceheard",
    "/zone/status",
    "/occupancygroup/status",
    "/system/away",
  ];
  for (const p of subscribePaths) {
    const r = await readRaw(caseta, p);
    console.log(`  ${p} → ${r.Header?.StatusCode}`);
  }

  // 8. Try some paths that might reveal what Create operations exist
  console.log("\n\n--- Probing Create/Update Paths ---");

  // Read the existing service entries
  const svc = await readRaw(caseta, "/service");
  dump("/service", svc.Body);

  // Area details — can we create areas?
  const area = await readRaw(caseta, "/area/2");
  dump("/area/2", area.Body);

  // Read occupancy group programming model → presets
  const ogPm = await readRaw(caseta, "/programmingmodel/175");
  if (ogPm.Body) {
    dump("/programmingmodel/175 (DualAction for occupancy)", ogPm.Body);
    // Follow the press preset
    const pressHref = ogPm.Body?.ProgrammingModel?.DualActionProperties?.PressPreset?.href;
    if (pressHref) {
      const pressPreset = await readRaw(caseta, pressHref);
      dump(`${pressHref} (press preset)`, pressPreset.Body);
      // Get its assignments
      const assignments = pressPreset.Body?.Preset?.PresetAssignments ?? [];
      if (assignments.length) {
        const firstPa = await readRaw(caseta, assignments[0].href);
        dump(`${assignments[0].href} (first assignment)`, firstPa.Body);
      }
    }
  }

  // 9. Virtual button detail — can we program unprogrammed ones?
  console.log("\n\n--- Virtual Buttons (programmable scenes) ---");
  const vbs = await readRaw(caseta, "/virtualbutton");
  const buttons = vbs.Body?.VirtualButtons ?? [];
  for (const vb of buttons) {
    const detail = await readRaw(caseta, vb.href);
    const vbd = detail.Body?.VirtualButton ?? vb;
    console.log(`  ${vb.href}: "${vbd.Name}" IsProgrammed=${vbd.IsProgrammed} PM=${vbd.ProgrammingModel?.href}`);

    // For programmed ones, show what they do
    if (vbd.IsProgrammed && vbd.ProgrammingModel?.href) {
      const pm = await readRaw(caseta, vbd.ProgrammingModel.href);
      const preset = pm.Body?.ProgrammingModel?.Preset;
      if (preset?.href) {
        const presetDetail = await readRaw(caseta, preset.href);
        const pas = presetDetail.Body?.Preset?.PresetAssignments ?? [];
        if (pas.length > 0) {
          // Get first assignment to see what it does
          const pa = await readRaw(caseta, pas[0].href);
          const paBody = pa.Body?.PresetAssignment;
          if (paBody) {
            console.log(`    → ${pas.length} assignments. First: zone=${paBody.AffectedZone?.href} level=${paBody.Level} fade=${paBody.Fade} delay=${paBody.Delay}`);
          }
        }
      }
    }
  }

  caseta.close();

  // ===== RA3 =====
  console.log("\n\n=== RA3 ===\n");
  const ra3 = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });
  await ra3.connect();

  // Zone expanded on RA3
  const ra3zse = await readRaw(ra3, "/zone/273/status/expanded");
  dump("RA3 /zone/273/status/expanded", ra3zse.Body);

  // RA3 firmware images
  console.log("\n--- RA3 Firmware ---");
  const ra3fw = await readRaw(ra3, "/firmwareimage/266");
  dump("RA3 /firmwareimage/266", ra3fw.Body);

  const ra3fw2 = await readRaw(ra3, "/firmwareimage/1993");
  dump("RA3 /firmwareimage/1993 (Sunnata CCX)", ra3fw2.Body);

  // RA3 processor firmware
  const ra3fw3 = await readRaw(ra3, "/firmwareimage/232");
  dump("RA3 /firmwareimage/232 (processor)", ra3fw3.Body);

  // RA3 service
  const ra3svc = await readRaw(ra3, "/service");
  dump("RA3 /service", ra3svc.Body);

  ra3.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
