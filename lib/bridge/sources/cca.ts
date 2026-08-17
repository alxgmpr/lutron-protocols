/**
 * CCA source — normalizes 433 MHz Clear Connect Type A frames into model
 * intents.
 *
 * Like the CCX source, it makes no decisions: filtering and dedup belong to the
 * model. What it owns is the translation, and two things about CCA make that
 * translation different from CCX's.
 *
 * ## Dedup keys, and why CCA's are not built from its sequence number
 *
 * CCA frames do carry a sequence byte at offset 1, but it means the opposite of
 * the CCX one. Per docs/protocols/cca/tdma.md §2 it packs a retransmit counter
 * in bits 7-3 and the sender's TDMA slot in bits 2-0, and the counter advances
 * by slot_count on every retransmit — so the 2 frames of a tap burst carry two
 * *different* sequence values for one press. Keying on it would let every
 * retransmit through as its own event.
 *
 * So the key is the payload with that byte masked out. Two frames that are
 * identical apart from the sequence are one wire event; anything else is not.
 * The residual limit is honest and bounded: two byte-identical presses of one
 * button inside the burst window cannot be told apart on this transport, which
 * is why the window is sized to the burst and no longer.
 *
 * ## Zones
 *
 * CCA addresses loads by 4-byte device id, not by the LEAP zone ids the model
 * and Home Assistant are keyed on, and nothing in this repo maps between them.
 * So level and state frames are counted but produce no zone intent: guessing a
 * zone would drive the wrong entity, which is worse than driving none. A
 * device_id → LEAP zone table is what unlocks the CCA output path.
 */

import { Buffer } from "node:buffer";
import {
  getActionName,
  getButtonName,
  identifyPacket,
} from "../../../protocol/protocol-ui";
import type { StreamPacketFrame } from "../../stream-frame";
import { deviceIdFor } from "../device-id";
import type { DeviceAction, SourceIntent } from "../types";
import type { IntentTarget } from "./ccx";

/**
 * How long one CCA wire event owns its dedup key.
 *
 * A button tap is `CCA_TX_COUNT_BURST = 2` frames at one-frame spacing, so the
 * burst spans ~75 ms, and observed inter-frame jitter runs 60-75 ms against the
 * canonical period. 250 ms covers that with margin.
 *
 * It is deliberately far below the model's 500 ms default. This window is the
 * span in which CCA cannot distinguish a second press from a retransmit, so
 * every millisecond of it is a real double press the transport may swallow —
 * the shorter the better, down to the burst it has to cover.
 */
export const CCA_BURST_DEDUP_MS = 250;

/** Offset of the sequence byte, masked out of every dedup key. */
const SEQ_OFFSET = 1;

/** Wire action codes → the model's vocabulary. Anything absent is not an event. */
const ACTIONS: Record<string, DeviceAction> = {
  PRESS: "press",
  HOLD: "hold",
  RELEASE: "release",
};

export interface CcaSourceOptions {
  model: IntentTarget;
  log?: (msg: string) => void;
}

export class CcaSource {
  private model: IntentTarget;
  private log: (msg: string) => void;

  /** Every CCA frame handed to this source, decoded or not. */
  packetCount = 0;

  constructor(opts: CcaSourceOptions) {
    this.model = opts.model;
    this.log = opts.log ?? (() => {});
  }

  handleFrame(frame: StreamPacketFrame): void {
    this.packetCount++;
    // A TX echo is the board reporting what it sent. Reading it as a device
    // event would re-fire whatever the bridge itself just did.
    if (frame.isTx) return;

    const intent = this.toIntent(frame.data);
    if (!intent) return;
    this.model.apply(intent, () => this.logFrame(frame, intent));
  }

  private toIntent(data: Buffer): SourceIntent | null {
    if (data.length < 12) return null;

    const info = identifyPacket(data);
    if (info.category !== "BUTTON") return null;

    const button = this.fieldByte(info, data, "button");
    const action = this.fieldByte(info, data, "action");
    const deviceId = this.deviceId(info, data);
    if (button === null || action === null || deviceId === null) return null;

    const mapped = ACTIONS[getActionName(action)];
    if (!mapped) return null;

    return {
      kind: "deviceEvent",
      deviceId,
      button,
      action: mapped,
      origin: getButtonName(button),
      source: "cca",
      // The wire byte, reported as-is for diagnostics. It is NOT what the key
      // is built from — see the header.
      sequence: data[SEQ_OFFSET],
      dedupKey: `4:${deviceId}:${mapped}:${payloadKey(data)}`,
      dedupWindowMs: CCA_BURST_DEDUP_MS,
    };
  }

  /**
   * The control's identity: its 4-byte wire id, in wire order, namespaced by
   * transport.
   *
   * Wire order deliberately ignores the display-endianness flag, for the reason
   * lib/cca-decode-adapter.ts records: packet types disagree about it and one
   * device would otherwise file under two identities. The `cca_` prefix keeps it
   * from colliding with a CCX device id made of the same four bytes — they are
   * both four undifferentiated bytes, and a collision would merge two physical
   * controls into one Home Assistant entity.
   */
  private deviceId(
    info: ReturnType<typeof identifyPacket>,
    data: Buffer,
  ): string | null {
    const field = info.fields.find(
      (f) => f.name === "device_id" || f.name === "source_id",
    );
    if (!field || field.offset + 4 > data.length) return null;
    return deviceIdFor(
      "cca",
      data.subarray(field.offset, field.offset + 4).toString("hex"),
    );
  }

  /** One byte of a named field, or null when this type does not carry it. */
  private fieldByte(
    info: ReturnType<typeof identifyPacket>,
    data: Buffer,
    name: string,
  ): number | null {
    const field = info.fields.find((f) => f.name === name);
    if (!field || field.offset >= data.length) return null;
    return data[field.offset];
  }

  private logFrame(frame: StreamPacketFrame, intent: SourceIntent): void {
    if (intent.kind !== "deviceEvent") return;
    this.log(
      `${intent.deviceId} ${intent.origin} ${intent.action}  [cca seq=${intent.sequence} rssi=-${frame.flags & 0x1f}]`,
    );
  }
}

/**
 * The frame's bytes with the sequence masked out — one wire event's identity.
 *
 * Retransmissions of one payload differ only in that byte, so masking it makes
 * them one key. Everything else about the frame still separates events.
 */
function payloadKey(data: Buffer): string {
  const copy = Buffer.from(data);
  copy[SEQ_OFFSET] = 0;
  return copy.toString("hex");
}
