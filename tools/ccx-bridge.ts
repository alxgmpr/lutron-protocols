#!/usr/bin/env bun

/**
 * CCX Bridge — Listen for Lutron level changes on Thread, forward to external outputs.
 *
 * Captures both:
 *   - LEVEL_CONTROL (processor → devices, multicast) — app/scene commands
 *   - DEVICE_REPORT (device → processor, unicast) — physical dimmer touches
 *
 * Uses tshark + nRF sniffer dongle to capture all Thread traffic, decodes CBOR,
 * deduplicates, and forwards level changes to WiZ lights, HTTP webhooks, or stdout.
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
import { CCX_CONFIG, getZoneName, getSerialName, getPresetInfo, presetIdFromDeviceId } from "../ccx/config";
import { buildPacket, formatMessage, getMessageTypeName } from "../ccx/decoder";
import type { CCXDeviceReport, CCXDimHold, CCXLevelControl, CCXPacket } from "../ccx/types";

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

interface SerialZoneMap {
  [serial: string]: number; // device serial → zone ID
}

interface PresetZoneMap {
  [presetId: string]: number; // LEAP preset ID → zone ID
}

interface BridgeConfig {
  outputs: (WizOutput | WebhookOutput)[];
  devices?: { name: string; zoneIds: number[] }[];
  serialToZone?: SerialZoneMap;
  presetToZone?: PresetZoneMap;
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

// Build serial → zone mapping from config + LEAP data
const serialToZone = new Map<number, number>();
if (config.serialToZone) {
  for (const [serial, zoneId] of Object.entries(config.serialToZone)) {
    serialToZone.set(Number(serial), zoneId);
  }
}

// Build preset → zone mapping (for pico buttons: On/Off/Raise/Lower)
const presetToZone = new Map<number, number>();
if (config.presetToZone) {
  for (const [preset, zoneId] of Object.entries(config.presetToZone)) {
    presetToZone.set(Number(preset), zoneId);
  }
}

/** Resolve zone ID from a DIM_HOLD/DIM_STEP deviceId via preset lookup */
function resolveZoneFromPreset(deviceId: Uint8Array): number {
  if (deviceId.length < 2) return 0;
  const presetId = presetIdFromDeviceId(deviceId);
  return presetToZone.get(presetId) ?? 0;
}

/** Get raise/lower direction from preset name (for BUTTON_PRESS On/Off handling) */
function getPresetAction(deviceId: Uint8Array): "on" | "off" | "raise" | "lower" | null {
  const presetId = presetIdFromDeviceId(deviceId);
  const info = getPresetInfo(presetId);
  if (!info) return null;
  const name = info.name.toLowerCase();
  if (name === "on") return "on";
  if (name === "off") return "off";
  if (name === "raise") return "raise";
  if (name === "lower") return "lower";
  return null;
}

// ── Deduplication ─────────────────────────────────────────
// Processor sends 6-7 copies of each command. Dedup by type+key+seq/level.

const recentCommands = new Map<string, number>();
const DEDUP_WINDOW_MS = 2000;

function isDuplicate(key: string): boolean {
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

/** Scale Lutron 1-100% → Wiz 10-100% linearly. 0% = off. */
function lutronToWizDimming(lutronPercent: number): number {
  return Math.round(10 + (lutronPercent / 100) * 90);
}

async function sendWiz(output: WizOutput, levelPercent: number) {
  if (!wizSocket) return;
  const isOff = levelPercent <= 0;
  const wizDim = lutronToWizDimming(levelPercent);
  const payload = isOff
    ? JSON.stringify({ method: "setPilot", params: { state: false } })
    : JSON.stringify({
        method: "setPilot",
        params: { state: true, dimming: wizDim },
      });

  const buf = Buffer.from(payload);
  const port = output.wizPort ?? 38899;

  return new Promise<void>((resolve) => {
    wizSocket!.send(buf, port, output.wizIp, (err) => {
      if (err) {
        console.error(`  [wiz] Error → ${output.wizIp}: ${err.message}`);
      } else {
        console.log(`  [wiz] → ${output.wizIp} ${isOff ? "OFF" : `${Math.round(levelPercent)}%→wiz${wizDim}%`}`);
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

// ── DEVICE_REPORT level extraction ────────────────────────
// Two known formats:
//   Format A: {0: cmdType, 1: {0: level_byte, 1: level_byte+1}, 2: 3}
//     level_byte is 0-254 scale (0xFE = 100%), seen from standalone dimmers
//   Format B: {3: [[4, Uint8Array([hi, lo]), 2]]}
//     level as uint16 BE in byte array (0xFEFF = 100%), seen from hybrid keypads

function extractDeviceReportLevel(msg: CCXDeviceReport): number | null {
  const inner = msg.innerData;
  if (!inner || typeof inner !== "object") return null;

  // Format A: key 1 is a map with level byte at key 0
  const levelMap = inner[1];
  if (levelMap && typeof levelMap === "object") {
    const rawLevel = (levelMap as Record<number, unknown>)[0];
    if (typeof rawLevel === "number") {
      return (rawLevel / 254) * 100;
    }
  }

  // Format B: key 3 is array of [4, bytes, 2] tuples
  const key3 = inner[3];
  if (Array.isArray(key3)) {
    for (const entry of key3) {
      if (!Array.isArray(entry)) continue;
      const levelBytes = entry[1];
      if (levelBytes instanceof Uint8Array && levelBytes.length === 2) {
        const level16 = (levelBytes[0] << 8) | levelBytes[1];
        return (level16 / 0xFEFF) * 100;
      }
    }
  }

  return null;
}

// ── Dim Ramp (software raise/lower) ──────────────────────
// Lutron DIM_HOLD = start ramping, DIM_STEP = stop ramping.
// The device is supposed to ramp itself; we simulate for Wiz.

const RAMP_INTERVAL_MS = 100; // step every 100ms
const RAMP_RATE_PCT_PER_SEC = 20; // 0→100% in 5 seconds
const RAMP_STEP = (RAMP_RATE_PCT_PER_SEC * RAMP_INTERVAL_MS) / 1000;

// Track current level per zone (updated by LEVEL_CONTROL and ramp)
const zoneLevel = new Map<number, number>();

// Active ramp timers per zone
const activeRamps = new Map<number, ReturnType<typeof setInterval>>();

function startRamp(zoneId: number, direction: "raise" | "lower") {
  stopRamp(zoneId);
  let current = zoneLevel.get(zoneId) ?? 50; // assume 50% if unknown
  const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
  const time = new Date().toISOString().slice(11, 23);
  console.log(`\n${time} ** RAMP ${direction.toUpperCase()} → ${zoneName} (zone=${zoneId}) from ${current.toFixed(0)}%`);

  const timer = setInterval(() => {
    if (direction === "raise") {
      current = Math.min(100, current + RAMP_STEP);
    } else {
      current = Math.max(0, current - RAMP_STEP);
    }
    zoneLevel.set(zoneId, current);

    for (const output of config.outputs) {
      if (output.type === "wiz" && output.zoneId === zoneId) {
        sendWiz(output, current);
      }
    }

    // Stop at limits
    if (current >= 100 || current <= 0) {
      stopRamp(zoneId);
    }
  }, RAMP_INTERVAL_MS);

  activeRamps.set(zoneId, timer);
}

function stopRamp(zoneId: number) {
  const timer = activeRamps.get(zoneId);
  if (timer) {
    clearInterval(timer);
    activeRamps.delete(zoneId);
    const level = zoneLevel.get(zoneId) ?? 0;
    const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
    const time = new Date().toISOString().slice(11, 23);
    console.log(`${time} ** RAMP STOP → ${zoneName} (zone=${zoneId}) at ${level.toFixed(0)}%`);
  }
}

// ── Dispatch ──────────────────────────────────────────────

async function dispatch(zoneId: number, levelPercent: number, source: string, fade = 1) {
  zoneLevel.set(zoneId, levelPercent); // track current level
  const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
  const time = new Date().toISOString().slice(11, 23);
  const fadeSec = fade / 4;
  const fadeStr = fadeSec !== 0.25 ? ` fade=${fadeSec}s` : "";

  console.log(
    `\n${time} ** ${source} → ${zoneName} (zone=${zoneId}) ${levelPercent.toFixed(1)}%${fadeStr}`,
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
  if (presetToZone.size > 0) {
    console.log(`Presets: ${presetToZone.size} mapped to zones`);
  }
  console.log("");

  const tsharkArgs = [
    "-i", iface,
    "-l", // line-buffered
    "-Y", `udp.port == 9190`,
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

      // Log every packet
      const time = pkt.timestamp.slice(11, 23);
      const typeName = getMessageTypeName(pkt.msgType).padEnd(14);
      console.log(`${time} ${typeName} ${formatMessage(pkt.parsed)}  [${pkt.srcAddr} → ${pkt.dstAddr}]`);

      // Handle LEVEL_CONTROL (processor → devices, multicast)
      if (pkt.parsed.type === "LEVEL_CONTROL") {
        const { zoneId, sequence, levelPercent, fade } = pkt.parsed;
        if (watchedZones.size > 0 && !watchedZones.has(zoneId)) continue;
        if (isDuplicate(`lc:${zoneId}:${sequence}`)) continue;
        matchCount++;
        dispatch(zoneId, levelPercent, "LEVEL", fade);
        continue;
      }

      // Handle DEVICE_REPORT (physical dimmer → processor, unicast)
      if (pkt.parsed.type === "DEVICE_REPORT") {
        const level = extractDeviceReportLevel(pkt.parsed);
        if (level === null) continue;
        const serial = pkt.parsed.deviceSerial;
        const zoneId = serialToZone.get(serial);
        const serialName = getSerialName(serial);
        if (zoneId) {
          if (isDuplicate(`dr:${serial}:${Math.round(level)}`)) continue;
          matchCount++;
          dispatch(zoneId, level, `DIMMER(${serialName ?? serial})`);
        } else {
          // Log unmapped device reports so user can add serial→zone mapping
          if (!isDuplicate(`dr:${serial}:${Math.round(level)}`)) {
            const time = new Date().toISOString().slice(11, 23);
            console.log(
              `\n${time}    DIMMER ${serialName ?? `serial=${serial}`} → ${level.toFixed(1)}% (unmapped — add to serialToZone config)`,
            );
          }
        }
        continue;
      }

      // Handle BUTTON_PRESS (pico On/Off → dispatch, Raise/Lower → ramp)
      if (pkt.parsed.type === "BUTTON_PRESS") {
        const zone = resolveZoneFromPreset(pkt.parsed.deviceId);
        if (!zone) continue;
        if (watchedZones.size > 0 && !watchedZones.has(zone)) continue;
        if (isDuplicate(`bp:${zone}:${pkt.parsed.sequence}`)) continue;
        const action = getPresetAction(pkt.parsed.deviceId);
        if (action === "on") {
          matchCount++;
          dispatch(zone, 100, "BUTTON(On)");
        } else if (action === "off") {
          matchCount++;
          dispatch(zone, 0, "BUTTON(Off)");
        }
        // Raise/Lower handled via DIM_HOLD below
        continue;
      }

      // Handle DIM_HOLD (raise/lower start)
      if (pkt.parsed.type === "DIM_HOLD") {
        let { zoneId, action, sequence } = pkt.parsed;
        // Fall back to preset→zone lookup for pico-originated holds
        if (!zoneId) zoneId = resolveZoneFromPreset(pkt.parsed.deviceId);
        if (!zoneId) continue;
        if (watchedZones.size > 0 && !watchedZones.has(zoneId)) continue;
        if (isDuplicate(`dh:${zoneId}:${sequence}`)) continue;
        matchCount++;
        const direction = action === 3 ? "raise" : "lower";
        startRamp(zoneId, direction);
        continue;
      }

      // Handle DIM_STEP (raise/lower release)
      if (pkt.parsed.type === "DIM_STEP") {
        let { zoneId, sequence } = pkt.parsed;
        if (!zoneId) zoneId = resolveZoneFromPreset(pkt.parsed.deviceId);
        if (!zoneId) continue;
        if (watchedZones.size > 0 && !watchedZones.has(zoneId)) continue;
        if (isDuplicate(`ds:${zoneId}:${sequence}`)) continue;
        matchCount++;
        stopRamp(zoneId);
        continue;
      }
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
        const { zoneId, sequence, levelPercent, fade } = pkt.parsed;
        if (watchedZones.size === 0 || watchedZones.has(zoneId)) {
          if (!isDuplicate(`lc:${zoneId}:${sequence}`)) {
            dispatch(zoneId, levelPercent, "LEVEL", fade);
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
