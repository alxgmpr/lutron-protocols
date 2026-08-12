#!/usr/bin/env npx tsx

/**
 * Connection-time frame observer — read-only.
 *
 *   npx tsx tools/leap/leap-connect-observe.ts --host 10.1.10.37 --hold 20
 *   npx tsx tools/leap/leap-connect-observe.ts --host 10.1.10.37 --reads /server,/project
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
 * READ-ONLY by construction: the only requests it can issue are ReadRequests
 * from `--reads`, each gated by `assertVerbAllowed("GET")`. There is no code
 * path here that creates, updates, deletes, or subscribes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultHost } from "../../lib/config";
import { assertVerbAllowed } from "../../lib/echo-guard";
import { LeapConnection } from "../../lib/leap-client";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: "string", default: defaultHost },
    /** Seconds to sit silent after connecting, before any read is issued. */
    hold: { type: "string", default: "20" },
    /** Seconds to keep listening after the last read. */
    tail: { type: "string", default: "5" },
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
type FrameClass =
  | "unprompted-pre-read"
  | "response"
  | "push-on-request-tag"
  | "push-unknown-tag"
  | "push-untagged";

type SentRequest = {
  tag: string;
  url: string;
  sentAtMs: number;
  answeredAtMs?: number;
};

type FrameRecord = {
  seq: number;
  atIso: string;
  /** ms since connect() resolved — the single timeline for all frames. */
  atMs: number;
  classification: FrameClass;
  matchedRequest: string | null;
  deliveredToOnEvent: boolean;
  communiqueType: string | null;
  header: Record<string, unknown>;
  body: unknown;
};

async function main(): Promise<void> {
  const readUrls = (values.reads ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const conn = new LeapConnection({ host: HOST });

  const sent = new Map<string, SentRequest>();
  const frames: FrameRecord[] = [];
  let t0 = 0;
  /** False until the first byte this tool writes. */
  let hasWritten = false;
  let lastRecord: FrameRecord | null = null;
  let lastRaw: unknown = null;

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
      matchedRequest: req ? req.url : null,
      deliveredToOnEvent: false,
      communiqueType: msg?.CommuniqueType ?? null,
      header: msg?.Header ?? {},
      body: msg?.Body ?? null,
    };
    frames.push(rec);
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

  try {
    // --- Phase 1: silence -------------------------------------------------
    // Nothing is written to the socket in this window, so every frame in it
    // is the processor speaking first.
    await sleep(HOLD_MS);
    const quietFrames = frames.length;
    console.log(
      `quiet window over: ${quietFrames} frame(s) arrived before any request`,
    );

    // --- Phase 2: optional reads -----------------------------------------
    for (const url of readUrls) {
      assertVerbAllowed("GET");
      hasWritten = true;
      const sentAtMs = now();
      let status = "";
      let communiqueType = "";
      let body: unknown = null;
      let tag = "";
      try {
        const r = await conn.sendTagged("ReadRequest", url);
        tag = r.tag;
        sent.set(tag, { tag, url, sentAtMs, answeredAtMs: now() });
        status = r.response?.Header?.StatusCode ?? "(none)";
        communiqueType = r.response?.CommuniqueType ?? "";
        body = r.response?.Body ?? null;
        // The response frame was recorded before its tag was known, so fix
        // its classification now.
        for (const f of frames) {
          if (f.header?.ClientTag === tag) {
            f.classification = "response";
            f.matchedRequest = url;
          }
        }
      } catch (err) {
        status = `(error) ${(err as Error).message}`;
      }
      reads.push({ url, tag, status, communiqueType, body });
      console.log(`read ${url} -> ${status}`);
    }

    if (readUrls.length > 0) {
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
      note:
        readUrls.length === 0
          ? "single connection, zero requests sent: every frame is unprompted"
          : "single connection: silent hold, then ReadRequests only",
      frames,
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
