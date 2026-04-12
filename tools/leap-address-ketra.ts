#!/usr/bin/env npx tsx
/**
 * Address all ChromaZone (Ketra) device slots via LEAP.
 *
 * Assigns sequential synthetic serial numbers so the CCX→WiZ bridge
 * can send DEVICE_REPORT to update zone state on the RA3 processor.
 *
 * Usage:
 *   npx tsx tools/leap-address-ketra.ts              — dry-run (show plan)
 *   npx tsx tools/leap-address-ketra.ts --apply       — address all devices
 *   npx tsx tools/leap-address-ketra.ts --unaddress   — unaddress all devices
 */
import { defaultHost } from "../lib/config";
import { LeapConnection } from "./leap-client";

const CCX_LINK_ID = 437;
const PROCESSOR_RLOC_IPV6 = "fd00::ff:fe00:3800";

// Serial base: 0x0A000001 — sequential in hex for easy identification
const SERIAL_BASE = 0x0a000001;

// ChromaZone zone → device mapping (from LEAP probing)
const KETRA_ZONES: {
  zoneId: number;
  deviceId: number;
  name: string;
  area: string;
}[] = [
  { zoneId: 8238, deviceId: 8239, name: "Table Lamp", area: "Hallway" },
  { zoneId: 9390, deviceId: 9391, name: "Lamp", area: "Guest Bathroom" },
  {
    zoneId: 9475,
    deviceId: 9476,
    name: "Nightstand Lamps",
    area: "Master Bedroom",
  },
  { zoneId: 9538, deviceId: 9539, name: "Lamp", area: "Kitchen" },
  { zoneId: 9555, deviceId: 9556, name: "Floor Lamp", area: "Living Room" },
  { zoneId: 9572, deviceId: 9573, name: "Shelf Lamp", area: "Dining Room" },
  { zoneId: 9589, deviceId: 9590, name: "Dresser Lamp", area: "Dining Room" },
  { zoneId: 9606, deviceId: 9607, name: "Floor Lamp", area: "Dining Room" },
  { zoneId: 9623, deviceId: 9624, name: "Lamp", area: "Foyer" },
];

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unaddress = args.includes("--unaddress");

async function main() {
  const conn = new LeapConnection({ host: defaultHost });
  await conn.connect();
  console.log("Connected to RA3 processor\n");

  if (unaddress) {
    console.log("=== Unaddressing all Ketra devices ===\n");
    for (const z of KETRA_ZONES) {
      const dev = await conn.readBody(`/device/${z.deviceId}`);
      if (dev?.Device?.AddressedState !== "Addressed") {
        console.log(
          `  ${z.area}/${z.name} (device ${z.deviceId}): already unaddressed`,
        );
        continue;
      }
      try {
        const resp = await conn.create(
          `/device/${z.deviceId}/commandprocessor`,
          {
            Command: {
              CommandType: "UnaddressDevice",
              UnaddressDeviceParameters: { IsDeviceOffline: true },
            },
          },
        );
        console.log(`  ${z.area}/${z.name}: ${resp?.Header?.StatusCode}`);
      } catch (e: any) {
        console.log(`  ${z.area}/${z.name}: ERROR ${e.message}`);
      }
    }
    conn.close();
    return;
  }

  // Show plan
  console.log("=== Ketra Zone Addressing Plan ===\n");
  const toAddress: typeof KETRA_ZONES = [];

  for (let i = 0; i < KETRA_ZONES.length; i++) {
    const z = KETRA_ZONES[i];
    const serial = SERIAL_BASE + i;
    const dev = await conn.readBody(`/device/${z.deviceId}`);
    const state = dev?.Device?.AddressedState || "?";
    const existingSerial = dev?.Device?.SerialNumber || 0;

    if (state === "Addressed") {
      console.log(
        `  zone ${z.zoneId} ${z.area}/${z.name}: already addressed (serial ${existingSerial} / 0x${existingSerial.toString(16)})`,
      );
    } else {
      console.log(
        `  zone ${z.zoneId} ${z.area}/${z.name}: UNADDRESSED → will assign serial 0x${serial.toString(16)} (${serial})`,
      );
      toAddress.push(z);
    }
  }

  if (toAddress.length === 0) {
    console.log("\nAll devices already addressed. Nothing to do.");
    conn.close();
    return;
  }

  console.log(`\n${toAddress.length} devices to address.`);

  if (!apply) {
    console.log("Dry run. Use --apply to execute.");
    conn.close();
    return;
  }

  // Enter Association mode
  console.log("\nEntering Association mode on CCX link...");
  const assocResp = await conn.send(
    "UpdateRequest",
    `/link/${CCX_LINK_ID}/status`,
    {
      LinkStatus: { OperatingModes: ["Association"] },
    },
  );
  if (!assocResp?.Header?.StatusCode?.startsWith("200")) {
    console.error(
      "Failed to enter Association mode:",
      assocResp?.Header?.StatusCode,
    );
    conn.close();
    process.exit(1);
  }
  console.log("Association mode active.\n");

  // Small delay for mode to settle
  await new Promise((r) => setTimeout(r, 1000));

  // Address each device
  let success = 0;
  for (let i = 0; i < KETRA_ZONES.length; i++) {
    const z = KETRA_ZONES[i];
    const serial = SERIAL_BASE + i;

    // Skip already addressed
    const dev = await conn.readBody(`/device/${z.deviceId}`);
    if (dev?.Device?.AddressedState === "Addressed") continue;

    try {
      const resp = await conn.create(`/device/${z.deviceId}/commandprocessor`, {
        Command: {
          CommandType: "AddressDevice",
          AddressDeviceParameters: {
            SerialNumber: serial,
            DeviceClassParameters: {
              Action: "Overwrite",
              DeviceClass: {
                HexadecimalEncoding:
                  dev?.Device?.DeviceClass?.HexadecimalEncoding || "45e0101",
              },
            },
            IPv6Properties: {
              UniqueLocalUnicastAddresses: [PROCESSOR_RLOC_IPV6],
            },
          },
        },
      });
      const status = resp?.Header?.StatusCode || "?";
      if (status.startsWith("204") || status.startsWith("200")) {
        console.log(
          `  zone ${z.zoneId} ${z.area}/${z.name}: OK → serial 0x${serial.toString(16)}`,
        );
        success++;
      } else {
        console.log(
          `  zone ${z.zoneId} ${z.area}/${z.name}: ${status} ${resp?.Body?.Message || ""}`,
        );
      }
    } catch (e: any) {
      console.log(`  zone ${z.zoneId} ${z.area}/${z.name}: ERROR ${e.message}`);
    }
  }

  // Revert to Normal mode
  console.log("\nReverting to Normal mode...");
  await conn.send("UpdateRequest", `/link/${CCX_LINK_ID}/status`, {
    LinkStatus: { OperatingModes: ["Normal"] },
  });

  // Verify
  console.log("\n=== Verification ===\n");
  const serialMap: Record<string, { serial: number; hex: string }> = {};
  for (let i = 0; i < KETRA_ZONES.length; i++) {
    const z = KETRA_ZONES[i];
    const dev = await conn.readBody(`/device/${z.deviceId}`);
    const d = dev?.Device;
    const zStatus = await conn.readBody(`/zone/${z.zoneId}/status/expanded`);
    const accuracy = zStatus?.ZoneExpandedStatus?.StatusAccuracy || "?";
    const serial = d?.SerialNumber || 0;
    console.log(
      `  zone ${z.zoneId} ${z.area}/${z.name}: serial=${serial} (0x${serial.toString(16)}) addressed=${d?.AddressedState} accuracy=${accuracy}`,
    );
    if (serial > 0) {
      serialMap[String(z.zoneId)] = { serial, hex: "0x" + serial.toString(16) };
    }
  }

  // Write serial map
  const { writeFileSync } = await import("fs");
  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outPath = join(__dirname, "..", "data", "wiz-device-serials.json");
  writeFileSync(outPath, JSON.stringify(serialMap, null, 2) + "\n");
  console.log(`\nSerial map written to ${outPath}`);
  console.log(`${success} devices addressed successfully.`);

  conn.close();
}

main().catch(console.error);
