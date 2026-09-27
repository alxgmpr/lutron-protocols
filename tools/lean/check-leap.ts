import assert from "node:assert/strict";
import { mock } from "node:test";
import { LeapConnection, type LeapSubscription } from "../../lib/leap-client";

interface Internals {
  pendingRequests: Map<string, unknown>;
  subscriptions: Map<string, { active: boolean }>;
  handleData(data: string): void;
}

/** Exercise production methods without certificates, sockets, or config mutation. */
function harness(subscribe: boolean) {
  // SAFETY: This offline fixture initializes every field used by send/subscribe/close.
  // connect() is deliberately never called; no TLS socket can be created.
  const fixture = Object.assign(Object.create(LeapConnection.prototype), {
    socket: { write: () => true, destroy: () => {} },
    buffer: "",
    tagCounter: 0,
    pendingRequests: new Map(),
    subscriptions: new Map(),
    onFrame: null,
    onEvent: null,
  });
  const conn: LeapConnection = fixture;
  // SAFETY: Observe the initialized fixture through the same private seam as existing tests.
  const internal: Internals = fixture;
  let resolved = 0;
  let rejected = 0;
  let pushes = 0;
  let unsolicited = 0;
  let subscription: LeapSubscription | undefined;
  conn.onEvent = () => unsolicited++;
  const pending = subscribe
    ? conn
        .subscribe("/zone/status", () => pushes++, 10)
        .then((sub) => {
          subscription = sub;
        })
    : conn.send("ReadRequest", "/zone", undefined, 10);
  pending.then(
    () => resolved++,
    () => rejected++,
  );
  const snapshot = () => [
    internal.pendingRequests.size,
    [...internal.subscriptions.values()].filter((s) => s.active).length,
    resolved,
    rejected,
    pushes,
    unsolicited,
  ];
  const frame = (event: number) =>
    `${JSON.stringify({
      CommuniqueType: "ReadResponse",
      Header: {
        ClientTag: event === 5 ? "unknown" : "lt-1",
        StatusCode:
          event === 0
            ? "102 Processing"
            : event === 2
              ? "405 Refused"
              : "200 OK",
        Url: "/zone/status",
      },
      Body: {},
    })}\n`;
  return {
    conn,
    internal,
    snapshot,
    frame,
    getSubscription: () => subscription,
  };
}

async function flushPromises() {
  // sendWithTag → sendTagged/subscribe → public promise → observation callback.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

export async function checkLeapTrace(
  subscribe: boolean,
  events: number[],
  snapshots: number[][],
  batch = false,
) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(subscribe);
  try {
    if (batch) {
      h.internal.handleData(events.map(h.frame).join(""));
      await flushPromises();
      assert.deepEqual(h.snapshot(), snapshots.at(-1), "LEAP same-chunk trace");
    } else {
      for (const [index, event] of events.entries()) {
        if (event === 3) mock.timers.tick(10);
        else if (event === 4) h.conn.close();
        else h.internal.handleData(h.frame(event));
        await flushPromises();
        assert.deepEqual(
          h.snapshot(),
          snapshots[index],
          `LEAP subscribe=${subscribe} events=${events} step=${index}`,
        );
      }
    }
  } finally {
    h.conn.close();
    await flushPromises();
    mock.timers.reset();
  }
}

/** Old connection deadlines must not remove a new request with the same tag. */
export async function checkLeapTagReuse(expected: number[]) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const old = harness(false);
  try {
    mock.timers.tick(5);
    old.conn.close();
    await flushPromises();
    // Reuse the same object exactly as connect() does, but keep transport offline.
    Object.assign(old.conn, {
      socket: { write: () => true, destroy: () => {} },
    });
    let resolved = 0;
    let rejected = 0;
    const pending = old.conn.send("ReadRequest", "/new", undefined, 20);
    pending.then(
      () => resolved++,
      () => rejected++,
    );
    mock.timers.tick(5); // Old request's deadline, before the new one's deadline.
    await flushPromises();
    assert.deepEqual(
      [old.internal.pendingRequests.size, 0, resolved, rejected, 0, 0],
      expected,
      "An old timer must not consume a reused ClientTag",
    );
    old.internal.handleData(old.frame(1));
    await flushPromises();
    assert.equal(resolved, 1);
    assert.equal(rejected, 0);
  } finally {
    old.conn.close();
    await flushPromises();
    mock.timers.reset();
  }
}

export async function checkLeapSubscriptionReuse() {
  mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(true);
  try {
    h.conn.close();
    Object.assign(h.conn, { socket: { write: () => true, destroy: () => {} } });
    const replacement = h.conn.subscribe("/zone/status", () => {}, 20);
    // Observe rejection immediately if this regression returns.
    const outcome = replacement.then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    await flushPromises();
    assert.equal(
      h.internal.subscriptions.size,
      1,
      "Old rejection must preserve the new subscription",
    );
    h.internal.handleData(h.frame(1));
    const result = await outcome;
    assert.ok("value" in result);
    assert.equal(result.value.active, true);
    assert.equal(h.internal.subscriptions.size, 1);
  } finally {
    h.conn.close();
    await flushPromises();
    mock.timers.reset();
  }
}

export async function checkLeapDetach(expected: number[]) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(true);
  try {
    h.internal.handleData(h.frame(1));
    await flushPromises();
    const sub = h.getSubscription();
    assert.ok(sub);
    const detached = sub.unsubscribe();
    assert.equal(sub.active, false);
    // A push on the old tag arrives before the unsubscribe acknowledgement.
    h.internal.handleData(h.frame(1));
    h.internal.handleData(h.frame(1).replace("lt-1", "lt-2"));
    await detached;
    await flushPromises();
    assert.deepEqual(h.snapshot(), expected);
  } finally {
    h.conn.close();
    await flushPromises();
    mock.timers.reset();
  }
}
