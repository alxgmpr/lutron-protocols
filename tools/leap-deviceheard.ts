#!/usr/bin/env npx tsx
/**
 * Subscribe to DeviceHeard events from RA3 processor.
 * Run while addressing mode is active to see devices announce.
 */
import { defaultHost } from "../lib/config";
import { LeapConnection } from "./leap-client";

async function main() {
  const conn = new LeapConnection({ host: defaultHost });

  conn.onEvent = (msg: any) => {
    console.log(
      new Date().toISOString().slice(11, 23),
      JSON.stringify(msg, null, 2),
    );
  };

  await conn.connect();
  console.log("Connected. Subscribing to device heard events...");

  const resp = await conn.subscribe("/device/status/deviceheard");
  console.log("Subscribe response:", JSON.stringify(resp, null, 2));
  console.log(
    "\nWaiting for device heard events (press button on DVRF-6L)...\n",
  );
}

main().catch(console.error);
