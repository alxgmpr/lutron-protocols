/**
 * Probe firmware update session endpoints on Caseta and RA3 processors.
 * Read-only — only issues ReadRequest, never creates or updates anything.
 */

import { LeapConnection } from "./leap-client";

async function probeEndpoint(conn: LeapConnection, url: string): Promise<void> {
  try {
    const resp = await conn.read(url);
    const status = resp.Header?.StatusCode ?? "(no status)";
    const body = resp.Body;
    if (status.startsWith("200") && body && Object.keys(body).length > 0) {
      console.log(`  ${url} — ${status}`);
      console.log(JSON.stringify(body, null, 2));
    } else {
      console.log(`  ${url} — ${status}`);
    }
  } catch (err: any) {
    console.log(`  ${url} — ERROR: ${err.message}`);
  }
}

async function main() {
  // --- Caseta ---
  console.log("=== CASETA (10.0.0.2) ===\n");
  const caseta = new LeapConnection({ host: "10.0.0.2", certName: "caseta" });
  await caseta.connect();
  console.log("Connected to Caseta\n");

  const casetaEndpoints = [
    "/firmwareupdatesession",
    "/firmwareupdate",
    "/firmwareupdate/status",
    "/device/1/firmwareupdate",
    "/firmwareimage",
    "/firmwareimage/1",
    "/firmwareimage/15",
    "/firmwareimage/15/status",
    "/operation",
    "/operation/status",
    "/device/15/firmwareimage",
    "/device/15/firmwareupdate",
  ];

  for (const ep of casetaEndpoints) {
    await probeEndpoint(caseta, ep);
  }

  caseta.close();
  console.log("\nCaseta done.\n");

  // --- RA3 ---
  console.log("=== RA3 (10.0.0.1) ===\n");
  const ra3 = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });
  await ra3.connect();
  console.log("Connected to RA3\n");

  const ra3Endpoints = [
    "/firmwareupdatesession",
    "/firmwareupdatesession/expanded",
    "/operation/status",
    "/fwsessiondevice",
  ];

  for (const ep of ra3Endpoints) {
    await probeEndpoint(ra3, ep);
  }

  // RA3 devices from completed session
  const ra3Devices = [2399, 2351, 2422, 3131, 2306];
  console.log("\n  --- RA3 device Name + FirmwareImage ---");
  for (const devId of ra3Devices) {
    try {
      const resp = await ra3.read(`/device/${devId}`);
      const status = resp.Header?.StatusCode ?? "(no status)";
      const dev = resp.Body?.Device;
      if (status.startsWith("200") && dev) {
        console.log(`  /device/${devId} — ${status}`);
        console.log(`    Name: ${dev.Name ?? "(none)"}`);
        console.log(`    FirmwareImage: ${JSON.stringify(dev.FirmwareImage ?? null)}`);
      } else {
        console.log(`  /device/${devId} — ${status}`);
      }
    } catch (err: any) {
      console.log(`  /device/${devId} — ERROR: ${err.message}`);
    }
  }

  console.log("\n  --- RA3 firmware images ---");
  await probeEndpoint(ra3, "/firmwareimage/1993");
  await probeEndpoint(ra3, "/firmwareimage/1945");

  ra3.close();
  console.log("\nRA3 done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
