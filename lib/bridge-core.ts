/**
 * Bridge Core — Transport-agnostic CCX→WiZ bridge logic
 *
 * Handles: deduplication, zone matching, scene/preset resolution,
 * dim ramping, WiZ UDP dispatch, and RGBWC color control.
 *
 * Extracted for reuse across bridge entry points (bridge/main.ts).
 */

import { EventEmitter } from "events";
import { createSocket, type Socket } from "dgram";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  getPresetInfo,
  getZoneName,
  presetIdFromDeviceId,
} from "../ccx/config";
import { formatMessage, getMessageTypeName } from "../ccx/decoder";
import type { CCXPacket } from "../ccx/types";
import { evalWarmDimCurve, getWarmDimCurve } from "./warm-dim";
import { encodeDeviceReport, percentToLevel } from "../ccx/encoder";
import {
  cctToRgbwc,
  xyToRgbwc,
  rgbwcToPilotParams,
  type CctPoint,
} from "./wiz-color";

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
  };
}

export interface WizPairing {
  name: string;
  zoneId: number;
  wizIps: string[];
  wizPort: number;
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
  /** Nucleo host for Thread TX (enables DEVICE_REPORT state injection) */
  nucleoHost?: string;
  /** Zone → synthetic device serial mapping for DEVICE_REPORT */
  deviceSerials?: Map<number, number>;
}

// ── Constants ─────────────────────────────────────────────

const DEDUP_WINDOW_MS = 2000;
const FADE_STEP_MS = 250; // matches WiZ fadeIn=250ms and Lutron quarter-second resolution
const RAMP_INTERVAL_MS = 100;
const RAMP_RATE_PCT_PER_SEC = 100 / 4.75; // 4.75s full range (19 quarter-seconds)

// ── BridgeCore ────────────────────────────────────────────

export class BridgeCore extends EventEmitter {
  private pairings: WizPairing[];
  private pairingsByZone = new Map<number, WizPairing>();
  private presetZones: Map<number, PresetZoneEntry>;
  private watchedZones: Set<number>;
  private wizSocket: Socket | null;

  // Dedup state
  private recentCommands = new Map<string, number>();

  // Zone state
  private zoneLevel = new Map<number, number>();
  private zoneCct = new Map<number, number>(); // last-known CCT per zone
  private zoneColorXy = new Map<number, [number, number]>(); // last-known CIE xy per zone
  private activeRamps = new Map<
    number,
    {
      timer: ReturnType<typeof setInterval>;
      direction: "raise" | "lower";
      startLevel: number;
      startTime: number;
    }
  >();
  private activeFades = new Map<
    number,
    {
      timer: ReturnType<typeof setInterval>;
      totalSteps: number;
      step: number;
    }
  >();

  // Per-bulb calibration (fetched from each WiZ bulb on startup)
  private cctTables = new Map<string, CctPoint[]>(); // IP → CCT table

  // Nucleo state reporting (Thread TX via UDP:9433)
  private nucleoSocket: Socket | null = null;
  private nucleoHost: string | null = null;
  private serialByZone = new Map<number, number>(); // zoneId → synthetic serial
  private reportSeq = 0;

  // Stats
  packetCount = 0;
  matchCount = 0;

  constructor(opts: BridgeCoreOptions) {
    super();
    this.pairings = opts.pairings;
    this.presetZones = opts.presetZones;
    this.watchedZones = opts.watchedZones;
    for (const p of this.pairings) {
      this.pairingsByZone.set(p.zoneId, p);
    }

    this.wizSocket = this.pairings.length > 0 ? createSocket("udp4") : null;

    // Nucleo state reporting
    if (opts.nucleoHost) {
      this.nucleoHost = opts.nucleoHost;
      this.nucleoSocket = createSocket("udp4");
      if (opts.deviceSerials) {
        this.serialByZone = opts.deviceSerials;
      }
    }
  }

  /** Fetch CCT calibration tables from all paired WiZ bulbs */
  async fetchCctTables(): Promise<void> {
    if (!this.wizSocket) return;
    const uniqueIps = new Set<string>();
    for (const p of this.pairings) {
      for (const ip of p.wizIps) uniqueIps.add(ip);
    }

    const buf = Buffer.from(
      JSON.stringify({ method: "getCctTable", params: {} }),
    );

    const results = await Promise.all(
      [...uniqueIps].map(
        (ip) =>
          new Promise<{ ip: string; table?: CctPoint[] }>((resolve) => {
            const sock = createSocket("udp4");
            const timeout = setTimeout(() => {
              sock.close();
              resolve({ ip });
            }, 2000);
            sock.send(buf, 38899, ip, () => {
              sock.once("message", (msg) => {
                clearTimeout(timeout);
                sock.close();
                try {
                  const data = JSON.parse(msg.toString());
                  const pts = data?.result?.cctPoints as CctPoint[] | undefined;
                  resolve({ ip, table: pts });
                } catch {
                  resolve({ ip });
                }
              });
            });
          }),
      ),
    );

    for (const { ip, table } of results) {
      if (table && table.length > 0) {
        this.cctTables.set(ip, table);
        this.emit("log", `  [wiz] CCT table from ${ip}: ${table.length} points`);
      } else {
        this.emit("log", `  [wiz] CCT table from ${ip}: failed (using default)`);
      }
    }
  }

  /** Get the CCT table for a pairing (from first bulb that has one) */
  private getCctTable(pairing: WizPairing): CctPoint[] | undefined {
    for (const ip of pairing.wizIps) {
      const table = this.cctTables.get(ip);
      if (table) return table;
    }
    return undefined;
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
      const {
        zoneId,
        sequence,
        levelPercent,
        fade,
        cct,
        warmDimMode,
        colorXy,
      } = pkt.parsed;
      if (this.watchedZones.size > 0 && !this.watchedZones.has(zoneId)) return;
      if (this.isDuplicate(`lc:${zoneId}:${sequence}`)) return;
      this.matchCount++;
      // Resolve CCT: native CCT (key 6) > warm dim computation (key 5=5) > none
      let resolvedCct = cct;
      if (resolvedCct == null && warmDimMode != null && levelPercent > 0) {
        const curve = getWarmDimCurve("default");
        resolvedCct = evalWarmDimCurve(curve, levelPercent);
      }
      this.dispatch(zoneId, levelPercent, "LEVEL", fade, resolvedCct, colorXy);
      return;
    }

    // Handle BUTTON_PRESS — presets resolved via preset-zones lookup
    if (pkt.parsed.type === "BUTTON_PRESS") {
      const presetId = presetIdFromDeviceId(pkt.parsed.deviceId);
      if (this.isDuplicate(`bp:${presetId}:${pkt.parsed.sequence}`)) return;

      const sceneEntry = this.presetZones.get(presetId);
      if (sceneEntry) {
        const dispatches: Promise<void>[] = [];
        for (const [zid, assignment] of Object.entries(sceneEntry.zones)) {
          const zoneId = Number(zid);
          if (this.watchedZones.size > 0 && !this.watchedZones.has(zoneId))
            continue;
          this.matchCount++;
          dispatches.push(
            this.dispatch(
              zoneId,
              assignment.level,
              `PRESET(${sceneEntry.name})`,
              assignment.fade,
            ),
          );
        }
        Promise.all(dispatches);
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

  /** Clean up: close socket and clear ramp/fade timers */
  destroy(): void {
    for (const [zoneId] of this.activeRamps) {
      this.stopRamp(zoneId);
    }
    for (const [zoneId] of this.activeFades) {
      this.stopFade(zoneId);
    }
    this.wizSocket?.close();
    this.wizSocket = null;
    this.nucleoSocket?.close();
    this.nucleoSocket = null;
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

  private async sendWiz(
    pairing: WizPairing,
    levelPercent: number,
    nativeCct?: number,
    colorXy?: [number, number],
  ) {
    if (!this.wizSocket) return;

    let params: Record<string, number | boolean>;
    let logStr: string;

    const table = this.getCctTable(pairing);

    if (levelPercent <= 0) {
      params = { state: false };
      logStr = "OFF";
    } else if (colorXy) {
      // CIE xy color mode — blend RGB + white LEDs based on Planckian distance
      const x = colorXy[0] / 10000;
      const y = colorXy[1] / 10000;
      const channels = xyToRgbwc(x, y, levelPercent, table);
      params = rgbwcToPilotParams(channels);
      logStr = `${Math.round(levelPercent)}% xy=(${x.toFixed(4)},${y.toFixed(4)}) [r${channels.r} g${channels.g} b${channels.b} w${channels.w} c${channels.c}]`;
    } else {
      // CCT mode — use RGBWC for full 0-100% range (bypasses WiZ 10% floor)
      const cct = nativeCct ?? 2700;
      const channels = cctToRgbwc(cct, levelPercent, table);
      params = rgbwcToPilotParams(channels);
      const cctStr = nativeCct != null ? `${nativeCct}K` : "2700K(default)";
      logStr = `${Math.round(levelPercent)}% ${cctStr} [r${channels.r} g${channels.g} b${channels.b} w${channels.w} c${channels.c}]`;
    }

    const buf = Buffer.from(
      JSON.stringify({ method: "setPilot", params }),
    );

    await Promise.all(
      pairing.wizIps.map(
        (ip) =>
          new Promise<void>((resolve) => {
            this.wizSocket!.send(buf, pairing.wizPort, ip, (err) => {
              if (err) {
                this.emit("log", `  [wiz] Error → ${ip}: ${err.message}`);
              } else {
                this.emit("log", `  [wiz] → ${pairing.name} (${ip}) ${logStr}`);
              }
              resolve();
            });
          }),
      ),
    );
  }

  // ── Dispatch ──────────────────────────────────────────

  private dispatch(
    zoneId: number,
    levelPercent: number,
    source: string,
    fade = 1,
    nativeCct?: number,
    colorXy?: [number, number],
  ) {
    // Cancel any in-progress ramp or fade for this zone
    this.cancelZoneActivity(zoneId);

    // Track color mode state — color and CCT are mutually exclusive
    if (colorXy) {
      this.zoneColorXy.set(zoneId, colorXy);
      this.zoneCct.delete(zoneId);
    } else if (nativeCct != null) {
      this.zoneCct.set(zoneId, nativeCct);
      this.zoneColorXy.delete(zoneId);
    }
    // Warm dim mode (key 5) also implies CCT mode — clear color
    // (warmDimMode is resolved to nativeCct by the caller)

    // Resolve effective color state: explicit > last-known
    const effectiveColorXy = colorXy ?? this.zoneColorXy.get(zoneId);
    const cct = nativeCct ?? this.zoneCct.get(zoneId);

    const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
    const time = new Date().toISOString().slice(11, 23);
    const fadeSec = fade / 4;
    const fadeStr = fadeSec !== 0.25 ? ` fade=${fadeSec}s` : "";
    const colorStr = effectiveColorXy
      ? ` xy=(${(effectiveColorXy[0] / 10000).toFixed(4)},${(effectiveColorXy[1] / 10000).toFixed(4)})`
      : "";

    this.emit(
      "log",
      `\n${time} ** ${source} → ${zoneName} (zone=${zoneId}) ${levelPercent.toFixed(1)}%${fadeStr}${colorStr}`,
    );

    if (fade > 1) {
      // Stepped fade: N steps at 250ms intervals (1 qs = 1 step)
      // DEVICE_REPORT fires at the final step inside startFade
      this.startFade(zoneId, levelPercent, cct, fade, effectiveColorXy);
    } else {
      // Instant: fire WiZ + DEVICE_REPORT in parallel (no await)
      this.zoneLevel.set(zoneId, levelPercent);
      const pairing = this.pairingsByZone.get(zoneId);
      if (pairing)
        this.sendWiz(pairing, levelPercent, cct, effectiveColorXy);
      this.sendDeviceReport(zoneId, levelPercent);
    }
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
    this.cancelZoneActivity(zoneId);
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
      this.sendDeviceReport(zoneId, finalLevel);
    }
  }

  // ── Fade Stepping ───────────────────────────────────────

  private cancelZoneActivity(zoneId: number): void {
    this.stopRamp(zoneId);
    this.stopFade(zoneId);
  }

  private startFade(
    zoneId: number,
    endLevel: number,
    endCct: number | undefined,
    fadeQs: number,
    colorXy?: [number, number],
  ): void {
    const startLevel = this.zoneLevel.get(zoneId) ?? 0;
    const startCct = this.zoneCct.get(zoneId);
    const totalSteps = fadeQs;
    let step = 0;

    const pairing = this.pairingsByZone.get(zoneId);
    if (!pairing) return;

    const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
    const time = new Date().toISOString().slice(11, 23);
    this.emit(
      "log",
      `${time} ** FADE ${zoneName} (zone=${zoneId}) ${startLevel.toFixed(0)}%→${endLevel.toFixed(0)}% steps=${totalSteps} (${(totalSteps * 0.25).toFixed(2)}s)`,
    );

    const sendStep = () => {
      step++;
      const t = step >= totalSteps ? 1 : step / totalSteps;
      const level =
        step >= totalSteps
          ? endLevel
          : startLevel + t * (endLevel - startLevel);
      const cct =
        startCct != null && endCct != null
          ? step >= totalSteps
            ? endCct
            : Math.round(startCct + t * (endCct - startCct))
          : endCct ?? startCct;

      this.zoneLevel.set(zoneId, level);
      if (cct != null) this.zoneCct.set(zoneId, cct);
      // Color xy is fixed for the duration of the fade (only brightness ramps)
      this.sendWiz(pairing, level, cct, colorXy);

      if (step >= totalSteps) {
        this.stopFade(zoneId);
        this.sendDeviceReport(zoneId, level);
      }
    };

    // First step immediately, then interval for the rest
    sendStep();

    if (totalSteps > 1) {
      const timer = setInterval(sendStep, FADE_STEP_MS);
      this.activeFades.set(zoneId, { timer, totalSteps, step });
    }
  }

  private stopFade(zoneId: number): void {
    const fade = this.activeFades.get(zoneId);
    if (fade) {
      clearInterval(fade.timer);
      this.activeFades.delete(zoneId);
    }
  }

  // ── Nucleo DEVICE_REPORT ────────────────────────────────

  private sendDeviceReport(zoneId: number, levelPercent: number): void {
    if (!this.nucleoSocket || !this.nucleoHost) return;
    const serial = this.serialByZone.get(zoneId);
    if (!serial) return;

    const level = percentToLevel(levelPercent);
    const seq = this.reportSeq++ & 0xff;
    const cbor = encodeDeviceReport({ deviceSerial: serial, level, sequence: seq });

    // Stream protocol: [CMD=0x16, LEN, ...cbor]
    const frame = Buffer.alloc(2 + cbor.length);
    frame[0] = 0x16; // STREAM_CMD_TX_RAW_CCX_CBOR
    frame[1] = cbor.length;
    cbor.copy(frame, 2);

    this.nucleoSocket.send(frame, 9433, this.nucleoHost, (err) => {
      if (err) {
        this.emit("log", `  [nucleo] DEVICE_REPORT error: ${err.message}`);
      } else {
        this.emit(
          "log",
          `  [nucleo] DEVICE_REPORT zone=${zoneId} serial=${serial} level=${Math.round(levelPercent)}%`,
        );
      }
    });
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
  }>,
  defaults: { wizPort: number },
): WizPairing[] {
  return rawPairings.map((p) => {
    const wizIps = p.wizIps ?? (Array.isArray(p.wiz) ? p.wiz : [p.wiz!]);
    const zoneName = getZoneName(p.zoneId) ?? `Zone ${p.zoneId}`;
    return {
      name: p.name || zoneName,
      zoneId: p.zoneId,
      wizIps,
      wizPort: p.wizPort ?? defaults.wizPort,
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
