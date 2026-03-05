#!/usr/bin/env bun

/**
 * CCX Virtual Device — impersonate Lutron Sunnata dimmers on Thread.
 *
 * Joins the Lutron Thread network via utun8 and acts as a virtual dimmer:
 *   - Emits PRESENCE heartbeats at regular intervals
 *   - Emits STATUS messages
 *   - Listens for LEVEL_CONTROL on configured zone IDs via multicast
 *   - Responds with DEVICE_REPORT after "executing" a level command
 *   - Implements CoAP server on UDP:5683 to accept /cg/db/* programming
 *   - Fires output plugin callbacks for external integrations
 *
 * Usage:
 *   bun run tools/ccx-virtual-device.ts
 *   bun run tools/ccx-virtual-device.ts --config data/virtual-device.json
 *   bun run tools/ccx-virtual-device.ts --zone 961 --zone 962
 *   bun run tools/ccx-virtual-device.ts --zone 961 --wiz 10.1.1.50
 *   bun run tools/ccx-virtual-device.ts --zone 961 --webhook http://localhost:8080/lutron/level
 */

import { existsSync, readFileSync } from "fs";
import { createSocket, type Socket } from "dgram";
import { decode as cborDecode } from "cbor-x";
import { join } from "path";
import { CCX_CONFIG, getZoneName } from "../ccx/config";
import {
  CCXMessageType,
  CCXMessageTypeName,
  BodyKey,
  Level,
  levelToPercent,
} from "../ccx/constants";
import { encodeMessage, nextSequence } from "../ccx/encoder";
import { decodeBytes, formatMessage, getMessageTypeName } from "../ccx/decoder";
import {
  buildCoapPacket,
  buildCoapResponse,
  parseCoapPacket,
  getUriPath,
  decodeMaybeCbor,
  encodeCborValue,
  COAP_TYPE_ACK,
  COAP_TYPE_NON,
  coapCodeToString,
  coapTypeToString,
} from "../ccx/coap";

// --- CLI argument parsing ---

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

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`
CCX Virtual Device — Lutron Thread dimmer impersonation

Usage:
  bun run tools/ccx-virtual-device.ts [options]

Options:
  --config <path>        Config file (default: data/virtual-device.json)
  --zone <id>            Zone ID to listen on (can repeat)
  --iface <name>         Thread network interface (default: utun8)
  --heartbeat <sec>      Heartbeat interval in seconds (default: 30)
  --no-heartbeat         Disable heartbeat emission
  --no-coap              Disable CoAP server
  --no-report            Disable DEVICE_REPORT emission after level commands

Output plugins:
  --wiz <ip>             Forward levels to WiZ light at this IP
  --webhook <url>        POST level changes to this URL
  --quiet                Suppress log output (still emit to plugins)

Examples:
  bun run tools/ccx-virtual-device.ts --zone 961 --wiz 10.1.1.50
  bun run tools/ccx-virtual-device.ts --config data/virtual-device.json
`);
  process.exit(0);
}

// --- Types ---

export interface OutputPlugin {
  name: string;
  onLevel(
    zoneId: number,
    level: number,
    levelPercent: number,
    fade: number,
  ): Promise<void>;
  onState?(zoneId: number, state: "on" | "off"): Promise<void>;
  destroy?(): void;
}

interface VirtualDeviceConfig {
  devices: Array<{
    name: string;
    serialNumber: string;
    zoneIds: number[];
    ipv6?: string;
  }>;
  interface: string;
  heartbeatInterval: number;
  outputs: Array<
    | { type: "wiz"; zoneId?: number; wizIp: string }
    | { type: "webhook"; url: string; zoneId?: number }
  >;
}

// --- Config loading ---

function loadConfig(): VirtualDeviceConfig {
  const configPath =
    getArg("--config") ??
    join(import.meta.dir, "..", "data", "virtual-device.json");

  const iface = getArg("--iface") ?? "utun8";
  const heartbeat = parseInt(getArg("--heartbeat") ?? "30", 10);
  const cliZones = getAllArgs("--zone").map((z) => parseInt(z, 10));
  const wizIps = getAllArgs("--wiz");
  const webhookUrls = getAllArgs("--webhook");

  // Try loading config file
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      // CLI args override config file
      if (cliZones.length > 0) {
        raw.devices = [
          {
            name: "CLI Device",
            serialNumber: "CLI001",
            zoneIds: cliZones,
          },
        ];
      }
      if (getArg("--iface")) raw.interface = iface;
      if (getArg("--heartbeat")) raw.heartbeatInterval = heartbeat;

      // Merge CLI outputs
      const outputs = raw.outputs ?? [];
      for (const ip of wizIps) {
        outputs.push({ type: "wiz", wizIp: ip });
      }
      for (const url of webhookUrls) {
        outputs.push({ type: "webhook", url });
      }
      raw.outputs = outputs;

      return raw as VirtualDeviceConfig;
    } catch (err) {
      console.error(
        `Warning: Failed to parse ${configPath}: ${(err as Error).message}`,
      );
    }
  }

  // CLI-only config
  if (cliZones.length === 0) {
    console.error(
      "No zones configured. Use --zone <id> or --config <path>.",
    );
    process.exit(1);
  }

  const outputs: VirtualDeviceConfig["outputs"] = [];
  for (const ip of wizIps) {
    outputs.push({ type: "wiz", wizIp: ip });
  }
  for (const url of webhookUrls) {
    outputs.push({ type: "webhook", url });
  }

  return {
    devices: [
      {
        name: "Virtual Dimmer",
        serialNumber: "VIRT001",
        zoneIds: cliZones,
      },
    ],
    interface: iface,
    heartbeatInterval: heartbeat,
    outputs,
  };
}

// --- Output Plugins ---

function createLogPlugin(): OutputPlugin {
  return {
    name: "log",
    async onLevel(zoneId, level, levelPercent, fade) {
      const zoneName = getZoneName(zoneId);
      const label = zoneName ? `${zoneName} (${zoneId})` : `zone ${zoneId}`;
      const fadeSec = fade / 4;
      const fadeStr = fadeSec !== 0.25 ? `, fade=${fadeSec}s` : "";
      if (level === Level.OFF) {
        console.log(`  => ${label}: OFF${fadeStr}`);
      } else if (level === Level.FULL_ON) {
        console.log(`  => ${label}: ON (100%)${fadeStr}`);
      } else {
        console.log(
          `  => ${label}: ${levelPercent.toFixed(1)}% (0x${level.toString(16).padStart(4, "0")})${fadeStr}`,
        );
      }
    },
    onState: async (zoneId, state) => {
      const zoneName = getZoneName(zoneId);
      const label = zoneName ? `${zoneName} (${zoneId})` : `zone ${zoneId}`;
      console.log(`  => ${label}: ${state.toUpperCase()}`);
    },
  };
}

function createWizPlugin(wizIp: string, filterZoneId?: number): OutputPlugin {
  const sock = createSocket("udp4");
  return {
    name: `wiz:${wizIp}`,
    async onLevel(zoneId, _level, levelPercent, _fade) {
      if (filterZoneId !== undefined && zoneId !== filterZoneId) return;
      // WiZ setPilot: dimming 10-100 (below 10 = off)
      const dimming = Math.max(10, Math.min(100, Math.round(levelPercent)));
      const msg =
        levelPercent <= 0
          ? JSON.stringify({ method: "setPilot", params: { state: false } })
          : JSON.stringify({
              method: "setPilot",
              params: { state: true, dimming },
            });
      const buf = Buffer.from(msg, "utf8");
      sock.send(buf, 38899, wizIp, (err) => {
        if (err) console.error(`WiZ ${wizIp} error: ${err.message}`);
      });
    },
    onState: async (zoneId, state) => {
      if (filterZoneId !== undefined && zoneId !== filterZoneId) return;
      const msg = JSON.stringify({
        method: "setPilot",
        params: { state: state === "on" },
      });
      sock.send(Buffer.from(msg, "utf8"), 38899, wizIp);
    },
    destroy: () => sock.close(),
  };
}

function createWebhookPlugin(
  url: string,
  filterZoneId?: number,
): OutputPlugin {
  return {
    name: `webhook:${url}`,
    async onLevel(zoneId, level, levelPercent, fade) {
      if (filterZoneId !== undefined && zoneId !== filterZoneId) return;
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "level",
            zoneId,
            zoneName: getZoneName(zoneId) ?? null,
            level,
            levelPercent: Math.round(levelPercent * 10) / 10,
            fade,
            fadeSec: fade / 4,
            timestamp: new Date().toISOString(),
          }),
        });
      } catch (err) {
        console.error(`Webhook ${url} error: ${(err as Error).message}`);
      }
    },
  };
}

// --- Heartbeat emitter ---

class HeartbeatEmitter {
  private sock: Socket;
  private timer: ReturnType<typeof setInterval> | null = null;
  private iface: string;
  private intervalMs: number;

  constructor(iface: string, intervalSec: number) {
    this.sock = createSocket({ type: "udp6", reuseAddr: true });
    this.iface = iface;
    this.intervalMs = intervalSec * 1000;
  }

  start() {
    this.sock.bind(0, () => {
      try {
        this.sock.setMulticastInterface(`::%${this.iface}`);
      } catch (err) {
        console.error(
          `Heartbeat: failed to set multicast interface: ${(err as Error).message}`,
        );
        return;
      }

      // Emit immediately, then on interval
      this.emitPresence();
      this.timer = setInterval(() => this.emitPresence(), this.intervalMs);
    });
  }

  private emitPresence() {
    const seq = nextSequence();
    const buf = encodeMessage(CCXMessageType.PRESENCE, {
      [BodyKey.STATUS]: 0,
      [BodyKey.SEQUENCE]: seq,
    });
    this.sock.send(
      buf,
      0,
      buf.length,
      CCX_CONFIG.udpPort,
      `ff03::1%${this.iface}`,
      (err) => {
        if (err) console.error(`Heartbeat send error: ${err.message}`);
      },
    );
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.sock.close();
  }
}

// --- DEVICE_REPORT emitter ---

function emitDeviceReport(
  sock: Socket,
  iface: string,
  deviceSerial: number,
  level: number,
  zoneId: number,
) {
  const body: Record<number, unknown> = {
    [BodyKey.COMMAND]: { 0: level },
    [BodyKey.ZONE]: [16, zoneId],
    [BodyKey.DEVICE]: [1, deviceSerial],
    [BodyKey.EXTRA]: { 1: 0 },
  };
  const buf = encodeMessage(CCXMessageType.DEVICE_REPORT, body);
  sock.send(
    buf,
    0,
    buf.length,
    CCX_CONFIG.udpPort,
    `ff03::1%${iface}`,
    (err) => {
      if (err) console.error(`DEVICE_REPORT send error: ${err.message}`);
    },
  );
}

// --- CoAP server (programming plane) ---

class CoapServer {
  private sock: Socket;
  private port: number;

  constructor(port: number = 5683) {
    this.port = port;
    this.sock = createSocket({ type: "udp6", reuseAddr: true });
  }

  start() {
    this.sock.on("message", (msg, rinfo) => {
      const parsed = parseCoapPacket(msg);
      if (!parsed) return;

      const path = getUriPath(parsed.options);
      const payloadDecoded = parsed.payload.length
        ? decodeMaybeCbor(parsed.payload)
        : null;

      console.log(
        `CoAP ${coapTypeToString(parsed.type)} ${coapCodeToString(parsed.code)} ${path} from ${rinfo.address}`,
      );
      if (payloadDecoded != null) {
        console.log(`  cbor=${JSON.stringify(payloadDecoded)}`);
      }

      // Respond with 2.04 Changed for programming writes
      const code = parsed.code;
      if (code >= 1 && code <= 4 && path.startsWith("/cg/db")) {
        // 2.04 Changed = (2 << 5) | 4 = 0x44 = 68
        const responseCode = code === 4 ? 0x42 : 0x44; // DELETE → 2.02, others → 2.04
        const response = buildCoapResponse({
          type: COAP_TYPE_ACK,
          code: responseCode,
          mid: parsed.mid,
          token: Buffer.from(parsed.token),
        });
        this.sock.send(
          response,
          rinfo.port,
          rinfo.address,
          (err) => {
            if (err)
              console.error(`CoAP response error: ${err.message}`);
          },
        );
      }
    });

    this.sock.bind(this.port, "::", () => {
      console.log(`CoAP server: UDP:${this.port} (programming plane)`);
    });

    this.sock.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(
          `CoAP port ${this.port} in use — programming plane disabled`,
        );
      } else {
        console.error(`CoAP server error: ${err.message}`);
      }
    });
  }

  stop() {
    this.sock.close();
  }
}

// --- Runtime listener (LEVEL_CONTROL on multicast) ---

class RuntimeListener {
  private sock: Socket;
  private iface: string;
  private zoneIds: Set<number>;
  private plugins: OutputPlugin[];
  private lastSeq = new Map<number, number>(); // zoneId → last seq (dedup)
  private reportSock: Socket | null = null;
  private emitReports: boolean;
  private deviceSerial: number;

  constructor(opts: {
    iface: string;
    zoneIds: number[];
    plugins: OutputPlugin[];
    emitReports: boolean;
    deviceSerial: number;
  }) {
    this.sock = createSocket({ type: "udp6", reuseAddr: true });
    this.iface = opts.iface;
    this.zoneIds = new Set(opts.zoneIds);
    this.plugins = opts.plugins;
    this.emitReports = opts.emitReports;
    this.deviceSerial = opts.deviceSerial;

    if (this.emitReports) {
      this.reportSock = createSocket({ type: "udp6", reuseAddr: true });
    }
  }

  start() {
    this.sock.on("message", (msg, rinfo) => {
      try {
        const parsed = decodeBytes(msg);

        if (parsed.type === "LEVEL_CONTROL") {
          if (!this.zoneIds.has(parsed.zoneId)) return;

          // Dedup by sequence
          const lastSeq = this.lastSeq.get(parsed.zoneId);
          if (lastSeq === parsed.sequence) return;
          this.lastSeq.set(parsed.zoneId, parsed.sequence);

          const src = rinfo.address.replace(/%.*/, "");
          const typeName = "LEVEL_CONTROL";
          const formatted = formatMessage(parsed);
          const zoneName = getZoneName(parsed.zoneId);
          const annotation = zoneName ? ` [${zoneName}]` : "";

          console.log(
            `${new Date().toISOString().slice(11, 23)} ${typeName.padEnd(16)} ${src} → ${formatted}${annotation}`,
          );

          // Fire plugins
          for (const plugin of this.plugins) {
            plugin
              .onLevel(
                parsed.zoneId,
                parsed.level,
                parsed.levelPercent,
                parsed.fade,
              )
              .catch((err) => {
                console.error(
                  `Plugin ${plugin.name} error: ${(err as Error).message}`,
                );
              });

            // Fire onState for on/off transitions
            if (plugin.onState) {
              if (parsed.level === Level.OFF) {
                plugin.onState(parsed.zoneId, "off").catch(() => {});
              } else if (parsed.level === Level.FULL_ON) {
                plugin.onState(parsed.zoneId, "on").catch(() => {});
              }
            }
          }

          // Emit DEVICE_REPORT
          if (this.emitReports && this.reportSock) {
            setTimeout(() => {
              emitDeviceReport(
                this.reportSock!,
                this.iface,
                this.deviceSerial,
                parsed.level,
                parsed.zoneId,
              );
            }, 50);
          }
        }
      } catch {
        // Ignore decode errors for non-matching messages
      }
    });

    this.sock.bind(CCX_CONFIG.udpPort, () => {
      this.sock.addMembership("ff03::1", `::%${this.iface}`);
      console.log(
        `Runtime listener: ${this.iface} port ${CCX_CONFIG.udpPort} (zones: ${[...this.zoneIds].join(", ")})`,
      );
    });

    this.sock.on("error", (err) => {
      console.error(`Runtime listener error: ${err.message}`);
    });

    if (this.reportSock) {
      this.reportSock.bind(0, () => {
        try {
          this.reportSock!.setMulticastInterface(`::%${this.iface}`);
        } catch (err) {
          console.error(
            `DEVICE_REPORT multicast setup error: ${(err as Error).message}`,
          );
        }
      });
    }
  }

  stop() {
    this.sock.close();
    if (this.reportSock) this.reportSock.close();
  }
}

// --- Main ---

async function main() {
  const config = loadConfig();
  const quiet = hasFlag("--quiet");
  const noHeartbeat = hasFlag("--no-heartbeat");
  const noCoap = hasFlag("--no-coap");
  const noReport = hasFlag("--no-report");

  // Collect all zone IDs across devices
  const allZoneIds = config.devices.flatMap((d) => d.zoneIds);
  if (allZoneIds.length === 0) {
    console.error("No zone IDs configured.");
    process.exit(1);
  }

  // Use first device serial as numeric ID for DEVICE_REPORT
  const deviceSerial = parseInt(
    config.devices[0]?.serialNumber.replace(/\D/g, "") || "1",
    10,
  );

  console.log("CCX Virtual Device");
  console.log("==================");
  console.log(`Interface: ${config.interface}`);
  console.log(
    `Zones: ${allZoneIds.map((z) => `${z}${getZoneName(z) ? ` (${getZoneName(z)})` : ""}`).join(", ")}`,
  );
  console.log(`Devices: ${config.devices.map((d) => d.name).join(", ")}`);
  console.log(
    `Heartbeat: ${noHeartbeat ? "disabled" : `${config.heartbeatInterval}s`}`,
  );
  console.log(`CoAP server: ${noCoap ? "disabled" : "UDP:5683"}`);
  console.log(`DEVICE_REPORT: ${noReport ? "disabled" : "enabled"}`);

  // Build plugins
  const plugins: OutputPlugin[] = [];
  if (!quiet) plugins.push(createLogPlugin());

  for (const output of config.outputs) {
    if (output.type === "wiz") {
      plugins.push(createWizPlugin(output.wizIp, output.zoneId));
      console.log(
        `Output: WiZ → ${output.wizIp}${output.zoneId ? ` (zone ${output.zoneId})` : ""}`,
      );
    } else if (output.type === "webhook") {
      plugins.push(createWebhookPlugin(output.url, output.zoneId));
      console.log(
        `Output: Webhook → ${output.url}${output.zoneId ? ` (zone ${output.zoneId})` : ""}`,
      );
    }
  }

  console.log(`Plugins: ${plugins.map((p) => p.name).join(", ")}`);
  console.log("");

  // Start components
  let heartbeat: HeartbeatEmitter | null = null;
  if (!noHeartbeat) {
    heartbeat = new HeartbeatEmitter(
      config.interface,
      config.heartbeatInterval,
    );
    heartbeat.start();
    console.log("Heartbeat emitter started");
  }

  let coapServer: CoapServer | null = null;
  if (!noCoap) {
    coapServer = new CoapServer();
    coapServer.start();
  }

  const listener = new RuntimeListener({
    iface: config.interface,
    zoneIds: allZoneIds,
    plugins,
    emitReports: !noReport,
    deviceSerial,
  });
  listener.start();

  console.log("");
  console.log("Virtual device running. Press Ctrl+C to stop.");
  console.log("");

  const cleanup = () => {
    console.log("\nShutting down...");
    listener.stop();
    if (heartbeat) heartbeat.stop();
    if (coapServer) coapServer.stop();
    for (const plugin of plugins) {
      if (plugin.destroy) plugin.destroy();
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
