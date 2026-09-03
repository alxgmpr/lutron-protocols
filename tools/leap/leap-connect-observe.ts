#!/usr/bin/env npx tsx

/**
 * Connection-time frame observer — non-mutating: GET and SUBSCRIBE only.
 *
 *   npx tsx tools/leap/leap-connect-observe.ts --host 10.1.10.37 --hold 20
 *   npx tsx tools/leap/leap-connect-observe.ts --host 10.1.10.37 --reads /server,/project
 *   npx tsx tools/leap/leap-connect-observe.ts --host 10.1.10.37 --hold 5 \
 *       --subscribe /device/status/deviceheard,/button/status/event --tail 900
 *
 * Answers one question the other LEAP tools cannot: what does the processor
 * send on a connection where the client has asked for nothing at all?
 *
 * `leap-push-probe.ts` already showed that a provisioned Caseta bridge emits
 * two untagged `SubscribeResponse 204` frames within ~20ms of TLS connect, on
 * routes the client never subscribed to. But that tool starts issuing reads
 * immediately, so it cannot separate "the bridge pushes on connect" from "the
 * bridge pushes once a client speaks", and it writes to a zone, which rules it
 * out entirely on a bridge that must not be touched.
 *
 * This tool opens the connection and then does nothing for `--hold` seconds,
 * recording every frame the socket delivers on one timeline. `--reads` adds an
 * optional second phase of plain ReadRequests after the quiet window, so an
 * inventory can be taken on the same connection without losing the record of
 * what preceded it.
 *
 * `--subscribe` adds a phase between the two: a SubscribeRequest per URL. A
 * bridge auto-subscribes a connecting client to a fixed, small set of routes,
 * so a silent hold can only ever show what that set carries. Anything else —
 * a button press on a Pico, say — is invisible until something asks for it,
 * and asking is what this option does. Subscribes that are refused are the
 * point as much as the ones that are accepted: a 405 or 404 on a speculative
 * route is a fact about the bridge, so each URL's status is recorded and the
 * run continues to the next one rather than aborting.
 *
 * NON-MUTATING by construction: the only requests it can issue are
 * SubscribeRequests from `--subscribe` and ReadRequests from `--reads`, gated
 * by `assertVerbAllowed("SUBSCRIBE")` and `assertVerbAllowed("GET")`
 * respectively. There is no code path here that creates, updates, or deletes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultHost } from "../../lib/config";
import {
  isString,
  type JsonObject,
  type JsonValue,
} from "../../lib/data-values";
import { assertVerbAllowed } from "../../lib/echo-guard";
import { LeapConnection, type LeapWireFrame } from "../../lib/leap-client";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: "string", default: defaultHost },
    /** Seconds to sit silent after connecting, before any request is issued. */
    hold: { type: "string", default: "20" },
    /** Seconds to keep listening after the last request. */
    tail: { type: "string", default: "5" },
    /**
     * Comma-separated URLs to SubscribeRequest after the quiet window, before
     * any --reads. This is the window the tail then watches.
     */
    subscribe: { type: "string" },
    /** Comma-separated URLs to ReadRequest after the quiet window. */
    reads: { type: "string" },
    out: { type: "string" },
  },
});

const HOST = values.host!;
const HOLD_MS = parseFloat(values.hold!) * 1000;
const TAIL_MS = parseFloat(values.tail!) * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where a frame sits relative to this tool's own traffic.
 *
 * `unprompted-pre-read` is the bucket the connection-time question turns on:
 * a frame that arrived before this client had written a single byte of LEAP,
 * so nothing it says can be a response to anything.
 */
export type FrameClass =
  | "unprompted-pre-read"
  | "response"
  | "push-on-request-tag"
  | "push-unknown-tag"
  | "push-untagged";

type SentRequest = {
  tag: string;
  communiqueType: string;
  url: string;
  sentAtMs: number;
  answeredAtMs?: number;
};

export type FrameRecord = {
  seq: number;
  atIso: string;
  /** ms since connect() resolved — the single timeline for all frames. */
  atMs: number;
  classification: FrameClass;
  matchedRequest: string | null;
  deliveredToOnEvent: boolean;
  communiqueType: string | null;
  header: JsonObject;
  body: JsonValue;
};

/**
 * Attribute the frames belonging to one request to that request.
 *
 * `sendTagged` reveals the tag only when it resolves, so the response frame
 * was already recorded — and classified without knowing its tag — by the time
 * a caller can fix it up. The terminal frame is located by object identity
 * rather than by tag, and only it and anything carrying that tag before it
 * (e.g. a "102 Processing" interim ack) become responses.
 *
 * A frame carrying the tag *after* the terminal one keeps its push
 * classification. That is the whole point: `leap-push-probe` established that
 * a subscription push reuses the subscribe request's ClientTag, so a
 * tag-only match would relabel the pushed event as a response and erase the
 * one thing a subscribe run exists to capture.
 *
 * `raws` is index-aligned with `frames`.
 */
export function attributeResponseFrames(
  frames: FrameRecord[],
  raws: LeapWireFrame[],
  tag: string,
  label: string,
  terminal: LeapWireFrame,
): void {
  const terminalIdx = raws.indexOf(terminal);
  if (terminalIdx === -1) return;
  for (let i = 0; i <= terminalIdx && i < frames.length; i++) {
    const f = frames[i];
    if (f.header?.ClientTag !== tag) continue;
    f.classification = "response";
    f.matchedRequest = label;
  }
}

/** What one `--subscribe` URL did, whether or not the bridge accepted it. */
export type SubscriptionRecord = {
  url: string;
  tag: string;
  /** The StatusCode as answered, or `(error) …` if no answer arrived at all. */
  status: string;
  communiqueType: string;
  body: JsonValue;
};

/** The slice of LeapConnection that subscribePhase actually uses. */
type TaggedSender = {
  sendTagged(
    communiqueType: string,
    url: string,
    body?: JsonValue,
  ): Promise<{ tag: string; response: LeapWireFrame }>;
};

/**
 * SubscribeRequest each URL in turn, recording what came back.
 *
 * A refused subscription is data, not a failure: the experiment this exists
 * for asks a bridge about several routes it may well not have, and "405 on
 * /button/status/event" is an answer. So no status aborts the loop, and a
 * URL that produces no response at all (timeout, dead socket) is recorded as
 * an error and the remaining URLs still get their turn.
 *
 * Every request is gated by `assertVerbAllowed("SUBSCRIBE")` and no other
 * verb is reachable from here.
 */
export async function subscribePhase(
  conn: TaggedSender,
  urls: string[],
  hooks: {
    /** Called immediately before each write, so the caller can mark the socket dirty. */
    beforeSend?: () => void;
    /** Called with the terminal response, so the caller can attribute frames to the tag. */
    onAnswered?: (tag: string, url: string, response: LeapWireFrame) => void;
    log?: (line: string) => void;
  } = {},
): Promise<SubscriptionRecord[]> {
  const subscriptions: SubscriptionRecord[] = [];

  for (const url of urls) {
    assertVerbAllowed("SUBSCRIBE");
    hooks.beforeSend?.();

    let tag = "";
    let status = "";
    let communiqueType = "";
    let body = null;
    try {
      const r = await conn.sendTagged("SubscribeRequest", url);
      tag = r.tag;
      const responseStatus = r.response?.Header?.StatusCode;
      status = isString(responseStatus) ? responseStatus : "(none)";
      const responseType = r.response?.CommuniqueType;
      communiqueType = isString(responseType) ? responseType : "";
      body = r.response?.Body ?? null;
      hooks.onAnswered?.(tag, url, r.response);
    } catch (err) {
      status = `(error) ${err instanceof Error ? err.message : String(err)}`;
    }

    subscriptions.push({ url, tag, status, communiqueType, body });
    hooks.log?.(
      `subscribe ${url} -> ${status}${tag ? ` (tag=${tag})` : ""}` +
        `${communiqueType ? ` ct=${communiqueType}` : ""}`,
    );
  }

  return subscriptions;
}

async function main(): Promise<void> {
  const subscribeUrls = (values.subscribe ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const readUrls = (values.reads ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const conn = new LeapConnection({ host: HOST });

  const sent = new Map<string, SentRequest>();
  const frames: FrameRecord[] = [];
  /** Raw frame objects, index-aligned with `frames`, for identity matching. */
  const raws: LeapWireFrame[] = [];
  let t0 = 0;
  /** False until the first byte this tool writes. */
  let hasWritten = false;
  let lastRecord: FrameRecord | null = null;
  let lastRaw: LeapWireFrame | null = null;

  const now = () => Date.now() - t0;

  conn.onFrame = (msg: any) => {
    const atMs = now();
    const tag: string | undefined = msg?.Header?.ClientTag;
    const req = tag ? sent.get(tag) : undefined;

    let classification: FrameClass;
    if (!hasWritten) classification = "unprompted-pre-read";
    else if (!tag) classification = "push-untagged";
    else if (!req) classification = "push-unknown-tag";
    else if (req.answeredAtMs === undefined) classification = "response";
    else classification = "push-on-request-tag";

    const rec: FrameRecord = {
      seq: frames.length + 1,
      atIso: new Date().toISOString(),
      atMs,
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

    console.log(
      `[${atMs.toString().padStart(6)}ms] #${rec.seq} ${rec.communiqueType} ` +
        `tag=${tag ?? "(none)"} status=${msg?.Header?.StatusCode ?? "-"} ` +
        `url=${msg?.Header?.Url ?? "-"}  <-- ${classification}`,
    );
  };

  conn.onEvent = (msg: any) => {
    if (lastRecord && lastRaw === msg) lastRecord.deliveredToOnEvent = true;
  };

  const attributeResponse = (
    tag: string,
    label: string,
    terminal: LeapWireFrame,
  ): void => attributeResponseFrames(frames, raws, tag, label, terminal);

  const connectStartedAt = new Date().toISOString();
  const wallBeforeConnect = Date.now();
  await conn.connect();
  t0 = Date.now();
  const tlsHandshakeMs = t0 - wallBeforeConnect;
  console.log(
    `connected to ${HOST}:8081 (handshake ${tlsHandshakeMs}ms); ` +
      `holding ${HOLD_MS / 1000}s with zero requests sent`,
  );

  const reads: {
    url: string;
    tag: string;
    status: string;
    communiqueType: string;
    body: unknown;
  }[] = [];
  /** Declared out here so a mid-run throw still writes what was subscribed. */
  let subscriptions: SubscriptionRecord[] = [];

  try {
    // --- Phase 1: silence -------------------------------------------------
    // Nothing is written to the socket in this window, so every frame in it
    // is the processor speaking first.
    await sleep(HOLD_MS);
    const quietFrames = frames.length;
    console.log(
      `quiet window over: ${quietFrames} frame(s) arrived before any request`,
    );

    // --- Phase 2: optional subscriptions ---------------------------------
    // Deliberately before the reads: whatever a subscription pushes should
    // have the whole rest of the run to arrive in, and any read traffic
    // after this point is then visibly interleaved with it on one timeline.
    if (subscribeUrls.length > 0) {
      console.log(`--- subscribing to ${subscribeUrls.length} URL(s) ---`);
    }
    subscriptions = await subscribePhase(conn, subscribeUrls, {
      beforeSend: () => {
        hasWritten = true;
      },
      onAnswered: (tag, url, response) => {
        sent.set(tag, {
          tag,
          communiqueType: "SubscribeRequest",
          url,
          sentAtMs: now(),
          answeredAtMs: now(),
        });
        attributeResponse(tag, `SubscribeRequest ${url}`, response);
      },
      log: (line) => console.log(line),
    });
    const accepted = subscriptions.filter((s) => s.status.startsWith("200"));
    if (subscribeUrls.length > 0) {
      console.log(
        `subscriptions: ${accepted.length}/${subscriptions.length} accepted ` +
          `(refusals are recorded, not fatal)`,
      );
    }

    // --- Phase 3: optional reads -----------------------------------------
    for (const url of readUrls) {
      assertVerbAllowed("GET");
      hasWritten = true;
      const sentAtMs = now();
      let status = "";
      let communiqueType = "";
      let body = null;
      let tag = "";
      try {
        const r = await conn.sendTagged("ReadRequest", url);
        tag = r.tag;
        sent.set(tag, {
          tag,
          communiqueType: "ReadRequest",
          url,
          sentAtMs,
          answeredAtMs: now(),
        });
        status = r.response?.Header?.StatusCode ?? "(none)";
        communiqueType = r.response?.CommuniqueType ?? "";
        body = r.response?.Body ?? null;
        // The response frame was recorded before its tag was known, so fix
        // its classification now.
        attributeResponse(tag, `ReadRequest ${url}`, r.response);
      } catch (err) {
        status = `(error) ${err instanceof Error ? err.message : String(err)}`;
      }
      reads.push({ url, tag, status, communiqueType, body });
      console.log(`read ${url} -> ${status}`);
    }

    // The tail is where a subscription pays off — it is the only window in
    // which a button can be pressed and the resulting push seen — so it runs
    // whenever anything at all was asked for, not just for reads.
    if (readUrls.length > 0 || subscribeUrls.length > 0) {
      console.log(`tail: listening a further ${TAIL_MS / 1000}s`);
      await sleep(TAIL_MS);
    }
  } finally {
    const capture = {
      host: HOST,
      startedAt: connectStartedAt,
      finishedAt: new Date().toISOString(),
      tlsHandshakeMs,
      holdSeconds: HOLD_MS / 1000,
      tailSeconds: TAIL_MS / 1000,
      requestsIssued: readUrls,
      subscribesIssued: subscribeUrls,
      note:
        readUrls.length === 0 && subscribeUrls.length === 0
          ? "single connection, zero requests sent: every frame is unprompted"
          : "single connection: silent hold, then SubscribeRequests and/or " +
            "ReadRequests only — no mutating verb is reachable",
      frames,
      subscriptions,
      reads,
    };

    const outPath =
      values.out ??
      join(
        process.cwd(),
        "data/captures",
        `leap-connect-observe-${HOST}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(capture, null, 2)}\n`);
    console.log(`\nwrote ${frames.length} frames to ${outPath}`);

    const unprompted = frames.filter(
      (f) => f.classification === "unprompted-pre-read",
    );
    console.log(
      `frames: ${frames.length} total, ${unprompted.length} unprompted before any request`,
    );
    for (const f of unprompted) {
      console.log(
        `  #${f.seq} +${f.atMs}ms ${f.communiqueType} ` +
          `${f.header?.StatusCode ?? "-"} ${f.header?.Url ?? "-"} ` +
          `tag=${f.header?.ClientTag ?? "(none)"}`,
      );
    }

    if (subscriptions.length > 0) {
      console.log(`subscriptions (${subscriptions.length}):`);
      for (const s of subscriptions) {
        console.log(
          `  ${s.url} -> ${s.status} tag=${s.tag || "(none)"} ` +
            `ct=${s.communiqueType || "-"}`,
        );
      }
      // Everything that was neither unprompted nor a response to something we
      // sent: on a run whose only requests were subscribes, this is the push.
      const pushes = frames.filter(
        (f) =>
          f.classification !== "response" &&
          f.classification !== "unprompted-pre-read",
      );
      console.log(`post-request non-response frames: ${pushes.length}`);
      for (const p of pushes) {
        console.log(
          `  #${p.seq} +${p.atMs}ms ${p.classification} ${p.communiqueType} ` +
            `${p.header?.Url ?? "-"} tag=${p.header?.ClientTag ?? "(none)"}`,
        );
      }
    }

    conn.close();
  }
}

// Guard against running a live capture as a side effect of import.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
