#!/usr/bin/env npx tsx

/**
 * TMF Network Diagnostic sweep — enumerate the live Thread mesh by sending a
 * multicast CoAP POST to coap://[ff03::1]:61631/d/dg with a TypeList request,
 * then collecting per-responder TLV replies from the Nucleo [coap] broadcast
 * stream.
 *
 * Usage:
 *   npx tsx tools/tmf-diag.ts                 # print inventory to stdout
 *   npx tsx tools/tmf-diag.ts --save          # write data/ccx-mesh-inventory.json
 *   npx tsx tools/tmf-diag.ts --wait 4000     # collect broadcasts for 4 s (default 2500 ms)
 *   npx tsx tools/tmf-diag.ts --host 10.1.1.114  # override Nucleo host (default: openBridge)
 *
 * Requires firmware ≥ phase 3 (port-aware put/post; src= in [coap] broadcasts).
 */

import { createSocket } from "node:dgram";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeIpv6, eui64ToSecondaryMleid } from "../ccx/addressing";
import {
  DIAG_TLV_EXT_MAC,
  DIAG_TLV_IPV6_LIST,
  DIAG_TLV_RLOC16,
  decodeDiagResponse,
  encodeDiagTypeList,
} from "../ccx/tmf-diag";
import { parseCoapBroadcast } from "../lib/ccx-coap";
import { config } from "../lib/config";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const STREAM_CMD_KEEPALIVE = 0x00;
const STREAM_CMD_TEXT = 0x20;
const STREAM_RESP_TEXT = 0xfd;
const STREAM_HEARTBEAT = 0xff;

interface InventoryEntry {
  eui64: string;
  rloc16?: number;
  secondaryMleid: string;
  allAddresses: string[];
  primaryMleid?: string;
  designerName?: string;
  area?: string;
  station?: string;
  source: {
    srcAddr: string;
    capturedAt: string;
  };
}

interface Inventory {
  timestamp: string;
  mesh: {
    queryType: "tmf-diag";
    multicastTarget: string;
    tlvTypesRequested: number[];
  };
  devices: InventoryEntry[];
}

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function buildStreamCommand(cmd: number, data: Buffer): Buffer {
  if (data.length > 255) {
    throw new Error(`Stream command data too long (${data.length})`);
  }
  const out = Buffer.alloc(2 + data.length);
  out[0] = cmd & 0xff;
  out[1] = data.length & 0xff;
  data.copy(out, 2);
  return out;
}

interface DiagHit {
  srcAddr: string;
  token: string;
  mid: number;
  payload: Buffer;
  capturedAt: string;
}

function designerDbPath(): string | undefined {
  const p = join(__dir, "..", "data", "designer-ccx-devices.json");
  return existsSync(p) ? p : undefined;
}

interface DesignerRow {
  serial: number;
  eui64: string;
  stationName: string;
  areaName: string;
}

function loadDesignerRows(): DesignerRow[] {
  const p = designerDbPath();
  if (!p) return [];
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const host = getArg("--host") ?? config.openBridge;
  const streamPort = Number(getArg("--stream-port") ?? 9433);
  const waitMs = Number(getArg("--wait") ?? 2500);
  const doSave = hasFlag("--save");
  if (!host) {
    console.error("Missing --host and config.openBridge is unset");
    process.exit(1);
  }

  const tlvTypes = [DIAG_TLV_EXT_MAC, DIAG_TLV_RLOC16, DIAG_TLV_IPV6_LIST];
  const payload = encodeDiagTypeList(tlvTypes);
  const shellCommand = `ccx coap post ff03::1 d/dg ${payload.toString("hex")} 61631`;
  console.error(`# host=${host}:${streamPort} wait=${waitMs}ms`);
  console.error(`# query=${shellCommand}`);

  const hits: DiagHit[] = [];
  await new Promise<void>((resolve, reject) => {
    const sock = createSocket("udp4");
    const keepalive = buildStreamCommand(STREAM_CMD_KEEPALIVE, Buffer.alloc(0));
    const textCmd = buildStreamCommand(
      STREAM_CMD_TEXT,
      Buffer.from(shellCommand, "utf8"),
    );
    let kaTimer: ReturnType<typeof setInterval> | null = null;
    const done = (err?: Error) => {
      if (kaTimer) clearInterval(kaTimer);
      sock.close();
      if (err) reject(err);
      else resolve();
    };
    sock.on("error", (err) => done(err));
    sock.on("message", (msg) => {
      // Heartbeat: [0xFF, 0x00] — ignore
      if (msg.length >= 2 && msg[0] === STREAM_HEARTBEAT && msg[1] === 0x00) {
        return;
      }

      // Text broadcast / text response: [0xFD][utf8 bytes]. Both the shell's
      // response to our `ccx coap post ...` command and every asynchronous
      // [coap] broadcast emitted by stream_broadcast_text come through this
      // path. We scan for [coap] lines and ignore everything else (shell
      // echo lines like "CoAP POST d/dg (5 bytes) → waiting...").
      if (msg.length >= 1 && msg[0] === STREAM_RESP_TEXT) {
        const text = msg.subarray(1).toString("utf8");
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line.startsWith("[coap]")) continue;
          const parsed = parseCoapBroadcast(line);
          if (!parsed || !parsed.src || !parsed.payload) continue;
          hits.push({
            srcAddr: canonicalizeIpv6(parsed.src),
            token: parsed.token ?? "",
            mid: parsed.mid,
            payload: parsed.payload,
            capturedAt: new Date().toISOString(),
          });
        }
        return;
      }

      // Binary stream frames (CCX, TX echo, raw sniff) use the 10-byte header
      // format but carry no text — we don't need them for TMF diagnostics.
    });
    sock.bind(0, async () => {
      try {
        await new Promise<void>((r, rj) =>
          sock.send(keepalive, streamPort, host, (e) => (e ? rj(e) : r())),
        );
        kaTimer = setInterval(() => {
          sock.send(keepalive, streamPort, host, () => {});
        }, 1000);
        await new Promise<void>((r, rj) =>
          sock.send(textCmd, streamPort, host, (e) => (e ? rj(e) : r())),
        );
        setTimeout(() => done(), waitMs);
      } catch (err) {
        done(err as Error);
      }
    });
  });

  // Dedupe hits by source address (multicast may result in repeated frames)
  const bySrc = new Map<string, DiagHit>();
  for (const h of hits) {
    if (!bySrc.has(h.srcAddr)) bySrc.set(h.srcAddr, h);
  }

  const designerRows = loadDesignerRows();
  const byEui = new Map<string, DesignerRow>();
  for (const r of designerRows) byEui.set(r.eui64.toLowerCase(), r);

  const devices: InventoryEntry[] = [];
  for (const hit of bySrc.values()) {
    let decoded: ReturnType<typeof decodeDiagResponse>;
    try {
      decoded = decodeDiagResponse(hit.payload);
    } catch (err) {
      console.error(
        `# skip src=${hit.srcAddr}: decode failed (${(err as Error).message})`,
      );
      continue;
    }
    if (!decoded.eui64) {
      console.error(`# skip src=${hit.srcAddr}: no EUI-64 TLV`);
      continue;
    }
    const secondaryMleid = eui64ToSecondaryMleid(decoded.eui64);
    const primaryFd0d = decoded.ipv6Addresses.find((a) =>
      a.startsWith("fd0d:"),
    );
    const designer = byEui.get(decoded.eui64.toLowerCase());
    devices.push({
      eui64: decoded.eui64,
      rloc16: decoded.rloc16,
      secondaryMleid,
      allAddresses: decoded.ipv6Addresses,
      primaryMleid: primaryFd0d,
      designerName: designer
        ? `${designer.areaName} ${designer.stationName}`
        : undefined,
      area: designer?.areaName,
      station: designer?.stationName,
      source: { srcAddr: hit.srcAddr, capturedAt: hit.capturedAt },
    });
  }

  devices.sort((a, b) => (a.area ?? "").localeCompare(b.area ?? ""));

  const inventory: Inventory = {
    timestamp: new Date().toISOString(),
    mesh: {
      queryType: "tmf-diag",
      multicastTarget: "ff03::1",
      tlvTypesRequested: tlvTypes,
    },
    devices,
  };

  console.log(JSON.stringify(inventory, null, 2));

  if (doSave) {
    const out = join(__dir, "..", "data", "ccx-mesh-inventory.json");
    writeFileSync(out, `${JSON.stringify(inventory, null, 2)}\n`);
    console.error(`# saved ${devices.length} devices to ${out}`);
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
