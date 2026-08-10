import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  assertVerbAllowed,
  checkEcho,
  type JsonValue,
} from "../lib/echo-guard";

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

// Adversarial cases from code review: the runner only ever feeds this
// function JSON.parse output, but the signature previously said `unknown`,
// which invited inputs that broke the "not moved" verdict silently. These
// pin the fixes: a narrowed JsonValue contract, a runtime guard for
// non-plain objects, cycle detection, and path disambiguation for dotted
// keys.
describe("checkEcho — adversarial cases", () => {
  test("detects a difference nested 5 levels deep", () => {
    const before = { a: { b: { c: { d: { e: 1 } } } } };
    const after = { a: { b: { c: { d: { e: 2 } } } } };
    const v = checkEcho(before, after);
    assert.equal(v.moved, true);
    assert.match((v as { reason: string }).reason, /a\.b\.c\.d\.e/);
  });

  test("detects a difference inside an array of objects", () => {
    const v = checkEcho([{ id: 1, level: 10 }], [{ id: 1, level: 20 }]);
    assert.equal(v.moved, true);
    assert.match((v as { reason: string }).reason, /\[0\]\.level/);
  });

  test("a circular reference reports movement instead of throwing", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    const b: Record<string, unknown> = { x: 2 };
    b.self = b;

    const v = checkEcho(a as unknown as JsonValue, b as unknown as JsonValue);
    assert.equal(v.moved, true);
    assert.match((v as { reason: string }).reason, /circular/i);
  });

  test("a non-plain-object input (Date) is reported as movement, not silently accepted", () => {
    const v = checkEcho(
      new Date(2020, 1, 1) as unknown as JsonValue,
      new Date(2021, 1, 1) as unknown as JsonValue,
    );
    assert.equal(v.moved, true);
    assert.match((v as { reason: string }).reason, /Date/);
  });

  test("a key containing a literal dot is disambiguated from a nested path", () => {
    const dotKey = checkEcho({ "a.b": 1 }, { "a.b": 2 });
    const nested = checkEcho({ a: { b: 1 } }, { a: { b: 2 } });

    assert.equal(dotKey.moved, true);
    assert.equal(nested.moved, true);

    const dotReason = (dotKey as { reason: string }).reason;
    const nestedReason = (nested as { reason: string }).reason;

    assert.match(dotReason, /\["a\.b"\]/);
    assert.match(nestedReason, /^a\.b:/);
    assert.notEqual(dotReason, nestedReason);
  });

  test("a differing non-enumerable property is detected, not silently missed", () => {
    // Object.defineProperty<T>(o: T, ...) returns T, so this compiles under
    // strict with no cast — the JsonValue type alone cannot block it. Only
    // getOwnPropertyNames (vs. keys) catches the difference at runtime.
    const a: JsonValue = { visible: 1 };
    const b: JsonValue = { visible: 1 };
    Object.defineProperty(a, "hidden", { value: 1, enumerable: false });
    Object.defineProperty(b, "hidden", { value: 2, enumerable: false });

    const v = checkEcho(a, b);
    assert.equal(v.moved, true);
    assert.match((v as { reason: string }).reason, /hidden/);
  });

  test("a differing named property on an array is detected, not silently missed", () => {
    // Mirrors the object case: Object.defineProperty preserves JsonValue's
    // array branch too, so this also compiles clean under strict with no
    // cast. An in-bounds index is caught by the ordinary element walk
    // regardless of enumerability; only extra named properties beyond
    // length/indices needed a dedicated check.
    const a: JsonValue = [1, 2, 3];
    const b: JsonValue = [1, 2, 3];
    Object.defineProperty(a, "hidden", { value: 1, enumerable: false });
    Object.defineProperty(b, "hidden", { value: 2, enumerable: false });

    const v = checkEcho(a, b);
    assert.equal(v.moved, true);
    assert.match((v as { reason: string }).reason, /hidden/);
  });
});
