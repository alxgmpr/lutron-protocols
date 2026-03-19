#!/usr/bin/env -S npx tsx

/**
 * CCX Bridge — Listen for Lutron level changes on Thread, forward to external outputs.
 *
 * Captures both:
 *   - LEVEL_CONTROL (processor → devices, multicast) — app/scene commands
 *   - DEVICE_REPORT (device → processor, unicast) — physical dimmer touches
 *
 * Uses tshark + nRF sniffer dongle to capture all Thread traffic, decodes CBOR,
 * deduplicates, and forwards level changes to WiZ smart lights.
 *
 * Usage:
 *   npx tsx tools/ccx-bridge.ts                          # Use default config
 *   npx tsx tools/ccx-bridge.ts --zone 3697              # Single zone, log only
 *   npx tsx tools/ccx-bridge.ts --zone 3697 --zone 518   # Multiple zones
 *   npx tsx tools/ccx-bridge.ts --config path/to/cfg.json
 *   npx tsx tools/ccx-bridge.ts -v                       # Verbose (all CCX traffic)
 *   npx tsx tools/ccx-bridge.ts --decrypt -v             # Native decrypt MAC-encrypted frames
 *   npx tsx tools/ccx-bridge.ts --decrypt --key <hex>    # Custom master key
 */

import { spawn } from "child_process";
import { createSocket } from "dgram";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  CCX_CONFIG,
  getAllDevices,
  getPresetInfo,
  getZoneName,
  presetIdFromDeviceId,
} from "../ccx/config";
import { buildPacket, formatMessage, getMessageTypeName } from "../ccx/decoder";
import type { CCXDeviceReport, CCXPacket } from "../ccx/types";
import { formatAddr, parseFrame } from "../lib/ieee802154";
import { decryptMacFrame, deriveThreadKeys } from "../lib/thread-crypto";
import { generateWarmDimTable, getWarmDimCurve } from "../lib/warm-dim";

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
  join(
    (import.meta as any).dir ?? import.meta.dirname ?? __dirname,
    "..",
    "config",
    "ccx-bridge.json",
  );
const zoneArgs = getAllArgs("--zone");
const verbose = hasFlag("--verbose") || hasFlag("-v");
const snifferIface = getArg("--iface"); // tshark interface override
const decryptMode = hasFlag("--decrypt");
const masterKey = getArg("--key") ?? CCX_CONFIG.masterKey;

// ── Config ────────────────────────────────────────────────

interface PairingConfig {
  zoneId: number;
  wiz: string | string[]; // single IP or array of IPs
  name?: string; // override zone name from LEAP
  wizPort?: number;
  warmDimming?: boolean;
  warmDimCurve?: string;
  warmDimMin?: number;
  warmDimMax?: number;
}

interface BridgeConfigFile {
  pairings: PairingConfig[];
  defaults?: {
    wizPort?: number;
    warmDimming?: boolean;
    warmDimCurve?: string;
    warmDimMin?: number;
    warmDimMax?: number;
    wizDimScaling?: boolean;
  };
}

interface WizPairing {
  name: string;
  zoneId: number;
  wizIps: string[];
  wizPort: number;
  warmDimTable: number[] | null;
}

function loadConfig(): WizPairing[] {
  if (zoneArgs.length > 0) return []; // --zone mode, no pairings

  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error(`Create it or use --zone <id> for quick testing.`);
    process.exit(1);
  }

  const raw: BridgeConfigFile = JSON.parse(readFileSync(configPath, "utf-8"));
  wizDimScaling = raw.defaults?.wizDimScaling ?? true;
  const defaultPort = raw.defaults?.wizPort ?? 38899;
  const defaultWarmDim = raw.defaults?.warmDimming ?? false;
  const defaultCurve = raw.defaults?.warmDimCurve ?? "default";
  const defaultMin = raw.defaults?.warmDimMin;
  const defaultMax = raw.defaults?.warmDimMax;

  return raw.pairings.map((p) => {
    const warmDimming = p.warmDimming ?? defaultWarmDim;
    let warmDimTable: number[] | null = null;
    if (warmDimming) {
      const curveName = p.warmDimCurve ?? defaultCurve;
      const curve = getWarmDimCurve(curveName);
      const min = p.warmDimMin ?? defaultMin;
      const max = p.warmDimMax ?? defaultMax;
      warmDimTable = generateWarmDimTable(curve, min, max);
    }
    const wizIps = Array.isArray(p.wiz) ? p.wiz : [p.wiz];
    const zoneName = getZoneName(p.zoneId) ?? `Zone ${p.zoneId}`;
    return {
      name: p.name ?? zoneName,
      zoneId: p.zoneId,
      wizIps,
      wizPort: p.wizPort ?? defaultPort,
      warmDimTable,
    };
  });
}

let wizDimScaling = true; // default: scale Lutron 1-100% → Wiz 10-100%
const pairings = loadConfig();
const pairingsByZone = new Map<number, WizPairing>();
for (const p of pairings) pairingsByZone.set(p.zoneId, p);

// Build set of watched zone IDs
const watchedZones = new Set<number>();
if (zoneArgs.length > 0) {
  for (const z of zoneArgs) watchedZones.add(parseInt(z, 10));
} else {
  for (const p of pairings) watchedZones.add(p.zoneId);
}

// ── Scene/preset → zone → level lookup (from transfer capture decode) ──
// Generated by: npx tsx tools/decode-preset-assignments.ts --save
interface PresetZoneEntry {
  name: string;
  zones: Record<string, { level: number; fade?: number }>;
}
const presetZoneLookup = new Map<number, PresetZoneEntry>();

function loadPresetZones() {
  const lookupPath = join(
    (import.meta as any).dir ?? import.meta.dirname ?? __dirname,
    "..",
    "data",
    "preset-zones.json",
  );
  if (!existsSync(lookupPath)) return;
  try {
    const data: Record<string, PresetZoneEntry> = JSON.parse(
      readFileSync(lookupPath, "utf-8"),
    );
    for (const [id, entry] of Object.entries(data)) {
      presetZoneLookup.set(Number(id), entry);
    }
  } catch {}
}
loadPresetZones();

/** Get raise/lower direction from preset name (for DIM_HOLD/DIM_STEP) */
function _getPresetAction(deviceId: Uint8Array): "raise" | "lower" | null {
  const presetId = presetIdFromDeviceId(deviceId);
  const info = getPresetInfo(presetId);
  if (!info) return null;
  const name = info.name.toLowerCase();
  if (name === "raise") return "raise";
  if (name === "lower") return "lower";
  return null;
}

// ── Native decrypt state ──────────────────────────────────
// Short addr → EUI-64 mapping, pre-populated from LEAP device map
const addrTable = new Map<number, Buffer>();
const keyCache = new Map<number, Buffer>();

if (decryptMode) {
  for (const dev of getAllDevices()) {
    if (dev.eui64) {
      const eui64 = Buffer.from(dev.eui64.replace(/:/g, ""), "hex");
      if (eui64.length === 8) addrTable.set(-dev.serial, eui64);
    }
  }
}

function getMacKey(keySequence: number): Buffer {
  let key = keyCache.get(keySequence);
  if (!key) {
    key = deriveThreadKeys(Buffer.from(masterKey, "hex"), keySequence).macKey;
    keyCache.set(keySequence, key);
  }
  return key;
}

/** Reconstruct 802.15.4 frame from tshark fields and decrypt */
function reconstructAndDecrypt(fields: string[]): CCXPacket | null {
  const [
    epochStr,
    ,
    ,
    srcEui64Str,
    ,
    ,
    fcfStr,
    seqStr,
    dstPanStr,
    dst16Str,
    src16Str,
    secLevelStr,
    keyIdModeStr,
    frameCounterStr,
    keyIndexStr,
    dataHex,
    micHex,
  ] = fields;

  if (!dataHex || !micHex) return null;

  const fcf = parseInt(fcfStr, 16);
  const seqNo = parseInt(seqStr, 10);
  const dstPan = parseInt(dstPanStr, 16);
  const dst16 = parseInt(dst16Str, 16);
  const src16 = parseInt(src16Str, 16);
  const secLevel = parseInt(secLevelStr, 10);
  const keyIdMode = parseInt(keyIdModeStr, 10);
  const frameCounter = parseInt(frameCounterStr, 10);
  const keyIndex = parseInt(keyIndexStr, 10);

  if (Number.isNaN(fcf) || Number.isNaN(frameCounter)) return null;

  // Reconstruct the 802.15.4 header
  const headerParts: number[] = [];
  // Frame control (2 bytes LE)
  headerParts.push(fcf & 0xff, (fcf >> 8) & 0xff);
  // Sequence number
  headerParts.push(seqNo & 0xff);
  // Destination PAN (2 bytes LE)
  headerParts.push(dstPan & 0xff, (dstPan >> 8) & 0xff);
  // Destination short addr (2 bytes LE)
  headerParts.push(dst16 & 0xff, (dst16 >> 8) & 0xff);
  // Source short addr (2 bytes LE) — PAN compressed, no src PAN
  headerParts.push(src16 & 0xff, (src16 >> 8) & 0xff);
  // Aux security header: security control byte
  const secControl = (keyIdMode << 3) | secLevel;
  headerParts.push(secControl);
  // Frame counter (4 bytes LE)
  headerParts.push(
    frameCounter & 0xff,
    (frameCounter >> 8) & 0xff,
    (frameCounter >> 16) & 0xff,
    (frameCounter >> 24) & 0xff,
  );
  // Key index (1 byte for keyIdMode 1)
  if (keyIdMode >= 1) {
    headerParts.push(keyIndex & 0xff);
  }

  const header = Buffer.from(headerParts);
  const encPayload = Buffer.from(dataHex.replace(/:/g, ""), "hex");
  const mic = Buffer.from(micHex.replace(/:/g, ""), "hex");
  const frame = Buffer.concat([header, encPayload, mic]);

  const parsed = parseFrame(frame);
  if (!parsed.securityEnabled) return null;

  const keySeq = keyIndex > 0 ? keyIndex - 1 : 0;
  const macKey = getMacKey(keySeq);

  const tryWith = (eui64: Buffer) =>
    decryptMacFrame({
      frame,
      headerEnd: parsed.headerEnd,
      secLevel: parsed.secLevel,
      frameCounter: parsed.frameCounter,
      macKey,
      eui64,
    });

  let plaintext: Buffer | null = null;
  let matchedEui64 = Buffer.alloc(8);

  // Try tshark-provided EUI-64
  if (srcEui64Str?.includes(":")) {
    const eui64 = Buffer.from(srcEui64Str.replace(/:/g, ""), "hex");
    if (eui64.length === 8) {
      plaintext = tryWith(eui64);
      if (plaintext) matchedEui64 = eui64;
    }
  }

  // Try address table (short → EUI-64)
  if (!plaintext && !Number.isNaN(src16)) {
    const eui64 = addrTable.get(src16);
    if (eui64) {
      plaintext = tryWith(eui64);
      if (plaintext) matchedEui64 = eui64;
    }
  }

  // Brute-force all known EUI-64s
  if (!plaintext) {
    for (const [, eui64] of addrTable) {
      plaintext = tryWith(eui64);
      if (plaintext) {
        matchedEui64 = eui64;
        break;
      }
    }
  }

  if (!plaintext) return null;

  // Scan for CBOR array marker (0x82 = 2-element array)
  for (let i = 0; i < plaintext.length - 2; i++) {
    if (plaintext[i] !== 0x82) continue;
    try {
      const epoch = parseFloat(epochStr);
      const eui64Hex = matchedEui64
        .toString("hex")
        .replace(/(.{2})/g, "$1:")
        .slice(0, -1);
      return buildPacket({
        timestamp: new Date(epoch * 1000).toISOString(),
        srcAddr: formatAddr(parsed.srcAddr),
        dstAddr: formatAddr(parsed.dstAddr),
        srcEui64: eui64Hex,
        dstEui64: "",
        payloadHex: plaintext.subarray(i).toString("hex"),
      });
    } catch {
      /* try next offset */
    }
  }

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

const wizSocket = pairings.length > 0 ? createSocket("udp4") : null;

/** Scale Lutron 1-100% → Wiz 10-100% linearly. 0% = off. Disable with wizDimScaling: false. */
function lutronToWizDimming(lutronPercent: number): number {
  if (!wizDimScaling) return Math.round(lutronPercent);
  return Math.round(10 + (lutronPercent / 100) * 90);
}

async function sendWiz(pairing: WizPairing, levelPercent: number) {
  if (!wizSocket) return;
  const isOff = levelPercent <= 0;
  const wizDim = lutronToWizDimming(levelPercent);

  let payload: string;
  let cctInfo = "";
  if (isOff) {
    payload = JSON.stringify({ method: "setPilot", params: { state: false } });
  } else {
    const params: Record<string, any> = { state: true, dimming: wizDim };
    if (pairing.warmDimTable) {
      const cct = pairing.warmDimTable[Math.round(levelPercent)];
      params.temp = cct;
      cctInfo = ` ${cct}K`;
    }
    payload = JSON.stringify({ method: "setPilot", params });
  }

  const buf = Buffer.from(payload);
  const levelStr = isOff
    ? "OFF"
    : `${Math.round(levelPercent)}%→wiz${wizDim}%${cctInfo}`;

  await Promise.all(
    pairing.wizIps.map(
      (ip) =>
        new Promise<void>((resolve) => {
          wizSocket!.send(buf, pairing.wizPort, ip, (err) => {
            if (err) {
              console.error(`  [wiz] Error → ${ip}: ${err.message}`);
            } else {
              console.log(`  [wiz] → ${pairing.name} (${ip}) ${levelStr}`);
            }
            resolve();
          });
        }),
    ),
  );
}

// ── DEVICE_REPORT level extraction ────────────────────────
// Two known formats:
//   Format A: {0: cmdType, 1: {0: level_byte, 1: level_byte+1}, 2: 3}
//     level_byte is 0-254 scale (0xFE = 100%), seen from standalone dimmers
//   Format B: {3: [[4, Uint8Array([hi, lo]), 2]]}
//     level as uint16 BE in byte array (0xFEFF = 100%), seen from hybrid keypads

function _extractDeviceReportLevel(msg: CCXDeviceReport): number | null {
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
        return (level16 / 0xfeff) * 100;
      }
    }
  }

  return null;
}

// ── Dim Ramp (software raise/lower) ──────────────────────
// Lutron DIM_HOLD = start ramping, DIM_STEP = stop ramping.
// The device is supposed to ramp itself; we simulate for Wiz.

const RAMP_INTERVAL_MS = 100; // visual update tick
const RAMP_RATE_PCT_PER_SEC = 100 / 4.75; // 4.75s full range (19 quarter-seconds)

interface ActiveRamp {
  timer: ReturnType<typeof setInterval>;
  direction: "raise" | "lower";
  startLevel: number;
  startTime: number;
}

// Track current level per zone (updated by LEVEL_CONTROL and ramp)
const zoneLevel = new Map<number, number>();

// Active ramp timers per zone
const activeRamps = new Map<number, ActiveRamp>();

function computeRampLevel(
  startLevel: number,
  direction: "raise" | "lower",
  elapsedMs: number,
): number {
  const delta = (elapsedMs / 1000) * RAMP_RATE_PCT_PER_SEC;
  if (direction === "raise") {
    return Math.min(100, startLevel + delta);
  }
  return Math.max(1, startLevel - delta);
}

function startRamp(zoneId: number, direction: "raise" | "lower") {
  stopRamp(zoneId);
  const startLevel = zoneLevel.get(zoneId) ?? 50; // assume 50% if unknown
  const startTime = Date.now();
  const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
  const time = new Date().toISOString().slice(11, 23);
  console.log(
    `\n${time} ** RAMP ${direction.toUpperCase()} → ${zoneName} (zone=${zoneId}) from ${startLevel.toFixed(0)}%`,
  );

  const timer = setInterval(() => {
    const level = computeRampLevel(
      startLevel,
      direction,
      Date.now() - startTime,
    );
    zoneLevel.set(zoneId, level);

    const pairing = pairingsByZone.get(zoneId);
    if (pairing) sendWiz(pairing, level);

    // Stop at limits (lower stops at 1%, not 0% — off is a separate command)
    if (level >= 100 || level <= 1) {
      stopRamp(zoneId);
    }
  }, RAMP_INTERVAL_MS);

  activeRamps.set(zoneId, { timer, direction, startLevel, startTime });
}

function stopRamp(zoneId: number) {
  const ramp = activeRamps.get(zoneId);
  if (ramp) {
    clearInterval(ramp.timer);
    activeRamps.delete(zoneId);
    const elapsedMs = Date.now() - ramp.startTime;
    const finalLevel = computeRampLevel(
      ramp.startLevel,
      ramp.direction,
      elapsedMs,
    );
    zoneLevel.set(zoneId, finalLevel);

    // Send final Wiz update with corrected level
    const pairing = pairingsByZone.get(zoneId);
    if (pairing) sendWiz(pairing, finalLevel);

    const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
    const time = new Date().toISOString().slice(11, 23);
    console.log(
      `${time} ** RAMP STOP → ${zoneName} (zone=${zoneId}) at ${finalLevel.toFixed(0)}% (${elapsedMs}ms)`,
    );
  }
}

// ── Dispatch ──────────────────────────────────────────────

async function dispatch(
  zoneId: number,
  levelPercent: number,
  source: string,
  fade = 1,
) {
  zoneLevel.set(zoneId, levelPercent); // track current level
  const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
  const time = new Date().toISOString().slice(11, 23);
  const fadeSec = fade / 4;
  const fadeStr = fadeSec !== 0.25 ? ` fade=${fadeSec}s` : "";

  console.log(
    `\n${time} ** ${source} → ${zoneName} (zone=${zoneId}) ${levelPercent.toFixed(1)}%${fadeStr}`,
  );

  const pairing = pairingsByZone.get(zoneId);
  if (pairing) await sendWiz(pairing, levelPercent);
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

  // Learn short→EUI-64 mappings from any frame that has both
  if (decryptMode && fields.length >= 12) {
    const src16Str = fields[10];
    if (srcEui64?.includes(":") && src16Str) {
      const shortAddr = parseInt(src16Str, 16);
      if (!Number.isNaN(shortAddr) && shortAddr !== 0xffff) {
        const eui64 = Buffer.from(srcEui64.replace(/:/g, ""), "hex");
        if (eui64.length === 8 && !addrTable.has(shortAddr)) {
          addrTable.set(shortAddr, eui64);
          if (verbose) {
            console.log(`  [addr] learned ${src16Str} → ${srcEui64}`);
          }
        }
      }
    }
  }

  // Path 1: tshark-decoded UDP payload (existing path)
  if (dataHex) {
    const payloadHex = dataHex.replace(/:/g, "");
    if (payloadHex) {
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
  }

  // Path 2: MAC-encrypted frame — reconstruct and decrypt natively
  if (decryptMode && fields.length >= 17) {
    return reconstructAndDecrypt(fields);
  }

  return null;
}

function main() {
  const iface = snifferIface ?? detectSnifferDevice();

  console.log("CCX Bridge (tshark sniffer)");
  console.log("==========================");
  console.log(`Sniffer: ${iface}`);
  console.log(`Channel: ${CCX_CONFIG.channel}`);
  if (decryptMode) {
    console.log(`Decrypt: enabled (key: ${masterKey.slice(0, 8)}...)`);
    const addrCount = [...addrTable.values()].length;
    console.log(`Address table: ${addrCount} EUI-64s pre-loaded`);
  }
  if (pairings.length > 0) {
    console.log(`Pairings:`);
    for (const p of pairings) {
      const ips = p.wizIps.join(", ");
      if (p.warmDimTable) {
        console.log(
          `  ${p.name} (zone ${p.zoneId}) → ${ips} (warm dim: ${p.warmDimTable[0]}→${p.warmDimTable[100]}K)`,
        );
      } else {
        console.log(`  ${p.name} (zone ${p.zoneId}) → ${ips}`);
      }
    }
  } else if (watchedZones.size > 0) {
    const zoneList = [...watchedZones]
      .map((z) => `${z} (${getZoneName(z) ?? "?"})`)
      .join(", ");
    console.log(`Zones: ${zoneList} (log only)`);
  } else {
    console.log("Zones: ALL (no filter, log only)");
  }
  if (presetZoneLookup.size > 0) {
    console.log(
      `Scenes: ${presetZoneLookup.size} presets loaded from preset-zones.json`,
    );
  }
  console.log("");

  const displayFilter = decryptMode
    ? `udp.port == ${CCX_CONFIG.udpPort} or (wpan.security == 1 and wpan.frame_type == 1)`
    : `udp.port == ${CCX_CONFIG.udpPort}`;

  const tsharkArgs = [
    "-i",
    iface,
    "-l", // line-buffered
    "-Y",
    displayFilter,
    "-T",
    "fields",
    "-e",
    "frame.time_epoch",
    "-e",
    "ipv6.src",
    "-e",
    "ipv6.dst",
    "-e",
    "wpan.src64",
    "-e",
    "wpan.dst64",
    "-e",
    "udp.payload",
    // Additional fields for native decryption
    ...(decryptMode
      ? [
          "-e",
          "wpan.fcf",
          "-e",
          "wpan.seq_no",
          "-e",
          "wpan.dst_pan",
          "-e",
          "wpan.dst16",
          "-e",
          "wpan.src16",
          "-e",
          "wpan.aux_sec.sec_level",
          "-e",
          "wpan.aux_sec.key_id_mode",
          "-e",
          "wpan.aux_sec.frame_counter",
          "-e",
          "wpan.aux_sec.key_index",
          "-e",
          "data.data",
          "-e",
          "wpan.mic",
        ]
      : []),
    "-E",
    "separator=\t",
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
      console.log(
        `${time} ${typeName} ${formatMessage(pkt.parsed)}  [${pkt.srcAddr} → ${pkt.dstAddr}]`,
      );

      // Handle LEVEL_CONTROL (processor → devices, multicast)
      if (pkt.parsed.type === "LEVEL_CONTROL") {
        const { zoneId, sequence, levelPercent, fade } = pkt.parsed;
        if (watchedZones.size > 0 && !watchedZones.has(zoneId)) continue;
        if (isDuplicate(`lc:${zoneId}:${sequence}`)) continue;
        matchCount++;
        dispatch(zoneId, levelPercent, "LEVEL", fade);
        continue;
      }

      // DEVICE_REPORT — informational only (physical dimmer feedback)
      // Not used for bridging; LEVEL_CONTROL and BUTTON_PRESS drive WiZ output

      // Handle BUTTON_PRESS — all presets (On/Off/scenes) resolved via preset-zones.json
      if (pkt.parsed.type === "BUTTON_PRESS") {
        const presetId = presetIdFromDeviceId(pkt.parsed.deviceId);
        if (isDuplicate(`bp:${presetId}:${pkt.parsed.sequence}`)) continue;

        const sceneEntry = presetZoneLookup.get(presetId);
        if (sceneEntry) {
          for (const [zid, assignment] of Object.entries(sceneEntry.zones)) {
            const zoneId = Number(zid);
            if (watchedZones.size > 0 && !watchedZones.has(zoneId)) continue;
            matchCount++;
            dispatch(
              zoneId,
              assignment.level,
              `PRESET(${sceneEntry.name})`,
              assignment.fade,
            );
          }
        }
        continue;
      }

      // Handle DIM_HOLD (raise/lower start) — resolve zones from preset-zones lookup
      if (pkt.parsed.type === "DIM_HOLD") {
        const { action, sequence } = pkt.parsed;
        const { zoneId } = pkt.parsed;
        if (isDuplicate(`dh:${zoneId || "p"}:${sequence}`)) continue;
        const direction = action === 3 ? "raise" : "lower";

        if (zoneId && (watchedZones.size === 0 || watchedZones.has(zoneId))) {
          matchCount++;
          startRamp(zoneId, direction);
        } else {
          // Resolve from preset-zones: find watched zones affected by this preset
          const presetId = presetIdFromDeviceId(pkt.parsed.deviceId);
          const entry = presetZoneLookup.get(presetId);
          if (entry) {
            for (const zid of Object.keys(entry.zones)) {
              const z = Number(zid);
              if (watchedZones.size > 0 && !watchedZones.has(z)) continue;
              matchCount++;
              startRamp(z, direction);
            }
          }
        }
        continue;
      }

      // Handle DIM_STEP (raise/lower release)
      if (pkt.parsed.type === "DIM_STEP") {
        const { zoneId, sequence } = pkt.parsed;
        if (isDuplicate(`ds:${zoneId || "p"}:${sequence}`)) continue;

        if (zoneId && (watchedZones.size === 0 || watchedZones.has(zoneId))) {
          matchCount++;
          stopRamp(zoneId);
        } else {
          const presetId = presetIdFromDeviceId(pkt.parsed.deviceId);
          const entry = presetZoneLookup.get(presetId);
          if (entry) {
            for (const zid of Object.keys(entry.zones)) {
              const z = Number(zid);
              if (watchedZones.size > 0 && !watchedZones.has(z)) continue;
              matchCount++;
              stopRamp(z);
            }
          }
        }
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
    console.log(
      `\n${packetCount} packets seen, ${matchCount} level commands forwarded.`,
    );
    wizSocket?.close();
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => {
    console.log("\nStopping...");
    tshark.kill("SIGINT");
  });
}

main();
