/**
 * LEAP RA3 CCX Probe
 *
 * Quick probe of RA3 LEAP endpoints for CCX link and firmware update session details.
 */

import { LeapConnection } from "./leap-client";

async function main() {
  const conn = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });

  console.log("Connecting to RA3 at 10.0.0.1...");
  await conn.connect();
  console.log("Connected.\n");

  const endpoints = [
    "/link/234/associatedlinknode/expanded",
    "/fwsessiondevice/@Proc-232-Op-4",
    "/operation/@Proc-232-Op-4",
    "/operation/@Proc-232-Op-4/status",
  ];

  for (const url of endpoints) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`ENDPOINT: ${url}`);
    console.log("=".repeat(80));

    try {
      const resp = await conn.read(url);
      console.log(JSON.stringify(resp, null, 2));
    } catch (err) {
      console.log(`ERROR: ${err}`);
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  conn.close();
}

main().catch(console.error);
