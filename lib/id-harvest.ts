import { isJsonObject, isString, type JsonValue } from "./data-values";

/** Resource segment (`"zone"`) to the concrete ids observed for it. */
export type IdIndex = Map<string, Set<string>>;

const HREF_SEGMENT = /\/([a-z]+)\/(\d+)/g;

/**
 * Walk a response body and collect every `/resource/<digits>` pair appearing in
 * an `href`. Ids discovered here are what make the parameterised routes
 * probe-able — the firmware gives the template, the wire gives the ids.
 */
export function harvestIds(
  body: JsonValue | undefined,
  into: IdIndex = new Map(),
): IdIndex {
  const visit = (node: JsonValue): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (isJsonObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (key === "href" && isString(value)) {
          for (const m of value.matchAll(HREF_SEGMENT)) {
            const set = into.get(m[1]) ?? new Set<string>();
            set.add(m[2]);
            into.set(m[1], set);
          }
        } else {
          visit(value);
        }
      }
    }
  };
  if (body !== undefined) visit(body);
  return into;
}

/**
 * Substitute harvested ids into a firmware path template.
 *
 * Each `{id}` is filled from the ids seen for the segment preceding it, which
 * is the same ownership rule the spec's path disambiguation uses. Multiple
 * placeholders expand as a cross product, capped at `limit` so a template with
 * two well-populated resources cannot explode the sweep.
 */
export function expandTemplate(
  template: string,
  index: IdIndex,
  limit: number,
): string[] {
  const segments = template.split("/");
  let results = [""];

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (!/^\{\w+\}$/.test(seg)) {
      results = results.map((r) => `${r}/${seg}`);
      continue;
    }
    const owner = segments[i - 1];
    const ids = [...(index.get(owner) ?? [])];
    if (ids.length === 0) return [];
    const next: string[] = [];
    for (const r of results) {
      for (const id of ids) {
        if (next.length >= limit) break;
        next.push(`${r}/${id}`);
      }
    }
    results = next;
  }

  return results.slice(0, limit);
}
