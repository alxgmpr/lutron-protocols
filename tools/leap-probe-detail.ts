#!/usr/bin/env bun
/**
 * LEAP Detail Probe — dig into preset assignments, programming models,
 * countdown timers, and other specifics
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
  const conn = new LeapConnection({ host: "10.0.0.2", certName: "caseta" });
  await conn.connect();
  console.log("Connected to Caseta");

  // 1. ALL preset assignments — show fade/delay/level for each
  console.log("\n=== ALL PRESET ASSIGNMENTS ===");
  const paResp = await readFull(conn, "/presetassignment");
  const pas = paResp.body?.PresetAssignments ?? [];
  console.log(`${pas.length} total preset assignments`);

  // Group by fade/delay values to see patterns
  const fadeDelayMap = new Map<string, number>();
  const withDelay: any[] = [];
  const withFade: any[] = [];

  for (const pa of pas) {
    const key = `fade=${pa.Fade},delay=${pa.Delay}`;
    fadeDelayMap.set(key, (fadeDelayMap.get(key) ?? 0) + 1);
    if (pa.Delay > 0) withDelay.push(pa);
    if (pa.Fade > 0) withFade.push(pa);
  }

  console.log("\nFade/Delay distribution:");
  for (const [key, count] of [...fadeDelayMap.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count} assignments`);
  }

  if (withDelay.length) {
    console.log(`\n${withDelay.length} assignments WITH delay:`);
    for (const pa of withDelay.slice(0, 10)) {
      dump(`PresetAssignment ${hrefId(pa.href)} (DELAY=${pa.Delay})`, pa);
    }
  }

  if (withFade.length) {
    console.log(`\n${withFade.length} assignments WITH fade > 0:`);
    for (const pa of withFade.slice(0, 5)) {
      console.log(`  ${hrefId(pa.href)}: fade=${pa.Fade} delay=${pa.Delay} level=${pa.Level} zone=${pa.AffectedZone?.href}`);
    }
  }

  // 2. ALL programming models
  console.log("\n\n=== ALL PROGRAMMING MODELS ===");
  const pmResp = await readFull(conn, "/programmingmodel");
  const pms = pmResp.body?.ProgrammingModels ?? [];
  console.log(`${pms.length} programming models`);

  // Group by type
  const typeMap = new Map<string, number>();
  for (const pm of pms) {
    const type = pm.ProgrammingModelType ?? "unknown";
    typeMap.set(type, (typeMap.get(type) ?? 0) + 1);
  }
  console.log("\nTypes:");
  for (const [type, count] of typeMap) {
    console.log(`  ${type}: ${count}`);
  }

  // Show DualAction models in detail
  const dualActions = pms.filter((pm: any) => pm.ProgrammingModelType === "DualActionProgrammingModel");
  console.log(`\n${dualActions.length} DualAction models:`);
  for (const da of dualActions.slice(0, 5)) {
    dump(`DualAction ${hrefId(da.href)}`, da);

    // Follow press/release presets
    if (da.DualActionProperties?.PressPreset?.href) {
      const pressPreset = await readFull(conn, da.DualActionProperties.PressPreset.href);
      if (pressPreset.body) {
        // Get first assignment
        const assignments = pressPreset.body.Preset?.PresetAssignments ?? [];
        if (assignments.length > 0) {
          const firstPa = await readFull(conn, assignments[0].href);
          console.log(`  Press preset → ${assignments.length} assignments, first:`, JSON.stringify(firstPa.body));
        }
      }
    }
  }

  // Show AdvancedToggle models
  const advToggle = pms.filter((pm: any) => pm.ProgrammingModelType === "AdvancedToggleProgrammingModel");
  console.log(`\n${advToggle.length} AdvancedToggle models:`);
  for (const at of advToggle.slice(0, 5)) {
    dump(`AdvancedToggle ${hrefId(at.href)}`, at);
  }

  // 3. DimmedLevelAssignment — check a few for detailed fade/delay
  console.log("\n\n=== DIMMED LEVEL ASSIGNMENTS ===");
  // Get all via a preset
  const somePreset = await readFull(conn, "/preset/210");
  if (somePreset.body?.Preset?.DimmedLevelAssignments) {
    const dlas = somePreset.body.Preset.DimmedLevelAssignments;
    for (const ref of dlas.slice(0, 5)) {
      const dla = await readFull(conn, ref.href);
      if (dla.body) dump(ref.href, dla.body);
    }
  }

  // 4. Countdown timers — list all
  console.log("\n\n=== COUNTDOWN TIMERS ===");
  // Try /countdowntimer
  const ctResp = await readFull(conn, "/countdowntimer");
  if (ctResp.body && !ctResp.body.Message) {
    dump("/countdowntimer", ctResp.body);
  } else {
    console.log(`  /countdowntimer → ${ctResp.body?.Message ?? ctResp.status}`);
    // We know timers are referenced from zones, so collect from zone walk
    const zonesResp2 = await readFull(conn, "/zone");
    const zones = zonesResp2.body?.Zones ?? [];
    for (const z of zones) {
      const zId = hrefId(z.href);
      const zDetail = await readFull(conn, `/zone/${zId}`);
      const zone = zDetail.body?.Zone;
      if (zone?.CountdownTimer?.href) {
        const ct = await readFull(conn, zone.CountdownTimer.href);
        if (ct.body?.CountdownTimer) {
          const t = ct.body.CountdownTimer;
          console.log(`  ${zone.Name.padEnd(25)} timer=${t.Timeout.padEnd(10)} enabled=${t.EnabledState}`);
        }
      }
    }
  }

  // 5. Load shedding detail
  console.log("\n\n=== LOAD SHEDDING ===");
  const lsResp = await readFull(conn, "/system/loadshedding/status");
  dump("/system/loadshedding/status", lsResp.body);

  // 6. NLO
  console.log("\n\n=== NLO ===");
  const nloResp = await readFull(conn, "/system/naturallightoptimization");
  dump("/system/naturallightoptimization", nloResp.body);

  conn.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
