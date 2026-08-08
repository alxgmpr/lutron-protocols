import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { parse } from "yaml";
import { processorIPs } from "../../lib/config";
import { assertVerbAllowed } from "../../lib/echo-guard";
import { expandTemplate, harvestIds, type IdIndex } from "../../lib/id-harvest";
import { LeapConnection } from "../../lib/leap-client";
import {
  coveredIdentsFromOperationIds,
  planSweep,
  type Route,
} from "../../lib/route-plan";

const OUT_DIR = "data/sweep";
const ROUTES = "data/firmware-re/leap-routes.json";
/** Published spec, used only to skip routes already documented. */
const SPEC =
  process.env.LEAP_SPEC_PATH ?? "/Users/alex/leap-api/dist/openapi.yaml";
/** Max concrete paths probed per parameterised template. */
const ID_LIMIT = 8;
/** Delay between requests. The processor caps at 10 clients / 600s idle. */
const PACE_MS = 120;
/** Published fixtures used to seed the id index; absent files are skipped. */
const FIXTURES = [
  "/Users/alex/leap-api/fixtures/ra3.json",
  "/Users/alex/leap-api/fixtures/caseta.json",
];

type Capture = Record<string, { status: string; body?: unknown }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write the capture atomically: a kill mid-write must leave either the old
 * complete file or the new one, never a truncated one. writeFileSync alone
 * truncates the target in place, so a kill between truncate and write left
 * invalid JSON that the next run's JSON.parse threw on before connecting —
 * losing all prior progress instead of resuming from it.
 */
function writeCaptureAtomic(outPath: string, capture: Capture): void {
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(capture, null, 2)}\n`);
  renameSync(tmpPath, outPath);
}

/** Ids harvested from the published fixtures, used to prime the read phase. */
function seedIndexFromFixtures(): IdIndex {
  const index: IdIndex = new Map();
  for (const file of FIXTURES) {
    if (!existsSync(file)) continue;
    const probe: Capture = JSON.parse(readFileSync(file, "utf8"));
    for (const entry of Object.values(probe)) {
      if (entry.status.startsWith("200")) harvestIds(entry.body, index);
    }
  }
  const total = [...index.values()].reduce((n, s) => n + s.size, 0);
  console.log(
    `seeded ${index.size} resource types, ${total} ids from fixtures`,
  );
  return index;
}

function coveredIdents(): Set<string> {
  if (!existsSync(SPEC)) {
    console.warn(`spec not found at ${SPEC}; treating everything as uncovered`);
    return new Set();
  }
  const doc = parse(readFileSync(SPEC, "utf8")) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const ids: string[] = [];
  for (const item of Object.values(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === "parameters") continue;
      if (op?.operationId) ids.push(op.operationId);
    }
  }
  return coveredIdentsFromOperationIds(ids);
}

async function probe(
  conn: LeapConnection,
  url: string,
  capture: Capture,
): Promise<unknown> {
  assertVerbAllowed("GET");
  try {
    const resp = await conn.send("ReadRequest", url);
    const status = String(resp?.Header?.StatusCode ?? "(none)");
    capture[url] = { status, body: resp?.Body };
    return resp?.Body;
  } catch (err) {
    capture[url] = { status: `(error) ${(err as Error).message}` };
    return undefined;
  }
}

async function main(): Promise<void> {
  const host = process.argv[2] ?? processorIPs[0];
  if (!host) throw new Error("no host given and none configured");

  const routes: Route[] = JSON.parse(readFileSync(ROUTES, "utf8"));
  const plan = planSweep(routes, coveredIdents());
  const discovery = plan.filter((e) => e.phase === "discovery");
  const read = plan.filter((e) => e.phase === "read");
  console.log(
    `host=${host}  discovery=${discovery.length}  read=${read.length}`,
  );

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = `${OUT_DIR}/${host}-read.json`;
  const capture: Capture = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : {};

  const conn = new LeapConnection({ host });
  await conn.connect();
  const index: IdIndex = seedIndexFromFixtures();

  try {
    // Phase 1 — discovery. Every body also feeds the id index.
    for (const entry of discovery) {
      if (capture[entry.template]) {
        harvestIds(capture[entry.template].body, index);
        continue;
      }
      const body = await probe(conn, entry.template, capture);
      harvestIds(body, index);
      writeCaptureAtomic(outPath, capture);
      await sleep(PACE_MS);
    }
    console.log(
      `discovery done: ${index.size} resource types, ` +
        `${[...index.values()].reduce((n, s) => n + s.size, 0)} ids`,
    );

    // Phase 2 — read, using the ids discovery (and the fixture seed) found.
    for (const entry of read) {
      for (const url of expandTemplate(entry.template, index, ID_LIMIT)) {
        if (capture[url]) continue;
        const body = await probe(conn, url, capture);
        harvestIds(body, index);
        writeCaptureAtomic(outPath, capture);
        await sleep(PACE_MS);
      }
    }
  } finally {
    conn.close();
  }

  const ok = Object.values(capture).filter((v) =>
    v.status.startsWith("200"),
  ).length;
  console.log(
    `captured ${Object.keys(capture).length} paths, ${ok} with 200 OK`,
  );
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
