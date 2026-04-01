#!/usr/bin/env node --import tsx

/**
 * coap-probe — probe all CCX devices for CoAP endpoints.
 *
 * Usage: npx tsx tools/coap-probe.ts
 *        npx tsx tools/coap-probe.ts --rloc 4800    # single device
 */

import { createSocket } from "dgram";

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};

const host = getArg("--host") ?? process.env.NUCLEO_HOST ?? "10.0.0.3";
const singleRloc = getArg("--rloc");
const PORT = 9433;
const CMD_TEXT = 0x20;
const CMD_KEEPALIVE = 0x00;
const RESP_TEXT = 0xfd;

const sock = createSocket("udp4");

function send(cmd: number, data?: Buffer) {
  const d = data ?? Buffer.alloc(0);
  const frame = Buffer.alloc(2 + d.length);
  frame[0] = cmd;
  frame[1] = d.length;
  d.copy(frame, 2);
  sock.send(frame, 0, frame.length, PORT, host);
}

function sendText(text: string): Promise<string> {
  return new Promise((resolve) => {
    const handler = (msg: Buffer) => {
      if (msg[0] === RESP_TEXT) {
        const text = msg.subarray(1).toString("utf-8").trim();
        if (text.length > 0) {
          sock.removeListener("message", handler);
          resolve(text);
        }
      }
    };
    sock.on("message", handler);
    send(CMD_TEXT, Buffer.from(text, "utf-8"));
    // Timeout
    setTimeout(() => {
      sock.removeListener("message", handler);
      resolve("");
    }, 8000);
  });
}

async function coapGet(
  rloc: string,
  path: string,
): Promise<{ code: string; payload: string }> {
  const resp = await sendText(`ccx coap get rloc:${rloc} ${path}`);
  // Parse: "CoAP GET ... → waiting...\r\nCoAP response code=X.XX mid=0xXXXX ...\r\n..."
  const codeMatch = resp.match(/code=(\d+\.\d+)/);
  const payloadMatch = resp.match(/Payload \((\d+) bytes\):([ 0-9A-F]+)/);
  const code = codeMatch ? codeMatch[1] : "timeout";
  const payload = payloadMatch ? payloadMatch[2].trim() : "";
  return { code, payload };
}

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

function decodeFwItMd(hex: string): string {
  const buf = Buffer.from(hex.replace(/ /g, ""), "hex");
  if (buf.length < 13) return "(too short)";
  const state = buf[0];
  const ver = `${buf[5]}.${buf[6]}.${buf[7]}`;
  const build = buf.readUInt16BE(9);
  // Find null-terminated string
  const strStart = 13;
  let strEnd = buf.indexOf(0, strStart);
  if (strEnd < 0) strEnd = buf.length;
  const variant = buf.subarray(strStart, strEnd).toString("ascii");
  return `state=${state} ver=${ver} build=${build} variant="${variant}"`;
}

function decodeFwIcMd(hex: string): string {
  const buf = Buffer.from(hex.replace(/ /g, ""), "hex");
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

async function probeDevice(dev: (typeof devices)[0]) {
  const { rloc, leapId, type, name } = dev;
  const shortType = type.replace("Sunnata", "").replace("Hybrid", "H-");

  process.stderr.write(`Probing ${rloc} ${shortType} ${name}...\n`);

  const result: Record<string, string> = {};

  // Firmware endpoints
  for (const ep of fwEndpoints) {
    const { code, payload } = await coapGet(rloc, ep);
    if (code === "2.05" && payload) {
      if (ep === "fw/it/md") result[ep] = decodeFwItMd(payload);
      else if (ep === "fw/ic/md") result[ep] = decodeFwIcMd(payload);
      else result[ep] = payload;
    } else if (code !== "timeout") {
      result[ep] = code;
    }
  }

  // Bucket discovery
  const foundBuckets: string[] = [];
  for (const ep of bucketEndpoints) {
    const { code } = await coapGet(rloc, ep);
    if (code !== "4.04" && code !== "timeout") {
      const bucket = ep.split("/").pop()!;
      foundBuckets.push(bucket);
    }
  }
  if (foundBuckets.length > 0) result["buckets"] = foundBuckets.join(", ");

  // Other endpoints
  for (const ep of otherEndpoints) {
    const { code, payload } = await coapGet(rloc, ep);
    if (code !== "4.04" && code !== "timeout") {
      result[ep] = payload ? `${code} (${payload.split(" ").length}B)` : code;
    }
  }

  return { rloc, leapId, type: shortType, name, result };
}

async function main() {
  // Register as UDP client
  await new Promise<void>((resolve) => {
    sock.bind(0, () => {
      send(CMD_KEEPALIVE);
      setTimeout(resolve, 200);
    });
  });

  const targets = singleRloc
    ? devices.filter((d) => d.rloc.toLowerCase() === singleRloc.toLowerCase())
    : devices;

  if (targets.length === 0) {
    console.error("No matching devices");
    process.exit(1);
  }

  // Probe one representative per type first, then all if no --rloc
  const byType = new Map<string, (typeof devices)[0][]>();
  for (const d of targets) {
    const list = byType.get(d.type) || [];
    list.push(d);
    byType.set(d.type, list);
  }

  const results: Awaited<ReturnType<typeof probeDevice>>[] = [];

  for (const [type, devs] of byType) {
    // Probe first device of each type for full bucket scan
    const first = devs[0];
    const r = await probeDevice(first);
    results.push(r);

    // For remaining devices of same type, only probe fw/it/md (quick fingerprint)
    for (let i = 1; i < devs.length; i++) {
      const d = devs[i];
      process.stderr.write(`Quick probe ${d.rloc} ${d.name}...\n`);
      const { code, payload } = await coapGet(d.rloc, "fw/it/md");
      const fwInfo = code === "2.05" && payload ? decodeFwItMd(payload) : code;
      results.push({
        rloc: d.rloc,
        leapId: d.leapId,
        type: type.replace("Sunnata", "").replace("Hybrid", "H-"),
        name: d.name,
        result: { "fw/it/md": fwInfo },
      });
    }
  }

  // Print results grouped by type
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

  sock.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
