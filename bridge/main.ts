#!/usr/bin/env -S npx tsx

/**
 * CCX→WiZ Bridge — Container entry point
 *
 * Captures Lutron Thread traffic via nRF sniffer dongle (direct serial),
 * decrypts and decodes CCX CBOR messages, and forwards level/scene/button
 * commands to WiZ smart bulbs over UDP.
 *
 * Designed to run in Docker on a Raspberry Pi with the nRF dongle attached.
 *
 * Config:
 *   /config/ccx-bridge.json   — zone→WiZ pairings
 *   /config/preset-zones.json — scene preset data
 *   /config/leap-*.json       — LEAP dump data (zone names, device map)
 *
 * Environment:
 *   SNIFFER_DEVICE    — serial port (default: /dev/ttyACM0)
 *   THREAD_CHANNEL    — 802.15.4 channel (default: from LEAP data)
 *   THREAD_MASTER_KEY — Thread master key hex (default: from LEAP data)
 *   CCX_DATA_DIR      — path to LEAP/device data (default: /config)
 *   CCX_CONFIG_PATH   — path to ccx-bridge.json (default: /config/ccx-bridge.json)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// HA add-on: read /data/options.json and apply as env var fallbacks
const HA_OPTIONS = "/data/options.json";
if (existsSync(HA_OPTIONS)) {
  try {
    const opts = JSON.parse(readFileSync(HA_OPTIONS, "utf8"));
    if (opts.thread_channel && !process.env.THREAD_CHANNEL)
      process.env.THREAD_CHANNEL = String(opts.thread_channel);
    if (opts.thread_master_key && !process.env.THREAD_MASTER_KEY)
      process.env.THREAD_MASTER_KEY = opts.thread_master_key;
  } catch {}
}

// Set CCX_DATA_DIR BEFORE importing ccx/config (which loads LEAP data at import time).
// Must happen before dynamic import() since ESM hoists static imports.
const configDir = process.env.CCX_DATA_DIR ?? "/config";
if (!process.env.CCX_DATA_DIR && existsSync(configDir)) {
  process.env.CCX_DATA_DIR = configDir;
}

async function main() {
  // Dynamic imports — ccx/config reads CCX_DATA_DIR at module load time
  const { CCX_CONFIG, getAllDevices, resolveDataDir } = await import(
    "../ccx/config"
  );
  const { BridgeCore, loadBridgeConfig, loadPresetZones } = await import(
    "../lib/bridge-core"
  );
  const { FramePipeline } = await import("../lib/frame-pipeline");
  const { SerialSniffer, detectSnifferPort } = await import(
    "../lib/serial-sniffer"
  );

  // ── Config resolution ─────────────────────────────────────

  const configPath =
    process.env.CCX_CONFIG_PATH ?? join(configDir, "ccx-bridge.json");
  const snifferDevice = process.env.SNIFFER_DEVICE ?? detectSnifferPort();
  const channel = process.env.THREAD_CHANNEL
    ? parseInt(process.env.THREAD_CHANNEL, 10)
    : CCX_CONFIG.channel;
  const masterKey = process.env.THREAD_MASTER_KEY ?? CCX_CONFIG.masterKey;

  if (!masterKey) {
    console.error(
      "Error: No Thread master key. Set THREAD_MASTER_KEY or provide LEAP data.",
    );
    process.exit(1);
  }
  if (!channel) {
    console.error(
      "Error: No Thread channel. Set THREAD_CHANNEL or provide LEAP data.",
    );
    process.exit(1);
  }

  // ── Load config ───────────────────────────────────────────

  const { pairings, wizDimScaling } = loadBridgeConfig(configPath);
  const dataDir = resolveDataDir();
  const presetZones = loadPresetZones(dataDir);

  const watchedZones = new Set<number>();
  for (const p of pairings) watchedZones.add(p.zoneId);

  // ── Build pipeline ────────────────────────────────────────

  const devices = getAllDevices().map((d: any) => ({
    serial: d.serial,
    eui64: d.eui64,
  }));

  const sniffer = new SerialSniffer({ port: snifferDevice, channel });
  const pipeline = new FramePipeline({ masterKey, knownDevices: devices });
  const bridge = new BridgeCore({
    pairings,
    presetZones,
    watchedZones,
    wizDimScaling,
  });

  // ── Wire everything together ──────────────────────────────

  pipeline.onAddressLearned = (shortAddr: number, eui64: string) => {
    console.log(`  [addr] learned 0x${shortAddr.toString(16)} → ${eui64}`);
  };

  bridge.on("log", (msg: string) => {
    console.log(msg);
  });

  sniffer.on("frame", (frame: Buffer) => {
    const pkt = pipeline.process(frame);
    if (pkt) bridge.handlePacket(pkt);
  });

  sniffer.on("error", (err: Error) => {
    console.error(`[sniffer] ${err.message}`);
  });

  sniffer.on("closed", () => {
    console.log("[sniffer] Port closed, will reconnect...");
  });

  sniffer.on("ready", () => {
    console.log("Listening... (Ctrl+C to stop)\n");
  });

  // ── Startup banner ────────────────────────────────────────

  console.log("CCX→WiZ Bridge (serial sniffer)");
  console.log("================================");
  console.log(`Sniffer: ${snifferDevice}`);
  console.log(`Channel: ${channel}`);
  console.log(`Decrypt: enabled (key: ${masterKey.slice(0, 8)}...)`);
  console.log(`Address table: ${pipeline.addressCount} EUI-64s pre-loaded`);

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
  }

  if (presetZones.size > 0) {
    console.log(
      `Scenes: ${presetZones.size} presets loaded from preset-zones.json`,
    );
  }
  console.log("");

  // ── Start ─────────────────────────────────────────────────

  sniffer.start().catch((err: Error) => {
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

  process.on("SIGTERM", () => {
    sniffer.stop();
    bridge.destroy();
    process.exit(0);
  });
}

main();
