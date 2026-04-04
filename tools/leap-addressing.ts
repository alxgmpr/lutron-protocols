#!/usr/bin/env npx tsx
/**
 * LEAP CCA addressing mode control + device activation
 * Usage:
 *   npx tsx tools/leap-addressing.ts enter     — enter addressing mode
 *   npx tsx tools/leap-addressing.ts exit      — exit addressing mode
 *   npx tsx tools/leap-addressing.ts activate <serial_dec> <device_id> <hex_encoding>
 */
import { LeapConnection } from "./leap-client";

const args = process.argv.slice(2);
const cmd = args[0];
const LINK_ID = 439; // RA3 CCA link

async function main() {
  const conn = new LeapConnection({
    host: process.env.RA3_HOST ?? "10.0.0.1",
    certName: "ra3",
  });
  await conn.connect();
  console.log("Connected to RA3 processor");

  if (cmd === "enter") {
    console.log(`Entering addressing mode on link ${LINK_ID}...`);
    const resp = await conn.send("UpdateRequest", `/link/${LINK_ID}/status`, {
      LinkStatus: { OperatingModes: ["Association"] },
    });
    console.log("Response:", JSON.stringify(resp, null, 2));
  } else if (cmd === "exit") {
    console.log(`Exiting addressing mode on link ${LINK_ID}...`);
    const resp = await conn.send("UpdateRequest", `/link/${LINK_ID}/status`, {
      LinkStatus: { OperatingModes: ["Normal"] },
    });
    console.log("Response:", JSON.stringify(resp, null, 2));
  } else if (cmd === "activate") {
    const serialNumber = parseInt(args[1], 10);
    const deviceId = parseInt(args[2], 10);
    const hexEncoding = args[3];
    if (!serialNumber || !deviceId || !hexEncoding) {
      console.error("Usage: activate <serial_dec> <device_id> <hex_encoding>");
      process.exit(1);
    }
    console.log(
      `Activating device ${deviceId} with serial ${serialNumber} (0x${serialNumber.toString(16)}) class ${hexEncoding}...`,
    );
    const resp = await conn.send(
      "CreateRequest",
      `/device/${deviceId}/commandprocessor`,
      {
        Command: {
          CommandType: "AddressDevice",
          AddressDeviceParameters: {
            SerialNumber: serialNumber,
            DeviceClassParameters: {
              DeviceClass: {
                HexadecimalEncoding: hexEncoding,
              },
              Action: "Overwrite",
            },
          },
        },
      },
    );
    console.log("Response:", JSON.stringify(resp, null, 2));
  } else {
    console.log("Commands: enter, exit, activate <serial> <device_id> <hex>");
  }

  conn.close();
}

main().catch(console.error);
