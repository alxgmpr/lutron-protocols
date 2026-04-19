#!/usr/bin/env npx tsx

/**
 * Parse pipe-delimited SQLMODELINFO output into tools/data/model-info.json.
 *
 * Input: stdin or file with lines like "461|RRD-3LD"
 * Output: tools/data/model-info.json
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { buildModelInfoOutput, parseModelInfo } from "../lib/build-model-info";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const input = readFileSync(0, "utf8");
const models = parseModelInfo(input);
const output = buildModelInfoOutput(models);
const outPath = resolve(__dir, "data/model-info.json");

writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");

console.log(`Written ${models.length} models to ${outPath}`);
console.log(`Duplicate names: ${output.duplicateNames.length}`);
