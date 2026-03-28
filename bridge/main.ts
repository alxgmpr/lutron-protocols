#!/usr/bin/env -S npx tsx

/**
 * CCX→WiZ Bridge — Container entry point
 *
 * Captures Lutron Thread traffic via nRF sniffer dongle (direct serial),
 * decrypts and decodes CCX CBOR messages, and forwards level/scene/button
 * commands to WiZ smart bulbs over UDP.
 *
 * Config sources (in priority order):
 *   1. HA add-on options: /data/options.json (all config in HA UI)
 *   2. YAML file: CCX_CONFIG_PATH or /config/ccx-bridge.yaml
 *   3. Environment variables for individual overrides
 *
 * Data files (LEAP dumps, preset-zones):
 *   CCX_DATA_DIR (default: /config for container, ../data for local dev)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ── Load HA options.json if present ──────────────────────

interface HAOptions {
  thread_channel?: number;
  thread_master_key?: string;
  sniffer_device?: string;
  wiz_port?: number;
  pairings?: Array<{
    zone_id: number;
    name?: string;
    wiz_ips: string[];
  }>;
}

let haOptions: HAOptions | null = null;
const HA_OPTIONS_PATH = "/data/options.json";
if (existsSync(HA_OPTIONS_PATH)) {
  try {
    haOptions = JSON.parse(readFileSync(HA_OPTIONS_PATH, "utf8"));
  } catch {}
}

// Set CCX_DATA_DIR BEFORE importing ccx/config (which loads LEAP data at import time).
const configDir = process.env.CCX_DATA_DIR ?? "/config";
if (!process.env.CCX_DATA_DIR && existsSync(configDir)) {
  process.env.CCX_DATA_DIR = configDir;
}

async function main() {
  const { CCX_CONFIG, getAllDevices, resolveDataDir } = await import(
    "../ccx/config"
  );
  const {
    BridgeCore,
    loadBridgeConfig,
    loadBridgeConfigFromOptions,
    loadPresetZones,
  } = await import("../lib/bridge-core");
  const { FramePipeline } = await import("../lib/frame-pipeline");
  const { SerialSniffer, detectSnifferPort } = await import(
    "../lib/serial-sniffer"
  );

  // ── Config resolution ─────────────────────────────────────

  const snifferDevice =
    process.env.SNIFFER_DEVICE ??
    haOptions?.sniffer_device ??
    detectSnifferPort();
  const channel = process.env.THREAD_CHANNEL
    ? parseInt(process.env.THREAD_CHANNEL, 10)
    : (haOptions?.thread_channel ?? CCX_CONFIG.channel);
  const masterKey =
    process.env.THREAD_MASTER_KEY ??
    haOptions?.thread_master_key ??
    CCX_CONFIG.masterKey;

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

  const { pairings } =
    haOptions?.pairings && haOptions.pairings.length > 0
      ? loadBridgeConfigFromOptions(haOptions)
      : loadBridgeConfig(
          process.env.CCX_CONFIG_PATH ?? join(configDir, "ccx-bridge.yaml"),
        );

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
  });

  // ── Fetch per-bulb calibration data ───────────────────────

  await bridge.fetchCctTables();

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

  const configSource = haOptions?.pairings?.length
    ? "HA options"
    : "config file";
  console.log("CCX→WiZ Bridge (serial sniffer)");
  console.log("================================");
  console.log(`Config:  ${configSource}`);
  console.log(`Sniffer: ${snifferDevice}`);
  console.log(`Channel: ${channel}`);
  console.log(`Decrypt: enabled (key: ${masterKey.slice(0, 8)}...)`);
  console.log(`Address table: ${pipeline.addressCount} EUI-64s pre-loaded`);

  if (pairings.length > 0) {
    console.log(`Pairings:`);
    for (const p of pairings) {
      const ips = p.wizIps.join(", ");
      console.log(`  ${p.name} (zone ${p.zoneId}) → ${ips}`);
    }
    console.log(`CCT: native (key 6) or warm dim (key 5=5 → B-spline)`);
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
