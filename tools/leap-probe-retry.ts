#!/usr/bin/env npx tsx
/**
 * Re-probe all routes, capturing actual status codes.
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

async function main() {
  const routes: Route[] = JSON.parse(
    readFileSync("data/firmware-re/leap-routes.json", "utf8"),
  );

  const leap = new LeapConnection({ host });
  await leap.connect();
  console.log(`Connected to ${host}`);

  // Fetch real IDs
  const probeIds: Record<string, { id: number; xid?: string }> = {};
  const bodies = await Promise.all([
    leap.readBody("/zone"),
    leap.readBody("/area"),
    leap.readBody("/device"),
    leap.readBody("/button"),
    leap.readBody("/link"),
  ]);
  const [zonesBody, areasBody, devicesBody, buttonsBody, linksBody] = bodies;
  const firstOf = (body: any, field: string) => {
    const items = body?.[field] ?? [];
    if (!items.length) return null;
    const it = items[0];
    return { id: hrefId(it.href), xid: it.XID };
  };
  probeIds["zone"] = firstOf(zonesBody, "Zones") || { id: 1 };
  probeIds["area"] = firstOf(areasBody, "Areas") || { id: 1 };
  probeIds["device"] = firstOf(devicesBody, "Devices") || { id: 1 };
  probeIds["button"] = firstOf(buttonsBody, "Buttons") || { id: 1 };
  probeIds["link"] = firstOf(linksBody, "Links") || { id: 1 };

  console.log(
    `Probe IDs: zone=${probeIds.zone.id} area=${probeIds.area.id} device=${probeIds.device.id} button=${probeIds.button.id} link=${probeIds.link.id}`,
  );

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

  function fillPath(p: string): string | null {
    const segs = p.split("/").filter(Boolean);
    const rootId = probeIds[segs[0]] ?? probeIds["zone"];
    return p
      .replace("{id}", String(rootId.id))
      .replace("{xid}", rootId.xid ?? String(rootId.id));
  }

  const results: any[] = [];

  for (let i = 0; i < getRoutes.length; i++) {
    const r = getRoutes[i];
    const concrete = fillPath(r.path)!;
    try {
      const resp = await leap.send("ReadRequest", concrete, undefined, 8000);
      const status = resp?.Header?.StatusCode ?? "";
      const code = status.split(" ")[0];
      const body = resp?.Body;
      const keys = body ? Object.keys(body) : [];
      const arrField = keys.find((k) => Array.isArray(body[k]));
      results.push({
        path: r.path,
        concrete,
        verbs: r.verbs,
        code,
        statusText: status,
        responseType: r.responseType,
        bodyKeys: keys,
        arrayField: arrField,
        arrayLen: arrField ? body[arrField].length : undefined,
        msgType: resp?.Header?.MessageBodyType,
      });
    } catch (_e) {
      results.push({
        path: r.path,
        concrete,
        verbs: r.verbs,
        code: "TIMEOUT",
        responseType: r.responseType,
      });
    }
    if ((i + 1) % 30 === 0) {
      const bycode: Record<string, number> = {};
      for (const res of results) bycode[res.code] = (bycode[res.code] ?? 0) + 1;
      console.log(
        `  ${i + 1}/${getRoutes.length}  ${Object.entries(bycode)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      );
    }
    await sleep(20);
  }

  writeFileSync(
    "data/firmware-re/leap-probe-results.json",
    JSON.stringify(results, null, 2),
  );
  console.log();

  // Summarize by status code
  const bycode: Record<string, number> = {};
  for (const r of results) bycode[r.code] = (bycode[r.code] ?? 0) + 1;
  console.log(`=== Final status codes ===`);
  for (const [k, v] of Object.entries(bycode).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
