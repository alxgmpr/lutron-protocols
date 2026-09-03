/**
 * WiZ sink — pushes zone state to WiZ bulbs over UDP.
 *
 * One sink among several. It subscribes to zone:changed and knows nothing
 * about CCX, dedup, ramps or fades: by the time an event reaches it the model
 * has already decided what the zone's colour and level are.
 */

import { createSocket, type Socket } from "dgram";
import { isJsonObject, isNumber, type JsonValue } from "../../data-values";
import {
  type CctPoint,
  cctToRgbwc,
  rgbwcToPilotParams,
  type WizPilotParams,
  xyToRgbwc,
} from "../../wiz-color";
import type { BridgeSink, SinkHost, ZoneChangedEvent } from "../types";

export interface WizPairing {
  name: string;
  zoneId: number;
  wizIps: string[];
  wizPort: number;
  /** Warm dim curve name (from warm-dim.ts). Applied by the model, not here. */
  warmDimCurve?: string;
}

export interface WizSinkOptions {
  pairings: WizPairing[];
  log?: (msg: string) => void;
}

const WIZ_DISCOVERY_PORT = 38899;
const CCT_FETCH_TIMEOUT_MS = 2000;
const DEFAULT_CCT = 2700;

function isCctPoint(value: JsonValue): value is CctPoint {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every((component) => isNumber(component))
  );
}

export class WizSink implements BridgeSink {
  readonly name = "wiz";

  private pairings: WizPairing[];
  private pairingsByZone = new Map<number, WizPairing>();
  private cctTables = new Map<string, CctPoint[]>();
  private unpairedWarned = new Set<number>();
  private socket: Socket | null;
  private host: SinkHost | null = null;
  private log: (msg: string) => void;

  constructor(opts: WizSinkOptions) {
    this.pairings = opts.pairings;
    this.log = opts.log ?? (() => {});
    for (const p of this.pairings) this.pairingsByZone.set(p.zoneId, p);
    this.socket = this.pairings.length > 0 ? createSocket("udp4") : null;
  }

  attach(model: SinkHost): void {
    this.host = model;
    model.on("zone:changed", (e) => this.onZoneChanged(e));
  }

  detach(): void {
    this.socket?.close();
    this.socket = null;
  }

  private onZoneChanged(e: ZoneChangedEvent): void {
    const pairing = this.pairingsByZone.get(e.zoneId);
    if (!pairing) {
      // Only worth mentioning for a zone someone asked us to watch, and only
      // once — a fade would otherwise repeat it every tick.
      if (
        this.host?.isExplicitlyWatched(e.zoneId) &&
        !this.unpairedWarned.has(e.zoneId)
      ) {
        this.unpairedWarned.add(e.zoneId);
        this.log(`  [warn] Zone ${e.zoneId} has no WiZ pairing`);
      }
      return;
    }
    this.send(e, pairing);
  }

  private send(e: ZoneChangedEvent, pairing: WizPairing): void {
    if (!this.socket) return;
    const cctTable = this.getCctTable(pairing);

    let params: WizPilotParams;
    let logStr: string;

    if (e.level <= 0) {
      params = { state: false };
      logStr = "OFF";
    } else if (e.colorMode === "xy" && e.colorXy) {
      const x = e.colorXy[0] / 10000;
      const y = e.colorXy[1] / 10000;
      const channels = xyToRgbwc(x, y, e.level, cctTable);
      params = rgbwcToPilotParams(channels);
      logStr = `${Math.round(e.level)}% xy=(${x.toFixed(4)},${y.toFixed(4)}) [r${channels.r} g${channels.g} b${channels.b} w${channels.w} c${channels.c}]`;
    } else {
      const channels = cctToRgbwc(e.cct ?? DEFAULT_CCT, e.level, cctTable);
      params = rgbwcToPilotParams(channels);
      const cctStr = e.cct != null ? `${e.cct}K` : `${DEFAULT_CCT}K(default)`;
      logStr = `${Math.round(e.level)}% ${cctStr} [r${channels.r} g${channels.g} b${channels.b} w${channels.w} c${channels.c}]`;
    }

    const buf = Buffer.from(JSON.stringify({ method: "setPilot", params }));
    for (const ip of pairing.wizIps) {
      this.socket.send(buf, pairing.wizPort, ip);
    }
    this.log(
      `  [wiz] → ${pairing.name} (${pairing.wizIps.length} bulbs) ${logStr}`,
    );
  }

  // ── Per-bulb CCT calibration ────────────────────────────

  private getCctTable(pairing: WizPairing): CctPoint[] | undefined {
    for (const ip of pairing.wizIps) {
      const table = this.cctTables.get(ip);
      if (table) return table;
    }
    return undefined;
  }

  /** Fetch CCT calibration tables from every paired bulb. */
  async fetchCctTables(): Promise<void> {
    if (!this.socket) return;
    const uniqueIps = new Set<string>();
    for (const p of this.pairings) {
      for (const ip of p.wizIps) uniqueIps.add(ip);
    }

    const buf = Buffer.from(
      JSON.stringify({ method: "getCctTable", params: {} }),
    );

    for (const ip of uniqueIps) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const table = await this.fetchOne(ip, buf);
        if (table) {
          this.cctTables.set(ip, table);
          this.log(`  [wiz] CCT table from ${ip}: ${table.length} points`);
          break;
        }
        if (attempt === 1) {
          this.log(
            `  [wiz] CCT table from ${ip}: FAILED after retry (using default)`,
          );
        }
      }
    }
  }

  private fetchOne(ip: string, buf: Buffer): Promise<CctPoint[] | null> {
    return new Promise((resolve) => {
      if (!this.socket) return resolve(null);
      const timeout = setTimeout(() => resolve(null), CCT_FETCH_TIMEOUT_MS);
      const onMsg = (msg: Buffer, rinfo: { address: string }) => {
        if (rinfo.address !== ip) return; // not from this bulb
        clearTimeout(timeout);
        this.socket?.removeListener("message", onMsg);
        try {
          const data: JsonValue = JSON.parse(msg.toString());
          const result =
            isJsonObject(data) && isJsonObject(data.result)
              ? data.result
              : null;
          const rawPoints = result?.cctPoints;
          const pts = Array.isArray(rawPoints)
            ? rawPoints.filter(isCctPoint)
            : [];
          resolve(pts && pts.length > 0 ? pts : null);
        } catch {
          resolve(null);
        }
      };
      this.socket.on("message", onMsg);
      this.socket.send(buf, WIZ_DISCOVERY_PORT, ip, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.socket?.removeListener("message", onMsg);
          resolve(null);
        }
      });
    });
  }
}
