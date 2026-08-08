import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import {
  ALLOWED_VERBS,
  coveredIdentsFromOperationIds,
  planSweep,
  type Route,
} from "../lib/route-plan";

const r = (ident: string, path: string, verbs: string[]): Route => ({
  ident,
  path,
  verbs,
  handlers: {},
});

describe("ALLOWED_VERBS", () => {
  test("is exactly GET, SUBSCRIBE, UPDATE", () => {
    assert.deepEqual([...ALLOWED_VERBS].sort(), ["GET", "SUBSCRIBE", "UPDATE"]);
  });

  test("excludes the destructive verbs", () => {
    assert.ok(!ALLOWED_VERBS.has("CREATE"));
    assert.ok(!ALLOWED_VERBS.has("DELETE"));
  });
});

describe("coveredIdentsFromOperationIds", () => {
  test("strips the lowercase verb prefix", () => {
    const s = coveredIdentsFromOperationIds([
      "getZoneID",
      "putZoneID",
      "postArea",
    ]);
    assert.ok(s.has("ZoneID"));
    assert.ok(s.has("Area"));
  });

  test("ignores operationIds with no recognisable prefix", () => {
    const s = coveredIdentsFromOperationIds(["weird"]);
    assert.equal(s.size, 0);
  });
});

describe("planSweep", () => {
  test("routes with no id go to discovery", () => {
    const p = planSweep([r("Zone", "/zone", ["GET"])], new Set());
    assert.deepEqual(p, [
      {
        phase: "discovery",
        ident: "Zone",
        template: "/zone",
        verb: "GET",
        needsId: false,
      },
    ]);
  });

  test("routes needing an id go to read", () => {
    const p = planSweep([r("ZoneID", "/zone/{id}", ["GET"])], new Set());
    assert.equal(p[0].phase, "read");
    assert.equal(p[0].needsId, true);
  });

  test("SUBSCRIBE produces its own entry alongside GET", () => {
    const p = planSweep(
      [r("ZoneStatus", "/zone/{id}/status", ["GET", "SUBSCRIBE"])],
      new Set(),
    );
    assert.deepEqual(p.map((e) => e.phase).sort(), ["read", "subscribe"]);
  });

  test("UPDATE is planned only when the route also has GET", () => {
    const withGet = planSweep(
      [r("A", "/a/{id}", ["GET", "UPDATE"])],
      new Set(),
    );
    assert.ok(withGet.some((e) => e.phase === "echo-write"));

    const withoutGet = planSweep([r("B", "/b", ["UPDATE"])], new Set());
    assert.equal(withoutGet.length, 0, "no GET means nothing to echo");
  });

  test("CREATE and DELETE never produce an entry", () => {
    const p = planSweep(
      [r("C", "/c", ["CREATE"]), r("D", "/d/{id}", ["DELETE"])],
      new Set(),
    );
    assert.deepEqual(p, []);
  });

  test("a CREATE route that also has GET is still read", () => {
    const p = planSweep([r("E", "/e", ["CREATE", "GET"])], new Set());
    assert.deepEqual(
      p.map((x) => x.phase),
      ["discovery"],
    );
    assert.ok(p.every((x) => x.verb !== "CREATE"));
  });

  test("already-covered idents are skipped", () => {
    const p = planSweep([r("Zone", "/zone", ["GET"])], new Set(["Zone"]));
    assert.deepEqual(p, []);
  });
});

describe("the real corpus", () => {
  const routes: Route[] = JSON.parse(
    readFileSync("data/firmware-re/leap-routes.json", "utf8"),
  );

  test("reaches 386 of the 410 routes when nothing is covered", () => {
    const p = planSweep(routes, new Set());
    const distinct = new Set(p.map((e) => e.ident));
    assert.equal(routes.length, 410);
    assert.equal(
      distinct.size,
      386,
      "routes carrying GET, SUBSCRIBE, or echo-able UPDATE",
    );
  });

  test("the 24 unreachable routes carry only CREATE, DELETE, or bare UPDATE", () => {
    const planned = new Set(planSweep(routes, new Set()).map((e) => e.ident));
    const unreachable = routes.filter((r) => !planned.has(r.ident));
    assert.equal(unreachable.length, 24);
    for (const r of unreachable) {
      assert.ok(
        !r.verbs.includes("GET") && !r.verbs.includes("SUBSCRIBE"),
        `${r.path} should have been reachable`,
      );
    }
  });

  test("no planned entry is CREATE or DELETE", () => {
    for (const e of planSweep(routes, new Set())) {
      assert.ok(ALLOWED_VERBS.has(e.verb), `illegal verb planned: ${e.verb}`);
    }
  });
});
