/**
 * openlutron source — one stream, both radios.
 *
 * The board hears CCA on its CC1101 and CCX on its nRF52840 and streams both
 * over one UDP socket, so this is the demux: it dispatches each frame to the
 * normalization for its band and both feed one DeviceModel. Every sink
 * downstream — MQTT, WiZ, the log — sees one system rather than two, which is
 * the point of the source/sink split.
 *
 * ## Dispatch is on FLAG_CCX, and the order is not cosmetic
 *
 * `FLAG_SRC` (0x10) shares bit 4 with the CCA `|RSSI|` field, so the CCX flag
 * has to be read first: a CCX frame that reached the CCA path would have its
 * source-attribution bit read as signal strength. lib/stream-frame.ts already
 * only reports a source on CCX frames for the same reason.
 *
 * ## Nothing here is allowed to throw
 *
 * This runs behind a UDP datagram handler in an unattended add-on. A CBOR
 * decode failure on one malformed frame must cost that frame and nothing else,
 * so the decode is guarded and the frame is counted either way.
 */

import { Buffer } from "node:buffer";
import { buildPacket } from "../../../ccx/decoder";
import type { StreamPacketFrame } from "../../stream-frame";
import { CcaSource } from "./cca";
import { CcxSource, type IntentTarget } from "./ccx";

/** The slice of OpenlutronStream this source consumes. */
export interface FrameSource {
  on(event: "frame", listener: (frame: StreamPacketFrame) => void): unknown;
}

export interface OpenlutronSourceOptions {
  model: IntentTarget;
  log?: (msg: string) => void;
}

export class OpenlutronSource {
  private readonly cca: CcaSource;
  private readonly ccx: CcxSource;
  private readonly log: (msg: string) => void;

  /**
   * CCX frames routed here, counted whether or not they decoded.
   *
   * Kept by the demux rather than read off CcxSource, which only counts the
   * packets that got far enough to become one.
   */
  private ccxFrames = 0;

  constructor(opts: OpenlutronSourceOptions) {
    this.log = opts.log ?? (() => {});
    this.cca = new CcaSource({ model: opts.model, log: this.log });
    this.ccx = new CcxSource({ model: opts.model, log: this.log });
  }

  /** CCA frames seen, decoded or not. */
  get ccaPacketCount(): number {
    return this.cca.packetCount;
  }

  /** CCX frames seen, decoded or not. */
  get ccxPacketCount(): number {
    return this.ccxFrames;
  }

  /** Everything the board has handed us. */
  get packetCount(): number {
    return this.cca.packetCount + this.ccxFrames;
  }

  /** Subscribe to a stream's frames. */
  attach(stream: FrameSource): void {
    stream.on("frame", (frame) => this.handleFrame(frame));
  }

  handleFrame(frame: StreamPacketFrame): void {
    // FLAG_CCX first — see the header on why the order matters.
    if (frame.isCcx) {
      this.handleCcx(frame);
      return;
    }
    this.cca.handleFrame(frame);
  }

  private handleCcx(frame: StreamPacketFrame): void {
    this.ccxFrames++;

    // A TX echo with no source is the board reporting its own transmission,
    // including the DEVICE_REPORT state this bridge injects. Reading that back
    // as an observation would feed the bridge its own output.
    if (frame.isTx) return;
    if (frame.data.length === 0) return;

    let packet: ReturnType<typeof buildPacket>;
    try {
      packet = buildPacket({
        // Board timestamps are uptime milliseconds, not wall clock, so the
        // packet is stamped at receipt.
        timestamp: new Date().toISOString(),
        // The stream carries the sender only; there is no destination in the
        // frame to report.
        srcAddr: frame.srcAddr ?? "",
        dstAddr: "",
        payloadHex: Buffer.from(frame.data).toString("hex"),
      });
    } catch (err) {
      this.log(
        `  [openlutron] undecodable CCX frame: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    this.ccx.handlePacket(packet);
  }
}
