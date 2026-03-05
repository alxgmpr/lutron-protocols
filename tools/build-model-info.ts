#!/usr/bin/env bun

/**
 * Parse pipe-delimited SQLMODELINFO output into tools/data/model-info.json.
 *
 * Input: stdin or file with lines like "461|RRD-3LD"
 * Output: tools/data/model-info.json
 */

import { resolve } from "path";

const input = await Bun.stdin.text();
const lines = input.split("\n").map((l) => l.trim()).filter(Boolean);

const models: { id: number; name: string }[] = [];
for (const line of lines) {
  // Skip header/separator lines
  if (line.startsWith("-") || line.startsWith("MODEL")) continue;
  const pipeIdx = line.indexOf("|");
  if (pipeIdx < 0) continue;
  const idStr = line.slice(0, pipeIdx).trim();
  const name = line.slice(pipeIdx + 1).trim();
  const id = parseInt(idStr);
  if (!isNaN(id) && name) {
    models.push({ id, name });
  }
}

// Build name→id[] map to detect duplicates
const byName = new Map<string, number[]>();
for (const m of models) {
  const arr = byName.get(m.name) || [];
  arr.push(m.id);
  byName.set(m.name, arr);
}

const output = {
  _comment:
    "SQLMODELINFO model table extract. Prefixes: RR/HQ/HR/PJ only.",
  _extracted: new Date().toISOString(),
  _version: "26.0.1.100",
  models: models.sort((a, b) => a.name.localeCompare(b.name)),
  duplicateNames: [...byName.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, ids: ids.sort((a, b) => a - b) })),
};

const outPath = resolve(import.meta.dir, "data/model-info.json");
await Bun.write(outPath, JSON.stringify(output, null, 2) + "\n");

console.log(`Written ${models.length} models (${byName.size} unique names) to ${outPath}`);
console.log(`Duplicate names: ${output.duplicateNames.length}`);
