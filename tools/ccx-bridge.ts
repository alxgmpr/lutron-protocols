#!/usr/bin/env -S npx tsx

/**
 * CCX Bridge — Listen for Lutron level changes on Thread, forward to external outputs.
 *
 * Captures both:
 *   - LEVEL_CONTROL (processor → devices, multicast) — app/scene commands
 *   - DEVICE_REPORT (device → processor, unicast) — physical dimmer touches
 *
 * Two capture modes:
 *   --serial   Direct serial to nRF sniffer dongle (no tshark needed)
 *   (default)  tshark + nRF sniffer extcap (macOS, requires Wireshark)
 *
 * Usage:
 *   npx tsx tools/ccx-bridge.ts --serial                  # Direct serial (recommended)
 *   npx tsx tools/ccx-bridge.ts --serial --port /dev/X    # Custom serial port
 *   npx tsx tools/ccx-bridge.ts                           # tshark mode (legacy)
 *   npx tsx tools/ccx-bridge.ts --zone 3697               # Single zone, log only
 *   npx tsx tools/ccx-bridge.ts --zone 3697 --zone 518    # Multiple zones
 *   npx tsx tools/ccx-bridge.ts --config path/to/cfg.json
 *   npx tsx tools/ccx-bridge.ts -v                        # Verbose (all CCX traffic)
 *   npx tsx tools/ccx-bridge.ts --decrypt -v              # Native decrypt (tshark mode)
 *   npx tsx tools/ccx-bridge.ts --decrypt --key <hex>     # Custom master key
 */

import { spawn } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  CCX_CONFIG,
  getAllDevices,
  getZoneName,
  resolveDataDir,
} from "../ccx/config";
import { buildPacket } from "../ccx/decoder";
import type { CCXPacket } from "../ccx/types";
import {
  BridgeCore,
  loadBridgeConfig,
  loadPresetZones,
} from "../lib/bridge-core";
import { FramePipeline } from "../lib/frame-pipeline";
import { formatAddr, parseFrame } from "../lib/ieee802154";
import { detectSnifferPort, SerialSniffer } from "../lib/serial-sniffer";
import { decryptMacFrame, deriveThreadKeys } from "../lib/thread-crypto";

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
    "ccx-bridge.yaml",
  );
const zoneArgs = getAllArgs("--zone");
const verbose = hasFlag("--verbose") || hasFlag("-v");
const snifferIface = getArg("--iface"); // tshark interface override
const serialMode = hasFlag("--serial");
const serialPort = getArg("--port"); // serial port override for --serial
const decryptMode = hasFlag("--decrypt") || serialMode; // serial always decrypts
const masterKey = getArg("--key") ?? CCX_CONFIG.masterKey;

// ── Config ────────────────────────────────────────────────

let wizDimScaling = true;
let pairings: import("../lib/bridge-core").WizPairing[] = [];

if (zoneArgs.length === 0) {
  try {
    const cfg = loadBridgeConfig(configPath);
    pairings = cfg.pairings;
    wizDimScaling = cfg.wizDimScaling;
  } catch (err: any) {
    console.error(err.message);
    console.error(`Create it or use --zone <id> for quick testing.`);
    process.exit(1);
  }
}

// Build set of watched zone IDs
const watchedZones = new Set<number>();
if (zoneArgs.length > 0) {
  for (const z of zoneArgs) watchedZones.add(parseInt(z, 10));
} else {
  for (const p of pairings) watchedZones.add(p.zoneId);
}

// Load preset zones
const dataDir = resolveDataDir();
const presetZoneLookup = loadPresetZones(dataDir);

// ── Serial mode ───────────────────────────────────────────

function runSerialMode() {
  const devices = getAllDevices().map((d) => ({
    serial: d.serial,
    eui64: d.eui64,
  }));
  const port = serialPort ?? detectSnifferPort();
  const channel = CCX_CONFIG.channel;

  const sniffer = new SerialSniffer({ port, channel });
  const pipeline = new FramePipeline({ masterKey, knownDevices: devices });
  const bridge = new BridgeCore({
    pairings,
    presetZones: presetZoneLookup,
    watchedZones,
    wizDimScaling,
  });

  pipeline.onAddressLearned = (shortAddr, eui64) => {
    if (verbose)
      console.log(`  [addr] learned 0x${shortAddr.toString(16)} → ${eui64}`);
  };

  bridge.on("log", (msg: string) => console.log(msg));

  sniffer.on("frame", (frame: Buffer) => {
    const pkt = pipeline.process(frame);
    if (pkt) bridge.handlePacket(pkt);
  });

  sniffer.on("error", (err: Error) =>
    console.error(`[sniffer] ${err.message}`),
  );
  sniffer.on("closed", () =>
    console.log("[sniffer] Port closed, will reconnect..."),
  );
  sniffer.on("ready", () => console.log("Listening... (Ctrl+C to stop)\n"));

  // Banner
  console.log("CCX Bridge (serial sniffer)");
  console.log("==========================");
  console.log(`Sniffer: ${port}`);
  console.log(`Channel: ${channel}`);
  console.log(`Decrypt: enabled (key: ${masterKey.slice(0, 8)}...)`);
  console.log(`Address table: ${pipeline.addressCount} EUI-64s pre-loaded`);
  printPairings();
  console.log("");

  sniffer.start().catch((err) => {
    console.error(`Failed to start sniffer: ${err.message}`);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    console.log("\nStopping...");
    sniffer.stop();
    console.log(
      `\n${bridge.packetCount} packets seen, ${bridge.matchCount} level commands forwarded.`,
    );
    bridge.destroy();
    process.exit(0);
  });
}

// ── tshark mode (legacy) ──────────────────────────────────

// Native decrypt state (only for tshark mode)
const addrTable = new Map<number, Buffer>();
const keyCache = new Map<number, Buffer>();

if (decryptMode && !serialMode) {
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
  headerParts.push(fcf & 0xff, (fcf >> 8) & 0xff);
  headerParts.push(seqNo & 0xff);
  headerParts.push(dstPan & 0xff, (dstPan >> 8) & 0xff);
  headerParts.push(dst16 & 0xff, (dst16 >> 8) & 0xff);
  headerParts.push(src16 & 0xff, (src16 >> 8) & 0xff);
  const secControl = (keyIdMode << 3) | secLevel;
  headerParts.push(secControl);
  headerParts.push(
    frameCounter & 0xff,
    (frameCounter >> 8) & 0xff,
    (frameCounter >> 16) & 0xff,
    (frameCounter >> 24) & 0xff,
  );
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

  if (srcEui64Str?.includes(":")) {
    const eui64 = Buffer.from(srcEui64Str.replace(/:/g, ""), "hex");
    if (eui64.length === 8) {
      plaintext = tryWith(eui64);
      if (plaintext) matchedEui64 = eui64;
    }
  }

  if (!plaintext && !Number.isNaN(src16)) {
    const eui64 = addrTable.get(src16);
    if (eui64) {
      plaintext = tryWith(eui64);
      if (plaintext) matchedEui64 = eui64;
    }
  }

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

  if (decryptMode && fields.length >= 17) {
    return reconstructAndDecrypt(fields);
  }

  return null;
}

function detectSnifferDevice(): string {
  const candidates = [
    "/dev/cu.usbmodem201401",
    "/dev/cu.usbmodem0004401800001",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  try {
    const entries = readdirSync("/dev")
      .filter((e) => e.startsWith("cu.usbmodem"))
      .sort();
    if (entries.length > 0) return `/dev/${entries[0]}`;
  } catch {}
  return "/dev/cu.usbmodem201401";
}

// ── Shared helpers ────────────────────────────────────────

function printPairings() {
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
}

// ── tshark mode entry ─────────────────────────────────────

function runTsharkMode() {
  const bridge = new BridgeCore({
    pairings,
    presetZones: presetZoneLookup,
    watchedZones,
    wizDimScaling,
  });

  bridge.on("log", (msg: string) => console.log(msg));

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
  printPairings();
  console.log("");

  const displayFilter = decryptMode
    ? `udp.port == ${CCX_CONFIG.udpPort} or (wpan.security == 1 and wpan.frame_type == 1)`
    : `udp.port == ${CCX_CONFIG.udpPort}`;

  const extcapKey = iface.replace(/\//g, "_").replace(/\./g, "_");

  const tsharkArgs = [
    "-i",
    iface,
    "-o",
    `extcap.${extcapKey}.channel:${CCX_CONFIG.channel}`,
    "-o",
    `extcap.${extcapKey}.metadata:ieee802154-tap`,
    "-l",
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

  tshark.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const pkt = processLine(line);
      if (!pkt) continue;
      bridge.handlePacket(pkt);
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
      if (pkt) bridge.handlePacket(pkt);
    }
    console.log(
      `\n${bridge.packetCount} packets seen, ${bridge.matchCount} level commands forwarded.`,
    );
    bridge.destroy();
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => {
    console.log("\nStopping...");
    tshark.kill("SIGINT");
  });
}

// ── Main ──────────────────────────────────────────────────

if (serialMode) {
  runSerialMode();
} else {
  runTsharkMode();
}
