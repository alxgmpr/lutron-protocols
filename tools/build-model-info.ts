#!/usr/bin/env bun

/**
 * Parse pipe-delimited SQLMODELINFO output into tools/data/model-info.json.
 *
 * Input: stdin or file with lines like "461|RRD-3LD"
 * Output: tools/data/model-info.json
 */

import { resolve } from "path";
import { buildModelInfoOutput, parseModelInfo } from "./build-model-info-lib";

const input = await Bun.stdin.text();
const models = parseModelInfo(input);
const output = buildModelInfoOutput(models);
const outPath = resolve(import.meta.dir, "data/model-info.json");

await Bun.write(outPath, JSON.stringify(output, null, 2) + "\n");

console.log(`Written ${models.length} models to ${outPath}`);
console.log(`Duplicate names: ${output.duplicateNames.length}`);
