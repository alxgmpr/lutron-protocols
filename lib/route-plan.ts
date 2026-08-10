/** A route as recorded in the firmware extraction. */
export type Route = {
  ident: string;
  path: string;
  verbs: string[];
  handlers: Record<string, string>;
  responseType?: string;
};

export type Phase = "discovery" | "read" | "subscribe" | "echo-write";

export type PlanEntry = {
  phase: Phase;
  ident: string;
  /** Firmware path template, e.g. `/zone/{id}/status`. */
  template: string;
  verb: "GET" | "SUBSCRIBE" | "UPDATE";
  needsId: boolean;
};

/**
 * The only verbs this harness may ever issue.
 *
 * An allow-list, deliberately. A deny-list of forbidden verbs would let a new
 * or renamed verb through by default; this cannot. CREATE is excluded because
 * it cannot be echoed and cannot be undone without DELETE, which is excluded
 * because the target is a live production system.
 */
export const ALLOWED_VERBS: ReadonlySet<string> = new Set([
  "GET",
  "SUBSCRIBE",
  "UPDATE",
]);

const OPERATION_PREFIXES = ["get", "post", "put", "delete"];

/**
 * Recover route idents from a published spec's operationIds.
 *
 * `route-to-path.ts` in leap-openapi builds them as `${verb}${ident}`, so
 * stripping a known lowercase prefix recovers the ident. Matching on ident
 * rather than path avoids coupling to that repo's parameter-renaming rules.
 */
export function coveredIdentsFromOperationIds(
  operationIds: string[],
): Set<string> {
  const out = new Set<string>();
  for (const id of operationIds) {
    const prefix = OPERATION_PREFIXES.find(
      (p) => id.startsWith(p) && id.length > p.length,
    );
    if (prefix) out.add(id.slice(prefix.length));
  }
  return out;
}

export function planSweep(
  routes: Route[],
  coveredIdents: Set<string>,
): PlanEntry[] {
  const out: PlanEntry[] = [];

  for (const route of routes) {
    if (coveredIdents.has(route.ident)) continue;

    const needsId = route.path.includes("{");
    const hasGet = route.verbs.includes("GET");
    const base = { ident: route.ident, template: route.path, needsId };

    if (hasGet) {
      out.push({
        ...base,
        phase: needsId ? "read" : "discovery",
        verb: "GET",
      });
    }

    if (route.verbs.includes("SUBSCRIBE")) {
      out.push({ ...base, phase: "subscribe", verb: "SUBSCRIBE" });
    }

    // Echo-back needs a prior value, so UPDATE without GET is unreachable.
    if (route.verbs.includes("UPDATE") && hasGet) {
      out.push({ ...base, phase: "echo-write", verb: "UPDATE" });
    }
  }

  return out;
}
