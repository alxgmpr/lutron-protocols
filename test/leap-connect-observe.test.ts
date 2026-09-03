import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { JsonObject, JsonValue } from "../lib/data-values";
import {
  attributeResponseFrames,
  type FrameRecord,
  subscribePhase,
} from "../tools/leap/leap-connect-observe";

type Frame = {
  CommuniqueType: string;
  Header: JsonObject;
  Body?: JsonValue;
};

/**
 * Duck-typed stand-in for LeapConnection — subscribePhase only calls
 * `.sendTagged()`. Each url maps to either a frame to answer with or an Error
 * to throw, so a refusal (which arrives as an ordinary response) and a
 * no-answer failure (timeout, dead socket) can both be scripted.
 */
function makeFakeConn(script: Record<string, Frame | Error>) {
  const calls: { communiqueType: string; url: string; tag: string }[] = [];
  let tagCounter = 0;
  const sendTagged = async (communiqueType: string, url: string) => {
    const tag = `lt-${++tagCounter}`;
    calls.push({ communiqueType, url, tag });
    const scripted = script[url];
    if (scripted === undefined) {
      throw new Error(`no scripted response for ${communiqueType} ${url}`);
    }
    if (scripted instanceof Error) throw scripted;
    return { tag, response: scripted };
  };
  return { sendTagged, calls };
}

const ok = (tag: string, url: string): Frame => ({
  CommuniqueType: "SubscribeResponse",
  Header: { StatusCode: "200 OK", ClientTag: tag, Url: url },
});

const refused = (tag: string, url: string, status: string): Frame => ({
  CommuniqueType: "ExceptionResponse",
  Header: { StatusCode: status, ClientTag: tag, Url: url },
});

// ── subscribePhase ────────────────────────────────────────────────

describe("subscribePhase", () => {
  test("issues one SubscribeRequest per url, in order, and no other verb", async () => {
    const conn = makeFakeConn({
      "/a": ok("lt-1", "/a"),
      "/b": ok("lt-2", "/b"),
    });

    await subscribePhase(conn, ["/a", "/b"]);

    assert.deepEqual(
      conn.calls.map((c) => c.communiqueType),
      ["SubscribeRequest", "SubscribeRequest"],
    );
    assert.deepEqual(
      conn.calls.map((c) => c.url),
      ["/a", "/b"],
    );
  });

  test("records url, tag, status, CommuniqueType and body per subscription", async () => {
    const conn = makeFakeConn({
      "/zone/status": {
        CommuniqueType: "SubscribeResponse",
        Header: { StatusCode: "200 OK", ClientTag: "lt-1" },
        Body: { ZoneStatuses: [] },
      },
    });

    const subs = await subscribePhase(conn, ["/zone/status"]);

    assert.equal(subs.length, 1);
    assert.equal(subs[0].url, "/zone/status");
    assert.equal(subs[0].tag, "lt-1");
    assert.equal(subs[0].status, "200 OK");
    assert.equal(subs[0].communiqueType, "SubscribeResponse");
    assert.deepEqual(subs[0].body, { ZoneStatuses: [] });
  });

  test("a refused subscribe is recorded and the run continues", async () => {
    // The experiment subscribes to speculative routes; the refusals are the
    // measurement, so a 405 in the middle must not cost the later URLs.
    const conn = makeFakeConn({
      "/button/status/event": refused(
        "lt-1",
        "/button/status/event",
        "405 MethodNotAllowed",
      ),
      "/device/status": refused("lt-2", "/device/status", "404 NotFound"),
      "/area/status": refused("lt-3", "/area/status", "400 BadRequest"),
      "/zone/status": ok("lt-4", "/zone/status"),
    });

    const subs = await subscribePhase(conn, [
      "/button/status/event",
      "/device/status",
      "/area/status",
      "/zone/status",
    ]);

    assert.equal(conn.calls.length, 4, "every url must still be attempted");
    assert.deepEqual(
      subs.map((s) => s.status),
      ["405 MethodNotAllowed", "404 NotFound", "400 BadRequest", "200 OK"],
    );
    assert.deepEqual(
      subs.map((s) => s.tag),
      ["lt-1", "lt-2", "lt-3", "lt-4"],
    );
  });

  test("a subscribe that never answers is recorded as an error, not thrown", async () => {
    const conn = makeFakeConn({
      "/dead": new Error("Timeout: SubscribeRequest /dead"),
      "/live": ok("lt-2", "/live"),
    });

    const subs = await subscribePhase(conn, ["/dead", "/live"]);

    assert.equal(subs.length, 2);
    assert.match(
      subs[0].status,
      /^\(error\) Timeout: SubscribeRequest \/dead$/,
    );
    assert.equal(subs[0].tag, "", "no tag is claimed when nothing came back");
    assert.equal(subs[1].status, "200 OK", "the next url still ran");
  });

  test("onAnswered fires only for answered subscribes, with the terminal frame", async () => {
    const good = ok("lt-2", "/live");
    const conn = makeFakeConn({
      "/dead": new Error("Timeout: SubscribeRequest /dead"),
      "/live": good,
    });

    const answered: { tag: string; url: string; response: unknown }[] = [];
    await subscribePhase(conn, ["/dead", "/live"], {
      onAnswered: (tag, url, response) => answered.push({ tag, url, response }),
    });

    assert.equal(answered.length, 1);
    assert.equal(answered[0].url, "/live");
    assert.equal(answered[0].tag, "lt-2");
    assert.equal(
      answered[0].response,
      good,
      "the terminal frame must be passed by identity, for frame attribution",
    );
  });

  test("beforeSend runs before every write, including one that fails", async () => {
    const conn = makeFakeConn({
      "/dead": new Error("Timeout"),
      "/live": ok("lt-2", "/live"),
    });

    let marks = 0;
    await subscribePhase(conn, ["/dead", "/live"], {
      beforeSend: () => {
        marks++;
      },
    });

    assert.equal(marks, 2);
  });

  test("no urls means no traffic at all", async () => {
    const conn = makeFakeConn({});
    const subs = await subscribePhase(conn, []);
    assert.deepEqual(subs, []);
    assert.equal(conn.calls.length, 0);
  });
});

// ── attributeResponseFrames ───────────────────────────────────────

function frame(seq: number, tag: string | undefined): FrameRecord {
  return {
    seq,
    atIso: "1970-01-01T00:00:00.000Z",
    atMs: seq,
    classification: "push-unknown-tag",
    matchedRequest: null,
    deliveredToOnEvent: false,
    communiqueType: "SubscribeResponse",
    header: tag === undefined ? {} : { ClientTag: tag },
    body: null,
  };
}

describe("attributeResponseFrames", () => {
  test("a frame reusing the tag after the response stays a push", () => {
    // The load-bearing case: leap-push-probe showed a subscription push
    // reuses the subscribe request's ClientTag. Matching on tag alone would
    // relabel the pushed event a response and erase the capture's point.
    const frames = [frame(1, "lt-4"), frame(2, "lt-4")];
    const raws = [{ terminal: true }, { push: true }];

    attributeResponseFrames(
      frames,
      raws,
      "lt-4",
      "SubscribeRequest /zone/status",
      raws[0],
    );

    assert.equal(frames[0].classification, "response");
    assert.equal(frames[0].matchedRequest, "SubscribeRequest /zone/status");
    assert.equal(frames[1].classification, "push-unknown-tag");
    assert.equal(frames[1].matchedRequest, null);
  });

  test("an interim frame on the tag before the response is attributed too", () => {
    const frames = [frame(1, "lt-4"), frame(2, "lt-4")];
    const raws = [{ interim: true }, { terminal: true }];

    attributeResponseFrames(
      frames,
      raws,
      "lt-4",
      "ReadRequest /server",
      raws[1],
    );

    assert.deepEqual(
      frames.map((f) => f.classification),
      ["response", "response"],
    );
  });

  test("frames on other tags, and untagged frames, are left alone", () => {
    const frames = [frame(1, "lt-3"), frame(2, undefined), frame(3, "lt-4")];
    const raws = [{ a: 1 }, { b: 2 }, { c: 3 }];

    attributeResponseFrames(
      frames,
      raws,
      "lt-4",
      "SubscribeRequest /x",
      raws[2],
    );

    assert.deepEqual(
      frames.map((f) => f.classification),
      ["push-unknown-tag", "push-unknown-tag", "response"],
    );
  });

  test("an unrecorded terminal frame changes nothing", () => {
    const frames = [frame(1, "lt-4")];
    const raws = [{ a: 1 }];

    attributeResponseFrames(frames, raws, "lt-4", "SubscribeRequest /x", {
      notInRaws: true,
    });

    assert.equal(frames[0].classification, "push-unknown-tag");
  });
});
