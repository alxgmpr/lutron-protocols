#!/usr/bin/env npx tsx

/**
 * Gather preset/scene zone assignments from Designer LocalDB and generate
 * data/preset-zones.json — the lookup table used by the CCX-WiZ bridge
 * to handle scene BUTTON_PRESS events.
 *
 * Requires Designer to be running with a project open (LocalDB active)
 * and the sql-http-api.ps1 listener on the VM.
 *
 * Usage: npx tsx tools/gather-presets.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config } from "../lib/config";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const dataDir = join(__dir, "../data");
const outPath = join(dataDir, "preset-zones.json");

const SQL = `
SELECT pa.ParentID AS PresetID, p.Name AS PresetName,
       pa.AssignableObjectID AS ZoneID, z.Name AS ZoneName,
       MAX(CASE WHEN acp.ParameterType = 3 THEN acp.ParameterValue END) AS LevelPct,
       MAX(CASE WHEN acp.ParameterType = 1 THEN acp.ParameterValue END) AS FadeQs,
       MAX(CASE WHEN acp.ParameterType = 2 THEN acp.ParameterValue END) AS DelayQs,
       MAX(CASE WHEN acp.ParameterType = 69 THEN acp.ParameterValue END) AS WarmDimCurveId
FROM tblPresetAssignment pa
JOIN tblPreset p ON p.PresetID = pa.ParentID
JOIN tblZone z ON z.ZoneID = pa.AssignableObjectID
JOIN tblAssignmentCommandParameter acp ON acp.ParentId = pa.PresetAssignmentID
GROUP BY pa.ParentID, p.Name, pa.AssignableObjectID, z.Name
ORDER BY pa.ParentID, pa.AssignableObjectID
`.trim();

/** Map Designer WarmDimCurveId → warm-dim.ts curve name */
const CURVE_NAMES: Record<number, string> = {
  1: "default",
  2: "halogen",
  3: "finire2700",
  4: "finire3000",
  // 5 is unknown — fall back to default
};

async function queryDesignerDb(sql: string): Promise<string> {
  const url = `http://${config.designer.host}:9999/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: sql,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new Error(
      `Designer DB query failed: ${res.status} ${await res.text()}`,
    );
  return res.text();
}

function loadLeapPresetNames(): Record<string, string> {
  const lookup: Record<string, string> = {};
  for (const file of readdirSync(dataDir).filter(
    (f) => f.startsWith("leap-") && f.endsWith(".json"),
  )) {
    try {
      const data = JSON.parse(readFileSync(join(dataDir, file), "utf-8"));
      for (const [id, p] of Object.entries(data.presets ?? {}) as [
        string,
        any,
      ][]) {
        const name = p.name?.trim();
        const device = p.device || "";
        if (name) lookup[id] = device ? `${name} [${device}]` : name;
        else if (device) lookup[id] = `[${device}]`;
      }
    } catch {}
  }
  return lookup;
}

async function main() {
  console.log(`Querying Designer DB at ${config.designer.host}...`);
  const raw = await queryDesignerDb(SQL);

  // Parse pipe-delimited output, skip header rows
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const dataLines = lines.filter(
    (l) => !l.startsWith("PresetID") && !l.startsWith("--------"),
  );

  const leapNames = loadLeapPresetNames();

  const result: Record<
    string,
    {
      name: string;
      zones: Record<
        string,
        { level: number; fade?: number; warmDimCurve?: string }
      >;
    }
  > = {};
  let totalZoneAssignments = 0;
  let skippedNull = 0;
  let warmDimCount = 0;

  for (const line of dataLines) {
    const [presetId, designerName, zoneId, , levelStr, fadeStr, , curveIdStr] =
      line.split("|");
    if (!presetId || !zoneId) continue;

    // Skip NULL levels (fan speed, CCO, etc.)
    if (levelStr === "NULL" || levelStr === undefined) {
      skippedNull++;
      continue;
    }

    const level = Number(levelStr);
    const fade = Number(fadeStr);

    if (!result[presetId]) {
      result[presetId] = {
        name: leapNames[presetId] || designerName,
        zones: {},
      };
    }

    const entry: { level: number; fade?: number; warmDimCurve?: string } = {
      level,
    };
    if (fade > 0) entry.fade = fade;
    if (curveIdStr && curveIdStr !== "NULL") {
      const curveId = Number(curveIdStr);
      entry.warmDimCurve = CURVE_NAMES[curveId] ?? "default";
      warmDimCount++;
    }
    result[presetId].zones[zoneId] = entry;
    totalZoneAssignments++;
  }

  // Sort by preset ID
  const sorted: typeof result = {};
  for (const key of Object.keys(result).sort((a, b) => Number(a) - Number(b))) {
    sorted[key] = result[key];
  }

  writeFileSync(outPath, JSON.stringify(sorted, null, 2) + "\n");

  const presetCount = Object.keys(sorted).length;
  console.log(`\nWrote ${outPath}`);
  console.log(
    `  ${presetCount} presets, ${totalZoneAssignments} zone assignments (${skippedNull} NULL levels skipped, ${warmDimCount} with warm dim curve)`,
  );

  // Sample verification
  const p3116 = sorted["3116"];
  if (p3116) {
    console.log(`\n  Sample — Preset 3116: ${p3116.name}`);
    console.log(
      `    ${Object.keys(p3116.zones).length} zones, e.g. zone 1512: ${JSON.stringify(p3116.zones["1512"])}`,
    );
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
