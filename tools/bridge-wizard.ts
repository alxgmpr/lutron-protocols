#!/usr/bin/env -S npx tsx

/**
 * Bridge Config Wizard — Interactive setup for CCX→WiZ bridge pairings.
 *
 * Discovers WiZ bulbs on the LAN via UDP broadcast, loads Lutron zones from
 * LEAP dump data, and walks through pairing bulbs to zones. Supports multiple
 * bulbs per zone (e.g., "Lamps" zone → 2 smart bulbs).
 *
 * Usage:
 *   npx tsx tools/bridge-wizard.ts                          # Full interactive flow
 *   npx tsx tools/bridge-wizard.ts --no-discover            # Skip UDP discovery
 *   npx tsx tools/bridge-wizard.ts --config /tmp/test.json  # Custom output path
 */

import { createSocket } from "dgram";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { networkInterfaces } from "os";
import { dirname, join } from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";
import YAML from "yaml";
import { getAllZonesWithControlType, getZoneName } from "../ccx/config";
import { WARM_DIM_CURVES } from "../lib/warm-dim";

// ── CLI args ──────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(name);

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dir, "..");
const configPath =
  getArg("--config") ?? join(projectRoot, "config", "ccx-bridge.yaml");
const noDiscover = hasFlag("--no-discover");

// ── Config interfaces (same shape as ccx-bridge.ts) ──────

interface PairingConfig {
  zoneId: number;
  wiz: string | string[];
  name?: string;
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

// ── WiZ bulb discovery info ──────────────────────────────

interface WizBulb {
  ip: string;
  mac: string;
  module?: string;
  state?: boolean;
  dimming?: number;
  temp?: number;
}

// ── Readline helpers ─────────────────────────────────────

let rl: readline.Interface;

function initReadline() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("close", () => {
    console.log("\nAborted.");
    process.exit(0);
  });
}

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function askYesNo(prompt: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`${prompt} (${hint}) `);
  if (answer === "") return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

async function askChoice(
  prompt: string,
  items: string[],
  allowSkip = false,
): Promise<number> {
  console.log(prompt);
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}. ${items[i]}`);
  }
  if (allowSkip) console.log("  0. Skip");

  while (true) {
    const raw = await ask("> ");
    const n = parseInt(raw, 10);
    if (allowSkip && n === 0) return -1;
    if (n >= 1 && n <= items.length) return n - 1;
    console.log(
      `  Enter a number 1-${items.length}${allowSkip ? " (or 0 to skip)" : ""}`,
    );
  }
}

/** Ask for multiple selections from a list. Returns array of selected indices. */
async function askMultiChoice(
  prompt: string,
  items: string[],
): Promise<number[]> {
  console.log(prompt);
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}. ${items[i]}`);
  }
  console.log(`\n  Enter numbers separated by commas (e.g. 1,3) or "all"`);

  while (true) {
    const raw = await ask("> ");
    if (raw.toLowerCase() === "all") {
      return items.map((_, i) => i);
    }
    const parts = raw.split(/[,\s]+/).filter(Boolean);
    const indices: number[] = [];
    let valid = true;
    for (const p of parts) {
      const n = parseInt(p, 10);
      if (n >= 1 && n <= items.length) {
        indices.push(n - 1);
      } else {
        console.log(`  Invalid: ${p}. Enter numbers 1-${items.length}.`);
        valid = false;
        break;
      }
    }
    if (valid && indices.length > 0) return [...new Set(indices)];
    if (valid) console.log("  Select at least one.");
  }
}

// ── WiZ discovery ────────────────────────────────────────

function getLocalIp(): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "0.0.0.0";
}

async function discoverWizBulbs(): Promise<WizBulb[]> {
  const localIp = getLocalIp();
  const bulbs = new Map<string, WizBulb>();

  const sock = createSocket("udp4");

  await new Promise<void>((resolve, reject) => {
    sock.bind(0, () => {
      sock.setBroadcast(true);
      resolve();
    });
    sock.on("error", reject);
  });

  const registration = JSON.stringify({
    method: "registration",
    params: {
      phoneMac: "AAAAAAAAAAAA",
      register: false,
      phoneIp: localIp,
      id: "1",
    },
  });

  sock.on("message", (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.result?.mac) {
        bulbs.set(data.result.mac, {
          ip: rinfo.address,
          mac: data.result.mac,
          module: data.result.moduleName,
        });
      }
    } catch {
      /* ignore */
    }
  });

  // Send broadcast 3 times over 3 seconds for reliability
  const buf = Buffer.from(registration);
  for (let i = 0; i < 3; i++) {
    sock.send(buf, 38899, "255.255.255.255");
    await new Promise((r) => setTimeout(r, 1000));
  }

  sock.close();
  return [...bulbs.values()];
}

async function getPilotInfo(bulb: WizBulb): Promise<void> {
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    const payload = JSON.stringify({ method: "getPilot", params: {} });
    let done = false;

    sock.send(Buffer.from(payload), 38899, bulb.ip, () => {});

    const finish = () => {
      if (done) return;
      done = true;
      sock.off("message", handler);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve();
    };

    const handler = (msg: Buffer) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.result) {
          bulb.state = data.result.state ?? false;
          bulb.dimming = data.result.dimming;
          bulb.temp = data.result.temp;
        }
      } catch {
        /* ignore */
      }
      finish();
    };

    sock.on("message", handler);
    setTimeout(finish, 2000);
  });
}

function formatBulb(bulb: WizBulb): string {
  const macShort = bulb.mac === "unknown" ? "" : ` mac:${bulb.mac.slice(-6)}`;
  let info = `${bulb.ip}`;
  if (bulb.module) info += ` (${bulb.module}${macShort})`;
  else if (macShort) info += ` (${macShort.trim()})`;
  if (bulb.state !== undefined) {
    if (bulb.state) {
      info += ` ON ${bulb.dimming ?? "?"}%`;
      if (bulb.temp) info += ` ${bulb.temp}K`;
    } else {
      info += " OFF";
    }
  }
  return info;
}

/** Flash a bulb briefly so user can identify it */
async function identifyBulb(ip: string): Promise<void> {
  const sock = createSocket("udp4");
  const on = Buffer.from(
    JSON.stringify({
      method: "setPilot",
      params: { state: true, dimming: 100 },
    }),
  );
  const off = Buffer.from(
    JSON.stringify({ method: "setPilot", params: { state: false } }),
  );
  for (let i = 0; i < 3; i++) {
    sock.send(on, 38899, ip);
    await new Promise((r) => setTimeout(r, 300));
    sock.send(off, 38899, ip);
    await new Promise((r) => setTimeout(r, 300));
  }
  // Restore to on at medium brightness
  const restore = Buffer.from(
    JSON.stringify({
      method: "setPilot",
      params: { state: true, dimming: 50 },
    }),
  );
  sock.send(restore, 38899, ip);
  sock.close();
}

// ── Warm dim config helper ──────────────────────────────

async function configureWarmDim(): Promise<{
  warmDimming: boolean;
  warmDimCurve?: string;
  warmDimMin?: number;
  warmDimMax?: number;
}> {
  const warmDimming = await askYesNo("  Enable warm dimming?", false);
  if (!warmDimming) return { warmDimming: false };

  const curveKeys = Object.keys(WARM_DIM_CURVES);
  const curveLabels = curveKeys.map((k) => WARM_DIM_CURVES[k].name);
  const curveIdx = await askChoice("  Warm dim curve:", curveLabels);
  const warmDimCurve = curveKeys[curveIdx];

  let warmDimMin: number | undefined;
  let warmDimMax: number | undefined;
  const customRange = await askYesNo("  Custom CCT range?", false);
  if (customRange) {
    const minStr = await ask("    Min CCT (e.g. 1800): ");
    const maxStr = await ask("    Max CCT (e.g. 3000): ");
    if (minStr) warmDimMin = parseInt(minStr, 10);
    if (maxStr) warmDimMax = parseInt(maxStr, 10);
  }

  return {
    warmDimming: true,
    warmDimCurve: warmDimCurve !== "default" ? warmDimCurve : undefined,
    warmDimMin,
    warmDimMax,
  };
}

// ── Main wizard flow ─────────────────────────────────────

async function main() {
  initReadline();

  console.log("CCX-WiZ Bridge Config Wizard");
  console.log("============================\n");

  // ── Step 1: Check existing config ──────────────────────
  let existingConfig: BridgeConfigFile | null = null;
  let existingPairings: PairingConfig[] = [];
  let existingDefaults: BridgeConfigFile["defaults"] = {};

  if (existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      existingPairings = existingConfig!.pairings ?? [];
      existingDefaults = existingConfig!.defaults ?? {};

      if (existingPairings.length > 0) {
        console.log(`Existing config: ${configPath}`);
        console.log(`  ${existingPairings.length} pairing(s):`);
        for (const p of existingPairings) {
          const ips = Array.isArray(p.wiz) ? p.wiz.join(", ") : p.wiz;
          const name = p.name ?? getZoneName(p.zoneId) ?? `Zone ${p.zoneId}`;
          console.log(`    ${name} (zone ${p.zoneId}) -> ${ips}`);
        }
        console.log();
      }
    } catch {
      console.log(`Warning: Could not parse ${configPath}, starting fresh.\n`);
    }
  }

  const startFresh =
    existingPairings.length > 0
      ? await askYesNo("Start fresh (replace all pairings)?", false)
      : true;

  const pairings: PairingConfig[] = startFresh ? [] : [...existingPairings];
  const pairedZoneIds = new Set(pairings.map((p) => p.zoneId));

  console.log();

  // ── Step 2: Discover WiZ bulbs ─────────────────────────
  const bulbs: WizBulb[] = [];

  if (!noDiscover) {
    console.log("Discovering WiZ bulbs on LAN...");
    try {
      const discovered = await discoverWizBulbs();
      if (discovered.length > 0) {
        await Promise.all(discovered.map((b) => getPilotInfo(b)));
        bulbs.push(...discovered);
      }
    } catch (err: any) {
      console.log(`  UDP broadcast failed: ${err.message}`);
    }
  }

  if (bulbs.length > 0) {
    console.log(`Found ${bulbs.length} WiZ bulb(s):`);
    for (let i = 0; i < bulbs.length; i++) {
      console.log(`  ${i + 1}. ${formatBulb(bulbs[i])}`);
    }
  } else {
    if (!noDiscover) console.log("  No WiZ bulbs found via broadcast.");
  }

  // Manual IP entry
  console.log();
  while (true) {
    const ip = await ask("Add WiZ bulb IP manually (or Enter to continue): ");
    if (!ip) break;
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      console.log("  Invalid IP format.");
      continue;
    }
    // Check for duplicates
    if (bulbs.some((b) => b.ip === ip)) {
      console.log(`  ${ip} already in list.`);
      continue;
    }
    const manual: WizBulb = { ip, mac: "unknown" };
    process.stdout.write(`  Probing ${ip}... `);
    await getPilotInfo(manual);
    if (manual.state !== undefined) {
      console.log(`found: ${formatBulb(manual)}`);
    } else {
      console.log("no response (added anyway).");
    }
    bulbs.push(manual);
  }

  if (bulbs.length === 0) {
    console.log("\nNo WiZ bulbs to configure. Exiting.");
    rl.close();
    return;
  }

  // ── Step 3: Load Lutron zones ──────────────────────────
  const allZones = getAllZonesWithControlType();
  if (allZones.length === 0) {
    console.error("\nError: No LEAP zone data found.");
    console.error("Run `npx tsx tools/leap-dump.ts --save` first.");
    rl.close();
    process.exit(1);
  }

  const eligibleZones = allZones
    .filter((z) => z.controlType === "Dimmed" || z.controlType === "Switched")
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Step 4: Pair zones to bulbs ────────────────────────
  console.log(
    `\n${eligibleZones.length} Lutron zones available. Let's create pairings.\n`,
  );
  console.log(
    "For each pairing, you'll pick a Lutron zone and one or more WiZ bulbs.\n",
  );

  const usedBulbIps = new Set<string>();
  // Mark bulbs from existing pairings as used
  for (const p of pairings) {
    const ips = Array.isArray(p.wiz) ? p.wiz : [p.wiz];
    for (const ip of ips) usedBulbIps.add(ip);
  }

  while (true) {
    // Show available (unpaired) zones
    const availZones = eligibleZones.filter((z) => !pairedZoneIds.has(z.id));
    if (availZones.length === 0) {
      console.log("All zones paired.");
      break;
    }

    // Show available (unassigned) bulbs
    const availBulbs = bulbs.filter((b) => !usedBulbIps.has(b.ip));
    if (availBulbs.length === 0) {
      console.log("All WiZ bulbs assigned.");
      break;
    }

    console.log(`--- New Pairing (${pairings.length + 1}) ---`);
    console.log(
      `  ${availBulbs.length} unassigned bulb(s), ${availZones.length} unpaired zone(s)\n`,
    );

    // Pick zone
    const zoneLabels = availZones.map(
      (z) => `${z.name} (zone ${z.id}, ${z.controlType})`,
    );
    const zoneIdx = await askChoice("Select Lutron zone:", zoneLabels, true);
    if (zoneIdx === -1) break; // done adding pairings
    const zone = availZones[zoneIdx];

    // Pick bulb(s) — allow selecting multiple
    const bulbLabels = availBulbs.map((b) => formatBulb(b));

    let selectedBulbs: WizBulb[];
    if (availBulbs.length === 1) {
      // Only one bulb left, auto-select
      selectedBulbs = [availBulbs[0]];
      console.log(`  Auto-selecting: ${formatBulb(availBulbs[0])}`);
    } else {
      // Offer identify before selecting
      const wantId = await askYesNo("  Flash a bulb to identify it?", false);
      if (wantId) {
        while (true) {
          console.log("  Which bulb to flash?");
          for (let i = 0; i < availBulbs.length; i++) {
            console.log(`    ${i + 1}. ${formatBulb(availBulbs[i])}`);
          }
          const idxStr = await ask("  Bulb # (or Enter to stop): ");
          if (!idxStr) break;
          const idx = parseInt(idxStr, 10) - 1;
          if (idx >= 0 && idx < availBulbs.length) {
            process.stdout.write(`  Flashing ${availBulbs[idx].ip}... `);
            await identifyBulb(availBulbs[idx].ip);
            console.log("done.");
          }
        }
      }

      const bulbIndices = await askMultiChoice(
        `Select WiZ bulb(s) for "${zone.name}":`,
        bulbLabels,
      );
      selectedBulbs = bulbIndices.map((i) => availBulbs[i]);
    }

    const wizIps = selectedBulbs.map((b) => b.ip);
    for (const ip of wizIps) usedBulbIps.add(ip);
    pairedZoneIds.add(zone.id);

    // Warm dimming
    let warmDimConfig: Awaited<ReturnType<typeof configureWarmDim>> = {
      warmDimming: false,
    };
    if (zone.controlType === "Dimmed") {
      warmDimConfig = await configureWarmDim();
    }

    // Build pairing
    const pairing: PairingConfig = {
      zoneId: zone.id,
      wiz: wizIps.length === 1 ? wizIps[0] : wizIps,
    };
    if (warmDimConfig.warmDimming) {
      pairing.warmDimming = true;
      if (warmDimConfig.warmDimCurve)
        pairing.warmDimCurve = warmDimConfig.warmDimCurve;
      if (warmDimConfig.warmDimMin !== undefined)
        pairing.warmDimMin = warmDimConfig.warmDimMin;
      if (warmDimConfig.warmDimMax !== undefined)
        pairing.warmDimMax = warmDimConfig.warmDimMax;
    }

    pairings.push(pairing);
    const ipStr = wizIps.join(", ");
    console.log(`\n  + ${zone.name} (zone ${zone.id}) -> ${ipStr}\n`);

    // Continue?
    if (bulbs.filter((b) => !usedBulbIps.has(b.ip)).length === 0) {
      console.log("All WiZ bulbs assigned.\n");
      break;
    }
    const more = await askYesNo("Add another pairing?", true);
    if (!more) break;
    console.log();
  }

  if (pairings.length === 0) {
    console.log("\nNo pairings created. Exiting.");
    rl.close();
    return;
  }

  // ── Step 5: Defaults ───────────────────────────────────
  console.log("\n--- Defaults ---\n");

  const portStr = await ask(
    `WiZ UDP port [${existingDefaults?.wizPort ?? 38899}]: `,
  );
  const wizPort = portStr
    ? parseInt(portStr, 10)
    : (existingDefaults?.wizPort ?? 38899);

  const wizDimScaling = await askYesNo(
    "WiZ dim scaling? (maps Lutron 1-100% to WiZ 10-100%)",
    existingDefaults?.wizDimScaling ?? false,
  );

  const defaultWarmDim = await askYesNo(
    "Default warm dimming for new pairings?",
    existingDefaults?.warmDimming ?? false,
  );

  let defaultCurve: string | undefined;
  if (defaultWarmDim) {
    const curveKeys = Object.keys(WARM_DIM_CURVES);
    const curveLabels = curveKeys.map((k) => WARM_DIM_CURVES[k].name);
    const curveIdx = await askChoice("  Default warm dim curve:", curveLabels);
    defaultCurve = curveKeys[curveIdx];
  }

  // ── Step 6: Check preset-zones.json ────────────────────
  const presetZonesPath = join(projectRoot, "data", "preset-zones.json");
  if (!existsSync(presetZonesPath)) {
    console.log(
      "\nNote: data/preset-zones.json not found. Scene buttons won't work.",
    );
    console.log("Run /gather-presets with Designer open to generate it.\n");
  } else {
    try {
      const pz = JSON.parse(readFileSync(presetZonesPath, "utf-8"));
      const presetCount = Object.keys(pz).length;
      console.log(
        `\nScene data: ${presetCount} presets loaded from preset-zones.json`,
      );
    } catch {}
  }

  // ── Step 7: Summary and write ──────────────────────────
  console.log("\n--- Config Summary ---\n");
  console.log(`  ${pairings.length} pairing(s):`);
  for (const p of pairings) {
    const ips = Array.isArray(p.wiz) ? p.wiz.join(", ") : p.wiz;
    const name = p.name ?? getZoneName(p.zoneId) ?? `Zone ${p.zoneId}`;
    let desc = `${name} (zone ${p.zoneId}) -> ${ips}`;
    if (p.warmDimming) desc += ` [warm dim: ${p.warmDimCurve ?? "default"}]`;
    console.log(`    ${desc}`);
  }
  console.log(
    `\n  Defaults: port=${wizPort}, dimScaling=${wizDimScaling ? "on" : "off"}, warmDim=${defaultWarmDim ? "on" : "off"}`,
  );

  const confirm = await askYesNo(`\nWrite to ${configPath}?`, true);
  if (!confirm) {
    console.log("Aborted.");
    rl.close();
    return;
  }

  const config: BridgeConfigFile = {
    pairings,
    defaults: {
      wizPort,
      warmDimming: defaultWarmDim,
      ...(defaultCurve ? { warmDimCurve: defaultCurve } : {}),
      wizDimScaling,
    },
  };

  writeFileSync(configPath, YAML.stringify(config));
  console.log(`\nWrote ${configPath}`);
  console.log("Start the bridge: npx tsx bridge/main.ts --serial");

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
