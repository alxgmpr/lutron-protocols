/**
 * Stream frame → capture observation.
 *
 * Lifted out of tools/cca/capture-rate.ts when that tool moved onto
 * lib/openlutron-stream.ts (GLAB-131). It lives here for one reason: the tool
 * only runs against the bench rig, so as long as these rules were inline in it
 * nothing could check them without hardware. capture-rate is an instrument —
 * a change in what it counts, or in when it spends CPU, moves its loss numbers
 * for reasons that have nothing to do with the radio.
 *
 * What "decoded" means is lib/cca-decode-adapter.ts's answer, not a second one.
 */

import { decodeBytes } from "../ccx/decoder";
import type { FrameObservation } from "./capture-run";
import { decodeCcaFrame } from "./cca-decode-adapter";
import { FLAG_RSSI_MASK, type StreamPacketFrame } from "./stream-frame";

/** Frames plus everything needed to rebuild the capture afterwards. */
export interface CapturedFrame {
  observation: FrameObservation;
  /** CCA payload hex, for feeding tools/cca/build-corpus.ts. */
  hex: string | null;
  /**
   * The five-bit |RSSI| the firmware actually sends, negated. Aliased modulo
   * 32 and therefore not a signal level — kept only so a run's raw readings
   * are recoverable from the report. Never fed to the analysis.
   */
  rssiRaw5Bit?: number | null;
  typeName: string | null;
  decoded: boolean;
  identified: boolean;
}

/** Observe one frame, dispatching on the band the flags declare. */
export function observeFrame(frame: StreamPacketFrame): CapturedFrame {
  return frame.isCcx ? observeCcx(frame) : observeCca(frame);
}

function observeCca(frame: StreamPacketFrame): CapturedFrame {
  const obs = decodeCcaFrame(frame.data);
  return {
    observation: {
      band: "cca",
      sender: obs.sender,
      type: obs.typeName,
      seq: obs.seq,
      // Deliberately withheld — see rssiRaw5Bit below.
      rssi: null,
      isTx: frame.isTx,
    },
    // The firmware packs |RSSI| into five bits of the flags byte
    // (`(uint8_t)(-rssi) & 0x1F` in stream.cpp), so anything past -31 dBm
    // aliases modulo 32: a real -70 dBm frame arrives here reading -6. The
    // value is kept for the record but must not reach the RF-vs-code
    // discriminator, which would read every frame as strong. GLAB-115.
    rssiRaw5Bit: frame.isTx ? null : -(frame.flags & FLAG_RSSI_MASK),
    hex: frame.data.toString("hex"),
    typeName: obs.typeName,
    decoded: obs.decoded,
    identified: obs.identified,
  };
}

function observeCcx(frame: StreamPacketFrame): CapturedFrame {
  let sequence: number | null = null;
  let typeName: string | null = null;
  let decoded = false;
  try {
    const msg = decodeBytes(new Uint8Array(frame.data));
    decoded = true;
    typeName = msg.type;
    sequence = msg.sequence;
  } catch {
    // Undecodable frame — counted, not attributed.
  }

  return {
    observation: {
      band: "ccx",
      // The stream's own source trailer, not the device inventory: that makes
      // band and sender self-verifying rather than a lookup that can go stale.
      sender: frame.srcAddr,
      type: typeName,
      seq: sequence,
      // CCX arrives via the NCP, which does not hand up a per-frame RSSI.
      rssi: null,
      isTx: frame.isTx,
    },
    rssiRaw5Bit: null,
    hex: null,
    typeName,
    decoded,
    identified: decoded && typeName !== null,
  };
}

/**
 * Frames observed inside a measurement window.
 *
 * The gate is not just bookkeeping. Decoding is the expensive part of the
 * receive path, and a run spends its first half-minute in an idle control
 * window whose whole purpose is to measure the board undisturbed — so frames
 * outside the window are not decoded at all.
 */
export class FrameCollector {
  readonly frames: CapturedFrame[] = [];

  private collecting = false;

  start(): void {
    this.collecting = true;
  }

  stop(): void {
    this.collecting = false;
  }

  handleFrame(frame: StreamPacketFrame): void {
    if (!this.collecting) return;
    this.frames.push(observeFrame(frame));
  }
}
