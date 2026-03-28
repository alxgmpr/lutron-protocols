/**
 * Bridge Core — Transport-agnostic CCX→WiZ bridge logic
 *
 * Unified zone state model with a single tick loop (50ms / 20 Hz).
 * No per-zone timers, no echo suppression, wall-clock fade interpolation.
 *
 * See docs/bridge-state-spec.md for the governing spec.
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
    warmDimCurve?: string;
  };
}

export interface WizPairing {
  name: string;
  zoneId: number;
  wizIps: string[];
  wizPort: number;
  /** Warm dim curve name (from warm-dim.ts). When set, the bridge evaluates
   *  brightness→CCT on every level change that lacks explicit CCT. */
  warmDimCurve?: string;
}

export interface PresetZoneEntry {
  name: string;
  zones: Record<string, { level: number; fade?: number; warmDimCurve?: string }>;
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

// ── Internal types ───────────────────────────────────────

type ZoneActivity =
  | { type: "idle" }
  | {
      type: "fading";
      startLevel: number;
      targetLevel: number;
      startCct: number | null;
      targetCct: number | null;
      colorXy: [number, number] | null;
      startTime: number;
      durationMs: number;
    }
  | {
      type: "ramping";
      direction: "raise" | "lower";
      startLevel: number;
      startTime: number;
    };

interface ZoneState {
  level: number;
  colorMode: "cct" | "xy";
  cct: number | null;
  colorXy: [number, number] | null;
  activity: ZoneActivity;
  dirty: boolean;
  reportAt: number; // 0 = no report pending, >0 = timestamp when report should fire
}

interface WizCommand {
  ips: string[];
  port: number;
  level: number;
  colorMode: "cct" | "xy" | "off";
  cct: number | null;
  colorXy: [number, number] | null;
  cctTable: CctPoint[] | undefined;
  zoneName: string;
}

// ── Constants ─────────────────────────────────────────────

const TICK_MS = 50; // 20 Hz tick loop
const DEDUP_WINDOW_MS = 200; // Thread retransmissions arrive within ~170ms
const RAMP_RATE_PCT_PER_SEC = 100 / 4.75; // 4.75s full range (19 quarter-seconds)
const REPORT_DELAY_MS = 2000; // delay DEVICE_REPORT after activity settles (real devices wait seconds)

// ── BridgeCore ────────────────────────────────────────────

export class BridgeCore extends EventEmitter {
  private pairings: WizPairing[];
  private pairingsByZone = new Map<number, WizPairing>();
  private presetZones: Map<number, PresetZoneEntry>;
  private watchedZones: Set<number>;
  private wizSocket: Socket | null;

  // Unified zone state
  private zones = new Map<number, ZoneState>();

  // Dedup
  private dedup = new Map<string, number>();

  // Per-bulb calibration (fetched from each WiZ bulb on startup)
  private cctTables = new Map<string, CctPoint[]>();

  // Nucleo state reporting (Thread TX via UDP:9433)
  private nucleoSocket: Socket | null = null;
  private nucleoHost: string | null = null;
  private serialByZone = new Map<number, number>();
  private reportSeq = 0;

  // Tick loop
  private tickTimer: ReturnType<typeof setInterval> | null = null;

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

    // Start tick loop
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  // ── Zone state ──────────────────────────────────────────

  private getZone(zoneId: number): ZoneState {
    let z = this.zones.get(zoneId);
    if (!z) {
      z = {
        level: 0,
        colorMode: "cct",
        cct: null,
        colorXy: null,
        activity: { type: "idle" },
        dirty: false,
        reportAt: 0,
      };
      this.zones.set(zoneId, z);
    }
    return z;
  }

  /** Expose zone state for testing */
  getZoneState(zoneId: number): ZoneState | undefined {
    return this.zones.get(zoneId);
  }

  // ── CCT Tables ──────────────────────────────────────────

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

    for (const ip of uniqueIps) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const table = await this.fetchOneCctTable(ip, buf);
        if (table) {
          this.cctTables.set(ip, table);
          this.emit("log", `  [wiz] CCT table from ${ip}: ${table.length} points`);
          break;
        }
        if (attempt === 1) {
          this.emit("log", `  [wiz] CCT table from ${ip}: FAILED after retry (using default)`);
        }
      }
    }
  }

  private fetchOneCctTable(
    ip: string,
    buf: Buffer,
  ): Promise<CctPoint[] | null> {
    return new Promise((resolve) => {
      if (!this.wizSocket) return resolve(null);
      const timeout = setTimeout(() => resolve(null), 2000);
      const onMsg = (msg: Buffer, rinfo: { address: string }) => {
        if (rinfo.address !== ip) return; // not from this bulb
        clearTimeout(timeout);
        this.wizSocket?.removeListener("message", onMsg);
        try {
          const data = JSON.parse(msg.toString());
          const pts = data?.result?.cctPoints as CctPoint[] | undefined;
          resolve(pts && pts.length > 0 ? pts : null);
        } catch {
          resolve(null);
        }
      };
      this.wizSocket.on("message", onMsg);
      this.wizSocket.send(buf, 38899, ip, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.wizSocket?.removeListener("message", onMsg);
          resolve(null);
        }
      });
    });
  }

  private getCctTable(pairing: WizPairing): CctPoint[] | undefined {
    for (const ip of pairing.wizIps) {
      const table = this.cctTables.get(ip);
      if (table) return table;
    }
    return undefined;
  }

  // ── Packet handling ─────────────────────────────────────

  /** Process a decoded CCX packet through the bridge pipeline */
  handlePacket(pkt: CCXPacket): void {
    this.packetCount++;

    // Only log and process actionable message types
    const { type } = pkt.parsed;
    if (
      type !== "LEVEL_CONTROL" &&
      type !== "BUTTON_PRESS" &&
      type !== "DIM_HOLD" &&
      type !== "DIM_STEP"
    ) {
      return; // skip ACK, DEVICE_REPORT, STATUS, etc.
    }

    const time = pkt.timestamp.slice(11, 23);
    const typeName = getMessageTypeName(pkt.msgType).padEnd(14);
    this.emit(
      "log",
      `${time} ${typeName} ${formatMessage(pkt.parsed)}  [${pkt.srcAddr} → ${pkt.dstAddr}]`,
    );

    if (type === "LEVEL_CONTROL") {
      this.handleLevelControl(pkt);
      return;
    }

    if (type === "BUTTON_PRESS") {
      this.handleButtonPress(pkt);
      return;
    }

    if (type === "DIM_HOLD") {
      this.handleDimHold(pkt);
      return;
    }

    if (type === "DIM_STEP") {
      this.handleDimStep(pkt);
    }
  }

  private handleLevelControl(pkt: CCXPacket): void {
    const msg = pkt.parsed;
    if (msg.type !== "LEVEL_CONTROL") return;
    const { zoneId, sequence, levelPercent, fade, cct, warmDimMode, colorXy } = msg;

    if (this.watchedZones.size > 0 && !this.watchedZones.has(zoneId)) return;
    if (this.isDuplicate(`0:${zoneId}:${sequence}`)) return;
    this.matchCount++;

    // Detect color-only command: CBOR key 0 (level) absent from inner map
    const inner = (msg.rawBody?.[0] ?? {}) as Record<number, unknown>;
    const levelPresent = 0 in inner;
    const level = levelPresent ? levelPercent : null;

    // Resolve color mode and CCT
    let resolvedCct = cct ?? null;
    let colorMode: "cct" | "xy" = "cct";

    if (colorXy) {
      colorMode = "xy";
    } else if (resolvedCct == null && level !== null && level > 0) {
      // Evaluate warm dim curve if no explicit color
      const curveName =
        warmDimMode != null
          ? "default"
          : this.pairingsByZone.get(zoneId)?.warmDimCurve;
      if (curveName) {
        resolvedCct = evalWarmDimCurve(getWarmDimCurve(curveName), level);
      }
    }

    this.dispatch(zoneId, level, colorMode, resolvedCct, colorXy ?? null, fade, "LEVEL");
  }

  private handleButtonPress(pkt: CCXPacket): void {
    const msg = pkt.parsed;
    if (msg.type !== "BUTTON_PRESS") return;
    const presetId = presetIdFromDeviceId(msg.deviceId);
    if (this.isDuplicate(`1:${presetId}:${msg.sequence}`)) return;

    const sceneEntry = this.presetZones.get(presetId);
    if (!sceneEntry) return;

    for (const [zid, assignment] of Object.entries(sceneEntry.zones)) {
      const zoneId = Number(zid);
      if (this.watchedZones.size > 0 && !this.watchedZones.has(zoneId)) continue;
      this.matchCount++;

      let cct: number | null = null;
      if (assignment.warmDimCurve && assignment.level > 0) {
        cct = evalWarmDimCurve(getWarmDimCurve(assignment.warmDimCurve), assignment.level);
      }

      this.dispatch(
        zoneId,
        assignment.level,
        "cct",
        cct,
        null,
        assignment.fade,
        `PRESET(${sceneEntry.name})`,
      );
    }
  }

  private handleDimHold(pkt: CCXPacket): void {
    const msg = pkt.parsed;
    if (msg.type !== "DIM_HOLD") return;
    const { action, sequence, zoneId } = msg;
    if (this.isDuplicate(`2:${zoneId || "p"}:${sequence}`)) return;
    const direction = action === 3 ? "raise" : "lower";

    if (zoneId && (this.watchedZones.size === 0 || this.watchedZones.has(zoneId))) {
      this.matchCount++;
      this.startRamp(zoneId, direction);
    } else {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const entry = this.presetZones.get(presetId);
      if (entry) {
        for (const zid of Object.keys(entry.zones)) {
          const z = Number(zid);
          if (this.watchedZones.size > 0 && !this.watchedZones.has(z)) continue;
          this.matchCount++;
          this.startRamp(z, direction);
        }
      }
    }
  }

  private handleDimStep(pkt: CCXPacket): void {
    const msg = pkt.parsed;
    if (msg.type !== "DIM_STEP") return;
    const { zoneId, sequence } = msg;
    if (this.isDuplicate(`3:${zoneId || "p"}:${sequence}`)) return;

    if (zoneId && (this.watchedZones.size === 0 || this.watchedZones.has(zoneId))) {
      this.matchCount++;
      this.stopRamp(zoneId);
    } else {
      const presetId = presetIdFromDeviceId(msg.deviceId);
      const entry = this.presetZones.get(presetId);
      if (entry) {
        for (const zid of Object.keys(entry.zones)) {
          const z = Number(zid);
          if (this.watchedZones.size > 0 && !this.watchedZones.has(z)) continue;
          this.matchCount++;
          this.stopRamp(z);
        }
      }
    }
  }

  // ── Dispatch (pure state mutation) ──────────────────────

  private dispatch(
    zoneId: number,
    level: number | null,
    colorMode: "cct" | "xy",
    cct: number | null,
    colorXy: [number, number] | null,
    fade = 1,
    source = "LEVEL",
  ): void {
    const zone = this.getZone(zoneId);

    // Fade idempotency: if already fading to same target, just update color
    if (
      zone.activity.type === "fading" &&
      level !== null &&
      fade > 1 &&
      Math.round(zone.activity.targetLevel) === Math.round(level)
    ) {
      this.updateColor(zone, colorMode, cct, colorXy);
      return;
    }

    // Cancel in-progress activity
    zone.activity = { type: "idle" };

    // Update color state
    this.updateColor(zone, colorMode, cct, colorXy);

    // Log
    const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
    const time = new Date().toISOString().slice(11, 23);
    const levelStr = level !== null ? `${level.toFixed(1)}%` : "color-only";
    const fadeSec = fade / 4;
    const fadeStr = fadeSec > 0.25 ? ` fade=${fadeSec}s` : "";
    const colorStr = colorXy
      ? ` xy=(${(colorXy[0] / 10000).toFixed(4)},${(colorXy[1] / 10000).toFixed(4)})`
      : "";
    this.emit(
      "log",
      `\n${time} ** ${source} → ${zoneName} (zone=${zoneId}) ${levelStr}${fadeStr}${colorStr}`,
    );

    if (level === null) {
      // Color-only: preserve level, mark dirty for WiZ send
      zone.dirty = true;
      zone.reportAt = Date.now() + REPORT_DELAY_MS;
      return;
    }

    if (fade > 1) {
      // Wall-clock fade
      zone.activity = {
        type: "fading",
        startLevel: zone.level,
        targetLevel: level,
        startCct: zone.colorMode === "cct" ? zone.cct : null,
        targetCct: colorMode === "cct" ? cct : null,
        colorXy,
        startTime: Date.now(),
        durationMs: fade * 250,
      };
      zone.dirty = true;
      zone.reportAt = Date.now() + REPORT_DELAY_MS;
    } else {
      // Instant — send WiZ immediately (don't wait for next tick)
      zone.level = level;
      zone.reportAt = Date.now() + REPORT_DELAY_MS;
      const pairing = this.pairingsByZone.get(zoneId);
      if (pairing) {
        this.sendWiz(this.buildWizCommand(zone, pairing));
      }
    }
  }

  private updateColor(
    zone: ZoneState,
    colorMode: "cct" | "xy",
    cct: number | null,
    colorXy: [number, number] | null,
  ): void {
    if (colorMode === "xy" && colorXy) {
      zone.colorMode = "xy";
      zone.colorXy = colorXy;
      zone.cct = null;
    } else if (cct != null) {
      zone.colorMode = "cct";
      zone.cct = cct;
      zone.colorXy = null;
    }
  }

  // ── Dim Ramp ──────────────────────────────────────────

  private startRamp(zoneId: number, direction: "raise" | "lower"): void {
    const zone = this.getZone(zoneId);
    zone.activity = { type: "idle" }; // cancel existing

    const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
    const time = new Date().toISOString().slice(11, 23);
    this.emit(
      "log",
      `\n${time} ** RAMP ${direction.toUpperCase()} → ${zoneName} (zone=${zoneId}) from ${zone.level.toFixed(0)}%`,
    );

    zone.activity = {
      type: "ramping",
      direction,
      startLevel: zone.level,
      startTime: Date.now(),
    };
    zone.dirty = true;
  }

  private stopRamp(zoneId: number): void {
    const zone = this.zones.get(zoneId);
    if (!zone || zone.activity.type !== "ramping") return;

    const elapsedMs = Date.now() - zone.activity.startTime;
    zone.activity = { type: "idle" };
    zone.dirty = true;
    zone.reportAt = Date.now() + REPORT_DELAY_MS;

    const zoneName = getZoneName(zoneId) ?? `Zone ${zoneId}`;
    const time = new Date().toISOString().slice(11, 23);
    this.emit(
      "log",
      `${time} ** RAMP STOP → ${zoneName} (zone=${zoneId}) at ${zone.level.toFixed(0)}% (${elapsedMs}ms)`,
    );
  }

  // ── Tick loop ──────────────────────────────────────────

  private tick(): void {
    const now = Date.now();
    const batch: WizCommand[] = [];

    for (const [zoneId, zone] of this.zones) {
      // Advance active animations
      if (zone.activity.type === "fading") {
        this.advanceFade(zone, now);
      } else if (zone.activity.type === "ramping") {
        this.advanceRamp(zone, zoneId, now);
      }

      // Collect dirty zones for batched send
      if (zone.dirty) {
        zone.dirty = false;
        const pairing = this.pairingsByZone.get(zoneId);
        if (pairing) {
          batch.push(this.buildWizCommand(zone, pairing));
        } else if (this.watchedZones.has(zoneId)) {
          this.emit("log", `  [warn] Zone ${zoneId} has no WiZ pairing`);
        }
      }

      // Emit DEVICE_REPORT after settling delay
      if (zone.reportAt > 0 && zone.activity.type === "idle" && now >= zone.reportAt) {
        zone.reportAt = 0;
        this.sendDeviceReport(zoneId, zone.level);
      }
    }

    // Send all WiZ commands for this tick
    for (const cmd of batch) {
      this.sendWiz(cmd);
    }
  }

  private advanceFade(zone: ZoneState, now: number): void {
    if (zone.activity.type !== "fading") return;
    const fade = zone.activity;
    const elapsed = now - fade.startTime;
    const t = Math.min(1, elapsed / fade.durationMs);

    zone.level = fade.startLevel + t * (fade.targetLevel - fade.startLevel);
    if (fade.startCct != null && fade.targetCct != null) {
      zone.cct = Math.round(fade.startCct + t * (fade.targetCct - fade.startCct));
    }
    zone.dirty = true;

    if (t >= 1) {
      zone.level = fade.targetLevel;
      if (fade.targetCct != null) zone.cct = fade.targetCct;
      zone.activity = { type: "idle" };
    }
  }

  private advanceRamp(zone: ZoneState, zoneId: number, now: number): void {
    if (zone.activity.type !== "ramping") return;
    const ramp = zone.activity;
    const elapsedSec = (now - ramp.startTime) / 1000;
    const delta = elapsedSec * RAMP_RATE_PCT_PER_SEC;

    if (ramp.direction === "raise") {
      zone.level = Math.min(100, ramp.startLevel + delta);
    } else {
      zone.level = Math.max(0, ramp.startLevel - delta);
    }

    // Re-evaluate warm dim CCT each tick
    const pairing = this.pairingsByZone.get(zoneId);
    if (pairing?.warmDimCurve && zone.level > 0) {
      zone.cct = evalWarmDimCurve(getWarmDimCurve(pairing.warmDimCurve), zone.level);
      zone.colorMode = "cct";
    }

    zone.dirty = true;

    // Auto-stop at limits
    if (zone.level >= 100 || zone.level <= 0) {
      zone.activity = { type: "idle" };
      zone.reportAt = Date.now() + REPORT_DELAY_MS;
    }
  }

  // ── WiZ UDP output ────────────────────────────────────

  private buildWizCommand(zone: ZoneState, pairing: WizPairing): WizCommand {
    return {
      ips: pairing.wizIps,
      port: pairing.wizPort,
      level: zone.level,
      colorMode: zone.level <= 0 ? "off" : zone.colorMode,
      cct: zone.cct,
      colorXy: zone.colorXy,
      cctTable: this.getCctTable(pairing),
      zoneName: pairing.name,
    };
  }

  private sendWiz(cmd: WizCommand): void {
    if (!this.wizSocket) return;

    let params: Record<string, number | boolean>;
    let logStr: string;

    if (cmd.colorMode === "off") {
      params = { state: false };
      logStr = "OFF";
    } else if (cmd.colorMode === "xy" && cmd.colorXy) {
      const x = cmd.colorXy[0] / 10000;
      const y = cmd.colorXy[1] / 10000;
      const channels = xyToRgbwc(x, y, cmd.level, cmd.cctTable);
      params = rgbwcToPilotParams(channels);
      logStr = `${Math.round(cmd.level)}% xy=(${x.toFixed(4)},${y.toFixed(4)}) [r${channels.r} g${channels.g} b${channels.b} w${channels.w} c${channels.c}]`;
    } else {
      const cct = cmd.cct ?? 2700;
      const channels = cctToRgbwc(cct, cmd.level, cmd.cctTable);
      params = rgbwcToPilotParams(channels);
      const cctStr = cmd.cct != null ? `${cmd.cct}K` : "2700K(default)";
      logStr = `${Math.round(cmd.level)}% ${cctStr} [r${channels.r} g${channels.g} b${channels.b} w${channels.w} c${channels.c}]`;
    }

    const buf = Buffer.from(JSON.stringify({ method: "setPilot", params }));

    for (const ip of cmd.ips) {
      this.wizSocket.send(buf, cmd.port, ip);
    }
    this.emit("log", `  [wiz] → ${cmd.zoneName} (${cmd.ips.length} bulbs) ${logStr}`);
  }

  // ── Deduplication ─────────────────────────────────────

  private isDuplicate(key: string): boolean {
    const now = Date.now();
    const prev = this.dedup.get(key);
    if (prev && now - prev < DEDUP_WINDOW_MS) return true;
    this.dedup.set(key, now);

    // Evict stale entries
    if (this.dedup.size > 100) {
      for (const [k, ts] of this.dedup) {
        if (now - ts > DEDUP_WINDOW_MS) this.dedup.delete(k);
      }
    }
    return false;
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

  // ── Lifecycle ──────────────────────────────────────────

  /** Clean up: close sockets and stop tick loop */
  destroy(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.wizSocket?.close();
    this.wizSocket = null;
    this.nucleoSocket?.close();
    this.nucleoSocket = null;
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
