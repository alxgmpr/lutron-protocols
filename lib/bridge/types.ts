/**
 * Bridge types — protocol-independent vocabulary shared by the model,
 * its sources and its sinks.
 *
 * Nothing here imports a transport. Sources normalize their wire format into
 * `SourceIntent`; sinks consume the events the model emits in response.
 */

// ── Zone state ────────────────────────────────────────────

export type ZoneActivity =
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

export interface ZoneState {
  level: number;
  colorMode: "cct" | "xy";
  cct: number | null;
  colorXy: [number, number] | null;
  activity: ZoneActivity;
  dirty: boolean;
  /** 0 = no settle pending, >0 = timestamp at which the zone reports settled */
  reportAt: number;
}

/** Scene definition: preset ID → the zone levels it drives. */
export interface PresetZoneEntry {
  name: string;
  zones: Record<
    string,
    { level: number; fade?: number; warmDimCurve?: string }
  >;
}

// ── Device events ─────────────────────────────────────────

/** What a control did. `press` is a discrete tap; hold/release bracket a ramp. */
export type DeviceAction = "press" | "hold" | "release";

/**
 * A control was operated. Device-scoped, not zone-scoped: it is a fact about
 * the button, independent of whether anything is bound to it. A Pico that
 * drives no watched zone still emits these — that is the point of the channel,
 * and why watch filtering does not apply to it.
 */
export interface DeviceEvent {
  /**
   * Stable hex identity of the control, taken from the wire payload.
   *
   * Deliberately NOT the IPv6 source address: a device's primary ML-EID
   * rotates (see ccx/config.ts, which keeps a separate stable `fd00::`
   * secondary for exactly this reason), and a rotating key would orphan every
   * Home Assistant entity built on it. This id is constant across presses,
   * across bridge restarts, and across a rename.
   */
  deviceId: string;
  /** Resolved display name, falling back to `Device <deviceId>`. */
  deviceName: string;
  button: number;
  action: DeviceAction;
  origin: string;
  /** Transport that observed it — "ccx" today. */
  source: string;
  sequence: number;
}

// ── Source intents ────────────────────────────────────────

/**
 * What a source says happened, in protocol-independent terms. The model owns
 * dedup, watch filtering, scene expansion and warm dim, so a source only has
 * to translate its wire format — it never decides whether to act.
 */
export type SourceIntent =
  | {
      kind: "zoneLevel";
      zoneId: number;
      /** null = colour-only command; the zone keeps its current level */
      level: number | null;
      cct: number | null;
      colorXy: [number, number] | null;
      /** quarter-seconds; 1 (or less) means instant */
      fade?: number;
      /** curve name forced by the wire format, overriding the zone's own */
      warmDimHint?: string;
      origin: string;
      dedupKey?: string;
      /** Window this key is suppressed for; defaults to DEDUP_WINDOW_MS. */
      dedupWindowMs?: number;
      /**
       * The wire says this is a fresh event, not a retransmission, so dedup
       * records its key but never suppresses it. See CcaSource.
       */
      isNewWireEvent?: boolean;
    }
  | {
      kind: "preset";
      presetId: number;
      origin: string;
      dedupKey?: string;
      /** Window this key is suppressed for; defaults to DEDUP_WINDOW_MS. */
      dedupWindowMs?: number;
      /**
       * The wire says this is a fresh event, not a retransmission, so dedup
       * records its key but never suppresses it. See CcaSource.
       */
      isNewWireEvent?: boolean;
    }
  | {
      kind: "ramp";
      action: "start" | "stop";
      direction?: "raise" | "lower";
      /** explicit zone target, when the wire format carries one */
      zoneId?: number;
      /** fallback scene target, used when zoneId is absent or unwatched */
      presetId?: number;
      origin: string;
      dedupKey?: string;
      /** Window this key is suppressed for; defaults to DEDUP_WINDOW_MS. */
      dedupWindowMs?: number;
      /**
       * The wire says this is a fresh event, not a retransmission, so dedup
       * records its key but never suppresses it. See CcaSource.
       */
      isNewWireEvent?: boolean;
    }
  | {
      kind: "deviceEvent";
      /**
       * Stable hex identity of the control, straight off the wire. Not an
       * address: see DeviceEvent.deviceId for why.
       */
      deviceId: string;
      button: number;
      action: DeviceAction;
      origin: string;
      /** Transport that observed it — "ccx" today. */
      source: string;
      /** Wire sequence number the dedup key is built from. */
      sequence: number;
      dedupKey?: string;
      /** Window this key is suppressed for; defaults to DEDUP_WINDOW_MS. */
      dedupWindowMs?: number;
      /**
       * The wire says this is a fresh event, not a retransmission, so dedup
       * records its key but never suppresses it. See CcaSource.
       */
      isNewWireEvent?: boolean;
    };

/**
 * Outcome of `DeviceModel.apply()`.
 * `accepted` is false only when the intent was filtered or deduped — sources
 * use it to decide whether the originating packet is worth logging.
 */
export interface ApplyResult {
  accepted: boolean;
  /** number of zones actually driven */
  applied: number;
}

// ── Model events ──────────────────────────────────────────

/** A zone's output state changed and sinks should push it. */
export interface ZoneChangedEvent {
  zoneId: number;
  zoneName: string;
  level: number;
  colorMode: "cct" | "xy";
  cct: number | null;
  colorXy: [number, number] | null;
  activity: "idle" | "fading" | "ramping";
}

/** A zone stopped moving and stayed still for the report delay. */
export interface ZoneSettledEvent {
  zoneId: number;
  zoneName: string;
  level: number;
}

/** A resolved command, for logging and diagnostics. */
export type CommandEvent =
  | {
      kind: "level";
      zoneId: number;
      zoneName: string;
      origin: string;
      level: number | null;
      fade: number;
      colorXy: [number, number] | null;
    }
  | {
      kind: "ramp-start";
      zoneId: number;
      zoneName: string;
      direction: "raise" | "lower";
      fromLevel: number;
    }
  | {
      kind: "ramp-stop";
      zoneId: number;
      zoneName: string;
      atLevel: number;
      elapsedMs: number;
    };

// ── Sinks ─────────────────────────────────────────────────

/** The subset of the model a sink is allowed to see. */
export interface SinkHost {
  on(event: "zone:changed", listener: (e: ZoneChangedEvent) => void): void;
  on(event: "zone:settled", listener: (e: ZoneSettledEvent) => void): void;
  on(event: "command", listener: (e: CommandEvent) => void): void;
  on(event: "device:event", listener: (e: DeviceEvent) => void): void;
  /** True only for zones named explicitly in the watch list. */
  isExplicitlyWatched(zoneId: number): boolean;
}

/**
 * An output. Sinks subscribe to model events and never see a packet, so a new
 * one (MQTT, CLI log, …) needs no change to any protocol or model code.
 */
export interface BridgeSink {
  readonly name: string;
  attach(model: SinkHost): void;
  detach(): void;
}
