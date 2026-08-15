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
import type { ApplyResult, SourceIntent } from "../types";

/** The slice of DeviceModel a source needs. */
export interface IntentTarget {
  apply(intent: SourceIntent): ApplyResult;
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
    const intent = this.toIntent(pkt);
    if (!intent) return;
    if (this.model.apply(intent).accepted) this.logPacket(pkt);
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
