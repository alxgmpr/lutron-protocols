import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { processorIPs } from "../lib/config";
import { isJsonObject, type JsonValue } from "../lib/data-values";
import {
  LeapConnection,
  type LeapPush,
  type LeapSubscription,
  pushItems,
} from "../lib/leap-client";

// LeapConnection internals are private; tests reach them with a narrow cast,
// matching the seam leap-client.test.ts already uses.
type ConnInternals = {
  tagCounter: number;
  socket: { write(data: string): void; destroy(): void } | null;
  pendingRequests: Map<
    string,
    { resolve: (v: JsonValue) => void; reject: (e: Error) => void }
  >;
  subscriptions: Map<string, LeapSubscription>;
  handleData(data: string): void;
};
const internals = (conn: LeapConnection): ConnInternals =>
  // SAFETY: The test controls this fixture and intentionally uses the asserted test-only shape.
  conn as ConnInternals;

const HOST = processorIPs[0];

/**
 * A connection with a captured socket, so a test can read the tag a request
 * went out with and then hand-feed the frames that answer it.
 *
 * subscribe() allocates its tag and writes synchronously before its first
 * await, so `writes` is already populated by the time the returned promise is
 * handed back — which is what lets a test answer a request it has not awaited.
 */
function harness() {
  const conn = new LeapConnection({ host: HOST });
  const i = internals(conn);
  const writes: string[] = [];
  let destroyed = false;
  i.socket = {
    write: (data: string) => {
      writes.push(data);
    },
    destroy: () => {
      destroyed = true;
    },
  };

  const lastRequest = () => JSON.parse(writes[writes.length - 1]);
  const lastTag = (): string => lastRequest().Header.ClientTag;

  const feed = (...frames: JsonValue[]): void => {
    i.handleData(frames.map((f) => `${JSON.stringify(f)}\n`).join(""));
  };

  const subscribeResponse = (
    tag: string,
    url: string,
    messageBodyType: string,
    body: JsonValue,
    status = "200 OK",
  ) => ({
    CommuniqueType: "SubscribeResponse",
    Header: {
      ClientTag: tag,
      StatusCode: status,
      Url: url,
      MessageBodyType: messageBodyType,
    },
    Body: body,
  });

  const push = (
    tag: string,
    url: string,
    messageBodyType: string,
    body: JsonValue,
  ) => ({
    CommuniqueType: "ReadResponse",
    Header: {
      ClientTag: tag,
      StatusCode: "200 OK",
      Url: url,
      MessageBodyType: messageBodyType,
    },
    Body: body,
  });

  return {
    conn,
    i,
    writes,
    lastRequest,
    lastTag,
    feed,
    subscribeResponse,
    push,
    wasDestroyed: () => destroyed,
  };
}

/** Subscribe and answer the SubscribeRequest with a 200 + snapshot. */
async function subscribed(
  h: ReturnType<typeof harness>,
  url: string,
  onPush: (p: LeapPush) => void,
  messageBodyType = "MultipleZoneStatus",
  snapshot: JsonValue = { ZoneStatuses: [] },
): Promise<LeapSubscription> {
  const pending = h.conn.subscribe(url, onPush);
  const tag = h.lastTag();
  h.feed(h.subscribeResponse(tag, url, messageBodyType, snapshot));
  return pending;
}

// ── subscribe(): the SubscribeResponse ────────────────────────────

describe("LeapConnection.subscribe", () => {
  test("sends a SubscribeRequest and resolves with the snapshot", async () => {
    const h = harness();
    const sub = await subscribed(
      h,
      "/zone/status",
      () => {},
      "MultipleZoneStatus",
      { ZoneStatuses: [{ href: "/zone/546/status", Level: 100 }] },
    );

    const req = JSON.parse(h.writes[0]);
    assert.equal(req.CommuniqueType, "SubscribeRequest");
    assert.equal(req.Header.Url, "/zone/status");

    assert.equal(sub.url, "/zone/status");
    assert.equal(sub.tag, req.Header.ClientTag);
    assert.equal(sub.status, "200 OK");
    assert.equal(sub.messageBodyType, "MultipleZoneStatus");
    assert.deepEqual(sub.snapshot, {
      ZoneStatuses: [{ href: "/zone/546/status", Level: 100 }],
    });
    assert.equal(sub.active, true);
  });

  test("rejects a refused subscription and registers nothing", async () => {
    const h = harness();
    const pending = h.conn.subscribe("/zone/546/status", () => {});
    const tag = h.lastTag();
    // RA3's real answer for per-zone status: subscribe the collection instead.
    h.feed({
      CommuniqueType: "ExceptionResponse",
      Header: {
        ClientTag: tag,
        StatusCode: "405 MethodNotAllowed",
        Url: "/zone/546/status",
      },
      Body: { Message: "This request is not supported" },
    });

    await assert.rejects(pending, /405 MethodNotAllowed/);
    assert.equal(
      internals(h.conn).subscriptions.size,
      0,
      "a refused subscription must not stay registered",
    );
  });

  test("treats 102 Processing on the subscribe tag as interim", async () => {
    const h = harness();
    const pending = h.conn.subscribe("/zone/status", () => {});
    const tag = h.lastTag();

    h.feed({
      CommuniqueType: "SubscribeResponse",
      Header: { ClientTag: tag, StatusCode: "102 Processing" },
      Body: null,
    });
    h.feed(
      h.subscribeResponse(tag, "/zone/status", "MultipleZoneStatus", {
        ZoneStatuses: [{ href: "/zone/1/status", Level: 5 }],
      }),
    );

    const sub = await pending;
    assert.equal(sub.status, "200 OK");
    assert.deepEqual(sub.snapshot, {
      ZoneStatuses: [{ href: "/zone/1/status", Level: 5 }],
    });
  });
});

// ── push routing ──────────────────────────────────────────────────

describe("subscription push routing", () => {
  test("a later frame on the subscribe tag reaches the push handler", async () => {
    const h = harness();
    const pushes: LeapPush[] = [];
    const events: unknown[] = [];
    h.conn.onEvent = (msg) => events.push(msg);

    const sub = await subscribed(h, "/zone/status", (p) => pushes.push(p));
    h.feed(
      h.push(sub.tag, "/zone/status", "MultipleZoneStatus", {
        ZoneStatuses: [{ href: "/zone/546/status", Level: 50 }],
      }),
    );

    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].url, "/zone/status");
    assert.equal(pushes[0].tag, sub.tag);
    assert.equal(pushes[0].communiqueType, "ReadResponse");
    assert.equal(pushes[0].messageBodyType, "MultipleZoneStatus");
    assert.deepEqual(pushes[0].body, {
      ZoneStatuses: [{ href: "/zone/546/status", Level: 50 }],
    });
    assert.equal(
      events.length,
      0,
      "a routed push must not also fall through to onEvent",
    );
  });

  test("two subscriptions on one connection route by their own tags", async () => {
    const h = harness();
    const zone: LeapPush[] = [];
    const area: LeapPush[] = [];

    const zoneSub = await subscribed(h, "/zone/status", (p) => zone.push(p));
    const areaSub = await subscribed(
      h,
      "/area/32/status",
      (p) => area.push(p),
      "OneAreaStatus",
      { AreaStatus: { href: "/area/32/status" } },
    );
    assert.notEqual(zoneSub.tag, areaSub.tag);

    h.feed(
      h.push(areaSub.tag, "/area/32/status", "OneAreaStatus", {
        AreaStatus: { InstantaneousPower: 36 },
      }),
      h.push(zoneSub.tag, "/zone/status", "MultipleZoneStatus", {
        ZoneStatuses: [{ Level: 50 }],
      }),
    );

    assert.equal(zone.length, 1);
    assert.equal(area.length, 1);
    assert.deepEqual(area[0].body, { AreaStatus: { InstantaneousPower: 36 } });
    assert.deepEqual(zone[0].body, { ZoneStatuses: [{ Level: 50 }] });
  });

  test("a frame on an unsubscribed tag still reaches onEvent", async () => {
    const h = harness();
    const pushes: LeapPush[] = [];
    const events: unknown[] = [];
    h.conn.onEvent = (msg) => events.push(msg);

    await subscribed(h, "/zone/status", (p) => pushes.push(p));
    h.feed(h.push("lt-999", "/device/status", "MultipleDeviceStatus", {}));

    assert.equal(pushes.length, 0);
    assert.equal(events.length, 1);
  });

  test("a handler that throws does not stop later frames from routing", async () => {
    const h = harness();
    let delivered = 0;
    const sub = await subscribed(h, "/zone/status", () => {
      delivered++;
      throw new Error("handler blew up");
    });

    const frame = h.push(sub.tag, "/zone/status", "MultipleZoneStatus", {});
    assert.doesNotThrow(() => h.feed(frame, frame));
    assert.equal(delivered, 2);
  });
});

// ── lifecycle ─────────────────────────────────────────────────────

describe("subscription lifecycle", () => {
  test("unsubscribe stops dispatch and sends an UnsubscribeRequest", async () => {
    const h = harness();
    const pushes: LeapPush[] = [];
    const events: unknown[] = [];
    h.conn.onEvent = (msg) => events.push(msg);

    const sub = await subscribed(h, "/zone/status", (p) => pushes.push(p));
    const pending = sub.unsubscribe();

    const req = h.lastRequest();
    assert.equal(req.CommuniqueType, "UnsubscribeRequest");
    assert.equal(req.Header.Url, "/zone/status");
    h.feed({
      CommuniqueType: "UnsubscribeResponse",
      Header: { ClientTag: req.Header.ClientTag, StatusCode: "200 OK" },
    });

    const result = await pending;
    assert.equal(result.status, "200 OK");
    assert.equal(sub.active, false);

    h.feed(h.push(sub.tag, "/zone/status", "MultipleZoneStatus", {}));
    assert.equal(pushes.length, 0, "no dispatch after unsubscribe");
    assert.equal(events.length, 1, "the frame falls back to onEvent");
  });

  test("unsubscribe detaches even when the processor refuses", async () => {
    const h = harness();
    const pushes: LeapPush[] = [];
    const sub = await subscribed(h, "/zone/status", (p) => pushes.push(p));

    const pending = sub.unsubscribe();
    const req = h.lastRequest();
    h.feed({
      CommuniqueType: "ExceptionResponse",
      Header: {
        ClientTag: req.Header.ClientTag,
        StatusCode: "405 MethodNotAllowed",
      },
    });

    const result = await pending;
    assert.equal(result.status, "405 MethodNotAllowed");
    assert.equal(sub.active, false);
    h.feed(h.push(sub.tag, "/zone/status", "MultipleZoneStatus", {}));
    assert.equal(pushes.length, 0);
  });

  test("close() deactivates every subscription", async () => {
    const h = harness();
    const a = await subscribed(h, "/zone/status", () => {});
    const b = await subscribed(h, "/device/status", () => {});

    h.conn.close();

    assert.equal(h.wasDestroyed(), true);
    assert.equal(a.active, false);
    assert.equal(b.active, false);
    assert.equal(internals(h.conn).subscriptions.size, 0);
  });

  test("close() rejects in-flight requests rather than leaving them to time out", async () => {
    const h = harness();
    const pending = h.conn.send("ReadRequest", "/project");
    h.conn.close();
    await assert.rejects(pending, /connection closed/);
  });

  test("close() restarts the tag counter, because tags are per-connection", async () => {
    const h = harness();
    await subscribed(h, "/zone/status", () => {});
    assert.ok(internals(h.conn).tagCounter > 0);

    h.conn.close();
    assert.equal(internals(h.conn).tagCounter, 0);
  });

  test("unsubscribe on a closed subscription is a no-op, not a write", async () => {
    const h = harness();
    const sub = await subscribed(h, "/zone/status", () => {});
    h.conn.close();

    const writesBefore = h.writes.length;
    const result = await sub.unsubscribe();
    assert.equal(result.status, "(inactive)");
    assert.equal(h.writes.length, writesBefore);
  });
});

// ── pushItems ─────────────────────────────────────────────────────

describe("pushItems", () => {
  test("unwraps a Multiple* collection body", () => {
    const items = pushItems({
      messageBodyType: "MultipleZoneStatus",
      body: {
        ZoneStatuses: [{ href: "/zone/1/status" }, { href: "/zone/2/status" }],
      },
    });
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { href: "/zone/1/status" });
  });

  test("wraps a One* singleton body in a one-element array", () => {
    const items = pushItems({
      messageBodyType: "OneAreaStatus",
      body: { AreaStatus: { href: "/area/32/status", InstantaneousPower: 36 } },
    });
    assert.deepEqual(items, [
      { href: "/area/32/status", InstantaneousPower: 36 },
    ]);
  });

  test("returns empty for a null or bodyless push", () => {
    assert.deepEqual(
      pushItems({ messageBodyType: "OneAreaStatus", body: null }),
      [],
    );
    assert.deepEqual(
      pushItems({ messageBodyType: "MultipleZoneStatus", body: {} }),
      [],
    );
  });

  test("reads the sole body key rather than deriving it from the type name", () => {
    // "MultipleZoneStatus" -> "ZoneStatuses": the plural is English, not
    // mechanical, so the key is read off the body instead of reconstructed.
    const items = pushItems({
      messageBodyType: "MultipleThingamajigStatus",
      body: { ThingamajigStatuses: [{ ok: true }] },
    });
    assert.deepEqual(items, [{ ok: true }]);
  });
});

// ── replay of the real capture ────────────────────────────────────

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

type Fixture = {
  subscriptions: { url: string; tag: string; status: string }[];
  frames: {
    seq: number;
    classification: string;
    frame: {
      CommuniqueType: string;
      Header: Record<string, string>;
      Body?: unknown;
    };
  }[];
};

describe("replay: RA3 push capture (2026-08-14, zone 546)", () => {
  const fixture: Fixture = JSON.parse(
    readFileSync(
      join(__dir, "fixtures/leap-subscription-push-ra3.json"),
      "utf-8",
    ),
  );

  /**
   * Drive the client with the recorded frames, subscribing to the same two
   * URLs the probe did. The capture's own `classification` is the oracle: every
   * frame the probe called a push must land on a handler, and no frame it
   * called a response may.
   */
  test("routes exactly the frames the probe classified as pushes", async () => {
    const h = harness();
    const byUrl = new Map<string, LeapPush[]>();
    const events: unknown[] = [];
    h.conn.onEvent = (msg) => events.push(msg);

    const subs = new Map<string, LeapSubscription>();
    for (const s of fixture.subscriptions) {
      byUrl.set(s.url, []);
      const pending = h.conn.subscribe(s.url, (p) => {
        byUrl.get(s.url)!.push(p);
      });
      const tag = h.lastTag();
      const recorded = fixture.frames.find(
        (f) =>
          f.frame.Header.ClientTag === s.tag && f.classification === "response",
      );
      assert.ok(recorded, `capture has a SubscribeResponse for ${s.url}`);
      h.feed({
        ...recorded.frame,
        Header: { ...recorded.frame.Header, ClientTag: tag },
      });
      subs.set(s.url, await pending);
    }

    // Tags are per-connection and allocated in order, so the client's tags
    // line up with the capture's once the same requests have been issued.
    const tagMap = new Map(
      fixture.subscriptions.map((s) => [s.tag, subs.get(s.url)!.tag]),
    );

    const pushFrames = fixture.frames.filter(
      (f) => f.classification === "push-on-request-tag",
    );
    assert.equal(pushFrames.length, 4, "capture holds four pushes");

    for (const f of pushFrames) {
      const tag = tagMap.get(f.frame.Header.ClientTag);
      assert.ok(
        tag,
        `push tag ${f.frame.Header.ClientTag} maps to a subscription`,
      );
      h.feed({ ...f.frame, Header: { ...f.frame.Header, ClientTag: tag } });
    }

    assert.equal(byUrl.get("/zone/status")!.length, 2);
    assert.equal(byUrl.get("/area/32/status")!.length, 2);
    assert.equal(
      events.length,
      0,
      "every recorded push was routed, none leaked",
    );
  });

  test("the snapshot is a full set and the pushes are deltas", async () => {
    const h = harness();
    const pushes: LeapPush[] = [];

    const snapshotFrame = fixture.frames.find(
      (f) =>
        f.frame.Header.MessageBodyType === "MultipleZoneStatus" &&
        f.frame.CommuniqueType === "SubscribeResponse",
    )!;
    const pushFrame = fixture.frames.find(
      (f) =>
        f.frame.Header.MessageBodyType === "MultipleZoneStatus" &&
        f.classification === "push-on-request-tag",
    )!;

    const pending = h.conn.subscribe("/zone/status", (p) => pushes.push(p));
    const tag = h.lastTag();
    h.feed({
      ...snapshotFrame.frame,
      Header: { ...snapshotFrame.frame.Header, ClientTag: tag },
    });
    const sub = await pending;

    h.feed({
      ...pushFrame.frame,
      Header: { ...pushFrame.frame.Header, ClientTag: tag },
    });

    const snapshotItems = pushItems({
      messageBodyType: sub.messageBodyType,
      body: sub.snapshot,
    }).filter(isJsonObject);
    const deltaItems = pushItems(pushes[0]).filter(isJsonObject);

    assert.ok(
      snapshotItems.length > deltaItems.length,
      `snapshot (${snapshotItems.length}) covers more zones than the delta (${deltaItems.length})`,
    );
    // The documented shape difference: the snapshot carries ZoneLockState,
    // pushed entries omit it. A consumer merging deltas into the snapshot must
    // not treat the missing field as a change to null.
    assert.ok(
      "ZoneLockState" in snapshotItems[0],
      "snapshot entries carry ZoneLockState",
    );
    assert.ok(
      deltaItems.every((z) => !("ZoneLockState" in z)),
      "pushed entries omit ZoneLockState",
    );
  });
});
