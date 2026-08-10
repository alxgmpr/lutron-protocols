/**
 * Planning for the coverage-BLIND spec probe.
 *
 * `route-plan.ts`'s `planSweep` skips every route the published spec already
 * documents. That filter is correct for discovery — its job is finding paths
 * the spec does NOT have — but it means the spec's own documented paths are
 * systematically never sent to hardware. The consequence is that a path can
 * sit in the spec, be perfectly serviceable, and still have no 200-OK fixture
 * behind it, because nothing ever asked the processor for it.
 *
 * This module plans the opposite pass: take the spec's path list as the input
 * set, ignore coverage entirely, and probe all of it read-only.
 *
 * Everything here is pure. The I/O lives in `tools/leap/leap-spec-probe.ts`.
 */

import { parse as parseYaml } from "yaml";
import { expandTemplate, type IdIndex } from "./id-harvest";

/** An OpenAPI placeholder segment: `{areaId}`, `{linknodeId}`, `{withId}`. */
const SPEC_PLACEHOLDER = /^\{\w+\}$/;

/**
 * Extract the path list from an OpenAPI document.
 *
 * Returned verbatim, still carrying OpenAPI-style `{areaId}` placeholders —
 * they are the keys the spec is indexed by, and reporting against them later
 * only works if they match the spec exactly. `specPathToTemplate` does the
 * normalisation, separately, so the original is never lost.
 */
export function parseSpecPaths(specYamlText: string): string[] {
  const doc = parseYaml(specYamlText) as { paths?: Record<string, unknown> };
  if (!doc || typeof doc !== "object" || !doc.paths) return [];
  return Object.keys(doc.paths);
}

/**
 * Normalise OpenAPI placeholders to the harness's generic `{id}` form so
 * `expandTemplate` can fill them.
 *
 * `expandTemplate` fills a placeholder from the ids harvested for the segment
 * IMMEDIATELY PRECEDING it — `/device/{id}/linknode/{id}` draws its first
 * placeholder from `device` ids and its second from `linknode` ids. That rule
 * only produces correct URLs if each spec placeholder is in fact owned by the
 * segment before it.
 *
 * Checked against all 210 paths of the published spec: every `{xId}`
 * placeholder is preceded by the segment `x`, with no exceptions
 * (`/device/{deviceId}/linknode/{linknodeId}` → owners `device`, `linknode`;
 * `/link/{linkId}/memberdiscoverysession/{memberdiscoverysessionId}/status` →
 * owners `link`, `memberdiscoverysession`). Replacing each placeholder in
 * place — never reordering or dropping a segment — is what preserves that
 * property, so the substitution below is deliberately positional.
 *
 * The one path where the convention is nominally satisfied but semantically
 * empty is `/service/alexadatasummary/scene/with/{withId}`, whose owner
 * segment is the literal word `with`. No ids are ever harvested for a
 * resource called `with`, so it expands to nothing and is reported as
 * skipped rather than probed with a wrong id.
 */
export function specPathToTemplate(specPath: string): string {
  return specPath
    .split("/")
    .map((seg) => (SPEC_PLACEHOLDER.test(seg) ? "{id}" : seg))
    .join("/");
}

/** Spec paths with no placeholder — the collection endpoints to read first. */
export function collectionPathsFromSpec(specPaths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of specPaths) {
    if (p.includes("{")) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Combine a live id index with a fallback (published-fixture) one, live first.
 *
 * The ordering is the whole point. `expandTemplate` reads ids out of the Set
 * in insertion order and stops at `limit`, so whichever index is inserted
 * first is the one that actually gets probed. A previous run seeded the index
 * from fixtures captured on a DIFFERENT processor and then added live ids on
 * top; with an `ID_LIMIT` of 8 the fixture ids filled every slot and the live
 * ids — the only ones that exist on the processor being probed — were crowded
 * out entirely. The run came back with 16 `404 "This resource does not exist"`
 * results across `/controlstation/*`, `/countdowntimer/*`, `/vbutton/*` and
 * `/firmwareimage/*` that said nothing about those routes and everything
 * about the ids they were handed.
 *
 * So: live ids first, truncated at `limit`; fallback ids appended only into
 * whatever capacity is left, and only if not already present. When live
 * supplies `limit` or more ids for a resource, no fallback id survives.
 */
export function mergeIdIndex(
  live: IdIndex,
  fallback: IdIndex,
  limit: number,
): IdIndex {
  const cap = Math.max(0, limit);
  const merged: IdIndex = new Map();
  const resources = new Set([...live.keys(), ...fallback.keys()]);

  for (const resource of resources) {
    const ids = new Set<string>();
    for (const id of live.get(resource) ?? []) {
      if (ids.size >= cap) break;
      ids.add(id);
    }
    for (const id of fallback.get(resource) ?? []) {
      if (ids.size >= cap) break;
      ids.add(id);
    }
    if (ids.size > 0) merged.set(resource, ids);
  }

  return merged;
}

/** A spec path that could not be turned into any concrete URL. */
export type SkippedTemplate = {
  /** The spec path, verbatim, so it can be looked up in the document. */
  specPath: string;
  /** Its `{id}`-normalised form. */
  template: string;
  /**
   * The first placeholder-owning segment with no harvested ids — the reason
   * nothing could be built.
   */
  missingResource: string;
};

export type SpecProbePlan = {
  /** Concrete, deduplicated URLs to probe, in spec order. */
  urls: string[];
  /** Templates that produced no URL at all. Never silently dropped. */
  skipped: SkippedTemplate[];
};

/**
 * Turn the spec's path list into concrete URLs to probe.
 *
 * Templates with no ids for their owning resource cannot be expanded and are
 * reported in `skipped` rather than omitted. A run that probed 140 of 210
 * paths and printed only the 140 would read as "covered everything"; the 70
 * that were never sent are exactly the gap this whole phase exists to close,
 * so they have to survive into the caller's output.
 */
export function planSpecProbe(
  specPaths: string[],
  idIndex: IdIndex,
  limit: number,
): SpecProbePlan {
  const urls: string[] = [];
  const seen = new Set<string>();
  const skipped: SkippedTemplate[] = [];

  for (const specPath of specPaths) {
    const template = specPathToTemplate(specPath);
    const expanded = expandTemplate(template, idIndex, limit);
    if (expanded.length === 0) {
      skipped.push({
        specPath,
        template,
        missingResource: firstUnfilledOwner(template, idIndex) ?? "(unknown)",
      });
      continue;
    }
    for (const url of expanded) {
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }

  return { urls, skipped };
}

/** The first placeholder owner in `template` with no ids in `idIndex`. */
function firstUnfilledOwner(template: string, idIndex: IdIndex): string | null {
  const segments = template.split("/");
  for (let i = 1; i < segments.length; i++) {
    if (!SPEC_PLACEHOLDER.test(segments[i])) continue;
    const owner = segments[i - 1];
    if ((idIndex.get(owner)?.size ?? 0) === 0) return owner;
  }
  return null;
}
