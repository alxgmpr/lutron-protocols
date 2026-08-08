import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { assertVerbAllowed, checkEcho } from "../lib/echo-guard";

describe("assertVerbAllowed", () => {
  test("permits the three allowed verbs", () => {
    for (const v of ["GET", "SUBSCRIBE", "UPDATE"]) {
      assert.doesNotThrow(() => assertVerbAllowed(v));
    }
  });

  test("throws on CREATE and DELETE", () => {
    assert.throws(() => assertVerbAllowed("CREATE"), /CREATE/);
    assert.throws(() => assertVerbAllowed("DELETE"), /DELETE/);
  });

  test("throws on anything unrecognised", () => {
    assert.throws(() => assertVerbAllowed("PATCH"));
    assert.throws(() => assertVerbAllowed(""));
  });

  test("is case-sensitive — lowercase is not an allowed verb", () => {
    assert.throws(() => assertVerbAllowed("get"));
  });
});

describe("checkEcho", () => {
  test("identical bodies have not moved", () => {
    const a = { Level: 100, Name: "x", Nested: { z: [1, 2] } };
    const b = { Level: 100, Name: "x", Nested: { z: [1, 2] } };
    assert.deepEqual(checkEcho(a, b), { moved: false });
  });

  test("a changed scalar is movement", () => {
    const v = checkEcho({ Level: 100 }, { Level: 50 });
    assert.equal(v.moved, true);
    assert.match((v as { reason: string }).reason, /Level/);
  });

  test("an added field is movement", () => {
    const v = checkEcho({ a: 1 }, { a: 1, b: 2 });
    assert.equal(v.moved, true);
  });

  test("a removed field is movement", () => {
    const v = checkEcho({ a: 1, b: 2 }, { a: 1 });
    assert.equal(v.moved, true);
  });

  test("array order matters", () => {
    const v = checkEcho({ a: [1, 2] }, { a: [2, 1] });
    assert.equal(v.moved, true);
  });

  test("array length change is movement", () => {
    const v = checkEcho({ a: [1] }, { a: [1, 2] });
    assert.equal(v.moved, true);
  });

  test("key order is NOT movement", () => {
    assert.deepEqual(checkEcho({ a: 1, b: 2 }, { b: 2, a: 1 }), {
      moved: false,
    });
  });

  test("null and undefined are distinguished", () => {
    assert.equal(checkEcho({ a: null }, { a: undefined }).moved, true);
  });

  test("type change is movement even at the same value", () => {
    assert.equal(checkEcho({ a: 1 }, { a: "1" }).moved, true);
  });

  test("both null is not movement", () => {
    assert.deepEqual(checkEcho(null, null), { moved: false });
  });

  test("the reason names a path into the body, for triage", () => {
    const v = checkEcho(
      { Zone: { Status: { Level: 100 } } },
      { Zone: { Status: { Level: 0 } } },
    );
    assert.match((v as { reason: string }).reason, /Zone\.Status\.Level/);
  });
});
