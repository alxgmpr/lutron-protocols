#!/usr/bin/env node --import tsx

/**
 * leap-level — set a zone level via LEAP.
 * Usage: npx tsx tools/leap-level.ts <zone_id> <level%> [fade_seconds]
 */

import { LeapConnection } from "./leap-client";

const args = process.argv.slice(2);
const zoneId = args[0];
const level = Number(args[1] ?? 0);
const fadeSec = Number(args[2] ?? 1);

if (!zoneId) {
  console.error(
    "Usage: npx tsx tools/leap-level.ts <zone_id> <level%> [fade_s]",
  );
  process.exit(1);
}

const fadeTime = `00:00:${String(fadeSec).padStart(2, "0")}`;

async function main() {
  const conn = new LeapConnection({
    host: process.env.RA3_HOST ?? "10.0.0.1",
    certName: "ra3",
  });
  await conn.connect();
  const body = {
    Command: {
      CommandType: "GoToDimmedLevel",
      DimmedLevelParameters: {
        Level: level,
        FadeTime: fadeTime,
      },
    },
  };
  const resp = await conn.create(`/zone/${zoneId}/commandprocessor`, body);
  console.log("LEAP:", resp?.Header?.StatusCode ?? "no response");
  await conn.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
