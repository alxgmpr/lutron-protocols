/**
 * openlutron bridge — the assembled read path.
 *
 *   openlutron board ──UDP :9433──▶ OpenlutronStream
 *                                        │ frames
 *                                        ▼
 *                                  OpenlutronSource  (CCX │ CCA demux)
 *                                        │ intents
 *                                        ▼
 *                                   DeviceModel      (dedup, scenes, fades)
 *                                        │ events
 *                                        ▼
 *                              MqttSink · WizSink · LogSink · report sink
 *
 * This is the wiring, kept out of the add-on entry point so it can be tested
 * with a fake socket and a fake broker. The entry point's job is only to turn
 * add-on options into these arguments.
 *
 * ## Availability is the part that has to be right
 *
 * The add-on is unattended, so the failure that matters is not a crash — it is
 * Home Assistant showing a live-looking set of entities fed by a board that
 * stopped answering an hour ago. The stream reports `up`/`down` from datagrams
 * actually arriving, and that drives the source's MQTT availability topic
 * directly. It starts `offline`: UDP has no handshake, so a bound socket is no
 * evidence of a board.
 *
 * Home Assistant only observes here. There are no command topics and no write
 * path; the DEVICE_REPORT injection that already existed is the one thing this
 * sends, and it goes to the board, not to HA.
 */

import { getPresetInfo, getZoneName } from "../ccx/config";
import { wireIdOf } from "./bridge/device-id";
import { DeviceModel } from "./bridge/model";
import { LogSink } from "./bridge/sinks/log";
import {
  bridgeTopics,
  type MqttClientLike,
  MqttSink,
} from "./bridge/sinks/mqtt";
import { NucleoReportSink } from "./bridge/sinks/nucleo-report";
import { type WizPairing, WizSink } from "./bridge/sinks/wiz";
import { OpenlutronSource } from "./bridge/sources/openlutron";
import type { BridgeSink, PresetZoneEntry } from "./bridge/types";
import {
  OPENLUTRON_UDP_PORT,
  OpenlutronStream,
  type StreamTimers,
} from "./openlutron-stream";

/**
 * The name this transport publishes its health under.
 *
 * One name for one stream, even though it carries two radios: the board is the
 * single thing that can go away. Per-radio health would need per-radio
 * liveness, and a quiet CC1101 is indistinguishable from a quiet room.
 */
export const OPENLUTRON_SOURCE_NAME = "openlutron";

/** Default gap between liveness lines. Quiet enough for a log, often enough to answer "is it working". */
const DEFAULT_STATUS_EVERY_MS = 300_000;

const realTimers: StreamTimers = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface OpenlutronBridgeOptions {
  /** Board address. */
  host: string;
  /** WiZ pairings; also the source of per-zone warm dim curves. */
  pairings: WizPairing[];
  presetZones: Map<number, PresetZoneEntry>;
  watchedZones: Set<number>;
  /**
   * Where to send DEVICE_REPORT state injection. Normally the same board, but
   * separate because it is a different direction of travel.
   */
  reportHost?: string;
  /** Zone → synthetic device serial, required for DEVICE_REPORT. */
  deviceSerials?: Map<number, number>;
  mqtt?: {
    client: MqttClientLike;
    baseTopic?: string;
    discoveryPrefix?: string;
  };
  log?: (msg: string) => void;
  /**
   * How often to log what has been heard. Default 5 minutes; 0 disables it.
   *
   * A bridge that only logs on activity cannot be told apart from one that is
   * not receiving at all, and "is it working?" is the first question anyone
   * asks of an add-on.
   */
  statusEveryMs?: number;
  /** Clock and timers for the status line, injected alongside `now`. */
  timers?: StreamTimers;
  /** Injected in tests; the add-on lets the bridge build its own. */
  stream?: OpenlutronStream;
  /**
   * Clock for the model's dedup window and fade interpolation.
   *
   * Injectable so a test can prove the thing that matters most about dedup —
   * that two presses a few hundred milliseconds apart both get through — on the
   * same clock the stream is driven by, rather than by really waiting.
   */
  now?: () => number;
}

export class OpenlutronBridge {
  readonly model: DeviceModel;
  readonly source: OpenlutronSource;
  readonly stream: OpenlutronStream;

  private readonly mqtt: MqttSink | null = null;
  private readonly log: (msg: string) => void;
  private readonly host: string;
  private readonly statusEveryMs: number;
  private readonly timers: StreamTimers;
  private statusTimer: unknown = null;
  /** Device events published since start — the number an operator asks for. */
  private eventCount = 0;

  constructor(opts: OpenlutronBridgeOptions) {
    this.log = opts.log ?? (() => {});
    this.host = opts.host;
    this.statusEveryMs = opts.statusEveryMs ?? DEFAULT_STATUS_EVERY_MS;
    this.timers = opts.timers ?? realTimers;

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
      now: opts.now,
    });

    this.source = new OpenlutronSource({ model: this.model, log: this.log });
    this.stream =
      opts.stream ?? new OpenlutronStream({ host: opts.host, port: undefined });
    this.source.attach(this.stream);

    if (opts.mqtt) {
      this.mqtt = new MqttSink({
        client: opts.mqtt.client,
        baseTopic: opts.mqtt.baseTopic,
        discoveryPrefix: opts.mqtt.discoveryPrefix,
        sources: [OPENLUTRON_SOURCE_NAME],
        log: this.log,
      });
      this.model.addSink(this.mqtt);
    }

    if (opts.pairings.length > 0) {
      this.model.addSink(
        new WizSink({ pairings: opts.pairings, log: this.log }),
      );
    }
    this.model.addSink(new LogSink({ log: this.log }));

    if (opts.reportHost) {
      this.model.addSink(
        new NucleoReportSink({
          host: opts.reportHost,
          serialByZone: opts.deviceSerials ?? new Map(),
          log: this.log,
        }),
      );
    }

    this.model.on("device:event", () => {
      this.eventCount++;
    });

    this.stream.on("up", () => {
      this.log(`  [openlutron] board reachable at ${opts.host}`);
      this.mqtt?.setSourceAvailable(OPENLUTRON_SOURCE_NAME, true);
    });
    this.stream.on("down", () => {
      this.log(`  [openlutron] no datagrams from ${opts.host} — marking down`);
      this.mqtt?.setSourceAvailable(OPENLUTRON_SOURCE_NAME, false);
    });
    // A socket error is already survivable — the client rebinds — so it is
    // reported and nothing more. Taking the bridge down over it is the one
    // response that cannot recover.
    this.stream.on("error", (err) =>
      this.log(`  [openlutron] stream error: ${err.message}`),
    );
  }

  /** The MQTT topic HA watches for this transport's health. */
  get availabilityTopic(): string {
    return bridgeTopics().sourceAvailability(OPENLUTRON_SOURCE_NAME);
  }

  /**
   * Bind, register, and publish the source as down until the board proves
   * otherwise.
   *
   * Deliberately does not wait for the board: an add-on whose start-up depends
   * on a device being powered is an add-on that cannot come back on its own.
   */
  async start(): Promise<void> {
    this.mqtt?.setSourceAvailable(OPENLUTRON_SOURCE_NAME, false);
    this.log(
      `  [openlutron] waiting for the board at ${this.host}:${OPENLUTRON_UDP_PORT} — nothing is published until it answers`,
    );
    await this.stream.connect();

    if (this.statusEveryMs > 0) {
      this.statusTimer = this.timers.setInterval(
        () => this.logStatus(),
        this.statusEveryMs,
      );
    }
  }

  /**
   * One line saying what has actually been heard.
   *
   * Counts, not rates: an operator reading this after the fact wants to know
   * whether anything at all has arrived since start, and from which radio.
   */
  private logStatus(): void {
    this.log(
      `  [openlutron] ${this.stream.connected ? "board up" : "BOARD DOWN"}` +
        ` — cca=${this.source.ccaPacketCount} ccx=${this.source.ccxPacketCount}` +
        ` events=${this.eventCount} zones=${this.model.appliedCount}`,
    );
  }

  addSink(sink: BridgeSink): void {
    this.model.addSink(sink);
  }

  close(): void {
    if (this.statusTimer !== null) {
      this.timers.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    this.stream.close();
    this.model.destroy();
  }
}

/**
 * Resolve a control's display name from its namespaced device id.
 *
 * Same lookup lib/bridge-core.ts uses: the wire id's first two bytes are the
 * preset address LEAP knows the control by. CCA controls are not in that table
 * and fall back to the model's `Device <id>`.
 */
function resolveDeviceName(deviceId: string): string | undefined {
  const wireId = wireIdOf(deviceId);
  if (wireId.length < 4) return undefined;
  const presetId = Number.parseInt(wireId.slice(0, 4), 16);
  if (Number.isNaN(presetId)) return undefined;
  const info = getPresetInfo(presetId);
  return info?.device ?? info?.name;
}
