/**
 * MQTT sink — publishes zone state and button presses with Home Assistant
 * Discovery, so HA builds the entities itself and nothing HA-specific leaks
 * into the protocol code.
 *
 * ## Topic layout
 *
 * Topics carry identity, not transport. One process covers every source, so a
 * zone observed on both CCX and LEAP is ONE entity that either source can
 * update, rather than two that never reconcile:
 *
 *   lutron/zone/<zoneId>/state              retained
 *   lutron/device/<deviceId>/event          NOT retained
 *   lutron/bridge/availability              retained, also the LWT
 *   lutron/bridge/source/<name>/availability retained
 *
 * Health is where the transport does appear. Each entity depends on the bridge
 * being up *and* on the source that feeds it, with `availability_mode: all`, so
 * a dead CCX sniffer greys out CCX-backed entities without touching the rest.
 *
 * ## Retention
 *
 * State and discovery are retained: HA must find current levels and its
 * entities after a restart. Button events are deliberately NOT retained — a
 * retained press is replayed to every new subscriber, which would re-fire
 * every automation bound to it each time HA restarts. Command topics (Phase 2)
 * must not be retained either, for the same reason.
 *
 * ## Identity
 *
 * `unique_id` is keyed on the Lutron zone id and the wire device id — the two
 * things that survive a rename, a bridge restart, and being seen on a second
 * transport. See DeviceEvent.deviceId for why the IPv6 source address is not
 * usable here.
 *
 * Occupancy sensors would slot in as a third entity kind here (`binary_sensor`
 * per sensor, off a `sensor:occupancy` model channel). Out of scope: there is
 * no occupancy in the vocabulary yet.
 */

import type {
  BridgeSink,
  DeviceEvent,
  SinkHost,
  ZoneChangedEvent,
} from "../types";

// ── Injected client ───────────────────────────────────────

/**
 * The slice of an MQTT client this sink uses, structurally compatible with
 * `mqtt.MqttClient`. Injected rather than constructed so tests assert on real
 * topics and payloads without a broker.
 */
export interface MqttClientLike {
  readonly connected: boolean;
  publish(
    topic: string,
    payload: string,
    opts: { retain?: boolean; qos?: 0 | 1 | 2 },
    cb?: (err?: Error) => void,
  ): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  end(force?: boolean, cb?: () => void): void;
}

export interface MqttSinkOptions {
  client: MqttClientLike;
  /** Root of the state topic tree. */
  baseTopic?: string;
  /** Where HA looks for discovery configs. */
  discoveryPrefix?: string;
  /** Sources feeding this bridge; each gets its own availability topic. */
  sources?: string[];
  log?: (msg: string) => void;
}

const DEFAULT_BASE_TOPIC = "lutron";
const DEFAULT_DISCOVERY_PREFIX = "homeassistant";
const ONLINE = "online";
const OFFLINE = "offline";

/** Every action a control can report, for the HA `event` entity's trigger list. */
const EVENT_TYPES = ["press", "hold", "release"];

// ── Topics ────────────────────────────────────────────────

/**
 * The bridge's topic tree. Exported so the LWT — which has to be set when the
 * client connects, before the sink exists — is built from the same place.
 */
export function bridgeTopics(baseTopic: string = DEFAULT_BASE_TOPIC) {
  return {
    availability: `${baseTopic}/bridge/availability`,
    sourceAvailability: (name: string) =>
      `${baseTopic}/bridge/source/${name}/availability`,
    zoneState: (zoneId: number) => `${baseTopic}/zone/${zoneId}/state`,
    deviceEvent: (deviceId: string) => `${baseTopic}/device/${deviceId}/event`,
  };
}

/** The LWT an MQTT client must register so HA greys out a bridge that died. */
export function lastWillFor(baseTopic: string = DEFAULT_BASE_TOPIC) {
  return {
    topic: bridgeTopics(baseTopic).availability,
    payload: OFFLINE,
    qos: 0 as const,
    retain: true,
  };
}

// ── Real client ───────────────────────────────────────────

export interface MqttConnectOptions {
  /** Broker URL, e.g. mqtt://homeassistant.local:1883 */
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
  baseTopic?: string;
}

/**
 * Build a live client with the bridge's LWT already registered.
 *
 * Kept out of MqttSink so the sink stays free of I/O, and imported lazily so
 * nothing pays for `mqtt` on an install with no broker configured. The returned
 * client reconnects on its own; the sink republishes discovery each time it
 * does.
 */
export async function connectMqttClient(
  opts: MqttConnectOptions,
): Promise<MqttClientLike> {
  const mqtt = await import("mqtt");
  return mqtt.connect(opts.url, {
    username: opts.username,
    password: opts.password,
    clientId: opts.clientId,
    will: lastWillFor(opts.baseTopic),
    reconnectPeriod: 5000,
  }) as unknown as MqttClientLike;
}

// ── Sink ──────────────────────────────────────────────────

export class MqttSink implements BridgeSink {
  readonly name = "mqtt";

  private client: MqttClientLike;
  private topics: ReturnType<typeof bridgeTopics>;
  private discoveryPrefix: string;
  private sources: string[];
  private log: (msg: string) => void;

  /** Discovery configs published so far, replayed on every reconnect. */
  private announced = new Map<string, string>();
  private sourceState = new Map<string, boolean>();

  constructor(opts: MqttSinkOptions) {
    this.client = opts.client;
    this.topics = bridgeTopics(opts.baseTopic ?? DEFAULT_BASE_TOPIC);
    this.discoveryPrefix = opts.discoveryPrefix ?? DEFAULT_DISCOVERY_PREFIX;
    this.sources = opts.sources ?? [];
    this.log = opts.log ?? (() => {});

    // An 'error' with no listener is an unhandled throw on an EventEmitter,
    // which would take the bridge down over a broker being unreachable.
    this.client.on("error", (err: Error) => {
      this.log(`  [mqtt] ${err?.message ?? String(err)}`);
    });
    this.client.on("connect", () => this.onConnect());
  }

  attach(model: SinkHost): void {
    model.on("zone:changed", (e) => this.onZoneChanged(e));
    model.on("device:event", (e) => this.onDeviceEvent(e));
  }

  detach(): void {
    this.publish(this.topics.availability, OFFLINE, true);
    try {
      this.client.end();
    } catch (err) {
      this.log(`  [mqtt] close failed: ${errMessage(err)}`);
    }
  }

  // ── Connection lifecycle ────────────────────────────────

  /**
   * Re-announce everything. The broker may have dropped its retained set, and
   * HA should get its entities back without waiting for someone to touch a
   * light.
   */
  private onConnect(): void {
    this.publish(this.topics.availability, ONLINE, true);
    for (const source of this.sources) {
      const up = this.sourceState.get(source) ?? true;
      this.publish(
        this.topics.sourceAvailability(source),
        up ? ONLINE : OFFLINE,
        true,
      );
    }
    for (const [topic, payload] of this.announced) {
      this.publish(topic, payload, true);
    }
  }

  /** Report a source as up or down without touching the bridge's own health. */
  setSourceAvailable(source: string, up: boolean): void {
    this.sourceState.set(source, up);
    this.publish(
      this.topics.sourceAvailability(source),
      up ? ONLINE : OFFLINE,
      true,
    );
  }

  // ── Zones ───────────────────────────────────────────────

  private onZoneChanged(e: ZoneChangedEvent): void {
    this.announceZone(e);
    this.publish(
      this.topics.zoneState(e.zoneId),
      JSON.stringify(zoneStatePayload(e)),
      true,
    );
  }

  private announceZone(e: ZoneChangedEvent): void {
    const uniqueId = `lutron_zone_${e.zoneId}`;
    const topic = `${this.discoveryPrefix}/light/${uniqueId}/config`;
    if (this.announced.has(topic)) return;

    const payload = JSON.stringify({
      schema: "json",
      name: e.zoneName,
      unique_id: uniqueId,
      object_id: uniqueId,
      state_topic: this.topics.zoneState(e.zoneId),
      brightness: true,
      brightness_scale: 255,
      supported_color_modes: ["color_temp", "xy"],
      availability: this.availabilityBlock(),
      availability_mode: "all",
      device: {
        identifiers: [uniqueId],
        name: e.zoneName,
        manufacturer: "Lutron",
        model: "Zone",
      },
    });

    this.announced.set(topic, payload);
    this.publish(topic, payload, true);
  }

  // ── Devices ─────────────────────────────────────────────

  private onDeviceEvent(e: DeviceEvent): void {
    this.announceDevice(e);
    this.publish(
      this.topics.deviceEvent(e.deviceId),
      JSON.stringify({
        event_type: e.action,
        button: e.button,
        origin: e.origin,
        source: e.source,
        sequence: e.sequence,
      }),
      // Never retained: a replayed press re-fires every bound automation.
      false,
    );
  }

  private announceDevice(e: DeviceEvent): void {
    const uniqueId = `lutron_button_${e.deviceId}`;
    const topic = `${this.discoveryPrefix}/event/${uniqueId}/config`;
    if (this.announced.has(topic)) return;

    const payload = JSON.stringify({
      name: `Button ${e.button}`,
      unique_id: uniqueId,
      object_id: uniqueId,
      state_topic: this.topics.deviceEvent(e.deviceId),
      event_types: EVENT_TYPES,
      device_class: "button",
      availability: this.availabilityBlock(e.source),
      availability_mode: "all",
      device: {
        identifiers: [`lutron_device_${e.deviceId}`],
        name: e.deviceName,
        manufacturer: "Lutron",
        model: "Control",
      },
    });

    this.announced.set(topic, payload);
    this.publish(topic, payload, true);
  }

  // ── Availability ────────────────────────────────────────

  /**
   * An entity is available when the bridge is up AND the source feeding it is.
   * With one source configured every entity depends on it; a device event
   * names its own source, so a second transport narrows this correctly.
   */
  private availabilityBlock(source?: string): { topic: string }[] {
    const names =
      source && this.sources.includes(source) ? [source] : this.sources;
    return [
      { topic: this.topics.availability },
      ...names.map((n) => ({ topic: this.topics.sourceAvailability(n) })),
    ];
  }

  // ── Publishing ──────────────────────────────────────────

  /**
   * Publishing is best-effort by design. The bridge decodes packets and drives
   * other sinks whether or not a broker is reachable, so nothing here is
   * allowed to throw or to block.
   */
  private publish(topic: string, payload: string, retain: boolean): void {
    if (!this.client.connected) return;
    try {
      this.client.publish(topic, payload, { retain, qos: 0 }, (err) => {
        if (err) this.log(`  [mqtt] publish ${topic} failed: ${err.message}`);
      });
    } catch (err) {
      this.log(`  [mqtt] publish ${topic} failed: ${errMessage(err)}`);
    }
  }
}

// ── Payload shaping ───────────────────────────────────────

/** HA JSON light schema. Levels are percent on the wire, 0-255 in HA. */
function zoneStatePayload(e: ZoneChangedEvent): Record<string, unknown> {
  if (e.level <= 0) return { state: "OFF" };

  const payload: Record<string, unknown> = {
    state: "ON",
    brightness: Math.round((e.level * 255) / 100),
  };

  if (e.colorMode === "xy" && e.colorXy) {
    payload.color_mode = "xy";
    // The wire carries CIE xy as integers scaled by 10000.
    payload.color = { x: e.colorXy[0] / 10000, y: e.colorXy[1] / 10000 };
  } else if (e.cct != null) {
    payload.color_mode = "color_temp";
    payload.color_temp_kelvin = e.cct;
  }

  return payload;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
