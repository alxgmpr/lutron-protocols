#!/usr/bin/env npx tsx
/**
 * Second-pass probe: re-test 400/404 routes with smarter segmentation variants.
 * For each failed ident, generate alternative paths by splitting at every
 * CamelCase boundary (lowercase-joined).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { defaultHost } from "../lib/config";
import { hrefId, LeapConnection } from "../lib/leap-client";

type Route = {
  ident: string;
  path: string;
  verbs: string[];
  responseType: string | null;
};

const host = (() => {
  const i = process.argv.indexOf("--host");
  return i >= 0 ? process.argv[i + 1] : defaultHost;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Given an ident like "AreaLoadShedding", produce candidate paths by varying
 * how to split CamelCase words into segments.
 *
 * Rules:
 *  - ID/XID markers always split as /{id}
 *  - For each contiguous CamelCase run, yield both the joined-lowercase form
 *    and every possible single-split position
 */
function pathVariants(ident: string): string[] {
  const chunks: { type: "WORD" | "ID" | "XID"; val: string }[] = [];
  let cur = "";
  let i = 0;
  while (i < ident.length) {
    if (
      ident.slice(i, i + 3) === "XID" &&
      (i + 3 === ident.length || /[A-Z]/.test(ident[i + 3]))
    ) {
      if (cur) chunks.push({ type: "WORD", val: cur });
      chunks.push({ type: "XID", val: "{xid}" });
      cur = "";
      i += 3;
    } else if (
      ident.slice(i, i + 2) === "ID" &&
      (i + 2 === ident.length || /[A-Z]/.test(ident[i + 2]))
    ) {
      if (cur) chunks.push({ type: "WORD", val: cur });
      chunks.push({ type: "ID", val: "{id}" });
      cur = "";
      i += 2;
    } else {
      cur += ident[i];
      i += 1;
    }
  }
  if (cur) chunks.push({ type: "WORD", val: cur });

  // For each WORD, find CamelCase word boundaries
  function camelSplits(s: string): string[][] {
    // Boundaries: between lowercase->uppercase transitions
    const words: string[] = [];
    let cur2 = "";
    for (const c of s) {
      if (/[A-Z]/.test(c) && cur2) {
        words.push(cur2);
        cur2 = c;
      } else {
        cur2 += c;
      }
    }
    if (cur2) words.push(cur2);
    const n = words.length;
    if (n <= 1) return [words.map((w) => w.toLowerCase())];
    // Try split at every possible position (including fully joined, fully split, and all intermediate)
    const variants: string[][] = [];
    const joined = words.map((w) => w.toLowerCase()).join("");
    variants.push([joined]);
    // Full split
    variants.push(words.map((w) => w.toLowerCase()));
    // All single splits
    for (let k = 1; k < n; k++) {
      const left = words.slice(0, k).join("").toLowerCase();
      const right = words.slice(k).join("").toLowerCase();
      variants.push([left, right]);
    }
    return variants;
  }

  // Cartesian product of chunk variants
  let paths: string[][] = [[]];
  for (const c of chunks) {
    if (c.type !== "WORD") {
      paths = paths.map((p) => [...p, c.val]);
    } else {
      const splits = camelSplits(c.val);
      const next: string[][] = [];
      for (const p of paths) for (const s of splits) next.push([...p, ...s]);
      paths = next;
    }
  }
  // Dedupe
  const set = new Set(paths.map((p) => "/" + p.join("/")));
  return [...set];
}

async function main() {
  const routes: Route[] = JSON.parse(
    readFileSync("data/firmware-re/leap-routes.json", "utf8"),
  );
  const priorResults = JSON.parse(
    readFileSync("data/firmware-re/leap-probe-results.json", "utf8"),
  );
  const priorOK = new Set(
    priorResults.filter((r: any) => r.code === "200").map((r: any) => r.path),
  );
  const prior400or404 = priorResults.filter((r: any) =>
    ["400", "404"].includes(r.code),
  );

  const leap = new LeapConnection({ host });
  await leap.connect();

  const probeIds: Record<string, { id: number; xid?: string }> = {};
  const [zonesBody, areasBody, devicesBody, linksBody] = await Promise.all([
    leap.readBody("/zone"),
    leap.readBody("/area"),
    leap.readBody("/device"),
    leap.readBody("/link"),
  ]);
  const firstOf = (body: any, field: string) => {
    const items = body?.[field] ?? [];
    return items.length
      ? { id: hrefId(items[0].href), xid: items[0].XID }
      : null;
  };
  probeIds.zone = firstOf(zonesBody, "Zones") || { id: 1 };
  probeIds.area = firstOf(areasBody, "Areas") || { id: 1 };
  probeIds.device = firstOf(devicesBody, "Devices") || { id: 1 };
  probeIds.link = firstOf(linksBody, "Links") || { id: 1 };
  console.log(
    `Probe IDs: zone=${probeIds.zone.id} area=${probeIds.area.id} device=${probeIds.device.id} link=${probeIds.link.id}`,
  );

  const fill = (p: string): string => {
    const segs = p.split("/").filter(Boolean);
    const rootId = probeIds[segs[0]] ?? probeIds.zone;
    return p
      .replace("{id}", String(rootId.id))
      .replace("{xid}", rootId.xid ?? String(rootId.id));
  };

  // Build candidate set: for each 400/404 route, try all path variants
  const candidates = new Set<string>();
  const routeByIdent: Record<string, Route> = {};
  for (const r of routes) routeByIdent[r.ident] = r;

  for (const bad of prior400or404) {
    const route = routes.find((r) => r.path === bad.path);
    if (!route) continue;
    const variants = pathVariants(route.ident);
    for (const v of variants) {
      if (v === bad.path) continue; // already tried
      if (priorOK.has(v)) continue; // already confirmed
      candidates.add(v);
    }
  }

  console.log(`Candidate alt paths to probe: ${candidates.size}`);

  const newFinds: any[] = [];
  let i = 0;
  for (const path of candidates) {
    i++;
    const concrete = fill(path);
    try {
      const resp = await leap.send("ReadRequest", concrete, undefined, 5000);
      const code = (resp?.Header?.StatusCode ?? "").split(" ")[0];
      if (code === "200" || code === "204") {
        const body = resp?.Body;
        const keys = body ? Object.keys(body) : [];
        const arrField = keys.find((k) => Array.isArray(body[k]));
        newFinds.push({
          path,
          concrete,
          code,
          msgType: resp?.Header?.MessageBodyType,
          bodyKeys: keys,
          arrayField: arrField,
          arrayLen: arrField ? body[arrField].length : undefined,
        });
        console.log(`  ✓ ${code} ${path}  (was tried as different split)`);
      }
    } catch {}
    if (i % 50 === 0)
      console.log(`  ${i}/${candidates.size}  found=${newFinds.length}`);
    await sleep(15);
  }

  writeFileSync(
    "data/firmware-re/leap-probe-v2-finds.json",
    JSON.stringify(newFinds, null, 2),
  );
  console.log(`\nNew paths found: ${newFinds.length}`);
  console.log("Wrote data/firmware-re/leap-probe-v2-finds.json");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
