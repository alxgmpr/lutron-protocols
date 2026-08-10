import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { processorIPs } from "../../lib/config";
import { assertVerbAllowed, checkEcho } from "../../lib/echo-guard";
import { expandTemplate, harvestIds, type IdIndex } from "../../lib/id-harvest";
import { LeapConnection } from "../../lib/leap-client";
import {
  coveredIdentsFromOperationIds,
  planSweep,
  type Route,
} from "../../lib/route-plan";
import {
  classifyTagReuse,
  type Frame,
  type SubscribeLog,
} from "../../lib/subscribe-log";

const OUT_DIR = "data/sweep";
const ROUTES = "data/firmware-re/leap-routes.json";
/** Published spec, used only to skip routes already documented. */
const SPEC =
  process.env.LEAP_SPEC_PATH ?? "/Users/alex/leap-api/dist/openapi.yaml";
/** Max concrete paths probed per parameterised template. */
const ID_LIMIT = 8;
/** Delay between requests. The processor caps at 10 clients / 600s idle. */
const PACE_MS = 120;
/** How long to hold the socket open collecting pushed frames, per route. */
const SUBSCRIBE_HOLD_MS = 20_000;
/** Max concrete ids probed per parameterised subscribe template. One working
 * subscription per route is the goal, not exhaustive id coverage. */
const SUBSCRIBE_ID_LIMIT = 2;
/**
 * How long to hold a firmwareimage read connection open after the response,
 * watching for a late frame on the resolved tag. Must be comfortably over
 * the "at least 10 seconds" the investigation calls for.
 */
const FIRMWARE_LATE_HOLD_MS = 15_000;
/**
 * Route paths (unexpanded) the published fixtures show actually responding
 * on this processor. Probed first within the subscribe phase so, if the
 * run is interrupted, the routes most likely to produce real evidence are
 * already captured.
 */
const SUBSCRIBE_PRIORITY = [
  "/zone",
  "/zone/{id}",
  "/zone/{id}/status",
  "/area",
  "/area/{id}/status",
  "/device",
  "/devicestatus",
  "/link/{id}/status",
  "/project",
];
/** Published fixtures used to seed the id index; absent files are skipped. */
const FIXTURES = [
  "/Users/alex/leap-api/fixtures/ra3.json",
  "/Users/alex/leap-api/fixtures/caseta.json",
];

type Capture = Record<string, { status: string; body?: unknown }>;

/**
 * A frame that arrived via the unsolicited (onEvent) path but carried the
 * ClientTag of a request our own code already resolved — i.e. a second
 * response to a request LeapConnection.send() considered finished.
 *
 * send() resolves on the first frame matching a tag and deletes the pending
 * entry immediately, so any later frame with that tag falls through to
 * onEvent. Task 4's runner never set onEvent, so such frames were silently
 * dropped there — notably five `102 Processing` responses on
 * `/firmwareimage/{id}` with null bodies, a status absent from both the
 * published spec and the firmware's declared list. This phase is the first
 * to set onEvent, so it is the first that can catch a late frame like that
 * instead of losing it.
 */
type LateFrame = {
  url: string;
  requestTag: string;
  seq: number;
  receivedMsAfterSubscribe: number;
  communiqueType: string;
  header: Record<string, unknown>;
  body?: unknown;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write JSON atomically: a kill mid-write must leave either the old complete
 * file or the new one, never a truncated one. writeFileSync alone truncates
 * the target in place, so a kill between truncate and write left invalid
 * JSON that the next run's JSON.parse threw on before connecting — losing
 * all prior progress instead of resuming from it.
 */
function writeJsonAtomic(outPath: string, data: unknown): void {
  const tmpPath = `${outPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmpPath, outPath);
}

function writeCaptureAtomic(outPath: string, capture: Capture): void {
  writeJsonAtomic(outPath, capture);
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

/**
 * Every SUBSCRIBE-capable route from the firmware table, expanded to
 * concrete paths — deliberately ignoring spec coverage.
 *
 * planSweep's coverage filter exists so discovery/read don't re-document
 * routes the published spec already has. Applying that same filter to the
 * subscribe phase was a mistake: the covered routes (`/zone`, `/area/{id}`,
 * `/device`, `/link/{id}/status`, `/project`, ...) are exactly the ones the
 * published fixtures show actually working, and the goal here is observing
 * pushed-frame behaviour, not adding new paths to the spec. Excluding them
 * left only the exotic, mostly-unimplemented routes, which is why an
 * earlier run of this phase came back all `no-frames`.
 */
function subscribableEntries(
  routes: Route[],
  index: IdIndex,
  idLimit: number,
): { template: string }[] {
  const priorityRank = (route: Route) => {
    const i = SUBSCRIBE_PRIORITY.indexOf(route.path);
    return i === -1 ? SUBSCRIBE_PRIORITY.length : i;
  };
  const subscribable = routes
    .filter((r) => r.verbs.includes("SUBSCRIBE"))
    .slice()
    .sort((a, b) => priorityRank(a) - priorityRank(b));

  const out: { template: string }[] = [];
  for (const route of subscribable) {
    if (!route.path.includes("{")) {
      out.push({ template: route.path });
      continue;
    }
    for (const url of expandTemplate(route.path, index, idLimit)) {
      out.push({ template: url });
    }
  }
  return out;
}

/**
 * Subscribe phase — the only artifact the existing fixture format cannot
 * hold, and the first opportunity to answer the ClientTag question the
 * published spec documents as unresolved.
 *
 * Opens a fresh connection per subscription, deliberately: the processor
 * caps at 10 concurrent clients, and one connection per route keeps each
 * frame stream unambiguous rather than multiplexed over a shared socket.
 * One consequence: LeapConnection's tag counter restarts on every new
 * connection, so `requestTag` is `lt-1` for every route here. That's
 * expected, but it means tag-reuse classification is only meaningful
 * within a single connection's frames, never across routes.
 */
async function subscribePhase(
  host: string,
  entries: { template: string }[],
  onLateFrame: (frame: LateFrame) => void,
): Promise<void> {
  const outPath = `${OUT_DIR}/${host}-subscribe.json`;
  const logs: SubscribeLog[] = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : [];
  const done = new Set(logs.map((l) => l.url));

  for (const entry of entries) {
    if (done.has(entry.template)) continue;

    assertVerbAllowed("SUBSCRIBE");
    const conn = new LeapConnection({ host });
    await conn.connect();

    const frames: Frame[] = [];
    // Tags our own code has already resolved on this connection. Populated
    // once the SubscribeRequest's ack comes back; checked on every
    // subsequent unsolicited frame to catch a duplicate response to a
    // request send() already considers finished.
    const resolvedTags = new Set<string>();
    const started = Date.now();
    conn.onEvent = (msg: {
      CommuniqueType?: string;
      Header?: Record<string, unknown>;
      Body?: unknown;
    }) => {
      const elapsed = Date.now() - started;
      frames.push({
        seq: frames.length,
        receivedMsAfterSubscribe: elapsed,
        communiqueType: String(msg?.CommuniqueType ?? "(none)"),
        header: msg?.Header ?? {},
        body: msg?.Body,
      });

      const frameTag = msg?.Header?.ClientTag;
      if (typeof frameTag === "string" && resolvedTags.has(frameTag)) {
        onLateFrame({
          url: entry.template,
          requestTag: frameTag,
          seq: frames.length - 1,
          receivedMsAfterSubscribe: elapsed,
          communiqueType: String(msg?.CommuniqueType ?? "(none)"),
          header: msg?.Header ?? {},
          body: msg?.Body,
        });
      }
    };

    let status = "(error)";
    let requestTag = "(unknown)";
    try {
      const resp = await conn.send("SubscribeRequest", entry.template);
      status = String(resp?.Header?.StatusCode ?? "(none)");
      requestTag = String(resp?.Header?.ClientTag ?? "(none)");
      resolvedTags.add(requestTag);
      await sleep(SUBSCRIBE_HOLD_MS);
    } catch (err) {
      status = `(error) ${(err as Error).message}`;
    } finally {
      conn.close();
    }

    const log: SubscribeLog = {
      url: entry.template,
      requestTag,
      subscribeStatus: status,
      frames,
    };
    logs.push(log);
    writeJsonAtomic(outPath, logs);
    console.log(
      `  ${entry.template}: ${status}, ${frames.length} frames, tag ${classifyTagReuse(log)}`,
    );
  }

  const verdicts = logs.map(classifyTagReuse);
  console.log(
    `subscribe: reuses=${verdicts.filter((v) => v === "reuses").length} ` +
      `does-not-reuse=${verdicts.filter((v) => v === "does-not-reuse").length} ` +
      `no-frames=${verdicts.filter((v) => v === "no-frames").length}`,
  );
}

/**
 * The read phase (Task 4) captured five `102 Processing` responses on
 * `/firmwareimage/{id}` with null bodies — a status absent from both the
 * published spec and the firmware's own declared list. LeapConnection.send
 * resolves and discards the pending entry on the first frame matching a
 * tag; Task 4's runner never set onEvent, so a genuine result arriving
 * after that interim ack would have been silently dropped.
 *
 * This re-issues a plain ReadRequest to each `/firmwareimage/{id}` route
 * that returned 102 in the existing read capture (selected by status, not
 * hardcoded ids), with onEvent installed and the connection held open
 * afterward, so a late frame on the resolved tag — if the processor ever
 * sends one — is caught instead of lost.
 */
async function firmwareImageLateFrameProbe(
  host: string,
  capture: Capture,
  onLateFrame: (frame: LateFrame) => void,
): Promise<void> {
  const targets = Object.keys(capture).filter(
    (url) =>
      /^\/firmwareimage\/\d+$/.test(url) &&
      capture[url].status.startsWith("102"),
  );
  if (targets.length === 0) {
    console.log(
      "firmwareimage 102-recheck: no 102-status routes found in read capture",
    );
    return;
  }
  console.log(
    `firmwareimage 102-recheck: ${targets.length} routes, ` +
      `holding ${FIRMWARE_LATE_HOLD_MS}ms after each`,
  );

  for (const url of targets) {
    assertVerbAllowed("GET");
    const conn = new LeapConnection({ host });
    await conn.connect();

    // Each connection issues exactly one request here, so its tag is
    // deterministically LeapConnection's first ("lt-1") — there is no
    // second request on this connection to disambiguate against.
    const resolvedTags = new Set(["lt-1"]);
    const started = Date.now();
    conn.onEvent = (msg: {
      CommuniqueType?: string;
      Header?: Record<string, unknown>;
      Body?: unknown;
    }) => {
      const frameTag = msg?.Header?.ClientTag;
      if (typeof frameTag === "string" && resolvedTags.has(frameTag)) {
        onLateFrame({
          url,
          requestTag: frameTag,
          seq: 0,
          receivedMsAfterSubscribe: Date.now() - started,
          communiqueType: String(msg?.CommuniqueType ?? "(none)"),
          header: msg?.Header ?? {},
          body: msg?.Body,
        });
      }
    };

    try {
      await probe(conn, url, capture);
      console.log(`  ${url}: ${capture[url]?.status}`);
      await sleep(FIRMWARE_LATE_HOLD_MS);
    } finally {
      conn.close();
    }
  }
}

/**
 * Every GET+UPDATE-capable route from the firmware table, unexpanded —
 * deliberately ignoring spec coverage, for the same reason subscribableEntries
 * does.
 *
 * planSweep's coverage filter exists so discovery/read don't re-document
 * routes the published spec already has. Applying that same filter to
 * echo-write excludes exactly the routes most likely to be live and
 * write-capable — `/area/{id}`, `/zone/{id}`, `/controlstation/{id}`, and
 * others the published fixtures already show working — leaving only the
 * exotic, mostly-unimplemented routes to validate write safety against. The
 * goal here is proving writes are safe on routes that actually respond, not
 * avoiding routes the spec already covers. echoWritePhase itself still
 * expands each template and applies the 200-only / defined-body guards, so a
 * route with no live ids or no successful read is simply skipped, not
 * force-probed.
 */
function echoWritableEntries(routes: Route[]): { template: string }[] {
  return routes
    .filter((r) => r.verbs.includes("GET") && r.verbs.includes("UPDATE"))
    .filter((r) => !ECHO_WRITE_EXCLUDED_ROUTES.has(r.path))
    .map((r) => ({ template: r.path }));
}

/**
 * Routes excluded from the echo-write phase entirely — not because writing
 * to them is unsafe, but because a live run against 10.1.9.2 showed the
 * echo-back assumption itself doesn't hold for them, for two distinct
 * reasons. Kept as one set with per-route reasoning recorded here rather
 * than two sets, since both share the same consequence (skip the route);
 * a future addition should say which category it belongs to.
 *
 * Clock-bearing — the body embeds live wall-clock state, so a read taken
 * before the write can never compare equal to a read taken after:
 *
 * - `/system`: the UpdateRequest returned `500 InternalServerError` ("An
 *   unknown error occurred"), so nothing sent was ever applied — yet the
 *   post-write read still differed from the pre-write read by
 *   `System.Time.Second: 16 became 22`, six seconds of wall clock elapsing
 *   across the read-write-read cycle. The interlock correctly read that as
 *   movement and aborted the whole phase.
 *
 * Action-triggering — the write is interpreted as a command to act, not an
 * assertion of current state, so echoing it back is not inert:
 *
 * - `/link/{id}`: `/link/437` returned `500 Failed to begin CCX channel
 *   update`. Writing back a byte-identical link body attempted an RF
 *   channel update on the CCX radio rather than doing nothing. It failed
 *   and no state moved, but the underlying assumption this whole phase
 *   rests on — that echoing a payload back is inert — does not hold for
 *   this route.
 *
 * Deliberately a route-level exclusion rather than a change to `checkEcho`.
 * Teaching the comparison to ignore fields that merely look time-like would
 * weaken the safety net for every route to accommodate `/system`, and a
 * field named `Second` on another resource might be a genuine setting
 * rather than a clock tick. Excluding by path keeps the comparison strict
 * everywhere it can still mean something, and keeps `/link` out of the
 * write path entirely rather than trying to make its write look inert.
 */
const ECHO_WRITE_EXCLUDED_ROUTES: ReadonlySet<string> = new Set([
  "/system",
  "/link/{id}",
]);

/**
 * The subset of LeapConnection echoWritePhase needs. Narrowed from the full
 * class (rather than taking `LeapConnection` directly) so a test can hand it
 * a fake object literal implementing `send` — LeapConnection's private
 * fields make a plain object structurally incompatible with the full class
 * type, even one that behaves identically.
 */
type EchoWriteConn = Pick<LeapConnection, "send">;

/**
 * Echo-back write pass.
 *
 * For each route: read, write the identical payload, read again, compare. Any
 * difference between the two reads aborts the ENTIRE phase — a single
 * unexplained state change means the echo assumption is wrong somewhere, and
 * continuing would compound it across a live system.
 */
export async function echoWritePhase(
  conn: EchoWriteConn,
  host: string,
  entries: { template: string }[],
  index: IdIndex,
): Promise<void> {
  const outPath = `${OUT_DIR}/${host}-write.json`;
  const capture: Capture = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : {};
  // Routes actually echo-written in THIS call, as distinct from
  // Object.keys(capture).length, which is the cumulative size of outPath
  // across every run that has ever written to it — including runs under a
  // filter or exclusion set that no longer applies. Logging the cumulative
  // count as if it were this run's result previously misreported the
  // phase's outcome twice (quoted as "54 routes" and "75 routes" for runs
  // that actually probed far fewer). The primary number in the summary
  // below must reflect work done in this call, not file size.
  let probedThisRun = 0;

  for (const entry of entries) {
    for (const url of expandTemplate(entry.template, index, ID_LIMIT)) {
      if (capture[url]) continue;

      assertVerbAllowed("GET");
      const before = await conn.send("ReadRequest", url);
      if (!String(before?.Header?.StatusCode ?? "").startsWith("200")) continue;
      if (before?.Body === undefined) continue;

      assertVerbAllowed("UPDATE");
      const wrote = await conn.send("UpdateRequest", url, before.Body);
      capture[url] = {
        status: String(wrote?.Header?.StatusCode ?? "(none)"),
        body: wrote?.Body,
      };
      probedThisRun++;
      await sleep(PACE_MS);

      assertVerbAllowed("GET");
      const after = await conn.send("ReadRequest", url);
      const verdict = checkEcho(before.Body, after?.Body);
      if (verdict.moved) {
        writeFileSync(outPath, `${JSON.stringify(capture, null, 2)}\n`);
        throw new Error(
          `ECHO WRITE MOVED STATE at ${url}: ${verdict.reason}\n` +
            `Aborting the write phase. Captures up to this point are saved. ` +
            `Investigate before re-running; the Designer backup can restore if needed.`,
        );
      }

      writeFileSync(outPath, `${JSON.stringify(capture, null, 2)}\n`);
      await sleep(PACE_MS);
    }
  }

  console.log(
    `echo-write: ${probedThisRun} routes exercised this run ` +
      `(${Object.keys(capture).length} cumulative in ${outPath}), no state moved`,
  );
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

  // Late frames (see subscribePhase / firmwareImageLateFrameProbe) accumulate
  // across both the subscribe phase and the firmwareimage recheck below, so
  // the recording callback and its backing file live here rather than
  // inside either function.
  const lateFramesPath = `${OUT_DIR}/${host}-late-frames.json`;
  const lateFrames: LateFrame[] = existsSync(lateFramesPath)
    ? JSON.parse(readFileSync(lateFramesPath, "utf8"))
    : [];
  const recordLateFrame = (frame: LateFrame): void => {
    lateFrames.push(frame);
    writeJsonAtomic(lateFramesPath, lateFrames);
  };

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

    // Echo-write — read, write back the identical payload, read again,
    // compare. Runs on this same connection while it's still open; the
    // subscribe and firmwareimage-recheck phases below open their own
    // per-route connections and don't need this one, so it must happen
    // here, before the `finally` below closes it.
    // Route source is deliberately coverage-blind, like subscribableEntries.
    // The spec-coverage filter exists to avoid re-documenting known paths; it
    // is wrong here, because the goal is validating write safety on hardware,
    // and the already-documented routes (/area/{id}, /zone/{id},
    // /controlstation/{id}) are precisely the live, write-capable ones.
    await echoWritePhase(conn, host, echoWritableEntries(routes), index);
  } finally {
    conn.close();
  }

  // Phase 3 — subscribe. Deliberately built from the full route table, not
  // the spec-coverage-filtered plan above — see subscribableEntries. Each
  // route gets its own connection (see subscribePhase's doc comment), so
  // this runs after the read-phase connection above is closed rather than
  // sharing it.
  const subscribeEntries = subscribableEntries(
    routes,
    index,
    SUBSCRIBE_ID_LIMIT,
  );
  console.log(`subscribe: ${subscribeEntries.length} entries`);
  await subscribePhase(host, subscribeEntries, recordLateFrame);

  // Phase 4 — recheck the firmwareimage routes that came back `102
  // Processing` in the read capture, watching for a late frame on the
  // resolved tag (see firmwareImageLateFrameProbe's doc comment).
  await firmwareImageLateFrameProbe(host, capture, recordLateFrame);
  writeCaptureAtomic(outPath, capture);

  // Guarantee the late-frames file exists even when nothing landed in it —
  // an empty result is itself a finding here, not a non-result.
  writeJsonAtomic(lateFramesPath, lateFrames);
  console.log(`late frames: ${lateFrames.length} total (${lateFramesPath})`);

  const ok = Object.values(capture).filter((v) =>
    v.status.startsWith("200"),
  ).length;
  console.log(
    `captured ${Object.keys(capture).length} paths, ${ok} with 200 OK`,
  );
  console.log(`wrote ${outPath}`);
}

// Guard against running the whole live sweep as a side effect of import.
// Without this, test/leap-sweep.test.ts importing echoWritePhase would also
// execute main() — including its real ReadRequest/UpdateRequest traffic to
// whatever host argv[0] or the config default resolves to — the moment the
// test file loaded, before a single test even ran.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
