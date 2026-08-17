/**
 * Bridge Core — the default composition of the bridge.
 *
 * The moving parts live under lib/bridge/:
 *   model.ts        DeviceModel — the authoritative, transport-agnostic state
 *   sources/ccx.ts  CcxSource   — Thread/CCX packets → model intents
 *   sinks/*.ts      WizSink, NucleoReportSink, LogSink
 *
 * This module wires them into the arrangement the shipped bridge runs, and
 * keeps the surface every existing caller already uses. A new output (MQTT,
 * a CLI packet log) is added with `addSink()` and needs no change here, in the
 * model, or in any protocol code.
 *
 * See docs/tooling/ccx-wiz-bridge.md for the governing spec.
 */

import { EventEmitter } from "events";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { getPresetInfo, getZoneName } from "../ccx/config";
import type { CCXPacket } from "../ccx/types";
import { wireIdOf } from "./bridge/device-id";
import { DeviceModel } from "./bridge/model";
import { LogSink } from "./bridge/sinks/log";
import { NucleoReportSink } from "./bridge/sinks/nucleo-report";
import { type WizPairing, WizSink } from "./bridge/sinks/wiz";
import { CcxSource } from "./bridge/sources/ccx";
import type { BridgeSink, PresetZoneEntry, ZoneState } from "./bridge/types";

export { DeviceModel } from "./bridge/model";
export type { WizPairing } from "./bridge/sinks/wiz";
export type { BridgeSink, PresetZoneEntry, ZoneState } from "./bridge/types";

// ── Config types ──────────────────────────────────────────

export interface PairingConfig {
  zoneId: number;
  wiz: string | string[];
  name?: string;
  wizPort?: number;
}

export interface BridgeConfigFile {
  pairings: PairingConfig[];
  defaults?: {
    wizPort?: number;
    warmDimCurve?: string;
  };
}

export interface BridgeCoreOptions {
  /** WiZ pairings (zone → WiZ IPs) */
  pairings: WizPairing[];
  /** Scene preset lookup (preset ID → zone levels) */
  presetZones: Map<number, PresetZoneEntry>;
  /** Zone IDs to watch (empty = all) */
  watchedZones: Set<number>;
  /** Nucleo host for Thread TX (enables DEVICE_REPORT state injection) */
  nucleoHost?: string;
  /** Zone → synthetic device serial mapping for DEVICE_REPORT */
  deviceSerials?: Map<number, number>;
}

// ── Name resolution ───────────────────────────────────────

/**
 * Resolve a control's display name from its device id.
 *
 * Ids are namespaced by transport (`ccx_`/`cca_`) so two transports cannot
 * collide on four identical bytes; the namespace is stripped here because the
 * preset lookup is about the wire id. The first two bytes of that id are the
 * preset address, which is what LEAP knows the control by; the remaining bytes
 * are constant. Falls back to the preset's own name when the owning device is
 * not recorded, and to the model's `Device <id>` default when neither is.
 *
 * A CCA id resolves to nothing today: the lookup is a CCX preset table, and CCA
 * controls are not in it. They surface under the model's default name.
 */
function resolveDeviceName(deviceId: string): string | undefined {
  const wireId = wireIdOf(deviceId);
  if (wireId.length < 4) return undefined;
  const presetId = Number.parseInt(wireId.slice(0, 4), 16);
  if (Number.isNaN(presetId)) return undefined;
  const info = getPresetInfo(presetId);
  return info?.device ?? info?.name;
}

// ── BridgeCore ────────────────────────────────────────────

export class BridgeCore extends EventEmitter {
  /** The state model. Exposed so callers can attach their own sinks. */
  readonly model: DeviceModel;

  private source: CcxSource;
  private wiz: WizSink;

  constructor(opts: BridgeCoreOptions) {
    super();
    const log = (msg: string) => this.emit("log", msg);

    // Warm dim is a property of the zone, not of the WiZ pairing that happens
    // to carry it in config — the model applies it so every sink benefits.
    const zoneCurves = new Map<number, string>();
    for (const p of opts.pairings) {
      if (p.warmDimCurve) zoneCurves.set(p.zoneId, p.warmDimCurve);
    }

    this.model = new DeviceModel({
      presetZones: opts.presetZones,
      watchedZones: opts.watchedZones,
      zoneCurves,
      resolveZoneName: getZoneName,
      resolveDeviceName,
    });

    this.source = new CcxSource({ model: this.model, log });

    this.wiz = new WizSink({ pairings: opts.pairings, log });
    this.model.addSink(this.wiz);
    this.model.addSink(new LogSink({ log }));

    if (opts.nucleoHost) {
      this.model.addSink(
        new NucleoReportSink({
          host: opts.nucleoHost,
          serialByZone: opts.deviceSerials ?? new Map(),
          log,
        }),
      );
    }
  }

  /** Packets seen by the CCX source. */
  get packetCount(): number {
    return this.source.packetCount;
  }

  /** Zones driven — one count per (zone, command) pair. */
  get matchCount(): number {
    return this.model.appliedCount;
  }

  /** Process a decoded CCX packet through the bridge pipeline */
  handlePacket(pkt: CCXPacket): void {
    this.source.handlePacket(pkt);
  }

  getZoneState(zoneId: number): ZoneState | undefined {
    return this.model.getZoneState(zoneId);
  }

  /** Attach an additional output. Detached automatically on destroy(). */
  addSink(sink: BridgeSink): void {
    this.model.addSink(sink);
  }

  /** Fetch CCT calibration tables from all paired WiZ bulbs */
  fetchCctTables(): Promise<void> {
    return this.wiz.fetchCctTables();
  }

  /** Clean up: close sockets and stop the tick loop */
  destroy(): void {
    this.model.destroy();
  }
}

// ── Config loading helpers ────────────────────────────────

/** Shared: resolve defaults and build WizPairing[] from raw pairings */
function buildPairings(
  rawPairings: Array<{
    zoneId: number;
    wiz?: string | string[];
    wizIps?: string[];
    name?: string;
    wizPort?: number;
    warmDimCurve?: string;
  }>,
  defaults: { wizPort: number; warmDimCurve?: string },
): WizPairing[] {
  return rawPairings.map((p) => {
    const wizIps = p.wizIps ?? (Array.isArray(p.wiz) ? p.wiz : [p.wiz!]);
    const zoneName = getZoneName(p.zoneId) ?? `Zone ${p.zoneId}`;
    return {
      name: p.name || zoneName,
      zoneId: p.zoneId,
      wizIps,
      wizPort: p.wizPort ?? defaults.wizPort,
      warmDimCurve: p.warmDimCurve ?? defaults.warmDimCurve,
    };
  });
}

/** Load bridge config from a YAML or JSON file */
export function loadBridgeConfig(configPath: string): {
  pairings: WizPairing[];
} {
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const text = readFileSync(configPath, "utf-8");
  const raw: BridgeConfigFile =
    configPath.endsWith(".yaml") || configPath.endsWith(".yml")
      ? YAML.parse(text)
      : JSON.parse(text);

  return {
    pairings: buildPairings(raw.pairings, {
      wizPort: raw.defaults?.wizPort ?? 38899,
      warmDimCurve: raw.defaults?.warmDimCurve ?? "halogen",
    }),
  };
}

/** Load bridge config from HA add-on /data/options.json */
export function loadBridgeConfigFromOptions(opts: {
  pairings?: Array<{
    zone_id: number;
    name?: string;
    wiz_ips: string[];
  }>;
  wiz_port?: number;
}): {
  pairings: WizPairing[];
} {
  const rawPairings = (opts.pairings ?? []).map((p) => ({
    zoneId: p.zone_id,
    name: p.name,
    wizIps: p.wiz_ips,
  }));

  return {
    pairings: buildPairings(rawPairings, {
      wizPort: opts.wiz_port ?? 38899,
      warmDimCurve: "halogen",
    }),
  };
}

/** Load preset-zones.json into a Map */
export function loadPresetZones(dataDir: string): Map<number, PresetZoneEntry> {
  const lookupPath = join(dataDir, "preset-zones.json");
  const map = new Map<number, PresetZoneEntry>();
  if (!existsSync(lookupPath)) return map;
  try {
    const data: Record<string, PresetZoneEntry> = JSON.parse(
      readFileSync(lookupPath, "utf-8"),
    );
    for (const [id, entry] of Object.entries(data)) {
      map.set(Number(id), entry);
    }
  } catch {}
  return map;
}
