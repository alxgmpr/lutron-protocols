#!/usr/bin/env npx tsx
/**
 * Probe the LEAP server for endpoints discovered in multi-server-phoenix.gobin.
 *
 * Reads data/firmware-re/leap-routes.json, substitutes {id}/{xid} with real
 * values fetched from the processor, and records which GET routes respond
 * with 200 vs 404/405. Writes a validated-routes report.
 *
 * Usage:
 *   npx tsx tools/leap-probe-new-routes.ts [--host 10.1.1.133]
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

async function main() {
  const routes: Route[] = JSON.parse(
    readFileSync("data/firmware-re/leap-routes.json", "utf8"),
  );

  const leap = new LeapConnection({ host });
  await leap.connect();
  console.log(`Connected to ${host}`);

  // Fetch real IDs for substitution
  const probeIds: Record<string, { id: number; xid?: string }> = {};
  const [zonesBody, areasBody, devicesBody, buttonsBody, linksBody] =
    await Promise.all([
      leap.readBody("/zone"),
      leap.readBody("/area"),
      leap.readBody("/device"),
      leap.readBody("/button"),
      leap.readBody("/link"),
    ]);

  const firstOf = (body: any, field: string) => {
    const items = body?.[field] ?? [];
    if (!items.length) return null;
    const it = items[0];
    return { id: hrefId(it.href), xid: it.XID ?? it.AssociatedXID };
  };

  probeIds["zone"] = firstOf(zonesBody, "Zones") || { id: 1 };
  probeIds["area"] = firstOf(areasBody, "Areas") || { id: 1 };
  probeIds["device"] = firstOf(devicesBody, "Devices") || { id: 1 };
  probeIds["button"] = firstOf(buttonsBody, "Buttons") || { id: 1 };
  probeIds["link"] = firstOf(linksBody, "Links") || { id: 1 };

  console.log(
    `Probe IDs: zone=${probeIds.zone.id} area=${probeIds.area.id} device=${probeIds.device.id} button=${probeIds.button.id} link=${probeIds.link.id}`,
  );
  console.log(`Zone XID: ${probeIds.zone.xid}, Area XID: ${probeIds.area.xid}`);

  // Substitute {id}/{xid} in a path. Use the id of the first segment (/zone/{id}/... → zone).
  function fillPath(p: string): string | null {
    const segs = p.split("/").filter(Boolean);
    if (segs.length === 0) return null;
    const rootId = probeIds[segs[0]] ?? probeIds["zone"]; // fallback
    return p
      .replace("{id}", String(rootId.id))
      .replace("{xid}", rootId.xid ?? String(rootId.id));
  }

  // Probe only GET routes (safe), skip obviously-bogus paths
  const skip =
    /\/(with|query|explicit|implicit|paging|summaryquery)$|\/with\/|\/query$/;
  const getRoutes = routes.filter(
    (r) =>
      r.verbs.includes("GET") &&
      !skip.test(r.path) &&
      !r.path.includes("?") &&
      r.path.length > 1,
  );
  console.log(`GET routes to probe: ${getRoutes.length}`);

  const results: {
    path: string;
    concrete: string;
    status: "ok" | "404" | "405" | "error" | "empty";
    responseType: string | null;
    bodyKeys?: string[];
    arrayField?: string;
    arrayLen?: number;
  }[] = [];

  let done = 0;
  for (const r of getRoutes) {
    done++;
    const concrete = fillPath(r.path);
    if (!concrete) continue;

    try {
      const resp = await leap.send("ReadRequest", concrete, undefined, 5000);
      const status = resp?.Header?.StatusCode ?? "";
      if (status.startsWith("200")) {
        const body = resp.Body;
        if (!body) {
          results.push({
            path: r.path,
            concrete,
            status: "empty",
            responseType: r.responseType,
          });
        } else {
          const keys = Object.keys(body);
          const arrField = keys.find((k) => Array.isArray(body[k]));
          results.push({
            path: r.path,
            concrete,
            status: "ok",
            responseType: r.responseType,
            bodyKeys: keys,
            arrayField: arrField,
            arrayLen: arrField ? body[arrField].length : undefined,
          });
        }
      } else if (status.startsWith("404")) {
        results.push({
          path: r.path,
          concrete,
          status: "404",
          responseType: r.responseType,
        });
      } else if (status.startsWith("405")) {
        results.push({
          path: r.path,
          concrete,
          status: "405",
          responseType: r.responseType,
        });
      } else {
        results.push({
          path: r.path,
          concrete,
          status: "error",
          responseType: r.responseType,
        });
      }
    } catch (_e) {
      results.push({
        path: r.path,
        concrete,
        status: "error",
        responseType: r.responseType,
      });
    }

    if (done % 25 === 0) {
      const ok = results.filter((r) => r.status === "ok").length;
      console.log(`  ${done}/${getRoutes.length} probed, ${ok} ok so far`);
    }
  }

  writeFileSync(
    "data/firmware-re/leap-probe-results.json",
    JSON.stringify(results, null, 2),
  );

  const ok = results.filter((r) => r.status === "ok");
  const notFound = results.filter((r) => r.status === "404");
  const noMethod = results.filter((r) => r.status === "405");
  console.log();
  console.log(`=== Results ===`);
  console.log(`OK:     ${ok.length}`);
  console.log(`404:    ${notFound.length}`);
  console.log(`405:    ${noMethod.length}`);
  console.log(`error:  ${results.filter((r) => r.status === "error").length}`);
  console.log(`empty:  ${results.filter((r) => r.status === "empty").length}`);
  console.log();
  console.log(`Wrote data/firmware-re/leap-probe-results.json`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
