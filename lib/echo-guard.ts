import { ALLOWED_VERBS } from "./route-plan";

export type EchoVerdict = { moved: false } | { moved: true; reason: string };

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
 */
export function checkEcho(before: unknown, after: unknown): EchoVerdict {
  const reason = firstDifference(before, after, "");
  return reason === null ? { moved: false } : { moved: true, reason };
}

function firstDifference(a: unknown, b: unknown, path: string): string | null {
  const here = path || "(root)";

  if (a === b) return null;

  if (a === null || b === null || a === undefined || b === undefined) {
    return `${here}: ${describe(a)} became ${describe(b)}`;
  }

  if (typeof a !== typeof b) {
    return `${here}: type changed from ${typeof a} to ${typeof b}`;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return `${here}: array/non-array mismatch`;
    }
    if (a.length !== b.length) {
      return `${here}: length ${a.length} became ${b.length}`;
    }
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }

  if (typeof a === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    for (const k of new Set([...ka, ...kb])) {
      const inA = ka.includes(k);
      const inB = kb.includes(k);
      if (!inA) return `${path ? `${path}.` : ""}${k}: appeared`;
      if (!inB) return `${path ? `${path}.` : ""}${k}: disappeared`;
      const d = firstDifference(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k,
      );
      if (d) return d;
    }
    return null;
  }

  return `${here}: ${describe(a)} became ${describe(b)}`;
}

function describe(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  return JSON.stringify(v);
}
