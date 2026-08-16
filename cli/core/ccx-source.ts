/**
 * CCX source attribution for the Nucleo stream.
 *
 * The firmware now tags received CCX frames with the sender's IPv6
 * (see lib/stream-frame.ts). Turning that into a device name takes two paths,
 * because Thread devices source from two different address families:
 *
 *   ML-EID (fd00::/fd0d::<iid>)  — the device map keys on these directly.
 *   RLOC   (fd..::00ff:fe00:XXXX) — a routing address that says nothing about
 *                                   identity, so we mirror the firmware's peer
 *                                   table: bind RLOC16 → serial/device id when
 *                                   a message carrying one arrives from it.
 */

import { getDeviceName, getSerialName } from "../../ccx/config";
import { rloc16FromIpv6, type StreamSrcKind } from "../../lib/stream-frame";

export interface CcxSourceLabel {
  /** Display text: a device name when known, else an RLOC or address. */
  text: string;
  /** Resolved device name, when one was found. */
  name?: string;
  /** RLOC16, when the source was an RLOC address. */
  rloc16?: number;
  /** The source address, when the frame carried one. */
  addr?: string;
}

/** What a decoded CCX message tells us about who sent it. */
export interface CcxSourceObservation {
  /** From DEVICE_REPORT / STATUS */
  serial?: number;
  /** From BUTTON_PRESS / DIM_HOLD / DIM_STEP */
  deviceId?: number;
}

export interface CcxSourceResolverOptions {
  deviceNameByAddr?: (addr: string) => string | undefined;
  deviceNameBySerial?: (serial: number) => string | undefined;
}

export class CcxSourceResolver {
  /** RLOC16 → serial or device id, learned from observed traffic. */
  private peers = new Map<number, number>();
  private byAddr: (addr: string) => string | undefined;
  private bySerial: (serial: number) => string | undefined;

  /** True once a frame with a source trailer has been seen — i.e. the attached
   *  firmware supports attribution. Lets the CLI say so instead of guessing. */
  firmwareSendsSource = false;

  constructor(opts: CcxSourceResolverOptions = {}) {
    this.byAddr = opts.deviceNameByAddr ?? getDeviceName;
    this.bySerial = opts.deviceNameBySerial ?? getSerialName;
  }

  /** Mirror of the firmware peer table: bind this RLOC to a device identity. */
  observe(srcAddr: string | null, obs: CcxSourceObservation): void {
    if (!srcAddr) return;
    const rloc16 = rloc16FromIpv6(srcAddr);
    if (rloc16 === null) return;

    const id = obs.serial ?? obs.deviceId;
    // A serial of 0 means "unknown" in the CCX decoders, not a real device.
    if (!id) return;
    this.peers.set(rloc16, id);
  }

  label(frame: {
    srcAddr: string | null;
    srcKind: StreamSrcKind;
  }): CcxSourceLabel {
    if (frame.srcKind === "attributed" && frame.srcAddr) {
      this.firmwareSendsSource = true;
      return this.labelAddr(frame.srcAddr);
    }
    if (frame.srcKind === "local") return { text: "local" };
    return { text: "?" };
  }

  private labelAddr(addr: string): CcxSourceLabel {
    const rloc16 = rloc16FromIpv6(addr) ?? undefined;

    // The address itself is the strongest key when the device map has it.
    const direct = this.byAddr(addr);
    if (direct) return { text: direct, name: direct, rloc16, addr };

    if (rloc16 !== undefined) {
      const id = this.peers.get(rloc16);
      const name = id !== undefined ? this.bySerial(id) : undefined;
      if (name) return { text: name, name, rloc16, addr };
      return {
        text: `0x${rloc16.toString(16).padStart(4, "0")}`,
        rloc16,
        addr,
      };
    }

    return { text: addr, addr };
  }
}
