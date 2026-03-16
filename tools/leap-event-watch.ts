#!/usr/bin/env bun

/**
 * LEAP Commissioning Event Watcher
 *
 * Subscribes to ALL relevant LEAP endpoints and logs events in real-time.
 * Run this while the Lutron app pairs a device to see what the processor
 * does during commissioning — no MITM required, uses our existing LEAP certs.
 *
 * Usage:
 *   bun run tools/leap-commission-watch.ts
 *   bun run tools/leap-commission-watch.ts --host $RA3_HOST --device 1234
 *   bun run tools/leap-commission-watch.ts --log capture.jsonl
 */

import { LeapConnection } from "./leap-client";

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

import { RA3_HOST } from "../lib/env";

const host = getArg("--host") ?? RA3_HOST;
const certName = getArg("--cert") ?? "ra3";
const deviceId = getArg("--device") ?? "3681";
const logFile = getArg("--log");
const pollInterval = parseInt(getArg("--poll") ?? "2000", 10);

import * as fs from "fs";

let logStream: fs.WriteStream | null = null;

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string, data?: any) {
  const line = data
    ? `[${ts()}] ${msg}\n${JSON.stringify(data, null, 2)}`
    : `[${ts()}] ${msg}`;
  console.log(line);
  if (logStream) {
    logStream.write(
      JSON.stringify({ ts: ts(), msg, data: data ?? null }) + "\n",
    );
  }
}

async function main() {
  if (logFile) {
    logStream = fs.createWriteStream(logFile, { flags: "a" });
    log(`Logging to ${logFile}`);
  }

  const conn = new LeapConnection({ host, certName });
  await conn.connect();
  log(`Connected to LEAP at ${host}`);

  // Set up event handler to log ALL unsolicited messages
  conn.onEvent = (msg) => {
    const url = msg.Header?.Url ?? "?";
    const type = msg.CommuniqueType ?? "?";
    const status = msg.Header?.StatusCode ?? "";
    log(`EVENT: ${type} ${url} [${status}]`, msg);
  };

  // ═══════════════════════════════════════════════════════════════
  // Read initial state of the fake device
  // ═══════════════════════════════════════════════════════════════
  log(`\n=== Initial Device State (device/${deviceId}) ===`);
  try {
    const device = await conn.read(`/device/${deviceId}`);
    const dev = device?.Body?.Device;
    if (dev) {
      log(`  Name: ${dev.Name}`);
      log(`  Type: ${dev.DeviceType}`);
      log(`  Serial: ${dev.SerialNumber}`);
      log(`  Model: ${dev.ModelNumber}`);
      log(`  AddressedState: ${dev.AddressedState}`);
      log(`  IsReachable: ${dev.IsReachable}`);
      log(`  Full device:`, dev);
    }
  } catch (e) {
    log(`  Failed: ${(e as Error).message}`);
  }

  // Read link node
  try {
    const linknode = await conn.read(`/device/${deviceId}/linknode`);
    log(`Link nodes:`, linknode?.Body);
  } catch (e) {
    log(`  Link node read failed: ${(e as Error).message}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Subscribe to ALL commissioning-relevant endpoints
  // ═══════════════════════════════════════════════════════════════
  log(`\n=== Subscribing to events ===`);

  const subscriptions = [
    // Device-specific
    `/device/${deviceId}`,
    `/device/${deviceId}/status`,

    // Link status (CCX)
    `/link/437`,
    `/link/437/status`,
    `/link/437/associatedlinknode`,

    // Server/system events
    `/server/1/status`,

    // Broad subscriptions that might catch commissioning events
    `/device`,
    `/link`,
    `/area`,
    `/zone`,

    // Transfer/provisioning sessions
    `/transfersession`,
    `/cloudprovision`,
    `/remoteaddressingsession`,
    `/service`,
    `/project`,
  ];

  for (const url of subscriptions) {
    try {
      const resp = await conn.subscribe(url);
      const status = resp?.Header?.StatusCode ?? "?";
      if (status.startsWith("200") || status.startsWith("204")) {
        log(`  Subscribed: ${url} [${status}]`);
      } else {
        log(`  ${url}: ${status} (${resp?.Header?.StatusText ?? ""})`);
      }
    } catch (e) {
      log(`  ${url}: ${(e as Error).message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Poll device state periodically for changes
  // ═══════════════════════════════════════════════════════════════
  log(`\n=== Watching for commissioning events (Ctrl+C to stop) ===`);
  log(`Open the Lutron app and initiate pairing for device ${deviceId}`);

  let lastState = "";
  let lastReachable: boolean | null = null;

  const poller = setInterval(async () => {
    try {
      const resp = await conn.read(`/device/${deviceId}`);
      const dev = resp?.Body?.Device;
      if (!dev) return;

      const state = dev.AddressedState;
      const reachable = dev.IsReachable;

      if (state !== lastState) {
        log(
          `*** DEVICE STATE CHANGED: ${lastState || "(initial)"} → ${state}`,
          dev,
        );
        lastState = state;
      }
      if (reachable !== lastReachable) {
        log(`*** DEVICE REACHABLE CHANGED: ${lastReachable} → ${reachable}`);
        lastReachable = reachable;
      }
    } catch {}

    // Also poll for any new link nodes
    try {
      const resp = await conn.read(`/link/437/associatedlinknode`);
      // Just log if the count changes
    } catch {}
  }, pollInterval);

  // Also try reading some interesting endpoints every 10s
  let readCycle = 0;
  const deepPoller = setInterval(async () => {
    readCycle++;
    const urls = [`/device/${deviceId}/linknode`, `/device/${deviceId}`];
    // Every 5th cycle, also read expanded link nodes
    if (readCycle % 5 === 0) {
      urls.push(`/link/437/associatedlinknode/expanded`);
    }

    for (const url of urls) {
      try {
        const resp = await conn.read(url);
        // Only log if there's something interesting
        const body = resp?.Body;
        if (body) {
          // Check for new data compared to previous
          const key = JSON.stringify(body);
          if (!seenBodies.has(url) || seenBodies.get(url) !== key) {
            if (seenBodies.has(url)) {
              log(`*** DATA CHANGED at ${url}`, body);
            }
            seenBodies.set(url, key);
          }
        }
      } catch {}
    }
  }, 10000);

  const seenBodies = new Map<string, string>();

  process.on("SIGINT", () => {
    clearInterval(poller);
    clearInterval(deepPoller);
    log("\nStopping...");
    conn.close();
    logStream?.end();
    process.exit(0);
  });

  // Keep running
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
