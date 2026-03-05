#!/usr/bin/env bun

/**
 * CCX Bridge — Listen for Lutron LEVEL_CONTROL on Thread, forward to external outputs.
 *
 * Uses tshark + nRF sniffer dongle to capture Thread traffic (same proven pipeline
 * as ccx-sniffer.ts), decodes CBOR, deduplicates, and forwards level changes
 * to WiZ lights, HTTP webhooks, or stdout.
 *
 * Usage:
 *   bun run tools/ccx-bridge.ts                          # Use default config
 *   bun run tools/ccx-bridge.ts --zone 3697              # Single zone, log only
 *   bun run tools/ccx-bridge.ts --zone 3697 --zone 518   # Multiple zones
 *   bun run tools/ccx-bridge.ts --config path/to/cfg.json
 *   bun run tools/ccx-bridge.ts -v                       # Verbose (all CCX traffic)
 */

import { spawn } from "child_process";
import { createSocket } from "dgram";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { CCX_CONFIG, getZoneName } from "../ccx/config";
import { buildPacket, formatMessage, getMessageTypeName } from "../ccx/decoder";
import type { CCXLevelControl, CCXPacket } from "../ccx/types";

// ── CLI args ──────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function getAllArgs(name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      results.push(args[i + 1]);
    }
  }
  return results;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

const configPath =
  getArg("--config") ??
  join(import.meta.dir, "..", "data", "virtual-device.json");
const zoneArgs = getAllArgs("--zone");
const verbose = hasFlag("--verbose") || hasFlag("-v");
const snifferIface = getArg("--iface"); // tshark interface override

// ── Config ────────────────────────────────────────────────

interface WizOutput {
  type: "wiz";
  zoneId: number;
  wizIp: string;
  wizPort?: number;
}

interface WebhookOutput {
  type: "webhook";
  url: string;
  zoneId?: number;
}

interface BridgeConfig {
  outputs: (WizOutput | WebhookOutput)[];
  devices?: { name: string; zoneIds: number[] }[];
}

function loadConfig(): BridgeConfig {
  if (zoneArgs.length > 0) {
    return {
      outputs: [],
      devices: [{ name: "CLI zones", zoneIds: zoneArgs.map((z) => parseInt(z, 10)) }],
    };
  }

  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error(`Create it or use --zone <id> for quick testing.`);
    process.exit(1);
  }

  return JSON.parse(readFileSync(configPath, "utf-8"));
}

const config = loadConfig();

// Build set of watched zone IDs
const watchedZones = new Set<number>();
if (config.devices) {
  for (const d of config.devices) {
    for (const z of d.zoneIds) watchedZones.add(z);
  }
}
for (const out of config.outputs) {
  if ("zoneId" in out && out.zoneId) watchedZones.add(out.zoneId);
}

// ── Deduplication ─────────────────────────────────────────
// Processor sends 6-7 copies of each command. Dedup by zone+seq.

const recentCommands = new Map<string, number>();
const DEDUP_WINDOW_MS = 2000;

function isDuplicate(zoneId: number, seq: number): boolean {
  const key = `${zoneId}:${seq}`;
  const now = Date.now();
  const prev = recentCommands.get(key);
  if (prev && now - prev < DEDUP_WINDOW_MS) return true;
  recentCommands.set(key, now);

  if (recentCommands.size > 100) {
    for (const [k, ts] of recentCommands) {
      if (now - ts > DEDUP_WINDOW_MS) recentCommands.delete(k);
    }
  }
  return false;
}

// ── Output: WiZ UDP ───────────────────────────────────────

const wizSocket = config.outputs.some((o) => o.type === "wiz")
  ? createSocket("udp4")
  : null;

async function sendWiz(output: WizOutput, levelPercent: number) {
  if (!wizSocket) return;
  const isOff = levelPercent === 0;
  const payload = isOff
    ? JSON.stringify({ method: "setPilot", params: { state: false } })
    : JSON.stringify({
        method: "setPilot",
        params: { state: true, dimming: Math.max(10, Math.round(levelPercent)) },
      });

  const buf = Buffer.from(payload);
  const port = output.wizPort ?? 38899;

  return new Promise<void>((resolve) => {
    wizSocket!.send(buf, port, output.wizIp, (err) => {
      if (err) {
        console.error(`  [wiz] Error → ${output.wizIp}: ${err.message}`);
      } else {
        console.log(`  [wiz] → ${output.wizIp} ${isOff ? "OFF" : `${Math.round(levelPercent)}%`}`);
      }
      resolve();
    });
  });
}

// ── Output: Webhook ───────────────────────────────────────

async function sendWebhook(output: WebhookOutput, zoneId: number, levelPercent: number, fade: number) {
  try {
    const resp = await fetch(output.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        zoneId,
        zoneName: getZoneName(zoneId) ?? `Zone ${zoneId}`,
        level: levelPercent,
        fade: fade / 4,
        timestamp: new Date().toISOString(),
      }),
    });
    console.log(`  [webhook] → ${output.url} ${resp.status}`);
  } catch (err) {
    console.error(`  [webhook] Error: ${(err as Error).message}`);
  }
}

// ── Dispatch ──────────────────────────────────────────────

async function dispatch(msg: CCXLevelControl) {
  const { zoneId, levelPercent, fade } = msg;
  const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
  const time = new Date().toISOString().slice(11, 23);
  const fadeSec = fade / 4;
  const fadeStr = fadeSec !== 0.25 ? ` fade=${fadeSec}s` : "";

  console.log(
    `\n${time} ** LEVEL → ${zoneName} (zone=${zoneId}) ${levelPercent.toFixed(1)}%${fadeStr}`,
  );

  const promises: Promise<void>[] = [];

  for (const output of config.outputs) {
    if (output.type === "wiz" && output.zoneId === zoneId) {
      promises.push(sendWiz(output, levelPercent));
    } else if (output.type === "webhook") {
      if (!output.zoneId || output.zoneId === zoneId) {
        promises.push(sendWebhook(output, zoneId, levelPercent, fade));
      }
    }
  }

  await Promise.all(promises);
}

// ── tshark sniffer pipeline ───────────────────────────────

function detectSnifferDevice(): string {
  const candidates = [
    "/dev/cu.usbmodem201401",
    "/dev/cu.usbmodem0004401800001",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return "/dev/cu.usbmodem201401";
}

function processLine(line: string): CCXPacket | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const fields = trimmed.split("\t");
  if (fields.length < 6) return null;

  const [epochStr, srcAddr, dstAddr, srcEui64, dstEui64, dataHex] = fields;
  if (!dataHex) return null;

  const payloadHex = dataHex.replace(/:/g, "");
  if (!payloadHex) return null;

  try {
    const epoch = parseFloat(epochStr);
    const timestamp = new Date(epoch * 1000).toISOString();
    return buildPacket({
      timestamp,
      srcAddr: srcAddr ?? "",
      dstAddr: dstAddr ?? "",
      srcEui64: srcEui64 ?? "",
      dstEui64: dstEui64 ?? "",
      payloadHex,
    });
  } catch {
    return null;
  }
}

function main() {
  const iface = snifferIface ?? detectSnifferDevice();

  console.log("CCX Bridge (tshark sniffer)");
  console.log("==========================");
  console.log(`Sniffer: ${iface}`);
  console.log(`Channel: ${CCX_CONFIG.channel}`);
  if (watchedZones.size > 0) {
    const zoneList = [...watchedZones]
      .map((z) => `${z} (${getZoneName(z) ?? "?"})`)
      .join(", ");
    console.log(`Zones: ${zoneList}`);
  } else {
    console.log("Zones: ALL (no filter)");
  }
  const outputDesc =
    config.outputs.length === 0
      ? "log only"
      : config.outputs.map((o) => o.type).join(", ");
  console.log(`Outputs: ${outputDesc}`);
  console.log("");

  const tsharkArgs = [
    "-i", iface,
    "-l", // line-buffered
    "-Y", `udp.port == ${CCX_CONFIG.udpPort}`,
    "-T", "fields",
    "-e", "frame.time_epoch",
    "-e", "ipv6.src",
    "-e", "ipv6.dst",
    "-e", "wpan.src64",
    "-e", "wpan.dst64",
    "-e", "udp.payload",
    "-E", "separator=\t",
  ];

  const tshark = spawn("tshark", tsharkArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";
  let packetCount = 0;
  let matchCount = 0;

  tshark.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const pkt = processLine(line);
      if (!pkt) continue;
      packetCount++;

      // Verbose: log all packets
      if (verbose) {
        const time = pkt.timestamp.slice(11, 23);
        const typeName = getMessageTypeName(pkt.msgType).padEnd(14);
        console.log(`${time} ${typeName} ${formatMessage(pkt.parsed)}`);
      }

      if (pkt.parsed.type !== "LEVEL_CONTROL") continue;

      // Filter by zone
      if (watchedZones.size > 0 && !watchedZones.has(pkt.parsed.zoneId)) continue;

      // Dedup
      if (isDuplicate(pkt.parsed.zoneId, pkt.parsed.sequence)) continue;

      matchCount++;
      dispatch(pkt.parsed);
    }
  });

  tshark.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg.includes("Capturing on")) {
      console.log(`Listening... (Ctrl+C to stop)\n`);
    } else if (msg.includes("packets captured")) {
      // ignore
    } else if (msg) {
      console.error(`[tshark] ${msg}`);
    }
  });

  tshark.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: tshark not found. Install Wireshark CLI tools.");
    } else {
      console.error(`tshark error: ${err.message}`);
    }
    process.exit(1);
  });

  tshark.on("close", (code) => {
    if (buffer.trim()) {
      const pkt = processLine(buffer);
      if (pkt && pkt.parsed.type === "LEVEL_CONTROL") {
        if (watchedZones.size === 0 || watchedZones.has(pkt.parsed.zoneId)) {
          if (!isDuplicate(pkt.parsed.zoneId, pkt.parsed.sequence)) {
            dispatch(pkt.parsed);
          }
        }
      }
    }
    console.log(`\n${packetCount} packets seen, ${matchCount} level commands forwarded.`);
    wizSocket?.close();
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => {
    console.log("\nStopping...");
    tshark.kill("SIGINT");
  });
}

main();
