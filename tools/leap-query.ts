#!/usr/bin/env node --import tsx

/**
 * leap-query — one-shot LEAP API query.
 *
 * Usage: npx tsx tools/leap-query.ts /device/3647/networkinterface
 *        npx tsx tools/leap-query.ts --host 10.0.0.2 /device/1/status
 */

import { defaultHost } from "../lib/config";
import { LeapConnection } from "./leap-client";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const host = getArg("--host") ?? defaultHost;
const path = args.find((a) => a.startsWith("/"));

if (!path) {
  console.error("Usage: npx tsx tools/leap-query.ts <path>");
  process.exit(1);
}

async function main() {
  const conn = new LeapConnection({ host });
  await conn.connect();
  const resp = await conn.read(path!);
  console.log(JSON.stringify(resp, null, 2));
  await conn.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
