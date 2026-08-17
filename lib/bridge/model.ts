/**
 * DeviceModel — the authoritative, protocol-independent picture of the system.
 *
 * Sources hand it `SourceIntent`s; it owns everything that has to be decided
 * once and shared by every output: deduplication, watched-zone filtering,
 * scene expansion, warm dim, wall-clock fade/ramp interpolation, and the
 * settle-to-idle timer behind `zone:settled`.
 *
 * Sinks subscribe to its events. It knows nothing about WiZ, MQTT or CCX.
 */

import { EventEmitter } from "events";
import { evalWarmDimCurve, getWarmDimCurve } from "../warm-dim";
import type {
  ApplyResult,
  BridgeSink,
  CommandEvent,
  DeviceEvent,
  PresetZoneEntry,
  SourceIntent,
  ZoneChangedEvent,
  ZoneSettledEvent,
  ZoneState,
} from "./types";

// ── Constants ─────────────────────────────────────────────

const TICK_MS = 50; // 20 Hz tick loop
const DEDUP_WINDOW_MS = 500; // Thread retransmissions span ~350ms across relays
const RAMP_RATE_PCT_PER_SEC = 100 / 4.75; // 4.75s full range (19 quarter-seconds)
const REPORT_DELAY_MS = 2000; // delay settle after activity stops (real devices wait seconds)
const DEDUP_MAX_ENTRIES = 100;

export interface DeviceModelOptions {
  /** Scene lookup (preset ID → zone levels) */
  presetZones?: Map<number, PresetZoneEntry>;
  /** Zone IDs to act on (empty = all zones) */
  watchedZones?: Set<number>;
  /** Zone ID → warm dim curve name, applied to colourless level commands */
  zoneCurves?: Map<number, string>;
  /** Display-name lookup, injected so the model owns no config loading */
  resolveZoneName?: (zoneId: number) => string | undefined;
  /** Device display-name lookup, injected for the same reason */
  resolveDeviceName?: (deviceId: string) => string | undefined;
  /** Clock, injectable for deterministic tests */
  now?: () => number;
  /** Tick interval; set autoTick false to drive tick() manually */
  tickMs?: number;
  reportDelayMs?: number;
  autoTick?: boolean;
}

export class DeviceModel extends EventEmitter {
  private zones = new Map<number, ZoneState>();
  private dedup = new Map<string, number>();
  private sinks: BridgeSink[] = [];

  private presetZones: Map<number, PresetZoneEntry>;
  private watchedZones: Set<number>;
  private zoneCurves: Map<number, string>;
  private resolveZoneName: (zoneId: number) => string | undefined;
  private resolveDeviceName: (deviceId: string) => string | undefined;
  private now: () => number;
  private reportDelayMs: number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Zones driven since construction — one count per (zone, command) pair. */
  appliedCount = 0;

  constructor(opts: DeviceModelOptions = {}) {
    super();
    this.presetZones = opts.presetZones ?? new Map();
    this.watchedZones = opts.watchedZones ?? new Set();
    this.zoneCurves = opts.zoneCurves ?? new Map();
    this.resolveZoneName = opts.resolveZoneName ?? (() => undefined);
    this.resolveDeviceName = opts.resolveDeviceName ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.reportDelayMs = opts.reportDelayMs ?? REPORT_DELAY_MS;

    if (opts.autoTick !== false) {
      this.tickTimer = setInterval(() => this.tick(), opts.tickMs ?? TICK_MS);
    }
  }

  // ── Sinks ───────────────────────────────────────────────

  addSink(sink: BridgeSink): void {
    this.sinks.push(sink);
    sink.attach(this);
  }

  /** True only for zones named explicitly in the watch list. */
  isExplicitlyWatched(zoneId: number): boolean {
    return this.watchedZones.has(zoneId);
  }

  private isWatched(zoneId: number): boolean {
    return this.watchedZones.size === 0 || this.watchedZones.has(zoneId);
  }

  // ── Zone access ─────────────────────────────────────────

  private getOrCreateZone(zoneId: number): ZoneState {
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

  getZoneState(zoneId: number): ZoneState | undefined {
    return this.zones.get(zoneId);
  }

  zoneName(zoneId: number): string {
    return this.resolveZoneName(zoneId) ?? `Zone ${zoneId}`;
  }

  deviceName(deviceId: string): string {
    return this.resolveDeviceName(deviceId) ?? `Device ${deviceId}`;
  }

  private snapshot(zoneId: number, zone: ZoneState): ZoneChangedEvent {
    return {
      zoneId,
      zoneName: this.zoneName(zoneId),
      level: zone.level,
      colorMode: zone.colorMode,
      cct: zone.cct,
      colorXy: zone.colorXy,
      activity: zone.activity.type,
    };
  }

  // ── Intent application ──────────────────────────────────

  /**
   * @param onAccepted invoked the moment the intent clears filtering and
   * dedup, before any zone is driven. Sources use it to log the originating
   * packet ahead of the command it resolved to.
   */
  apply(intent: SourceIntent, onAccepted?: () => void): ApplyResult {
    switch (intent.kind) {
      case "zoneLevel":
        return this.applyZoneLevel(intent, onAccepted);
      case "preset":
        return this.applyPreset(intent, onAccepted);
      case "ramp":
        return this.applyRamp(intent, onAccepted);
      case "deviceEvent":
        return this.applyDeviceEvent(intent, onAccepted);
    }
  }

  /**
   * Device events bypass the watch filter on purpose: watching is a statement
   * about which zones the bridge drives, and a button press is a fact about
   * the button. A Pico bound to nothing is still an automation trigger.
   *
   * Dedup still applies, and the caller's key must be built from the wire
   * sequence number — see `isDuplicate`.
   */
  private applyDeviceEvent(
    intent: Extract<SourceIntent, { kind: "deviceEvent" }>,
    onAccepted?: () => void,
  ): ApplyResult {
    if (this.isDuplicate(intent.dedupKey, intent.dedupWindowMs))
      return { accepted: false, applied: 0 };

    onAccepted?.();
    this.emit("device:event", {
      deviceId: intent.deviceId,
      deviceName: this.deviceName(intent.deviceId),
      button: intent.button,
      action: intent.action,
      origin: intent.origin,
      source: intent.source,
      sequence: intent.sequence,
    } satisfies DeviceEvent);
    // No zone was driven; the event is the whole outcome.
    return { accepted: true, applied: 0 };
  }

  private applyZoneLevel(
    intent: Extract<SourceIntent, { kind: "zoneLevel" }>,
    onAccepted?: () => void,
  ): ApplyResult {
    // Watch filter runs before dedup so unwatched traffic never occupies the
    // dedup table.
    if (!this.isWatched(intent.zoneId)) return { accepted: false, applied: 0 };
    if (this.isDuplicate(intent.dedupKey, intent.dedupWindowMs))
      return { accepted: false, applied: 0 };

    onAccepted?.();
    this.appliedCount++;
    this.dispatchLevel(
      intent.zoneId,
      intent.level,
      intent.cct,
      intent.colorXy,
      intent.fade ?? 1,
      intent.origin,
      intent.warmDimHint,
    );
    return { accepted: true, applied: 1 };
  }

  private applyPreset(
    intent: Extract<SourceIntent, { kind: "preset" }>,
    onAccepted?: () => void,
  ): ApplyResult {
    if (this.isDuplicate(intent.dedupKey, intent.dedupWindowMs))
      return { accepted: false, applied: 0 };

    onAccepted?.();
    const entry = this.presetZones.get(intent.presetId);
    // An unknown preset is still "accepted": the packet is real and worth
    // logging, there is just nothing mapped to it.
    if (!entry) return { accepted: true, applied: 0 };

    let applied = 0;
    for (const [zid, assignment] of Object.entries(entry.zones)) {
      const zoneId = Number(zid);
      if (!this.isWatched(zoneId)) continue;
      this.appliedCount++;
      applied++;
      this.dispatchLevel(
        zoneId,
        assignment.level,
        null,
        null,
        assignment.fade ?? 1,
        `${intent.origin}(${entry.name})`,
        assignment.warmDimCurve,
      );
    }
    return { accepted: true, applied };
  }

  private applyRamp(
    intent: Extract<SourceIntent, { kind: "ramp" }>,
    onAccepted?: () => void,
  ): ApplyResult {
    if (this.isDuplicate(intent.dedupKey, intent.dedupWindowMs))
      return { accepted: false, applied: 0 };

    onAccepted?.();
    const run = (zoneId: number) => {
      this.appliedCount++;
      if (intent.action === "start") {
        this.startRamp(zoneId, intent.direction ?? "raise");
      } else {
        this.stopRamp(zoneId);
      }
    };

    // An explicit but unwatched zone deliberately falls through to the scene
    // target rather than short-circuiting.
    if (intent.zoneId != null && this.isWatched(intent.zoneId)) {
      run(intent.zoneId);
      return { accepted: true, applied: 1 };
    }

    if (intent.presetId == null) return { accepted: true, applied: 0 };
    const entry = this.presetZones.get(intent.presetId);
    if (!entry) return { accepted: true, applied: 0 };

    let applied = 0;
    for (const zid of Object.keys(entry.zones)) {
      const zoneId = Number(zid);
      if (!this.isWatched(zoneId)) continue;
      applied++;
      run(zoneId);
    }
    return { accepted: true, applied };
  }

  // ── Level dispatch ──────────────────────────────────────

  private dispatchLevel(
    zoneId: number,
    level: number | null,
    cct: number | null,
    colorXy: [number, number] | null,
    fade: number,
    origin: string,
    warmDimHint?: string,
  ): void {
    const zone = this.getOrCreateZone(zoneId);

    // Resolve colour: an explicit xy or cct wins, otherwise fall back to the
    // warm dim curve for this zone.
    let resolvedCct = cct;
    let colorMode: "cct" | "xy" = "cct";
    if (colorXy) {
      colorMode = "xy";
    } else if (resolvedCct == null && level !== null && level > 0) {
      const curveName = warmDimHint ?? this.zoneCurves.get(zoneId);
      if (curveName) {
        resolvedCct = evalWarmDimCurve(getWarmDimCurve(curveName), level);
      }
    }

    // Fade idempotency: a repeat of the fade already running only updates colour.
    if (
      zone.activity.type === "fading" &&
      level !== null &&
      fade > 1 &&
      Math.round(zone.activity.targetLevel) === Math.round(level)
    ) {
      this.updateColor(zone, colorMode, resolvedCct, colorXy);
      return;
    }

    zone.activity = { type: "idle" }; // cancel whatever was in progress
    this.updateColor(zone, colorMode, resolvedCct, colorXy);

    this.emit("command", {
      kind: "level",
      zoneId,
      zoneName: this.zoneName(zoneId),
      origin,
      level,
      fade,
      colorXy,
    } satisfies CommandEvent);

    const now = this.now();

    if (level === null) {
      // Colour-only: keep the level, but the output still needs pushing.
      this.markDirty(zone);
      zone.reportAt = now + this.reportDelayMs;
      return;
    }

    if (fade > 1) {
      zone.activity = {
        type: "fading",
        startLevel: zone.level,
        targetLevel: level,
        startCct: zone.colorMode === "cct" ? zone.cct : null,
        targetCct: colorMode === "cct" ? resolvedCct : null,
        colorXy,
        startTime: now,
        durationMs: fade * 250,
      };
      this.markDirty(zone);
      zone.reportAt = now + this.reportDelayMs;
      return;
    }

    // Instant — publish now rather than waiting for the next tick.
    zone.level = level;
    zone.reportAt = now + this.reportDelayMs;
    zone.dirty = false;
    this.emit("zone:changed", this.snapshot(zoneId, zone));
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

  private markDirty(zone: ZoneState): void {
    zone.dirty = true;
  }

  // ── Ramp ────────────────────────────────────────────────

  private startRamp(zoneId: number, direction: "raise" | "lower"): void {
    const zone = this.getOrCreateZone(zoneId);
    zone.activity = { type: "idle" }; // cancel existing

    this.emit("command", {
      kind: "ramp-start",
      zoneId,
      zoneName: this.zoneName(zoneId),
      direction,
      fromLevel: zone.level,
    } satisfies CommandEvent);

    zone.activity = {
      type: "ramping",
      direction,
      startLevel: zone.level,
      startTime: this.now(),
    };
    this.markDirty(zone);
  }

  private stopRamp(zoneId: number): void {
    const zone = this.zones.get(zoneId);
    if (!zone || zone.activity.type !== "ramping") return;

    const now = this.now();
    const elapsedMs = now - zone.activity.startTime;
    zone.activity = { type: "idle" };
    this.markDirty(zone);
    zone.reportAt = now + this.reportDelayMs;

    this.emit("command", {
      kind: "ramp-stop",
      zoneId,
      zoneName: this.zoneName(zoneId),
      atLevel: zone.level,
      elapsedMs,
    } satisfies CommandEvent);
  }

  // ── Tick loop ───────────────────────────────────────────

  /** Advance animations and publish. Public so tests can step it. */
  tick(): void {
    const now = this.now();

    for (const [zoneId, zone] of this.zones) {
      if (zone.activity.type === "fading") {
        this.advanceFade(zone, now);
      } else if (zone.activity.type === "ramping") {
        this.advanceRamp(zone, zoneId, now);
      }

      if (zone.dirty) {
        zone.dirty = false;
        this.emit("zone:changed", this.snapshot(zoneId, zone));
      }

      if (
        zone.reportAt > 0 &&
        zone.activity.type === "idle" &&
        now >= zone.reportAt
      ) {
        zone.reportAt = 0;
        this.emit("zone:settled", {
          zoneId,
          zoneName: this.zoneName(zoneId),
          level: zone.level,
        } satisfies ZoneSettledEvent);
      }
    }
  }

  private advanceFade(zone: ZoneState, now: number): void {
    if (zone.activity.type !== "fading") return;
    const fade = zone.activity;
    const t = Math.min(1, (now - fade.startTime) / fade.durationMs);

    zone.level = fade.startLevel + t * (fade.targetLevel - fade.startLevel);
    if (fade.startCct != null && fade.targetCct != null) {
      zone.cct = Math.round(
        fade.startCct + t * (fade.targetCct - fade.startCct),
      );
    }
    this.markDirty(zone);

    if (t >= 1) {
      zone.level = fade.targetLevel;
      if (fade.targetCct != null) zone.cct = fade.targetCct;
      zone.activity = { type: "idle" };
    }
  }

  private advanceRamp(zone: ZoneState, zoneId: number, now: number): void {
    if (zone.activity.type !== "ramping") return;
    const ramp = zone.activity;
    const delta = ((now - ramp.startTime) / 1000) * RAMP_RATE_PCT_PER_SEC;

    zone.level =
      ramp.direction === "raise"
        ? Math.min(100, ramp.startLevel + delta)
        : Math.max(0, ramp.startLevel - delta);

    // Warm dim tracks the level as it moves.
    const curveName = this.zoneCurves.get(zoneId);
    if (curveName && zone.level > 0) {
      zone.cct = evalWarmDimCurve(getWarmDimCurve(curveName), zone.level);
      zone.colorMode = "cct";
    }

    this.markDirty(zone);

    if (zone.level >= 100 || zone.level <= 0) {
      zone.activity = { type: "idle" };
      zone.reportAt = now + this.reportDelayMs;
    }
  }

  // ── Dedup ───────────────────────────────────────────────

  /**
   * Dedup suppresses retransmissions of ONE wire event — nothing else. Every
   * key a source builds must therefore include that event's wire sequence
   * number, never just (device, button) or (zone, level): two presses of one
   * button are two events and must both get through, however close together.
   *
   * CCX can honour this because a retransmit repeats its sequence number and a
   * second press never does. CCA cannot: its sequence byte *increments* per
   * retransmit (it carries the TDMA slot in the low bits — see
   * docs/protocols/cca/tdma.md §2), so on that transport identical payload
   * bytes arriving close together are the only retransmit signal there is.
   *
   * That is why `windowMs` is per-intent. CCA asks for a window sized to its
   * retransmit burst instead of the default, keeping the span in which it
   * cannot distinguish a double press as short as the protocol allows. A
   * transport that cannot key on a sequence dedupes less; the asymmetry is
   * deliberate.
   */
  private isDuplicate(key: string | undefined, windowMs?: number): boolean {
    if (key === undefined) return false;
    const window = windowMs ?? DEDUP_WINDOW_MS;
    const now = this.now();
    const prev = this.dedup.get(key);
    if (prev !== undefined && now - prev < window) return true;
    this.dedup.set(key, now);

    if (this.dedup.size > DEDUP_MAX_ENTRIES) {
      for (const [k, ts] of this.dedup) {
        if (now - ts > DEDUP_WINDOW_MS) this.dedup.delete(k);
      }
    }
    return false;
  }

  // ── Lifecycle ───────────────────────────────────────────

  destroy(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const sink of this.sinks) sink.detach();
    this.sinks = [];
  }
}
