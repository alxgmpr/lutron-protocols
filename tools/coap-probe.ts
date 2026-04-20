#!/usr/bin/env node --import tsx

/**
 * coap-probe — probe all CCX devices for CoAP endpoints.
 *
 * Usage: npx tsx tools/coap-probe.ts
 *        npx tsx tools/coap-probe.ts --rloc 4800    # single device
 */

import {
  type CoapCode,
  type CoapResponse,
  type CoapTarget,
  createCcxCoapClient,
} from "../lib/ccx-coap";
import { config } from "../lib/config";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const host = getArg("--host") ?? config.openBridge;
const singleRloc = getArg("--rloc");

// Device table from diagnostics + LEAP
const devices: {
  rloc: string;
  leapId: number;
  type: string;
  name: string;
}[] = [
  {
    rloc: "8400",
    leapId: 1496,
    type: "SunnataDimmer",
    name: "Hallway Top of Stairs",
  },
  { rloc: "1400", leapId: 1862, type: "SunnataDimmer", name: "Foyer Entrance" },
  {
    rloc: "A000",
    leapId: 1940,
    type: "SunnataDimmer",
    name: "Master Bedroom Entrance",
  },
  {
    rloc: "A00A",
    leapId: 2001,
    type: "SunnataDimmer",
    name: "Master Bedroom Closet",
  },
  {
    rloc: "D001",
    leapId: 2111,
    type: "SunnataDimmer",
    name: "Living Room Entry",
  },
  {
    rloc: "D400",
    leapId: 2138,
    type: "SunnataDimmer",
    name: "Kitchen Entrance",
  },
  {
    rloc: "A402",
    leapId: 2291,
    type: "SunnataDimmer",
    name: "Dining Room Back Doorway",
  },
  {
    rloc: "C401",
    leapId: 2432,
    type: "SunnataDimmer",
    name: "Living Room Fireplace",
  },
  { rloc: "4800", leapId: 3647, type: "SunnataDimmer", name: "Office Closet" },
  {
    rloc: "F400",
    leapId: 3989,
    type: "SunnataDimmer",
    name: "Guest Bedroom Closet",
  },
  {
    rloc: "A801",
    leapId: 4623,
    type: "SunnataDimmer",
    name: "Storage Closet Stairs (a)",
  },
  {
    rloc: "A800",
    leapId: 4648,
    type: "SunnataDimmer",
    name: "Storage Closet Stairs (b)",
  },
  {
    rloc: "EC00",
    leapId: 5640,
    type: "SunnataDimmer",
    name: "Powder Bathroom Entry",
  },
  {
    rloc: "080C",
    leapId: 5747,
    type: "SunnataDimmer",
    name: "Master Bathroom Shower",
  },
  {
    rloc: "A002",
    leapId: 1965,
    type: "SunnataFanControl",
    name: "Master Bedroom Entrance",
  },
  {
    rloc: "3801",
    leapId: 483,
    type: "SunnataHybridKeypad",
    name: "Office Entrance",
  },
  {
    rloc: "0C00",
    leapId: 1091,
    type: "SunnataHybridKeypad",
    name: "Guest Bedroom Entrance",
  },
  {
    rloc: "6400",
    leapId: 1557,
    type: "SunnataHybridKeypad",
    name: "Hallway Top of Stairs",
  },
  {
    rloc: "1401",
    leapId: 1803,
    type: "SunnataHybridKeypad",
    name: "Foyer Entrance",
  },
  {
    rloc: "A001",
    leapId: 1894,
    type: "SunnataHybridKeypad",
    name: "Master Bedroom Entrance",
  },
  {
    rloc: "A400",
    leapId: 2028,
    type: "SunnataHybridKeypad",
    name: "Dining Room Entrance",
  },
  {
    rloc: "D800",
    leapId: 2165,
    type: "SunnataHybridKeypad",
    name: "Kitchen Entrance",
  },
  {
    rloc: "C400",
    leapId: 2384,
    type: "SunnataHybridKeypad",
    name: "Living Room Fireplace",
  },
  {
    rloc: "1402",
    leapId: 2461,
    type: "SunnataHybridKeypad",
    name: "Stairs Base",
  },
  {
    rloc: "0800",
    leapId: 2607,
    type: "SunnataHybridKeypad",
    name: "Hallway End",
  },
  {
    rloc: "0809",
    leapId: 4210,
    type: "SunnataHybridKeypad",
    name: "Master Bathroom Entry",
  },
  {
    rloc: "D000",
    leapId: 2076,
    type: "SunnataKeypad",
    name: "Living Room Entry",
  },
  {
    rloc: "A010",
    leapId: 2657,
    type: "SunnataKeypad",
    name: "Master Bedroom Bedside",
  },
  {
    rloc: "C000",
    leapId: 4291,
    type: "SunnataKeypad",
    name: "Laundry Room Entry",
  },
  {
    rloc: "EC01",
    leapId: 5665,
    type: "SunnataSwitch",
    name: "Powder Bathroom Entry",
  },
  {
    rloc: "0806",
    leapId: 5772,
    type: "SunnataSwitch",
    name: "Master Bathroom Shower",
  },
];

// Endpoints to probe
const fwEndpoints = ["fw/ic/md", "fw/it/md"];
const bucketEndpoints = [
  "cg/db/ct/c/AAI",
  "cg/db/ct/c/AHA",
  "cg/db/ct/c/AAB",
  "cg/db/ct/c/AAC",
  "cg/db/ct/c/AAD",
  "cg/db/ct/c/AAE",
  "cg/db/ct/c/AAF",
  "cg/db/ct/c/AAG",
  "cg/db/ct/c/AAH",
  "cg/db/ct/c/AAJ",
  "cg/db/ct/c/ACA",
  "cg/db/ct/c/ACB",
  "cg/db/ct/c/ADA",
  "cg/db/ct/c/AFA",
  "cg/db/ct/c/AGA",
  "cg/db/ct/c/AHB",
  "cg/db/ct/c/AIA",
  "cg/db/ct/c/ALA",
  "cg/db/ct/c/AMA",
  "cg/db/ct/c/ANA",
  "cg/db/ct/c/APA",
  "cg/db/ct/c/ARA",
  "cg/db/ct/c/ASA",
  "cg/db/ct/c/ATA",
  "cg/db/ct/c/ABA",
  "cg/db/ct/c/FAN",
  "cg/db/ct/c/FAD",
  "cg/db/ct/c/LED",
  "cg/db/ct/c/OCC",
  "cg/db/ct/c/PHZ",
  "cg/db/ct/c/TUN",
  "cg/db/ct/c/DIM",
  "cg/db/ct/c/SPD",
];
const otherEndpoints = ["cg/db/mc", "cg/db/pr", "lg/all", "lg/lim", "em/tc"];

function decodeFwItMd(buf: Buffer): string {
  if (buf.length < 13) return "(too short)";
  const state = buf[0];
  const ver = `${buf[5]}.${buf[6]}.${buf[7]}`;
  const build = buf.readUInt16BE(9);
  const strStart = 13;
  let strEnd = buf.indexOf(0, strStart);
  if (strEnd < 0) strEnd = buf.length;
  const variant = buf.subarray(strStart, strEnd).toString("ascii");
  return `state=${state} ver=${ver} build=${build} variant="${variant}"`;
}

function decodeFwIcMd(buf: Buffer): string {
  if (buf.length < 9) return "(too short)";
  const count = buf[0];
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const off = 1 + i * 8;
    if (off + 8 > buf.length) break;
    const flags = buf.readUInt32LE(off);
    const comp = buf[off + 4];
    const ver = `${buf[off + 5]}.${buf[off + 6]}.${buf[off + 7]}`;
    const compName =
      comp === 1
        ? "app"
        : comp === 2
          ? "boot"
          : comp === 4
            ? "peri"
            : `c${comp}`;
    const flagStr =
      flags === 0x80
        ? "active"
        : flags === 0x08
          ? "pending"
          : `0x${flags.toString(16)}`;
    parts.push(`${compName}:${ver}(${flagStr})`);
  }
  return parts.join(" ");
}

async function safeGet(
  client: ReturnType<typeof createCcxCoapClient>,
  target: CoapTarget,
  path: string,
): Promise<{ code: CoapCode | "timeout"; resp?: CoapResponse }> {
  try {
    const resp = await client.get(target, path);
    return { code: resp.code, resp };
  } catch (err) {
    if (/timeout/i.test((err as Error).message)) return { code: "timeout" };
    throw err;
  }
}

async function probeDevice(
  client: ReturnType<typeof createCcxCoapClient>,
  dev: (typeof devices)[0],
) {
  const { rloc, leapId, type, name } = dev;
  const shortType = type.replace("Sunnata", "").replace("Hybrid", "H-");
  const target: CoapTarget = { kind: "rloc", rloc };

  process.stderr.write(`Probing ${rloc} ${shortType} ${name}...\n`);
  const result: Record<string, string> = {};

  for (const ep of fwEndpoints) {
    const { code, resp } = await safeGet(client, target, ep);
    if (code === "2.05" && resp && resp.payload.length) {
      if (ep === "fw/it/md") result[ep] = decodeFwItMd(resp.payload);
      else if (ep === "fw/ic/md") result[ep] = decodeFwIcMd(resp.payload);
      else result[ep] = resp.payload.toString("hex");
    } else if (code !== "timeout") {
      result[ep] = code;
    }
  }

  const foundBuckets: string[] = [];
  for (const ep of bucketEndpoints) {
    const { code } = await safeGet(client, target, ep);
    if (code !== "4.04" && code !== "timeout") {
      const bucket = ep.split("/").pop()!;
      foundBuckets.push(bucket);
    }
  }
  if (foundBuckets.length > 0) result["buckets"] = foundBuckets.join(", ");

  for (const ep of otherEndpoints) {
    const { code, resp } = await safeGet(client, target, ep);
    if (code !== "4.04" && code !== "timeout") {
      result[ep] = resp?.payload.length
        ? `${code} (${resp.payload.length}B)`
        : code;
    }
  }

  return { rloc, leapId, type: shortType, name, result };
}

async function main() {
  const client = createCcxCoapClient({ host });
  await client.connect();

  const targets = singleRloc
    ? devices.filter((d) => d.rloc.toLowerCase() === singleRloc.toLowerCase())
    : devices;

  if (targets.length === 0) {
    console.error("No matching devices");
    client.close();
    process.exit(1);
  }

  const byType = new Map<string, (typeof devices)[0][]>();
  for (const d of targets) {
    const list = byType.get(d.type) || [];
    list.push(d);
    byType.set(d.type, list);
  }

  const results: Awaited<ReturnType<typeof probeDevice>>[] = [];

  for (const [type, devs] of byType) {
    const first = devs[0];
    const r = await probeDevice(client, first);
    results.push(r);

    // Quick fingerprint for remaining devices of same type.
    for (let i = 1; i < devs.length; i++) {
      const d = devs[i];
      process.stderr.write(`Quick probe ${d.rloc} ${d.name}...\n`);
      const { code, resp } = await safeGet(
        client,
        { kind: "rloc", rloc: d.rloc },
        "fw/it/md",
      );
      const fwInfo =
        code === "2.05" && resp?.payload.length
          ? decodeFwItMd(resp.payload)
          : code;
      results.push({
        rloc: d.rloc,
        leapId: d.leapId,
        type: type.replace("Sunnata", "").replace("Hybrid", "H-"),
        name: d.name,
        result: { "fw/it/md": fwInfo },
      });
    }
  }

  let currentType = "";
  for (const r of results.sort((a, b) => a.type.localeCompare(b.type))) {
    if (r.type !== currentType) {
      currentType = r.type;
      console.log(`\n=== ${currentType} ===`);
    }
    console.log(`\n${r.rloc} [${r.leapId}] ${r.name}`);
    for (const [k, v] of Object.entries(r.result)) {
      console.log(`  ${k}: ${v}`);
    }
  }

  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
