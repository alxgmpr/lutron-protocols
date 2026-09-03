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
import type { StringLookup } from "../../data-values";
import type { StreamPacketFrame } from "../../stream-frame";
import { deviceIdFor } from "../device-id";
import type { DeviceAction, SourceIntent } from "../types";
import type { IntentTarget } from "./ccx";

/**
 * How long one CCA wire event owns its dedup key.
 *
 * Sized to the longest retransmit burst, not to a guess about how fast someone
 * can press twice. `CCA_TX_COUNT_NORMAL` is 11 frames at one-frame spacing —
 * ~825 ms — and a release burst measured on the bench rig ran sequence 0 → 36
 * over 457 ms. A window shorter than the burst reports one release twice.
 *
 * A window this long would swallow a double tap on its own. What stops it is
 * `isNewWireEvent` below: the window only ever suppresses frames that identify
 * themselves as retransmissions.
 */
export const CCA_BURST_DEDUP_MS = 1200;

/** Offset of the sequence byte, masked out of every dedup key. */
const SEQ_OFFSET = 1;

/**
 * Sequence value that starts a burst.
 *
 * Every burst observed on the bench rig starts here and steps by a fixed
 * stride — `0, 6, 12` for a tap, `0 … 36` for a release — matching the
 * "First=0x00, retx increments" note in docs/protocols/cca/pairing.md. So a
 * frame at sequence 0 is a fresh user action and anything else is a
 * retransmission of the burst in progress. That is a stronger signal than a
 * timer: two taps 100 ms apart are still two events, because the second one
 * starts its own burst at 0.
 *
 * A device that started a burst somewhere other than 0 would fall back to the
 * window, which is why the window is still there.
 */
const SEQ_BURST_START = 0;

/** Wire action codes → the model's vocabulary. Anything absent is not an event. */
const ACTIONS: StringLookup<DeviceAction> = {
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
      dedupKey: `4:${deviceId}:${mapped}:${payloadKey(info, data)}`,
      dedupWindowMs: CCA_BURST_DEDUP_MS,
      isNewWireEvent: data[SEQ_OFFSET] === SEQ_BURST_START,
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
 * The frame's bytes with the sequence *and the CRC* masked out — one wire
 * event's identity.
 *
 * The CRC has to go too, and missing that made this key match nothing at all.
 * CRC-16 is computed over the whole frame including the sequence byte, so two
 * retransmissions of one payload differ in two places, not one. Off the bench
 * rig:
 *
 *   8b 06 08 69 2d 70 21 04 03 00 08 00 cc×10 b5 37
 *   8b 0c 08 69 2d 70 21 04 03 00 08 00 cc×10 0e a3
 *                                       ^^^^^ crc16(bytes 0..21)
 *
 * Synthetic test frames with a zero CRC hide this completely, which is why
 * test/bridge-cca-source.test.ts uses those exact bytes.
 *
 * The CRC's offset comes from the protocol definition rather than a constant,
 * so the 53-byte packet types are covered by the same code.
 */
function payloadKey(
  info: ReturnType<typeof identifyPacket>,
  data: Buffer,
): string {
  const copy = Buffer.from(data);
  copy[SEQ_OFFSET] = 0;
  const crc = info.fields.find((f) => f.name === "crc");
  if (crc) {
    for (
      let i = crc.offset;
      i < crc.offset + crc.size && i < copy.length;
      i++
    ) {
      copy[i] = 0;
    }
  }
  return copy.toString("hex");
}
