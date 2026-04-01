#!/usr/bin/env node --import tsx

/**
 * leap-query — one-shot LEAP API query.
 *
 * Usage: npx tsx tools/leap-query.ts /device/3647/networkinterface
 *        npx tsx tools/leap-query.ts --host 10.0.0.2 --certs caseta /device/1/status
 */

import { LeapConnection } from "./leap-client";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const host = getArg("--host") ?? "10.0.0.1";
const certName = getArg("--certs") ?? "ra3";
const path = args.find((a) => a.startsWith("/"));

if (!path) {
  console.error("Usage: npx tsx tools/leap-query.ts <path>");
  process.exit(1);
}

async function main() {
  const conn = new LeapConnection({ host, certName });
  await conn.connect();
  const resp = await conn.read(path!);
  console.log(JSON.stringify(resp, null, 2));
  await conn.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
