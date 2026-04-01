#!/usr/bin/env npx tsx

/**
 * CCX Command Sender — send CBOR-encoded commands to Lutron Thread devices
 *
 * Uses the nRF52840 dongle's Thread interface (utun8) to multicast
 * LEVEL_CONTROL and SCENE_RECALL commands to Lutron devices.
 *
 * Usage:
 *   bun run tools/ccx-send.ts on <zone>                    Turn on a zone
 *   bun run tools/ccx-send.ts off <zone>                   Turn off a zone
 *   bun run tools/ccx-send.ts level <zone> <percent>       Set level (0-100)
 *   bun run tools/ccx-send.ts scene <sceneId>              Recall a scene
 *   bun run tools/ccx-send.ts raw <cbor-hex>               Send raw CBOR bytes
 *   bun run tools/ccx-send.ts zones                        List known zones
 *   bun run tools/ccx-send.ts listen                       Sniff CCX traffic via Thread
 *
 * Options:
 *   --repeat <n>      Number of retransmissions (default: 10)
 *   --interval <ms>   Delay between retransmissions (default: 80)
 *   --iface <name>    Network interface (default: utun8)
 *   --dry-run         Print CBOR hex without sending
 *   --seq <n>         Override sequence number
 */

import { decode as cborDecode } from "cbor-x";
import { createSocket } from "dgram";
import { CCX_CONFIG, getAllZones, getZoneName } from "../ccx/config";
import { decodeBytes, formatMessage, getMessageTypeName } from "../ccx/decoder";
import {
  encodeLevelControl,
  encodeOff,
  encodeOn,
  encodeSceneRecall,
  nextSequence,
  percentToLevel,
} from "../ccx/encoder";

// --- CLI argument parsing (same pattern as ccx-sniffer.ts) ---

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

const repeat = parseInt(getArg("--repeat") ?? "10", 10);
const interval = parseInt(getArg("--interval") ?? "80", 10);
const iface = getArg("--iface") ?? "utun8";
const dryRun = hasFlag("--dry-run");
const seqOverride = getArg("--seq");
const fadeArg = getArg("--fade"); // seconds → quarter-seconds
const delayArg = getArg("--delay"); // seconds → quarter-seconds (experimental)

const MULTICAST_ADDR = "ff03::1";
const PORT = CCX_CONFIG.udpPort;

// --- Zone lookup ---

function resolveZone(input: string): { id: number; name: string } | null {
  const zones = getAllZones();

  const num = parseInt(input, 10);
  if (!Number.isNaN(num)) {
    const match = zones.find((z) => z.id === num);
    if (match) return match;
  }

  const lower = input.toLowerCase();
  const match = zones.find((z) => z.name.toLowerCase().includes(lower));
  return match ?? null;
}

// --- Transport ---

function sendPackets(
  buf: Buffer,
  count: number,
  intervalMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createSocket({ type: "udp6", reuseAddr: true });

    sock.on("error", (err) => {
      sock.close();
      reject(err);
    });

    sock.bind(0, () => {
      try {
        sock.setMulticastInterface(`::%${iface}`);
      } catch (err) {
        sock.close();
        reject(
          new Error(
            `Failed to set multicast interface ${iface}: ${(err as Error).message}`,
          ),
        );
        return;
      }

      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= count) {
          clearInterval(timer);
          // Small delay before closing to let last packet flush
          setTimeout(() => {
            sock.close();
            resolve();
          }, 50);
          return;
        }
        sock.send(
          buf,
          0,
          buf.length,
          PORT,
          `${MULTICAST_ADDR}%${iface}`,
          (err) => {
            if (err) {
              clearInterval(timer);
              sock.close();
              reject(err);
            }
          },
        );
        sent++;
      }, intervalMs);
    });
  });
}

// --- Commands ---

function printHex(label: string, buf: Buffer) {
  const hex = buf
    .toString("hex")
    .replace(/(.{2})/g, "$1 ")
    .trim();
  console.log(`${label}: ${hex}`);
}

async function cmdOn(zoneInput: string) {
  const zone = resolveZone(zoneInput);
  if (!zone) {
    console.error(
      `Unknown zone: "${zoneInput}". Use 'zones' command to list known zones.`,
    );
    process.exit(1);
  }
  const seq =
    seqOverride !== undefined ? parseInt(seqOverride, 10) : nextSequence();
  const fade =
    fadeArg !== undefined ? Math.round(parseFloat(fadeArg) * 4) : undefined;
  const delay =
    delayArg !== undefined ? Math.round(parseFloat(delayArg) * 4) : undefined;
  const buf = encodeOn(zone.id, seq, fade, delay);
  const fadeLabel = fade !== undefined ? `, fade=${fadeArg}s` : "";
  const delayLabel = delay !== undefined ? `, delay=${delayArg}s` : "";
  console.log(
    `ON → ${zone.name} (zone=${zone.id}, seq=${seq}${fadeLabel}${delayLabel})`,
  );
  printHex("CBOR", buf);
  if (!dryRun) {
    await sendPackets(buf, repeat, interval);
    console.log(`Sent ${repeat} packets via ${iface}`);
  }
}

async function cmdOff(zoneInput: string) {
  const zone = resolveZone(zoneInput);
  if (!zone) {
    console.error(
      `Unknown zone: "${zoneInput}". Use 'zones' command to list known zones.`,
    );
    process.exit(1);
  }
  const seq =
    seqOverride !== undefined ? parseInt(seqOverride, 10) : nextSequence();
  const fade =
    fadeArg !== undefined ? Math.round(parseFloat(fadeArg) * 4) : undefined;
  const delay =
    delayArg !== undefined ? Math.round(parseFloat(delayArg) * 4) : undefined;
  const buf = encodeOff(zone.id, seq, fade, delay);
  const fadeLabel = fade !== undefined ? `, fade=${fadeArg}s` : "";
  const delayLabel = delay !== undefined ? `, delay=${delayArg}s` : "";
  console.log(
    `OFF → ${zone.name} (zone=${zone.id}, seq=${seq}${fadeLabel}${delayLabel})`,
  );
  printHex("CBOR", buf);
  if (!dryRun) {
    await sendPackets(buf, repeat, interval);
    console.log(`Sent ${repeat} packets via ${iface}`);
  }
}

async function cmdLevel(zoneInput: string, percentStr: string) {
  const zone = resolveZone(zoneInput);
  if (!zone) {
    console.error(
      `Unknown zone: "${zoneInput}". Use 'zones' command to list known zones.`,
    );
    process.exit(1);
  }
  const percent = parseFloat(percentStr);
  if (Number.isNaN(percent) || percent < 0 || percent > 100) {
    console.error(`Invalid level: "${percentStr}". Must be 0-100.`);
    process.exit(1);
  }
  const level = percentToLevel(percent);
  const seq =
    seqOverride !== undefined ? parseInt(seqOverride, 10) : nextSequence();
  const fade =
    fadeArg !== undefined ? Math.round(parseFloat(fadeArg) * 4) : undefined;
  const delay =
    delayArg !== undefined ? Math.round(parseFloat(delayArg) * 4) : undefined;
  const buf = encodeLevelControl({
    zoneId: zone.id,
    level,
    sequence: seq,
    fade,
    delay,
  });
  const fadeLabel = fade !== undefined ? `, fade=${fadeArg}s` : "";
  const delayLabel = delay !== undefined ? `, delay=${delayArg}s` : "";
  console.log(
    `LEVEL ${percent}% (0x${level.toString(16).padStart(4, "0")}) → ${zone.name} (zone=${zone.id}, seq=${seq}${fadeLabel}${delayLabel})`,
  );
  printHex("CBOR", buf);
  if (!dryRun) {
    await sendPackets(buf, repeat, interval);
    console.log(`Sent ${repeat} packets via ${iface}`);
  }
}

async function cmdScene(sceneIdStr: string) {
  const sceneId = parseInt(sceneIdStr, 10);
  if (Number.isNaN(sceneId)) {
    console.error(`Invalid scene ID: "${sceneIdStr}".`);
    process.exit(1);
  }
  const seq =
    seqOverride !== undefined ? parseInt(seqOverride, 10) : nextSequence();
  const buf = encodeSceneRecall({ sceneId, sequence: seq });
  console.log(`SCENE_RECALL (scene=${sceneId}, seq=${seq})`);
  printHex("CBOR", buf);
  if (!dryRun) {
    await sendPackets(buf, repeat, interval);
    console.log(`Sent ${repeat} packets via ${iface}`);
  }
}

async function cmdRaw(hexStr: string) {
  const clean = hexStr.replace(/[\s:,]/g, "").replace(/^0x/i, "");
  const buf = Buffer.from(clean, "hex");
  if (buf.length === 0) {
    console.error("Invalid hex string.");
    process.exit(1);
  }
  printHex("RAW", buf);
  if (!dryRun) {
    await sendPackets(buf, repeat, interval);
    console.log(`Sent ${repeat} packets via ${iface}`);
  }
}

function cmdZones() {
  const entries = getAllZones().sort((a, b) => a.name.localeCompare(b.name));

  console.log("Known CCX zones:\n");
  for (const { id, name } of entries) {
    console.log(`  ${String(id).padStart(5)}  ${name}`);
  }
  console.log(`\n${entries.length} zones total`);
}

function cmdListen() {
  const sock = createSocket({ type: "udp6", reuseAddr: true });
  const jsonOutput = hasFlag("--json");
  const showRaw = hasFlag("--raw-keys");

  sock.on("message", (msg, rinfo) => {
    const hex = msg.toString("hex");
    const time = new Date().toISOString().slice(11, 23);

    try {
      const parsed = decodeBytes(msg);
      const typeName = getMessageTypeName(
        (cborDecode(msg) as unknown[])[0] as number,
      ).padEnd(14);
      const formatted = formatMessage(parsed);

      // Annotate with zone name
      let annotation = "";
      if (parsed.type === "LEVEL_CONTROL") {
        const zoneName = getZoneName(parsed.zoneId);
        if (zoneName) annotation = ` [${zoneName}]`;
      }

      if (jsonOutput) {
        // Include raw CBOR body for field exploration
        const raw = cborDecode(msg) as unknown[];
        console.log(
          JSON.stringify({
            time,
            src: rinfo.address,
            type: typeName.trim(),
            parsed,
            rawBody: raw[1],
            hex,
          }),
        );
      } else {
        const src = rinfo.address.replace(/%.*/, ""); // strip %utun8
        console.log(`${time} ${typeName} ${src} → ${formatted}${annotation}`);

        // Show raw inner command keys for exploration
        if (showRaw) {
          const raw = cborDecode(msg) as unknown[];
          const body = raw[1] as Record<number, unknown> | undefined;
          if (body && body[0] !== undefined) {
            const inner = body[0] as Record<number, unknown>;
            const keys = Object.entries(inner)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ");
            console.log(`         cmd keys: {${keys}}`);
          }
        }
      }
    } catch (err) {
      console.log(`${time} [decode error] ${(err as Error).message}: ${hex}`);
    }
  });

  sock.bind(PORT, () => {
    sock.addMembership(MULTICAST_ADDR, `::%${iface}`);
    console.log(`Listening for CCX traffic on ${iface} port ${PORT}`);
    console.log(`  Multicast group: ${MULTICAST_ADDR}`);
    if (showRaw) console.log("  Showing raw command keys (--raw-keys)");
    if (jsonOutput) console.log("  JSON output mode");
    console.log("  Press Ctrl+C to stop\n");
  });

  sock.on("error", (err) => {
    console.error(`Listen error: ${err.message}`);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    console.log("\nStopping listener...");
    sock.close();
  });
}

// --- Main ---

// Grab positional args (non-flag args)
const positional = args.filter((a, i) => {
  if (a.startsWith("--")) return false;
  // Skip values that follow a flag
  if (
    i > 0 &&
    args[i - 1].startsWith("--") &&
    !["on", "off", "level", "scene", "raw", "zones", "listen"].includes(
      args[i - 1],
    )
  )
    return false;
  return true;
});

const cmd = positional[0];

if (!cmd) {
  console.log(`
CCX Command Sender — control Lutron Thread devices

Usage:
  bun run tools/ccx-send.ts on <zone>              Turn on
  bun run tools/ccx-send.ts off <zone>             Turn off
  bun run tools/ccx-send.ts level <zone> <percent>  Set level (0-100)
  bun run tools/ccx-send.ts scene <sceneId>         Recall scene
  bun run tools/ccx-send.ts raw <cbor-hex>          Send raw CBOR bytes
  bun run tools/ccx-send.ts zones                   List known zones
  bun run tools/ccx-send.ts listen                   Sniff CCX traffic via Thread

Options:
  --repeat <n>      Retransmissions (default: 10)
  --interval <ms>   Delay between sends (default: 80ms)
  --iface <name>    Multicast interface (default: utun8)
  --dry-run         Print CBOR hex without sending
  --seq <n>         Override sequence number
  --fade <secs>     Fade time in seconds
  --delay <secs>    Delay before fade in seconds
  --raw-keys        (listen) Show raw CBOR command keys
  --json            (listen) Output JSON per packet
`);
  process.exit(0);
}

switch (cmd) {
  case "on":
    if (!positional[1]) {
      console.error("Usage: on <zone>");
      process.exit(1);
    }
    await cmdOn(positional[1]);
    break;
  case "off":
    if (!positional[1]) {
      console.error("Usage: off <zone>");
      process.exit(1);
    }
    await cmdOff(positional[1]);
    break;
  case "level":
    if (!positional[1] || !positional[2]) {
      console.error("Usage: level <zone> <percent>");
      process.exit(1);
    }
    await cmdLevel(positional[1], positional[2]);
    break;
  case "scene":
    if (!positional[1]) {
      console.error("Usage: scene <sceneId>");
      process.exit(1);
    }
    await cmdScene(positional[1]);
    break;
  case "raw":
    if (!positional[1]) {
      console.error("Usage: raw <cbor-hex>");
      process.exit(1);
    }
    await cmdRaw(positional[1]);
    break;
  case "zones":
    cmdZones();
    break;
  case "listen":
    cmdListen();
    break;
  default:
    console.error(
      `Unknown command: "${cmd}". Run without arguments for usage.`,
    );
    process.exit(1);
}
