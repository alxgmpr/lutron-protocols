/**
 * Bridge Core — Transport-agnostic CCX→WiZ bridge logic
 *
 * Handles: deduplication, zone matching, scene/preset resolution,
 * dim ramping, WiZ UDP dispatch, and warm dimming.
 *
 * Extracted from tools/ccx-bridge.ts for reuse in Docker container entry point.
 */

import { EventEmitter } from "events";
import { createSocket, type Socket } from "dgram";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  getPresetInfo,
  getZoneName,
  presetIdFromDeviceId,
} from "../ccx/config";
import { formatMessage, getMessageTypeName } from "../ccx/decoder";
import type { CCXPacket } from "../ccx/types";
import { generateWarmDimTable, getWarmDimCurve } from "./warm-dim";

// ── Config types ──────────────────────────────────────────

export interface PairingConfig {
  zoneId: number;
  wiz: string | string[];
  name?: string;
  wizPort?: number;
  warmDimming?: boolean;
  warmDimCurve?: string;
  warmDimMin?: number;
  warmDimMax?: number;
}

export interface BridgeConfigFile {
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

export interface WizPairing {
  name: string;
  zoneId: number;
  wizIps: string[];
  wizPort: number;
  warmDimTable: number[] | null;
}

export interface PresetZoneEntry {
  name: string;
  zones: Record<string, { level: number; fade?: number }>;
}

export interface BridgeCoreOptions {
  /** WiZ pairings (zone → WiZ IPs) */
  pairings: WizPairing[];
  /** Scene preset lookup (preset ID → zone levels) */
  presetZones: Map<number, PresetZoneEntry>;
  /** Zone IDs to watch (empty = all) */
  watchedZones: Set<number>;
  /** Enable WiZ dimming scaling: Lutron 1-100% → WiZ 10-100% (default: true) */
  wizDimScaling?: boolean;
}

// ── Constants ─────────────────────────────────────────────

const DEDUP_WINDOW_MS = 2000;
const RAMP_INTERVAL_MS = 100;
const RAMP_RATE_PCT_PER_SEC = 100 / 4.75; // 4.75s full range (19 quarter-seconds)

// ── BridgeCore ────────────────────────────────────────────

export class BridgeCore extends EventEmitter {
  private pairings: WizPairing[];
  private pairingsByZone = new Map<number, WizPairing>();
  private presetZones: Map<number, PresetZoneEntry>;
  private watchedZones: Set<number>;
  private wizDimScaling: boolean;
  private wizSocket: Socket | null;

  // Dedup state
  private recentCommands = new Map<string, number>();

  // Ramp state
  private zoneLevel = new Map<number, number>();
  private activeRamps = new Map<
    number,
    {
      timer: ReturnType<typeof setInterval>;
      direction: "raise" | "lower";
      startLevel: number;
      startTime: number;
    }
  >();

  // Stats
  packetCount = 0;
  matchCount = 0;

  constructor(opts: BridgeCoreOptions) {
    super();
    this.pairings = opts.pairings;
    this.presetZones = opts.presetZones;
    this.watchedZones = opts.watchedZones;
    this.wizDimScaling = opts.wizDimScaling ?? true;

    for (const p of this.pairings) {
      this.pairingsByZone.set(p.zoneId, p);
    }

    this.wizSocket = this.pairings.length > 0 ? createSocket("udp4") : null;
  }

  /** Process a decoded CCX packet through the bridge pipeline */
  handlePacket(pkt: CCXPacket): void {
    this.packetCount++;

    // Log every packet
    const time = pkt.timestamp.slice(11, 23);
    const typeName = getMessageTypeName(pkt.msgType).padEnd(14);
    this.emit(
      "log",
      `${time} ${typeName} ${formatMessage(pkt.parsed)}  [${pkt.srcAddr} → ${pkt.dstAddr}]`,
    );

    // Handle LEVEL_CONTROL (processor → devices, multicast)
    if (pkt.parsed.type === "LEVEL_CONTROL") {
      const { zoneId, sequence, levelPercent, fade } = pkt.parsed;
      if (this.watchedZones.size > 0 && !this.watchedZones.has(zoneId)) return;
      if (this.isDuplicate(`lc:${zoneId}:${sequence}`)) return;
      this.matchCount++;
      this.dispatch(zoneId, levelPercent, "LEVEL", fade);
      return;
    }

    // Handle BUTTON_PRESS — presets resolved via preset-zones lookup
    if (pkt.parsed.type === "BUTTON_PRESS") {
      const presetId = presetIdFromDeviceId(pkt.parsed.deviceId);
      if (this.isDuplicate(`bp:${presetId}:${pkt.parsed.sequence}`)) return;

      const sceneEntry = this.presetZones.get(presetId);
      if (sceneEntry) {
        for (const [zid, assignment] of Object.entries(sceneEntry.zones)) {
          const zoneId = Number(zid);
          if (this.watchedZones.size > 0 && !this.watchedZones.has(zoneId))
            continue;
          this.matchCount++;
          this.dispatch(
            zoneId,
            assignment.level,
            `PRESET(${sceneEntry.name})`,
            assignment.fade,
          );
        }
      }
      return;
    }

    // Handle DIM_HOLD (raise/lower start)
    if (pkt.parsed.type === "DIM_HOLD") {
      const { action, sequence, zoneId } = pkt.parsed;
      if (this.isDuplicate(`dh:${zoneId || "p"}:${sequence}`)) return;
      const direction = action === 3 ? "raise" : "lower";

      if (
        zoneId &&
        (this.watchedZones.size === 0 || this.watchedZones.has(zoneId))
      ) {
        this.matchCount++;
        this.startRamp(zoneId, direction);
      } else {
        const presetId = presetIdFromDeviceId(pkt.parsed.deviceId);
        const entry = this.presetZones.get(presetId);
        if (entry) {
          for (const zid of Object.keys(entry.zones)) {
            const z = Number(zid);
            if (this.watchedZones.size > 0 && !this.watchedZones.has(z))
              continue;
            this.matchCount++;
            this.startRamp(z, direction);
          }
        }
      }
      return;
    }

    // Handle DIM_STEP (raise/lower release)
    if (pkt.parsed.type === "DIM_STEP") {
      const { zoneId, sequence } = pkt.parsed;
      if (this.isDuplicate(`ds:${zoneId || "p"}:${sequence}`)) return;

      if (
        zoneId &&
        (this.watchedZones.size === 0 || this.watchedZones.has(zoneId))
      ) {
        this.matchCount++;
        this.stopRamp(zoneId);
      } else {
        const presetId = presetIdFromDeviceId(pkt.parsed.deviceId);
        const entry = this.presetZones.get(presetId);
        if (entry) {
          for (const zid of Object.keys(entry.zones)) {
            const z = Number(zid);
            if (this.watchedZones.size > 0 && !this.watchedZones.has(z))
              continue;
            this.matchCount++;
            this.stopRamp(z);
          }
        }
      }
    }
  }

  /** Clean up: close socket and clear ramp timers */
  destroy(): void {
    for (const [zoneId] of this.activeRamps) {
      this.stopRamp(zoneId);
    }
    this.wizSocket?.close();
    this.wizSocket = null;
  }

  // ── Deduplication ─────────────────────────────────────

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    const prev = this.recentCommands.get(key);
    if (prev && now - prev < DEDUP_WINDOW_MS) return true;
    this.recentCommands.set(key, now);

    if (this.recentCommands.size > 100) {
      for (const [k, ts] of this.recentCommands) {
        if (now - ts > DEDUP_WINDOW_MS) this.recentCommands.delete(k);
      }
    }
    return false;
  }

  // ── WiZ UDP output ────────────────────────────────────

  private lutronToWizDimming(lutronPercent: number): number {
    if (!this.wizDimScaling) return Math.round(lutronPercent);
    return Math.round(10 + (lutronPercent / 100) * 90);
  }

  private async sendWiz(pairing: WizPairing, levelPercent: number) {
    if (!this.wizSocket) return;
    const isOff = levelPercent <= 0;
    const wizDim = this.lutronToWizDimming(levelPercent);

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
            this.wizSocket!.send(buf, pairing.wizPort, ip, (err) => {
              if (err) {
                this.emit("log", `  [wiz] Error → ${ip}: ${err.message}`);
              } else {
                this.emit("log", `  [wiz] → ${pairing.name} (${ip}) ${levelStr}`);
              }
              resolve();
            });
          }),
      ),
    );
  }

  // ── Dispatch ──────────────────────────────────────────

  private async dispatch(
    zoneId: number,
    levelPercent: number,
    source: string,
    fade = 1,
  ) {
    this.zoneLevel.set(zoneId, levelPercent);
    const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
    const time = new Date().toISOString().slice(11, 23);
    const fadeSec = fade / 4;
    const fadeStr = fadeSec !== 0.25 ? ` fade=${fadeSec}s` : "";

    this.emit(
      "log",
      `\n${time} ** ${source} → ${zoneName} (zone=${zoneId}) ${levelPercent.toFixed(1)}%${fadeStr}`,
    );

    const pairing = this.pairingsByZone.get(zoneId);
    if (pairing) await this.sendWiz(pairing, levelPercent);
  }

  // ── Dim Ramp ──────────────────────────────────────────

  private computeRampLevel(
    startLevel: number,
    direction: "raise" | "lower",
    elapsedMs: number,
  ): number {
    const delta = (elapsedMs / 1000) * RAMP_RATE_PCT_PER_SEC;
    if (direction === "raise") return Math.min(100, startLevel + delta);
    return Math.max(1, startLevel - delta);
  }

  private startRamp(zoneId: number, direction: "raise" | "lower") {
    this.stopRamp(zoneId);
    const startLevel = this.zoneLevel.get(zoneId) ?? 50;
    const startTime = Date.now();
    const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
    const time = new Date().toISOString().slice(11, 23);
    this.emit(
      "log",
      `\n${time} ** RAMP ${direction.toUpperCase()} → ${zoneName} (zone=${zoneId}) from ${startLevel.toFixed(0)}%`,
    );

    const timer = setInterval(() => {
      const level = this.computeRampLevel(
        startLevel,
        direction,
        Date.now() - startTime,
      );
      this.zoneLevel.set(zoneId, level);

      const pairing = this.pairingsByZone.get(zoneId);
      if (pairing) this.sendWiz(pairing, level);

      if (level >= 100 || level <= 1) {
        this.stopRamp(zoneId);
      }
    }, RAMP_INTERVAL_MS);

    this.activeRamps.set(zoneId, { timer, direction, startLevel, startTime });
  }

  private stopRamp(zoneId: number) {
    const ramp = this.activeRamps.get(zoneId);
    if (ramp) {
      clearInterval(ramp.timer);
      this.activeRamps.delete(zoneId);
      const elapsedMs = Date.now() - ramp.startTime;
      const finalLevel = this.computeRampLevel(
        ramp.startLevel,
        ramp.direction,
        elapsedMs,
      );
      this.zoneLevel.set(zoneId, finalLevel);

      const pairing = this.pairingsByZone.get(zoneId);
      if (pairing) this.sendWiz(pairing, finalLevel);

      const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
      const time = new Date().toISOString().slice(11, 23);
      this.emit(
        "log",
        `${time} ** RAMP STOP → ${zoneName} (zone=${zoneId}) at ${finalLevel.toFixed(0)}% (${elapsedMs}ms)`,
      );
    }
  }
}

// ── Config loading helpers ────────────────────────────────

/** Load bridge config file and build WizPairing array */
export function loadBridgeConfig(configPath: string): {
  pairings: WizPairing[];
  wizDimScaling: boolean;
} {
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const raw: BridgeConfigFile = JSON.parse(readFileSync(configPath, "utf-8"));
  const wizDimScaling = raw.defaults?.wizDimScaling ?? true;
  const defaultPort = raw.defaults?.wizPort ?? 38899;
  const defaultWarmDim = raw.defaults?.warmDimming ?? false;
  const defaultCurve = raw.defaults?.warmDimCurve ?? "default";
  const defaultMin = raw.defaults?.warmDimMin;
  const defaultMax = raw.defaults?.warmDimMax;

  const pairings = raw.pairings.map((p) => {
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

  return { pairings, wizDimScaling };
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
