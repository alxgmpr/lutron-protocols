import { ALLOWED_VERBS } from "./route-plan";

export type EchoVerdict = { moved: false } | { moved: true; reason: string };

/**
 * The shape JSON.parse can actually produce. checkEcho takes this rather than
 * `unknown` so the exotic-object problem below is structural, not assumed:
 * a Date/Map/Set/class instance is simply not a JsonValue.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

/**
 * Throw unless the verb is one this harness is permitted to issue.
 *
 * Called immediately before every request the runner sends, so an illegal verb
 * cannot reach the socket even if a planning bug produced one.
 */
export function assertVerbAllowed(verb: string): void {
  if (!ALLOWED_VERBS.has(verb)) {
    throw new Error(
      `Refusing to issue ${verb || "(empty)"}: only ${[...ALLOWED_VERBS].join(", ")} are permitted`,
    );
  }
}

/**
 * Compare two reads of the same URL, taken either side of an echo write.
 *
 * Any difference means the echo assumption is wrong for that route, and the
 * runner aborts the whole write phase rather than continuing. Key order is
 * ignored because JSON object key order carries no meaning; array order is
 * significant because it does.
 *
 * Governing rule when the comparison itself is uncertain (an exotic input, a
 * cycle): report movement, not "not moved". A false "moved" costs an
 * investigation; a false "not moved" lets a real change on live equipment
 * pass unnoticed.
 *
 * Known limitations, both accepted rather than worked around:
 * - Integers beyond Number.MAX_SAFE_INTEGER (2^53) collide after JSON.parse,
 *   since two different wire integers can parse to the same double. A
 *   differing integer above that threshold would not be detected here;
 *   catching it would mean comparing raw response text instead of parsed
 *   JSON, which is out of scope for this module.
 * - `0` and `-0` compare equal. Unreachable via JSON.parse in practice —
 *   `JSON.stringify(-0)` is `"0"` — so a JSON round trip can never hand this
 *   function a `-0`.
 */
export function checkEcho(before: JsonValue, after: JsonValue): EchoVerdict {
  const reason = firstDifference(
    before,
    after,
    "",
    new WeakSet(),
    new WeakSet(),
  );
  return reason === null ? { moved: false } : { moved: true, reason };
}

function isObjectLike(
  v: JsonValue,
): v is JsonValue[] | { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null;
}

function isBoolean(v: JsonValue): v is boolean {
  return typeof v === "boolean";
}

function isNumber(v: JsonValue): v is number {
  return typeof v === "number";
}

function jsonKind(v: JsonValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (isObjectLike(v)) return "object";
  if (isBoolean(v)) return "boolean";
  if (isNumber(v)) return "number";
  return "string";
}

/**
 * True for the only object shapes JSON.parse ever produces: an object literal
 * (prototype === Object.prototype) or one built with Object.create(null).
 * A Date, Map, Set, or any class instance has some other prototype and
 * cannot be safely walked with Object.keys — it may look empty while
 * genuinely differing (a Date's value lives in an internal slot, a Map/Set's
 * entries aren't own enumerable properties at all).
 */
function isPlainObject(v: JsonValue[] | JsonObject): v is JsonObject {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function describeType(v: JsonValue[] | JsonObject): string {
  const proto = Object.getPrototypeOf(v);
  return proto?.constructor?.name || "object";
}

/**
 * Own property names on an array beyond `length` and its numeric indices.
 * Every array carries `length` as an own property, so it — and each index
 * already covered by the element-by-element walk — must be excluded, or
 * every ordinary array would be flagged as differing.
 */
function extraArrayPropertyNames(arr: JsonValue[]): string[] {
  const indexNames = new Set(arr.map((_, i) => String(i)));
  return Object.getOwnPropertyNames(arr).filter(
    (name) => name !== "length" && !indexNames.has(name),
  );
}

function ownJsonValue(value: JsonValue[] | JsonObject, key: string): JsonValue {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) throw new Error(`missing own property ${key}`);
  if ("value" in descriptor) return descriptor.value;
  return descriptor.get ? descriptor.get.call(value) : null;
}

/** Bracket-quote a key containing a literal dot so it can't be confused with nesting. */
function joinPath(path: string, key: string): string {
  const segment = key.includes(".") ? `["${key}"]` : key;
  if (!path) return segment;
  return key.includes(".") ? `${path}${segment}` : `${path}.${segment}`;
}

function firstDifference(
  a: JsonValue,
  b: JsonValue,
  path: string,
  ancestorsA: WeakSet<object>,
  ancestorsB: WeakSet<object>,
): string | null {
  const here = path || "(root)";

  // Cycle check first: a value we're already in the middle of walking, on
  // either side, means the walk can never terminate on its own. Report
  // movement rather than recursing into a stack overflow or silently
  // skipping the node.
  if (isObjectLike(a) && ancestorsA.has(a)) {
    return `circular reference at ${here}`;
  }
  if (isObjectLike(b) && ancestorsB.has(b)) {
    return `circular reference at ${here}`;
  }

  if (a === b) return null;

  if (a === null || b === null || a === undefined || b === undefined) {
    return `${here}: ${describe(a)} became ${describe(b)}`;
  }

  if (jsonKind(a) !== jsonKind(b)) {
    return `${here}: type changed from ${jsonKind(a)} to ${jsonKind(b)}`;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return `${here}: array/non-array mismatch`;
    }
    if (a.length !== b.length) {
      return `${here}: length ${a.length} became ${b.length}`;
    }
    ancestorsA.add(a);
    ancestorsB.add(b);
    try {
      for (let i = 0; i < a.length; i++) {
        const d = firstDifference(
          a[i],
          b[i],
          `${path}[${i}]`,
          ancestorsA,
          ancestorsB,
        );
        if (d) return d;
      }

      // Indices and length only cover an array's numeric own properties. An
      // array can also carry extra named own properties invisible to that
      // walk (e.g. attached via Object.defineProperty) — the array analog
      // of the getOwnPropertyNames fix in the object branch below. Real
      // JSON.parse output never has these, so this is a no-op for genuine
      // wire data.
      const extraA = extraArrayPropertyNames(a).sort();
      const extraB = extraArrayPropertyNames(b).sort();
      for (const k of new Set([...extraA, ...extraB])) {
        const inA = extraA.includes(k);
        const inB = extraB.includes(k);
        const childPath = joinPath(path, k);
        if (!inA) return `${childPath}: appeared`;
        if (!inB) return `${childPath}: disappeared`;
        const d = firstDifference(
          ownJsonValue(a, k),
          ownJsonValue(b, k),
          childPath,
          ancestorsA,
          ancestorsB,
        );
        if (d) return d;
      }

      return null;
    } finally {
      ancestorsA.delete(a);
      ancestorsB.delete(b);
    }
  }

  if (isObjectLike(a) && isObjectLike(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) {
      const culprit = !isPlainObject(a) ? a : b;
      return `${here}: ${describeType(culprit)} is not a plain JSON object — refusing to compare, reporting movement`;
    }

    ancestorsA.add(a);
    ancestorsB.add(b);
    try {
      // getOwnPropertyNames rather than keys: real JSON.parse output never
      // has non-enumerable properties, so this is a no-op for genuine wire
      // data, but it also catches a same-typed object with a non-enumerable
      // property attached out-of-band (e.g. via Object.defineProperty),
      // which `keys` would silently skip.
      const ka = Object.getOwnPropertyNames(a).sort();
      const kb = Object.getOwnPropertyNames(b).sort();
      for (const k of new Set([...ka, ...kb])) {
        const inA = ka.includes(k);
        const inB = kb.includes(k);
        const childPath = joinPath(path, k);
        if (!inA) return `${childPath}: appeared`;
        if (!inB) return `${childPath}: disappeared`;
        const d = firstDifference(
          a[k],
          b[k],
          childPath,
          ancestorsA,
          ancestorsB,
        );
        if (d) return d;
      }
      return null;
    } finally {
      ancestorsA.delete(a);
      ancestorsB.delete(b);
    }
  }

  return `${here}: ${describe(a)} became ${describe(b)}`;
}

function describe(v: JsonValue): string {
  if (v === null) return "null";
  return JSON.stringify(v);
}
