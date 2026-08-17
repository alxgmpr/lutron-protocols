/**
 * CCX source — normalizes decoded Thread/CCX packets into model intents.
 *
 * This is the only place in the bridge that knows about CBOR body keys,
 * Lutron sequence numbers or preset-encoded device IDs. It makes no decisions:
 * filtering, dedup and scene expansion all belong to the model, which reports
 * back whether the packet was acted on so the source knows what to log.
 */

import { presetIdFromDeviceId } from "../../../ccx/config";
import { formatMessage, getMessageTypeName } from "../../../ccx/decoder";
import type { CCXPacket } from "../../../ccx/types";
import { deviceIdFor } from "../device-id";
import type { ApplyResult, DeviceAction, SourceIntent } from "../types";

/** Lowercase hex of a wire device id; empty when the packet carried none. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The slice of DeviceModel a source needs. */
export interface IntentTarget {
  apply(intent: SourceIntent, onAccepted?: () => void): ApplyResult;
}

export interface CcxSourceOptions {
  model: IntentTarget;
  log?: (msg: string) => void;
}

export class CcxSource {
  private model: IntentTarget;
  private log: (msg: string) => void;

  packetCount = 0;

  constructor(opts: CcxSourceOptions) {
    this.model = opts.model;
    this.log = opts.log ?? (() => {});
  }

  handlePacket(pkt: CCXPacket): void {
    this.packetCount++;
    const intents = this.toIntents(pkt);
    if (intents.length === 0) return;
    // Logged via the accept hook rather than the return value so the packet
    // line precedes the command line the model resolves it into. One packet
    // logs at most once, however many intents it carries.
    let logged = false;
    const logOnce = () => {
      if (logged) return;
      logged = true;
      this.logPacket(pkt);
    };
    for (const intent of intents) this.model.apply(intent, logOnce);
  }

  /**
   * One packet can be more than one fact. A button press is both the press
   * itself (a device event, which Home Assistant surfaces as an `event`
   * entity) and the scene it recalls — different facts with different
   * consumers, so both are emitted. The raw event comes first; the
   * interpretation follows it.
   */
  private toIntents(pkt: CCXPacket): SourceIntent[] {
    const msg = pkt.parsed;
    const event = this.toDeviceEvent(msg);
    const intent = this.toIntent(pkt);
    return [event, intent].filter((i): i is SourceIntent => i !== null);
  }

  private toDeviceEvent(msg: CCXPacket["parsed"]): SourceIntent | null {
    let action: DeviceAction;
    let origin: string;
    switch (msg.type) {
      case "BUTTON_PRESS":
        action = "press";
        origin = "PRESET";
        break;
      case "DIM_HOLD":
        action = "hold";
        origin = "DIM_HOLD";
        break;
      case "DIM_STEP":
        action = "release";
        origin = "DIM_STEP";
        break;
      default:
        return null;
    }

    const wireId = toHex(msg.deviceId);
    if (!wireId) return null;
    const deviceId = deviceIdFor("ccx", wireId);

    return {
      kind: "deviceEvent",
      deviceId,
      // deviceId[1] is the button/preset selector within the control.
      button: msg.deviceId[1] ?? 0,
      action,
      origin,
      source: "ccx",
      sequence: msg.sequence,
      // Keyed on the wire sequence: a retransmit repeats it, a second press
      // never does. Keying on (device, button) would eat real double presses.
      dedupKey: `4:${deviceId}:${action}:${msg.sequence}`,
    };
  }

  private toIntent(pkt: CCXPacket): SourceIntent | null {
    const msg = pkt.parsed;
    switch (msg.type) {
      case "LEVEL_CONTROL": {
        // A level command with CBOR key 0 absent from the inner map is
        // colour-only and must not disturb the zone's level.
        const inner = (msg.rawBody?.[0] ?? {}) as Record<number, unknown>;
        const levelPresent = 0 in inner;
        return {
          kind: "zoneLevel",
          zoneId: msg.zoneId,
          level: levelPresent ? msg.levelPercent : null,
          cct: msg.cct ?? null,
          colorXy: msg.colorXy ?? null,
          fade: msg.fade,
          warmDimHint: msg.warmDimMode != null ? "default" : undefined,
          origin: "LEVEL",
          dedupKey: `0:${msg.zoneId}:${msg.sequence}`,
        };
      }

      case "BUTTON_PRESS": {
        const presetId = presetIdFromDeviceId(msg.deviceId);
        return {
          kind: "preset",
          presetId,
          origin: "PRESET",
          dedupKey: `1:${presetId}:${msg.sequence}`,
        };
      }

      case "DIM_HOLD":
        return {
          kind: "ramp",
          action: "start",
          direction: msg.action === 3 ? "raise" : "lower",
          // zoneId 0 means "absent" — pico holds carry no zone, only a preset.
          zoneId: msg.zoneId || undefined,
          presetId: presetIdFromDeviceId(msg.deviceId),
          origin: "DIM_HOLD",
          dedupKey: `2:${msg.zoneId || "p"}:${msg.sequence}`,
        };

      case "DIM_STEP":
        return {
          kind: "ramp",
          action: "stop",
          zoneId: msg.zoneId || undefined,
          presetId: presetIdFromDeviceId(msg.deviceId),
          origin: "DIM_STEP",
          dedupKey: `3:${msg.zoneId || "p"}:${msg.sequence}`,
        };

      default:
        return null;
    }
  }

  private logPacket(pkt: CCXPacket): void {
    const time = pkt.timestamp.slice(11, 23);
    const typeName = getMessageTypeName(pkt.msgType).padEnd(14);
    this.log(
      `${time} ${typeName} ${formatMessage(pkt.parsed)}  [${pkt.srcAddr} → ${pkt.dstAddr}]`,
    );
  }
}
