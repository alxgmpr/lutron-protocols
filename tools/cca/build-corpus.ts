#!/usr/bin/env npx tsx
/**
 * build-corpus — turn local CCA session captures into a committable,
 * redacted decode-coverage corpus.
 *
 * Captures themselves are gitignored and stay that way (see .gitignore:121).
 * What ships is the redacted, deduplicated set of frames plus a baseline of
 * the decode metrics over it, so CI can fail a push that decodes less than
 * the last one did.
 *
 * Deduplication is the point, not a size optimization: after redaction two
 * frames that differ only in identity are the same decode path, and the
 * corpus is meant to cover paths, not reproduce traffic volume.
 *
 * Run:  npx tsx tools/cca/build-corpus.ts [--check] [--from <dir>]...
 *       --check rebuilds and diffs against the committed corpus instead of
 *       writing, so a stale corpus fails rather than silently regenerates.
 *       --from adds a session-capture directory; defaults to this checkout's
 *       own, which is empty in a worktree.
 *       --data points at a checkout holding the LEAP dumps the serial scrub
 *       needs. Without them the leak gate is vacuous, so it refuses to run.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeDecode } from "../../lib/capture-metrics";
import { harvestDeviceIds, redactCcaFrame } from "../../lib/capture-redact";
import { decodeCcaFrame } from "../../lib/cca-decode-adapter";
import { isJsonObject, isNumber, type JsonValue } from "../../lib/data-values";

const ROOT = new URL("../../", import.meta.url).pathname;
const CORPUS = join(ROOT, "test/fixtures/cca-corpus.jsonl");
const BASELINE = join(ROOT, "test/fixtures/cca-corpus-baseline.json");

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function sourceDirs(): string[] {
  const extra: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from" && argv[i + 1]) extra.push(argv[i + 1]);
  }
  return [
    ...extra,
    join(ROOT, "data/captures/cca-sessions"),
    join(ROOT, "tools/captures/cca-sessions"),
  ];
}

/** Every serial we know about, for the value-scrub pass. */
function knownSerials(): number[] {
  const serials = new Set<number>();
  const dataDir = flagValue("--data") ?? join(ROOT, "data");
  if (!existsSync(dataDir)) return [];

  for (const name of readdirSync(dataDir)) {
    if (!name.startsWith("leap-") || !name.endsWith(".json")) continue;
    try {
      const dump = JSON.parse(readFileSync(join(dataDir, name), "utf8"));
      for (const s of Object.keys(dump.serials ?? {})) serials.add(Number(s));
    } catch {
      /* not a normalized dump — skip */
    }
  }

  const ccx = join(dataDir, "designer-ccx-devices.json");
  if (existsSync(ccx)) {
    const devices: JsonValue = JSON.parse(readFileSync(ccx, "utf8"));
    if (Array.isArray(devices)) {
      for (const device of devices) {
        if (isJsonObject(device) && isNumber(device.serial)) {
          serials.add(device.serial);
        }
      }
    }
  }
  return [...serials];
}

/** raw_hex is the last column and never contains a comma. */
function framesFromCsv(path: string): Buffer[] {
  const out: Buffer[] = [];
  for (const line of readFileSync(path, "utf8").trim().split("\n").slice(1)) {
    const hex = line
      .slice(line.lastIndexOf(",") + 1)
      .trim()
      .replace(/["' ]/g, "");
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 2) continue;
    if (hex.length % 2 !== 0) continue;
    out.push(Buffer.from(hex, "hex"));
  }
  return out;
}

function main() {
  const check = process.argv.includes("--check");
  const serials = knownSerials();

  // An empty inventory makes the leak gate below pass without testing
  // anything, which is worse than having no gate at all.
  if (serials.length === 0) {
    console.error(
      "No known serials loaded — the leak check would be vacuous.\n" +
        "Pass --data <dir> pointing at a checkout with LEAP dumps.",
    );
    process.exit(1);
  }

  const raw: Buffer[] = [];
  for (const dir of sourceDirs()) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".csv"))) {
      raw.push(...framesFromCsv(join(dir, name)));
    }
  }

  if (raw.length === 0) {
    console.error(
      "No source captures found. This tool needs the gitignored session\n" +
        "captures under data/captures/cca-sessions — it cannot run in CI.",
    );
    process.exit(1);
  }

  // Two passes. Structural redaction only covers types whose layout we know;
  // the same ids also sit inside other types at offsets no field definition
  // covers. Harvest first, then scrub the union by value everywhere.
  const harvested = harvestDeviceIds(raw);
  const scrubList = [...new Set([...serials, ...harvested])];
  const redacted = raw.map((f) =>
    redactCcaFrame(f, { knownSerials: scrubList }),
  );

  // Safety gate. A surviving serial means the corpus must not be written.
  const leaked = new Set<number>();
  for (const serial of scrubList) {
    const be = Buffer.alloc(4);
    be.writeUInt32BE(serial >>> 0);
    const le = Buffer.alloc(4);
    le.writeUInt32LE(serial >>> 0);
    for (const frame of redacted) {
      if (frame.includes(be) || frame.includes(le)) leaked.add(serial);
    }
  }
  if (leaked.size > 0) {
    console.error(`REFUSING TO WRITE: ${leaked.size} serial(s) survived`);
    process.exit(1);
  }

  // Redaction must not change what the decoders see.
  const before = summarizeDecode(raw.map(decodeCcaFrame));
  const after = summarizeDecode(redacted.map(decodeCcaFrame));
  for (const key of ["decoded", "identified", "unidentified"] as const) {
    if (before[key] !== after[key]) {
      console.error(
        `REFUSING TO WRITE: redaction changed ${key} ${before[key]} → ${after[key]}`,
      );
      process.exit(1);
    }
  }

  const unique = [...new Set(redacted.map((f) => f.toString("hex")))].sort();
  const corpus = `${unique.map((hex) => JSON.stringify({ hex })).join("\n")}\n`;

  const frames = unique.map((hex) => decodeCcaFrame(Buffer.from(hex, "hex")));
  const summary = summarizeDecode(frames);
  const baseline = `${JSON.stringify(
    {
      note: "Regenerate with: npx tsx tools/cca/build-corpus.ts",
      frames: summary.frames,
      identified: summary.identified,
      unidentified: summary.unidentified,
      fieldsDefined: frames.reduce((a, f) => a + f.fieldsDefined, 0),
      fieldsPresent: frames.reduce((a, f) => a + f.fieldsPresent, 0),
      fieldsNamed: frames.reduce((a, f) => a + f.fieldsNamed, 0),
      byType: Object.fromEntries(
        Object.entries(summary.byType).sort((a, b) => a[0].localeCompare(b[0])),
      ),
    },
    null,
    2,
  )}\n`;

  if (check) {
    const stale =
      readFileSync(CORPUS, "utf8") !== corpus ||
      readFileSync(BASELINE, "utf8") !== baseline;
    if (stale) {
      console.error("Corpus is stale — rerun without --check.");
      process.exit(1);
    }
    console.log("Corpus up to date.");
    return;
  }

  writeFileSync(CORPUS, corpus);
  writeFileSync(BASELINE, baseline);
  console.log(
    `${raw.length} frames → ${unique.length} unique decode paths\n` +
      `identified ${summary.identified}/${summary.frames} ` +
      `(${summary.identifiedPct.toFixed(1)}%), ` +
      `${serials.length} known serials + ${harvested.length} harvested ids ` +
      "scrubbed, 0 leaked",
  );
}

main();
