#!/usr/bin/env npx tsx
/**
 * Auto-activate: subscribes to DeviceHeard, and when the target serial
 * is heard, immediately sends the AddressDevice command.
 *
 * Usage: npx tsx tools/leap-auto-activate.ts <serial_dec> <device_id> <hex_encoding>
 */
import { LeapConnection } from "./leap-client";

const args = process.argv.slice(2);
const targetSerial = parseInt(args[0], 10);
const deviceId = parseInt(args[1], 10);
const hexEncoding = args[2] || "4350101";

if (!targetSerial || !deviceId) {
  console.error(
    "Usage: npx tsx tools/leap-auto-activate.ts <serial_dec> <device_id> [hex_encoding]",
  );
  process.exit(1);
}

async function main() {
  const conn = new LeapConnection({ host: "10.0.0.1", certName: "ra3" });

  let activated = false;

  conn.onEvent = async (msg: any) => {
    const heard = msg?.Body?.DeviceStatus?.DeviceHeard;
    if (!heard) return;

    console.log(
      `Device heard: serial=${heard.SerialNumber} class=${heard.DeviceClass?.HexadecimalEncoding} mechanism=${heard.DiscoveryMechanism}`,
    );

    if (heard.SerialNumber === targetSerial && !activated) {
      activated = true;
      console.log(
        `\nTarget device detected! Waiting 2s then sending AddressDevice...`,
      );
      await new Promise((r) => setTimeout(r, 2000));

      try {
        const resp = await conn.send(
          "CreateRequest",
          `/device/${deviceId}/commandprocessor`,
          {
            Command: {
              CommandType: "AddressDevice",
              AddressDeviceParameters: {
                SerialNumber: targetSerial,
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
        console.log("Activate response:", JSON.stringify(resp, null, 2));
      } catch (err: any) {
        console.error("Activate error:", err.message);
      }

      conn.close();
      process.exit(0);
    }
  };

  await conn.connect();
  console.log("Connected to RA3 processor");

  // Subscribe to device heard
  const subResp = await conn.subscribe("/device/status/deviceheard");
  console.log(`Subscribed (${subResp?.Header?.StatusCode})`);
  console.log(
    `\nWaiting for serial ${targetSerial} (0x${targetSerial.toString(16)})...`,
  );
  console.log("Press the DVRF-6L button now!\n");
}

main().catch(console.error);
