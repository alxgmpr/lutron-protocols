#!/usr/bin/env npx tsx
/**
 * Coverage-blind spec prober — read-only.
 *
 *   npx tsx tools/leap/leap-spec-probe.ts <host>
 *
 * Takes the published spec's own path list as the input set and sends a
 * ReadRequest to every one of them that can be expanded with live ids. This
 * is the inverse of `leap-sweep.ts`: `planSweep` deliberately SKIPS routes the
 * spec already documents, which is right for discovering new paths and wrong
 * for backing the documented ones with evidence. The result of that filter is
 * that most of the spec's documented paths have never been sent to any
 * processor — not probed and rejected, never probed — including routes
 * already known to work.
 *
 * Two properties this tool depends on, neither of them incidental:
 *
 * - Ids come from the LIVE processor first. Phase 1 reads the spec's own
 *   non-parameterised paths and harvests ids from the responses. Fixture ids
 *   are passed to `mergeIdIndex` as the FALLBACK only, filling leftover
 *   capacity. Seeding from fixtures first (as an earlier run did) hands the
 *   processor ids from a different system and produces 404s that describe the
 *   ids, not the routes.
 *
 * - The count reported at the end is work done in THIS run, not the size of
 *   the capture file. The capture is resumable and cumulative across runs;
 *   printing `Object.keys(capture).length` as the run's result has already
 *   produced wrong figures in a written report.
 *
 * GET only, by construction: every request here is a ReadRequest, and each is
 * gated by `assertVerbAllowed("GET")`. No create, update, delete, or
 * subscribe request is issued from this file.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { processorIPs } from "../../lib/config";
import type { JsonValue } from "../../lib/data-values";
import { assertVerbAllowed } from "../../lib/echo-guard";
import { harvestIds, type IdIndex } from "../../lib/id-harvest";
import { LeapConnection } from "../../lib/leap-client";
import {
  collectionPathsFromSpec,
  mergeIdIndex,
  parseSpecPaths,
  planSpecProbe,
} from "../../lib/spec-probe";

const OUT_DIR = "data/spec-probe";
/**
 * Capture path override. The default is keyed by host alone, and the capture
 * is resumable — a second run against the same IP skips every URL already in
 * the file. That is the right behaviour for finishing an interrupted run and
 * the wrong one when the machine behind the IP has materially changed (a
 * factory reset, a firmware update), because the resume would silently blend
 * two systems into one file and report almost nothing probed. Point this at a
 * fresh path whenever the host is no longer the host the file describes.
 */
const OUT_PATH_OVERRIDE = process.env.LEAP_SPEC_PROBE_OUT;
/** Published spec. Here it is the INPUT set, not a coverage filter. */
const SPEC =
  process.env.LEAP_SPEC_PATH ?? "/Users/alex/leap-api/dist/openapi.yaml";
/** Max concrete paths probed per parameterised template. */
const ID_LIMIT = 8;
/** Delay between requests. The processor caps at 10 clients / 600s idle. */
const PACE_MS = 120;
/**
 * Published fixtures, used ONLY as the fallback id source — they were
 * captured on other processors, so a live id must always win over them.
 * Absent files are skipped.
 */
const FIXTURES = [
  "/Users/alex/leap-api/fixtures/ra3.json",
  "/Users/alex/leap-api/fixtures/caseta.json",
];

type CaptureEntry = { status: string; body?: JsonValue };
type Capture = Record<string, CaptureEntry>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write JSON atomically: a kill mid-write must leave either the old complete
 * file or the new one, never a truncated one. The temp file is placed beside
 * the target so the rename stays within one filesystem and is therefore
 * atomic. Same convention as `leap-sweep.ts`, for the same reason — a
 * truncated capture makes the next run's JSON.parse throw before it connects,
 * losing every route probed so far.
 */
function writeCaptureAtomic(outPath: string, capture: Capture): void {
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(capture, null, 2)}\n`);
  renameSync(tmpPath, outPath);
}

/** Ids from the published fixtures. Fallback only — never the primary source. */
function fallbackIndexFromFixtures(): IdIndex {
  const index: IdIndex = new Map();
  for (const file of FIXTURES) {
    if (!existsSync(file)) continue;
    const probe: Capture = JSON.parse(readFileSync(file, "utf8"));
    for (const entry of Object.values(probe)) {
      if (entry.status.startsWith("200")) harvestIds(entry.body, index);
    }
  }
  return index;
}

/**
 * Send one ReadRequest, record the result, and hand the recorded entry back.
 *
 * Returning the entry rather than just the body keeps the caller from having
 * to read it back out of `capture` — the status is needed for the run's
 * distribution and the body for id harvesting, and both come from here.
 */
async function probe(
  conn: LeapConnection,
  url: string,
  capture: Capture,
): Promise<CaptureEntry> {
  assertVerbAllowed("GET");
  let entry: CaptureEntry;
  try {
    const resp = await conn.send("ReadRequest", url);
    entry = {
      status: String(resp?.Header?.StatusCode ?? "(none)"),
      body: resp?.Body,
    };
  } catch (err) {
    entry = {
      status: `(error) ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  capture[url] = entry;
  return entry;
}

/** `{ "200": 41, "404": 3 }`, keyed by the leading status token. */
interface StatusCounts {
  [status: string]: number;
}

function statusDistribution(statuses: string[]): StatusCounts {
  const out: StatusCounts = {};
  for (const status of statuses) {
    const key = status.split(" ")[0] || "(none)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function idTotal(index: IdIndex): number {
  return [...index.values()].reduce((n, s) => n + s.size, 0);
}

async function main(): Promise<void> {
  const host = process.argv[2] ?? processorIPs[0];
  if (!host) throw new Error("no host given and none configured");

  if (!existsSync(SPEC)) {
    console.warn(
      `spec not found at ${SPEC}; this tool probes the spec's own paths, ` +
        `so there is nothing to do. Set LEAP_SPEC_PATH to a built openapi.yaml.`,
    );
    process.exitCode = 1;
    return;
  }
  const specPaths = parseSpecPaths(readFileSync(SPEC, "utf8"));
  const collections = collectionPathsFromSpec(specPaths);
  console.log(
    `host=${host}  spec paths=${specPaths.length}  collections=${collections.length}`,
  );

  const outPath = OUT_PATH_OVERRIDE ?? `${OUT_DIR}/${host}-spec-read.json`;
  mkdirSync(dirname(outPath), { recursive: true });
  const capture: Capture = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : {};
  const statusesThisRun: string[] = [];
  let probedThisRun = 0;

  const conn = new LeapConnection({ host });
  await conn.connect();

  try {
    // Phase 1 — harvest ids from the LIVE processor. The collection list is
    // the spec's own non-parameterised paths, so this stays coverage-blind:
    // no route table, no fixture-derived path list.
    const live: IdIndex = new Map();
    for (const path of collections) {
      if (capture[path]) {
        // Resumed from a prior run of this same tool against this same host,
        // so the body is still live-processor data and still belongs in the
        // live index.
        harvestIds(capture[path].body, live);
        continue;
      }
      const entry = await probe(conn, path, capture);
      harvestIds(entry.body, live);
      statusesThisRun.push(entry.status);
      probedThisRun++;
      writeCaptureAtomic(outPath, capture);
      await sleep(PACE_MS);
    }
    console.log(
      `live harvest: ${live.size} resource types, ${idTotal(live)} ids`,
    );

    const fallback = fallbackIndexFromFixtures();
    console.log(
      `fixture fallback: ${fallback.size} resource types, ${idTotal(fallback)} ids`,
    );
    const index = mergeIdIndex(live, fallback, ID_LIMIT);
    console.log(
      `merged (live first, cap ${ID_LIMIT}/resource): ${index.size} resource types, ${idTotal(index)} ids`,
    );

    // Phase 2 — probe every spec path that can be expanded.
    const plan = planSpecProbe(specPaths, index, ID_LIMIT);
    console.log(
      `plan: ${plan.urls.length} urls, ${plan.skipped.length} templates unexpandable`,
    );

    for (const url of plan.urls) {
      if (capture[url]) continue;
      const entry = await probe(conn, url, capture);
      statusesThisRun.push(entry.status);
      probedThisRun++;
      writeCaptureAtomic(outPath, capture);
      await sleep(PACE_MS);
    }

    // Report what was NOT probed, explicitly. A skipped template is a spec
    // path still without evidence; leaving it out of the output would let a
    // partial run read as a complete one.
    if (plan.skipped.length > 0) {
      console.log(`\nskipped (no ids for the owning resource):`);
      for (const s of plan.skipped) {
        console.log(`  ${s.specPath}  [no ids for "${s.missingResource}"]`);
      }
    }

    console.log(
      `\n${probedThisRun} routes probed THIS RUN ` +
        `(${Object.keys(capture).length} cumulative in ${outPath})`,
    );
    console.log(
      `status distribution this run: ${JSON.stringify(statusDistribution(statusesThisRun))}`,
    );
    console.log(`wrote ${outPath}`);
  } finally {
    conn.close();
    writeCaptureAtomic(outPath, capture);
  }
}

// Guard against running a live probe as a side effect of import — the same
// hazard leap-sweep.ts guards against, and for the same reason: a test that
// imports anything from this file would otherwise open a TLS connection to
// whatever host the config default resolves to.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
