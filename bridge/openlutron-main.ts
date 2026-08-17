#!/usr/bin/env -S npx tsx

/**
 * openlutron bridge — container entry point.
 *
 * Takes the openlutron board's UDP :9433 stream — CCA from the CC1101, CCX from
 * the nRF52840 — decodes both, and publishes what it hears to MQTT with Home
 * Assistant discovery. WiZ pairings are driven from the same model.
 *
 * This file only turns add-on options into arguments; the wiring and every
 * behaviour worth testing live in lib/openlutron-bridge.ts.
 *
 * Two differences from the CCX-WiZ add-on this supersedes:
 *
 *   - No sniffer dongle, and no Thread credentials. The board is a Thread node,
 *     so CCX frames arrive already decrypted; there is nothing here to key.
 *   - It needs the network instead of /dev/ttyACM0.
 *
 * Read path only. Home Assistant observes; it does not command. The one thing
 * this sends is the DEVICE_REPORT state injection, and that goes to the board.
 *
 * Config sources, in priority order:
 *   1. HA add-on options: /data/options.json
 *   2. Environment variables
 *
 * Data files (LEAP dumps, preset-zones): CCX_DATA_DIR, default /config.
 */

import { existsSync, readFileSync } from "fs";

// ── HA options ────────────────────────────────────────────

interface HAOptions {
  openlutron_host?: string;
  report_state?: boolean;
  mqtt_url?: string;
  mqtt_username?: string;
  mqtt_password?: string;
  mqtt_base_topic?: string;
  mqtt_discovery_prefix?: string;
  device_serials?: Array<{ zone_id: number; serial: number }>;
  pairings?: Array<{ zone_id: number; name?: string; wiz_ips: string[] }>;
}

let haOptions: HAOptions | null = null;
const HA_OPTIONS_PATH = "/data/options.json";
if (existsSync(HA_OPTIONS_PATH)) {
  try {
    haOptions = JSON.parse(readFileSync(HA_OPTIONS_PATH, "utf8"));
  } catch {
    // A malformed options file is reported below, once the logger exists.
  }
}

// ccx/config reads LEAP data lazily; set the directory up front so every later
// lookup resolves against the same one.
const configDir = process.env.CCX_DATA_DIR ?? "/config";
if (!process.env.CCX_DATA_DIR && existsSync(configDir)) {
  process.env.CCX_DATA_DIR = configDir;
}

async function main() {
  const { resolveDataDir } = await import("../ccx/config");
  const { loadBridgeConfigFromOptions, loadPresetZones } = await import(
    "../lib/bridge-core"
  );
  const { OpenlutronBridge, OPENLUTRON_SOURCE_NAME } = await import(
    "../lib/openlutron-bridge"
  );

  const host = process.env.OPEN_BRIDGE_HOST ?? haOptions?.openlutron_host ?? "";
  if (!host) {
    console.error(
      "Error: no openlutron host. Set openlutron_host in the add-on options, or OPEN_BRIDGE_HOST.",
    );
    process.exit(1);
  }

  // ── Config ──────────────────────────────────────────────

  const { pairings } = haOptions?.pairings?.length
    ? loadBridgeConfigFromOptions(haOptions)
    : { pairings: [] };

  const presetZones = loadPresetZones(resolveDataDir());

  // An empty watch list means every zone, which is what a pure observer wants.
  // Pairings narrow it only because a WiZ bulb has to be driven deliberately.
  const watchedZones = new Set<number>();
  for (const p of pairings) watchedZones.add(p.zoneId);

  const deviceSerials = new Map<number, number>();
  for (const entry of haOptions?.device_serials ?? []) {
    if (entry.zone_id && entry.serial) {
      deviceSerials.set(entry.zone_id, entry.serial);
    }
  }

  // State injection goes back to the same board, and only when there are
  // serials to inject under.
  const reportHost =
    haOptions?.report_state !== false && deviceSerials.size > 0
      ? host
      : undefined;

  // ── MQTT ────────────────────────────────────────────────

  const mqttUrl = process.env.MQTT_URL ?? haOptions?.mqtt_url ?? "";
  const mqttBaseTopic =
    process.env.MQTT_BASE_TOPIC ?? haOptions?.mqtt_base_topic ?? "lutron";
  const discoveryPrefix =
    process.env.MQTT_DISCOVERY_PREFIX ?? haOptions?.mqtt_discovery_prefix;

  let mqtt: ConstructorParameters<typeof OpenlutronBridge>[0]["mqtt"];
  if (mqttUrl) {
    const { connectMqttClient } = await import("../lib/bridge/sinks/mqtt");
    try {
      const client = await connectMqttClient({
        url: mqttUrl,
        username: process.env.MQTT_USERNAME ?? haOptions?.mqtt_username,
        password: process.env.MQTT_PASSWORD ?? haOptions?.mqtt_password,
        clientId: "openlutron-bridge",
        baseTopic: mqttBaseTopic,
      });
      mqtt = { client, baseTopic: mqttBaseTopic, discoveryPrefix };
    } catch (err) {
      // A broker that is down is not a reason to stop decoding packets. The
      // client reconnects on its own; this only catches setup failures.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mqtt] setup failed, continuing without it: ${message}`);
    }
  }

  // ── Build ───────────────────────────────────────────────

  const bridge = new OpenlutronBridge({
    host,
    pairings,
    presetZones,
    watchedZones,
    reportHost,
    deviceSerials: deviceSerials.size > 0 ? deviceSerials : undefined,
    mqtt,
    log: (msg: string) => console.log(msg),
  });

  // ── Banner ──────────────────────────────────────────────

  console.log("openlutron Bridge (CCA + CCX → MQTT)");
  console.log("=====================================");
  console.log(`Board:   ${host}:9433 (CCA + CCX over one stream)`);
  console.log(
    `MQTT:    ${mqtt ? `${mqttUrl} (topics under ${mqttBaseTopic}/)` : "disabled"}`,
  );
  if (mqtt) {
    console.log(
      `Health:  ${mqttBaseTopic}/bridge/source/${OPENLUTRON_SOURCE_NAME}/availability`,
    );
  }
  console.log(
    `Report:  ${reportHost ? `DEVICE_REPORT → ${reportHost} (${deviceSerials.size} serials)` : "disabled"}`,
  );
  if (pairings.length > 0) {
    console.log("WiZ pairings:");
    for (const p of pairings) {
      const curve = p.warmDimCurve ? ` [${p.warmDimCurve}]` : "";
      console.log(
        `  ${p.name} (zone ${p.zoneId}) → ${p.wizIps.join(", ")}${curve}`,
      );
    }
  } else {
    console.log("WiZ:     no pairings — observing only");
  }
  if (presetZones.size > 0) {
    console.log(`Scenes:  ${presetZones.size} presets from preset-zones.json`);
  }
  console.log("");

  // ── Run ─────────────────────────────────────────────────

  // Deliberately not awaiting a reachable board: the stream reports the board
  // down and keeps re-registering, so an add-on that starts before its hardware
  // recovers on its own.
  await bridge.start();
  console.log("Listening... (Ctrl+C to stop)\n");

  const shutdown = () => {
    console.log("\nShutting down...");
    bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
