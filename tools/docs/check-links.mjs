#!/usr/bin/env node
// Verifies every relative markdown link under docs/ resolves to an existing file.
// Usage: node tools/docs/check-links.mjs
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "docs");
const linkRe = /\]\(([^)]+)\)/g;
let errors = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".md")) check(p);
  }
}

function check(file) {
  const text = readFileSync(file, "utf8");
  let m;
  while ((m = linkRe.exec(text))) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|#|tel:)/.test(target)) continue; // external/anchor
    target = target.split("#")[0]; // strip anchor
    if (!target) continue;
    if (target.startsWith("/")) continue; // absolute filesystem refs (rare); skip
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) {
      console.error(`BROKEN: ${file} -> ${m[1]}`);
      errors++;
    }
  }
}

walk(ROOT);
if (errors) {
  console.error(`\n${errors} broken link(s)`);
  process.exit(1);
}
console.log("All docs links resolve.");
