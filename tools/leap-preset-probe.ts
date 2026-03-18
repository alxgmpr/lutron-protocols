#!/usr/bin/env npx tsx

/**
 * Probe LEAP preset assignment endpoints to discover scene→zone level mappings.
 * Quick test to see what data structure /presetassignment returns.
 */

import { RA3_HOST } from "../lib/env";
import { hrefId, LeapConnection } from "./leap-client";

async function main() {
  const leap = new LeapConnection({ host: RA3_HOST, certName: "ra3" });
  console.log(`Connecting to ${RA3_HOST}...`);
  await leap.connect();
  console.log("Connected.\n");

  // Test 1: Read /presetassignment (list all)
  console.log("=== /presetassignment ===");
  const allAssignments = await leap.readBody("/presetassignment");
  if (allAssignments) {
    console.log(JSON.stringify(allAssignments, null, 2).slice(0, 2000));
    console.log("...\n");
  } else {
    console.log("(null — endpoint not available)\n");
  }

  // Test 2: Read a specific preset — 3116 = "Dimmed" on Hallway Top of Stairs
  const testPresetId = 3116;
  console.log(`=== /preset/${testPresetId} ===`);
  const preset = await leap.readBody(`/preset/${testPresetId}`);
  if (preset) {
    console.log(JSON.stringify(preset, null, 2));
  } else {
    console.log("(null)\n");
  }

  // Test 3: Read preset assignments for this specific preset
  console.log(`\n=== /preset/${testPresetId}/presetassignment ===`);
  const assignments = await leap.readBody(
    `/preset/${testPresetId}/presetassignment`,
  );
  if (assignments) {
    console.log(JSON.stringify(assignments, null, 2));
  } else {
    console.log("(null)\n");
  }

  // Test 4: Try various paths to find preset zone assignments
  const probePaths = [
    // Direct preset assignment paths
    `/preset/${testPresetId}/presetassignment`,
    `/preset/${testPresetId}/associatedpresetassignment`,

    // Shared scene
    `/sharedscene/${testPresetId}`,

    // Zone status — can we read current zone levels?
    "/zone/5147/status",
    "/zone/5147/status/level",

    // Area scene approaches
    "/areascene",
    "/virtualbutton",
    "/programmedscene",
    "/scene",
  ];

  for (const p of probePaths) {
    console.log(`\n=== ${p} ===`);
    const r = await leap.readBody(p);
    if (r) {
      console.log(JSON.stringify(r, null, 2).slice(0, 1000));
    } else {
      console.log("(null)");
    }
  }

  // Test 5: Walk all presets from the "Dimmed" button's device to see siblings
  // The capture shows "Dimmed" on "Hallway Top of Stairs" — let's find the device
  // and enumerate all its presets to find the full scene definition
  console.log("\n=== Finding 'Hallway Top of Stairs' presets ===");

  // We know preset 3116 exists. Let's check nearby IDs (scenes often sequential)
  for (const pid of [3114, 3115, 3116, 3117, 3118, 3119, 3120]) {
    const r = await leap.readBody(`/preset/${pid}`);
    if (r) {
      const parent = r.Preset?.Parent?.href ?? "(none)";
      console.log(`  preset/${pid}: parent=${parent}`);

      // If it has a sharedscene parent, get the name
      if (parent.includes("sharedscene")) {
        const sceneId = hrefId(parent);
        const scene = await leap.readBody(`/sharedscene/${sceneId}`);
        if (scene?.SharedScene?.Name) {
          console.log(`    → scene name: ${scene.SharedScene.Name}`);
        }
      }
    }
  }

  // Test 6: Try getting zone status to see if we can at least monitor
  console.log("\n=== Zone status subscription test ===");
  // First read current level
  const zoneStatus = await leap.readBody("/zone/5147/status");
  if (zoneStatus) {
    console.log("Zone 5147 status:", JSON.stringify(zoneStatus, null, 2));
  }

  // Test 7: Check if /zone/{id}/commandprocessor gives us anything
  console.log("\n=== /zone/5147/commandprocessor ===");
  const cp = await leap.readBody("/zone/5147/commandprocessor");
  if (cp) {
    console.log(JSON.stringify(cp, null, 2));
  } else {
    console.log("(null)");
  }

  leap.close();
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
