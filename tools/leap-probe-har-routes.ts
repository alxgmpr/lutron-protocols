#!/usr/bin/env bun
/**
 * LEAP HAR Route Probe — test new routes discovered from HAR file capture
 *
 * Tests read-only endpoints on both Caseta (10.0.0.2) and RA3 (10.0.0.1):
 *   1. /firmwareupdatesession — firmware update session status
 *   2. /operation/status — operation status
 *   3. /server/status/ping — should return LEAPVersion
 *   4. /link/1/associatedlinknode/expanded — link nodes with full device/firmware details
 *   5. /link/236/associatedlinknode/expanded — RA3 link
 *   6. /link/237/associatedlinknode/expanded — RA3 CCX link
 */

import { LeapConnection } from "./leap-client";

async function readRaw(conn: LeapConnection, url: string): Promise<any> {
  try {
    const resp = await conn.read(url);
    return resp;
  } catch (e: any) {
    return { Header: { StatusCode: e.message }, Body: null };
  }
}

function dump(label: string, data: any) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(70)}`);
  console.log(JSON.stringify(data, null, 2));
}

interface RouteTest {
  url: string;
  description: string;
  /** Which processors to test on: "both", "caseta", "ra3" */
  target: "both" | "caseta" | "ra3";
}

const routes: RouteTest[] = [
  {
    url: "/firmwareupdatesession",
    description: "Firmware update session status",
    target: "both",
  },
  {
    url: "/operation/status",
    description: "Operation status",
    target: "both",
  },
  {
    url: "/server/status/ping",
    description: "Server ping (should return LEAPVersion)",
    target: "both",
  },
  {
    url: "/link/1/associatedlinknode/expanded",
    description: "Caseta link 1 — all link nodes with full device/firmware details",
    target: "caseta",
  },
  {
    url: "/link/236/associatedlinknode/expanded",
    description: "RA3 RF link 236 — all link nodes expanded",
    target: "ra3",
  },
  {
    url: "/link/237/associatedlinknode/expanded",
    description: "RA3 CCX link 237 — all link nodes expanded",
    target: "ra3",
  },
];

async function probeProcessor(
  name: string,
  conn: LeapConnection,
  filter: "caseta" | "ra3" | "both",
) {
  const applicable = routes.filter(
    (r) => r.target === "both" || r.target === filter,
  );

  for (const route of applicable) {
    const resp = await readRaw(conn, route.url);
    const status = resp.Header?.StatusCode ?? "unknown";
    dump(
      `[${name}] ${route.url} — ${route.description} (${status})`,
      resp.Body,
    );
  }
}

async function main() {
  // ===== CASETA =====
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  CASETA (10.0.0.2)                                                 ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  const caseta = new LeapConnection({ host: "10.0.0.2", certName: "caseta" });
  await caseta.connect();
  console.log("Connected to Caseta.");

  await probeProcessor("Caseta", caseta, "caseta");

  caseta.close();
  console.log("\nCaseta connection closed.\n");

  // ===== RA3 =====
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  RA3 (10.0.0.1)                                                  ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  const ra3 = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });
  await ra3.connect();
  console.log("Connected to RA3.");

  await probeProcessor("RA3", ra3, "ra3");

  ra3.close();
  console.log("\nRA3 connection closed.");

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
