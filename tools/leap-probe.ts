#!/usr/bin/env bun
/**
 * LEAP Route Probe — test all known read-only LEAP endpoints
 * Usage: bun run tools/leap-probe.ts [--host <ip>] [--cert <name>]
 *        bun run tools/leap-probe.ts --both   (probe RA3 + Caseta)
 */

import { LeapConnection } from "./leap-client";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    host: { type: "string" },
    cert: { type: "string" },
    both: { type: "boolean", default: false },
    verbose: { type: "boolean", short: "v", default: false },
  },
});

// All known read-only routes from docs/leap-routes.md
const ROUTES = [
  // Core resources
  "/server",
  "/system",
  "/project",
  "/link",

  // Zones
  "/zone",
  "/zone/status",
  "/zone/status/expanded",

  // Devices
  "/device",
  "/device/status",
  "/device/commandprocessor",

  // Areas
  "/area",
  "/area/summary",

  // Control stations
  "/controlstation",

  // Buttons
  "/button",
  "/buttongroup",
  "/buttongroup/expanded",

  // Presets / Scenes
  "/areascene",
  "/areasceneassignment",
  "/presetassignment",
  "/virtualbutton",

  // Links
  "/link",

  // Occupancy
  "/occupancygroup",
  "/occupancygroup/status",

  // Time clock
  "/timeclock",
  "/timeclock/status",
  "/timeclockevent",

  // System
  "/system/action",
  "/system/away",
  "/system/loadshedding/status",
  "/system/naturallightoptimization",
  "/system/status/daynightstate",

  // Project extras
  "/project/contactinfo",
  "/project/masterdevicelist/devices",

  // Other
  "/service",
  "/household",
  "/favorite",
  "/associatedalias",
  "/homekitdata",
  "/facade",
  "/fadefighterproperties/programmingmodel/preset",

  // Provisioning (probably locked down)
  "/certificate/root",
  "/system/status/crosssign",
];

interface ProbeResult {
  route: string;
  status: string;
  bodyKeys: string[];
  snippet: string;
}

async function probeHost(host: string, certName: string): Promise<ProbeResult[]> {
  const conn = new LeapConnection({ host, certName });
  await conn.connect();
  console.log(`\nConnected to ${host} (cert: ${certName})\n`);

  const results: ProbeResult[] = [];

  for (const route of ROUTES) {
    try {
      const resp = await conn.read(route);
      const status = resp.Header?.StatusCode ?? "???";
      const bodyKeys = resp.Body ? Object.keys(resp.Body) : [];
      let snippet = "";

      if (resp.Body) {
        const json = JSON.stringify(resp.Body);
        snippet = json.length > 120 ? json.slice(0, 120) + "..." : json;
      }

      results.push({ route, status, bodyKeys, snippet });
    } catch (e: any) {
      results.push({
        route,
        status: e.message?.includes("Timeout") ? "TIMEOUT" : `ERROR: ${e.message}`,
        bodyKeys: [],
        snippet: "",
      });
    }
  }

  conn.close();
  return results;
}

function printResults(host: string, results: ProbeResult[], verbose: boolean) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Results for ${host}`);
  console.log(`${"=".repeat(70)}`);

  // Group by status
  const ok = results.filter((r) => r.status.startsWith("200"));
  const notFound = results.filter((r) => r.status.startsWith("404"));
  const notAllowed = results.filter((r) => r.status.startsWith("405"));
  const noContent = results.filter((r) => r.status.startsWith("204"));
  const other = results.filter(
    (r) =>
      !r.status.startsWith("200") &&
      !r.status.startsWith("404") &&
      !r.status.startsWith("405") &&
      !r.status.startsWith("204"),
  );

  console.log(`\n  200 OK: ${ok.length} routes`);
  for (const r of ok) {
    console.log(`    ${r.route.padEnd(50)} keys: [${r.bodyKeys.join(", ")}]`);
    if (verbose && r.snippet) {
      console.log(`      ${r.snippet}`);
    }
  }

  if (noContent.length) {
    console.log(`\n  204 No Content: ${noContent.length} routes`);
    for (const r of noContent) console.log(`    ${r.route}`);
  }

  if (notAllowed.length) {
    console.log(`\n  405 Not Allowed: ${notAllowed.length} routes`);
    for (const r of notAllowed) console.log(`    ${r.route}`);
  }

  if (notFound.length) {
    console.log(`\n  404 Not Found: ${notFound.length} routes`);
    for (const r of notFound) console.log(`    ${r.route}`);
  }

  if (other.length) {
    console.log(`\n  Other: ${other.length} routes`);
    for (const r of other) console.log(`    ${r.route.padEnd(50)} ${r.status}`);
  }
}

async function main() {
  const verbose = values.verbose ?? false;

  if (values.both) {
    // Probe both processors
    const configs = [
      { host: "10.0.0.1", cert: "ra3" },
      { host: "10.0.0.2", cert: "caseta" },
    ];

    for (const cfg of configs) {
      try {
        const results = await probeHost(cfg.host, cfg.cert);
        printResults(cfg.host, results, verbose);
      } catch (e: any) {
        console.error(`Failed to connect to ${cfg.host}: ${e.message}`);
      }
    }
  } else {
    const host = values.host ?? "10.0.0.1";
    const cert = values.cert ?? "ra3";
    const results = await probeHost(host, cert);
    printResults(host, results, verbose);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
