#!/usr/bin/env npx tsx

/**
 * aha-brightness — read/write Sunnata keypad status-LED brightness over CCX.
 *
 * Writes the `AHA` config bucket on a CCX device:
 *   PUT cg/db/ct/c/AHA  ->  CBOR [108, {4: active, 5: inactive}]   (0..255)
 * See docs/protocols/ccx/coap.md.
 *
 * Devices are addressed by Thread RLOC16. Get a device's live RLOC from the
 * processor's own link-health log — no sniffer needed:
 *   ssh root@<proc> "zcat /var/log/ccx-diagnostics-log.0.gz" | grep -i <serialhex>
 * The `Rloc16` column is what you pass to --rloc.
 *
 * Usage:
 *   npx tsx tools/ccx/aha-brightness.ts get --rloc D800
 *   npx tsx tools/ccx/aha-brightness.ts set --rloc D800 --active 60 --inactive 0
 *
 * Options:
 *   --host <ip>    Nucleo CCX shell bridge (default: config.openBridge)
 *   --rloc <hex>   target device RLOC16, e.g. D800
 *   --active <n>   active (lit) status LED level, 0-255
 *   --inactive <n> inactive (idle/nightlight) level, 0-255
 *   --timeout <ms> per-request timeout
 */

import { Decoder, Encoder } from "cbor-x";
import { createCcxCoapClient, type CoapTarget } from "../../lib/ccx-coap";
import { config } from "../../lib/config";

const AHA_PATH = "cg/db/ct/c/AHA";
const AHA_RECORD = 108;
const KEY_ACTIVE = 4;
const KEY_INACTIVE = 5;

const decoder = new Decoder({ mapsAsObjects: false });
const encoder = new Encoder({ useRecords: false, mapsAsObjects: false });

const args = process.argv.slice(2);
const getArg = (n: string) => {
  const i = args.indexOf(n);
  return i !== -1 ? args[i + 1] : undefined;
};

const mode = args[0];
const host = getArg("--host") ?? (config as { openBridge?: string }).openBridge;
const rloc = getArg("--rloc");
const timeout = Number(getArg("--timeout") ?? "8000");

function parseLevel(name: string): number {
  const raw = getArg(name);
  if (raw === undefined) throw new Error(`missing ${name}`);
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`${name} must be 0..255, got ${raw}`);
  }
  return n;
}

/** Decode an AHA payload into {active, inactive}, tolerating map-vs-object. */
function decodeAha(payload: Buffer): { active?: number; inactive?: number } {
  if (!payload?.length) return {};
  const v = decoder.decode(payload) as unknown;
  if (!Array.isArray(v) || v.length < 2) return {};
  const m = v[1];
  const read = (k: number): number | undefined => {
    if (m instanceof Map) return m.get(k) as number | undefined;
    if (m && typeof m === "object") return (m as Record<number, number>)[k];
    return undefined;
  };
  return { active: read(KEY_ACTIVE), inactive: read(KEY_INACTIVE) };
}

function encodeAha(active: number, inactive: number): Buffer {
  const m = new Map<number, number>([
    [KEY_ACTIVE, active],
    [KEY_INACTIVE, inactive],
  ]);
  return Buffer.from(encoder.encode([AHA_RECORD, m]));
}

async function main() {
  if (mode !== "get" && mode !== "set") {
    console.error("usage: aha-brightness.ts <get|set> --rloc <hex> [--active n --inactive n]");
    process.exit(2);
  }
  if (!rloc) throw new Error("--rloc is required");
  if (!host) throw new Error("--host is required (no config.openBridge)");

  const target: CoapTarget = { kind: "rloc", rloc };
  const client = createCcxCoapClient({ host });
  await client.connect();
  try {
    if (mode === "set") {
      const active = parseLevel("--active");
      const inactive = parseLevel("--inactive");
      const payload = encodeAha(active, inactive);
      console.log(`PUT ${AHA_PATH} rloc:${rloc} active=${active} inactive=${inactive}`);
      console.log(`  cbor=${payload.toString("hex")}`);
      const put = await client.put(target, AHA_PATH, payload, { timeoutMs: timeout });
      console.log(`  -> ${put.code}${put.ok ? " OK" : " FAILED"}`);
      if (!put.ok) process.exitCode = 1;
    }

    const res = await client.get(target, AHA_PATH, { timeoutMs: timeout });
    const cur = decodeAha(res.payload);
    console.log(
      `GET ${AHA_PATH} rloc:${rloc} -> ${res.code} ` +
        `active=${cur.active ?? "?"} inactive=${cur.inactive ?? "?"} ` +
        `(raw ${res.payload?.toString("hex") || "-"})`,
    );
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
