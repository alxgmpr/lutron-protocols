#!/usr/bin/env npx tsx

/**
 * LEAP subscription push probe — does the processor actually push, and does
 * the pushed frame reuse the subscribe request's ClientTag?
 *
 * Earlier subscribe captures held connections open but nothing in the house
 * changed during the hold window, so zero frames arrived and the question
 * stayed open. This tool causes the state change itself: on ONE connection it
 * subscribes to a zone's status, drives that zone to a different level, holds,
 * and then restores the original level.
 *
 * Every frame the socket delivers is recorded on one timeline (via the
 * client's raw onFrame tap) and classified against the tags this tool sent,
 * so a genuine unsolicited push can be told apart from the response to the
 * subscribe request and the response to the zone command.
 *
 * --pad N discriminates the two readings of the tag on a pushed frame. Every
 * capture so far subscribed at lt-18, because the prelude happens to be 17
 * reads long, so "the push carries the subscribe request's tag" and "the push
 * carries a tag fixed by sequence position" fit the evidence equally. N extra
 * harmless reads immediately before the subscribe move the subscribe onto a
 * different tag while changing nothing else, which separates them.
 *
 * Usage:
 *   npx tsx tools/leap/leap-push-probe.ts --zone 4664
 *   npx tsx tools/leap/leap-push-probe.ts --host 10.1.9.2 --zone 4664 --target 50
 *   npx tsx tools/leap/leap-push-probe.ts --zone 4664 --pad 7
 *
 * WRITES TO LIVE HARDWARE: it changes one zone's level and restores it.
 */

import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { hrefId, LeapConnection } from "../../lib/leap-client";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: "string", default: "10.1.9.2" },
    zone: { type: "string" },
    /** Level to drive the zone to. Defaults to "far from wherever it is now". */
    target: { type: "string" },
    /** Seconds to keep logging after the level change. */
    hold: { type: "string", default: "20" },
    /** Fade time in seconds for both the change and the restore. */
    fade: { type: "string", default: "1" },
    /** Override the subscribe URL instead of the derived defaults. */
    sub: { type: "string" },
    /**
     * Extra read-only requests to issue immediately before subscribing, so the
     * subscribe lands on a tag other than the one the unpadded prelude gives
     * it. 0 leaves the run identical to an unpadded one.
     */
    pad: { type: "string", default: "0" },
    out: { type: "string" },
  },
});

const HOST = values.host!;
const HOLD_MS = parseFloat(values.hold!) * 1000;
const FADE_S = parseFloat(values.fade!);

/**
 * What the padding reads ask for. Must be a plain read that changes nothing
 * and answers 200 on every platform, so the only thing padding alters is the
 * tag counter. /project qualifies on both RA3 and Caseta.
 */
const PAD_URL = "/project";

/** Format seconds as the HH:MM:SS LEAP expects for fade/delay. */
function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How a frame relates to the requests this tool sent. The interesting bucket
 * is "push-on-request-tag": a frame carrying a tag we sent, arriving after
 * that request had already been answered. That is what tag reuse on a push
 * would look like, and it is exactly what a plain onEvent handler cannot
 * distinguish from a response.
 */
type FrameClass =
  | "response" // tag matches a request still awaiting its answer
  | "push-on-request-tag" // tag matches a request already answered
  | "push-unknown-tag" // carries a tag this tool never sent
  | "push-untagged"; // no ClientTag at all

type SentRequest = {
  tag: string;
  communiqueType: string;
  url: string;
  sentAtMs: number;
  /** Set once send() resolved, i.e. the request has its terminal response. */
  answeredAtMs?: number;
};

type FrameRecord = {
  seq: number;
  atIso: string;
  /** ms since the probe connected — the single timeline for all frames. */
  atMs: number;
  /** ms since the level-change command was written, once it has been sent. */
  msAfterLevelChange: number | null;
  classification: FrameClass;
  /** Which request tag it matched, if any. */
  matchedRequest: string | null;
  /** Did LeapConnection itself treat this as unsolicited (onEvent)? */
  deliveredToOnEvent: boolean;
  communiqueType: string | null;
  header: Record<string, unknown>;
  body: unknown;
};

async function main() {
  if (!values.zone) {
    console.error("--zone is required (this tool writes to that zone)");
    process.exit(1);
  }
  const zoneId = parseInt(values.zone, 10);
  if (Number.isNaN(zoneId)) {
    console.error(`--zone must be numeric, got ${values.zone}`);
    process.exit(1);
  }

  const pad = parseInt(values.pad!, 10);
  if (Number.isNaN(pad) || pad < 0) {
    console.error(`--pad must be a non-negative integer, got ${values.pad}`);
    process.exit(1);
  }

  const conn = new LeapConnection({ host: HOST });

  const sent = new Map<string, SentRequest>();
  const frames: FrameRecord[] = [];
  /** Raw frame objects, index-aligned with `frames`, for identity matching. */
  const raws: unknown[] = [];
  let t0 = 0;
  let levelChangeSentAtMs: number | null = null;
  let lastRecord: FrameRecord | null = null;
  let lastRaw: unknown = null;

  const now = () => Date.now() - t0;

  conn.onFrame = (msg: any) => {
    const atMs = now();
    const tag: string | undefined = msg?.Header?.ClientTag;
    const req = tag ? sent.get(tag) : undefined;

    let classification: FrameClass;
    if (!tag) classification = "push-untagged";
    else if (!req) classification = "push-unknown-tag";
    else if (req.answeredAtMs === undefined) classification = "response";
    else classification = "push-on-request-tag";

    const rec: FrameRecord = {
      seq: frames.length + 1,
      atIso: new Date().toISOString(),
      atMs,
      msAfterLevelChange:
        levelChangeSentAtMs === null ? null : atMs - levelChangeSentAtMs,
      classification,
      matchedRequest: req ? `${req.communiqueType} ${req.url}` : null,
      deliveredToOnEvent: false,
      communiqueType: msg?.CommuniqueType ?? null,
      header: msg?.Header ?? {},
      body: msg?.Body ?? null,
    };
    frames.push(rec);
    raws.push(msg);
    lastRecord = rec;
    lastRaw = msg;

    // Arrival-time label only. A frame answering a request this tool is
    // still awaiting shows as push-unknown-tag here, because sendTagged only
    // reveals the tag on resolve; tracked() fixes the record afterwards. The
    // JSON capture and the closing summary carry the settled classification.
    const tail =
      classification === "response"
        ? ""
        : `  <-- at-arrival: ${classification}${req ? ` (${rec.matchedRequest})` : ""}`;
    console.log(
      `[${atMs.toString().padStart(6)}ms] #${rec.seq} ${rec.communiqueType} ` +
        `tag=${tag ?? "(none)"} status=${msg?.Header?.StatusCode ?? "-"} ` +
        `url=${msg?.Header?.Url ?? "-"}${tail}`,
    );
  };

  // onEvent fires from the same handleData pass, immediately after onFrame,
  // so the frame it is handed is the one just recorded. Recording this proves
  // the client's own routing agreed the frame was unsolicited.
  conn.onEvent = (msg: any) => {
    if (lastRecord && lastRaw === msg) lastRecord.deliveredToOnEvent = true;
  };

  /** send() + bookkeeping so onFrame can classify against outstanding tags. */
  async function tracked(communiqueType: string, url: string, body?: any) {
    const sentAtMs = now();
    // sendTagged allocates the tag synchronously before writing but only
    // reveals it on resolve, so frames carrying it are recorded before the
    // tag is known and are reclassified here. The terminal response frame is
    // identified by object identity, not by tag — a push that reused the tag
    // and arrived before the response must not be relabelled a response.
    const { tag, response } = await conn.sendTagged(communiqueType, url, body);
    const req: SentRequest = {
      tag,
      communiqueType,
      url,
      sentAtMs,
      answeredAtMs: now(),
    };
    sent.set(tag, req);

    const terminalIdx = raws.indexOf(response);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (f.header?.ClientTag !== tag) continue;
      // The terminal response and anything on this tag that preceded it
      // (e.g. a "102 Processing" interim ack) belong to the request.
      // Anything on this tag after it is a candidate push.
      if (terminalIdx !== -1 && i <= terminalIdx) {
        f.classification = "response";
        f.matchedRequest = `${communiqueType} ${url}`;
      }
    }
    return { tag, response };
  }

  const capture: Record<string, unknown> = {
    host: HOST,
    zone: zoneId,
    pad,
    padUrl: pad > 0 ? PAD_URL : null,
    startedAt: new Date().toISOString(),
    note: "single connection: subscribe, level change, hold, restore",
  };

  let originalLevel: number | null = null;
  const restored: {
    attempted: boolean;
    verifiedLevel: number | null;
    ok: boolean;
  } = { attempted: false, verifiedLevel: null, ok: false };

  await conn.connect();
  t0 = Date.now();
  console.log(`connected to ${HOST}:8081`);

  try {
    // --- 1. Zone identity and starting level -----------------------------
    const detail = await tracked("ReadRequest", `/zone/${zoneId}`);
    const zone = detail.response?.Body?.Zone;
    console.log(
      `zone ${zoneId}: ${zone?.Name} (ControlType=${zone?.ControlType})`,
    );
    if (zone?.ControlType !== "Dimmed") {
      throw new Error(
        `zone ${zoneId} is ControlType=${zone?.ControlType}; this probe expects a Dimmed zone`,
      );
    }

    const statusResp = await tracked("ReadRequest", `/zone/${zoneId}/status`);
    originalLevel = statusResp.response?.Body?.ZoneStatus?.Level ?? null;
    if (typeof originalLevel !== "number") {
      throw new Error(`could not read a numeric starting Level for ${zoneId}`);
    }
    console.log(`original level: ${originalLevel}%`);

    const target =
      values.target !== undefined
        ? parseFloat(values.target)
        : originalLevel < 30
          ? 50
          : 20;
    console.log(`target level: ${target}%`);

    capture.zoneName = zone?.Name;
    capture.originalLevel = originalLevel;
    capture.targetLevel = target;

    // The zone detail carries no area backlink on RA3, so walk leaf areas
    // until one lists this zone.
    let areaId: number | null = null;
    const areasBody = (await tracked("ReadRequest", "/area")).response?.Body;
    for (const area of areasBody?.Areas ?? []) {
      if (!area.IsLeaf || areaId !== null) continue;
      const id = hrefId(area.href);
      const zb = (await tracked("ReadRequest", `/area/${id}/associatedzone`))
        .response?.Body;
      if ((zb?.Zones ?? []).some((z: any) => hrefId(z.href) === zoneId)) {
        areaId = id;
      }
    }
    capture.areaId = areaId;
    console.log(`zone ${zoneId} belongs to area ${areaId ?? "(not found)"}`);

    // --- 1b. Pad the tag counter -----------------------------------------
    // Read-only, and deliberately the last thing before the subscribe, so a
    // padded run differs from an unpadded one in the subscribe's tag and in
    // nothing else.
    const padTags: string[] = [];
    if (pad > 0) {
      console.log(`--- padding: ${pad} x ReadRequest ${PAD_URL} ---`);
      for (let i = 0; i < pad; i++) {
        const p = await tracked("ReadRequest", PAD_URL);
        padTags.push(p.tag);
        const status = p.response?.Header?.StatusCode ?? "";
        if (!status.startsWith("200")) {
          throw new Error(
            `pad read ${i + 1}/${pad} of ${PAD_URL} answered ${status}; ` +
              `padding must be inert, so stopping rather than subscribing`,
          );
        }
      }
      console.log(`padded with tags: ${padTags.join(", ")}`);
    }
    capture.padTags = padTags;

    // --- 2. Subscribe ----------------------------------------------------
    // Per-zone status is NOT subscribable on this processor:
    // SubscribeRequest /zone/{id}/status answers 405 MethodNotAllowed
    // ("This request is not supported"). The zone-status collection
    // /zone/status is, and answers with every ZoneStatus. The zone's area
    // status is subscribable too and is included so an area-level push, if
    // that is the shape the processor uses, is not missed.
    const subUrls = values.sub
      ? [values.sub]
      : ["/zone/status", areaId !== null ? `/area/${areaId}/status` : null];

    const subscriptions: {
      url: string;
      tag: string;
      status: string;
      communiqueType: string;
    }[] = [];
    for (const url of subUrls) {
      if (!url) continue;
      const sub = await tracked("SubscribeRequest", url);
      const status = sub.response?.Header?.StatusCode ?? "";
      subscriptions.push({
        url,
        tag: sub.tag,
        status,
        communiqueType: sub.response?.CommuniqueType ?? "",
      });
      console.log(`subscribed: ${url} tag=${sub.tag} status=${status}`);
    }
    capture.subscriptions = subscriptions;
    if (!subscriptions.some((s) => s.status.startsWith("200"))) {
      throw new Error("no subscription was accepted — nothing to observe");
    }

    // Quiet period: anything arriving here is unprompted by us, and shows
    // whether the socket is chatty on its own.
    await sleep(3000);

    // --- 3. Change the level --------------------------------------------
    console.log(`--- driving zone ${zoneId} to ${target}% ---`);
    levelChangeSentAtMs = now();
    const cmd = await tracked(
      "CreateRequest",
      `/zone/${zoneId}/commandprocessor`,
      {
        Command: {
          CommandType: "GoToDimmedLevel",
          DimmedLevelParameters: {
            Level: target,
            FadeTime: fmtTime(FADE_S),
          },
        },
      },
    );
    capture.commandTag = cmd.tag;
    capture.commandStatus = cmd.response?.Header?.StatusCode ?? "";
    capture.levelChangeSentAtMs = levelChangeSentAtMs;
    console.log(
      `command sent: tag=${cmd.tag} status=${cmd.response?.Header?.StatusCode}`,
    );

    // --- 4. Hold ---------------------------------------------------------
    console.log(`holding ${HOLD_MS / 1000}s, logging every frame...`);
    await sleep(HOLD_MS);
  } finally {
    // --- 5. Restore ------------------------------------------------------
    if (originalLevel !== null) {
      restored.attempted = true;
      console.log(`--- restoring zone ${zoneId} to ${originalLevel}% ---`);
      // Restore on a fresh connection if the probe connection died, so a
      // mid-experiment socket failure still leaves the house as it was.
      let restoreConn = conn;
      let usedFallback = false;
      try {
        await tracked("CreateRequest", `/zone/${zoneId}/commandprocessor`, {
          Command: {
            CommandType: "GoToDimmedLevel",
            DimmedLevelParameters: {
              Level: originalLevel,
              FadeTime: fmtTime(FADE_S),
            },
          },
        });
      } catch (err) {
        console.error(`restore on probe connection failed: ${err}`);
        restoreConn = new LeapConnection({ host: HOST });
        usedFallback = true;
        await restoreConn.connect();
        await restoreConn.create(`/zone/${zoneId}/commandprocessor`, {
          Command: {
            CommandType: "GoToDimmedLevel",
            DimmedLevelParameters: {
              Level: originalLevel,
              FadeTime: fmtTime(FADE_S),
            },
          },
        });
      }

      // Verify: let the fade finish, then read the level back. Routed through
      // tracked() when it is the probe connection so the verify read's own
      // response is not left sitting in the log as an unattributed frame.
      await sleep(Math.max(2000, FADE_S * 1000 + 1500));
      const verify = usedFallback
        ? await restoreConn.readBody(`/zone/${zoneId}/status`)
        : (await tracked("ReadRequest", `/zone/${zoneId}/status`)).response
            ?.Body;
      const level = verify?.ZoneStatus?.Level ?? null;
      restored.verifiedLevel = level;
      restored.ok = level === originalLevel;
      console.log(
        `restore verified: read back ${level}% (expected ${originalLevel}%) — ` +
          `${restored.ok ? "MATCH" : "MISMATCH"}${usedFallback ? " [via fallback connection]" : ""}`,
      );
      if (usedFallback) restoreConn.close();
    }

    capture.frames = frames;
    capture.restore = { ...restored, originalLevel };
    capture.finishedAt = new Date().toISOString();
    capture.sentRequests = [...sent.values()];

    const outPath =
      values.out ??
      path.join(
        process.cwd(),
        "data/captures",
        `leap-push-probe-${HOST}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(capture, null, 2));
    console.log(`\nwrote ${frames.length} frames to ${outPath}`);

    const pushes = frames.filter((f) => f.classification !== "response");
    console.log(
      `frames: ${frames.length} total, ${pushes.length} non-response`,
    );
    for (const p of pushes) {
      console.log(
        `  #${p.seq} ${p.classification} ct=${p.communiqueType} ` +
          `tag=${p.header?.ClientTag ?? "(none)"} ` +
          `+${p.msAfterLevelChange ?? "n/a"}ms after change`,
      );
    }

    conn.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
