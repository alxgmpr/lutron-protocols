/**
 * Nucleo DEVICE_REPORT sink — injects settled zone levels back onto Thread.
 *
 * Subscribes to zone:settled, which the model fires once per command after
 * activity stops. That "once" is the whole point: real devices report a level
 * seconds after they finish moving, not on every intermediate step.
 */

import { createSocket, type Socket } from "dgram";
import { encodeDeviceReport, percentToLevel } from "../../../ccx/encoder";
import type { BridgeSink, SinkHost, ZoneSettledEvent } from "../types";

/** Stream protocol opcode: STREAM_CMD_TX_RAW_CCX_CBOR */
const CMD_TX_RAW_CCX_CBOR = 0x16;
const DEFAULT_NUCLEO_PORT = 9433;

export interface NucleoReportSinkOptions {
  host: string;
  port?: number;
  /** Zone → synthetic device serial to report as */
  serialByZone: Map<number, number>;
  log?: (msg: string) => void;
}

export class NucleoReportSink implements BridgeSink {
  readonly name = "nucleo-report";

  private socket: Socket | null;
  private host: string;
  private port: number;
  private serialByZone: Map<number, number>;
  private log: (msg: string) => void;
  private seq = 0;

  constructor(opts: NucleoReportSinkOptions) {
    this.host = opts.host;
    this.port = opts.port ?? DEFAULT_NUCLEO_PORT;
    this.serialByZone = opts.serialByZone;
    this.log = opts.log ?? (() => {});
    this.socket = createSocket("udp4");
  }

  attach(model: SinkHost): void {
    model.on("zone:settled", (e) => this.onSettled(e));
  }

  detach(): void {
    this.socket?.close();
    this.socket = null;
  }

  private onSettled(e: ZoneSettledEvent): void {
    if (!this.socket) return;
    const serial = this.serialByZone.get(e.zoneId);
    if (!serial) return;

    const cbor = encodeDeviceReport({
      deviceSerial: serial,
      level: percentToLevel(e.level),
      sequence: this.seq++ & 0xff,
    });

    const frame = Buffer.alloc(2 + cbor.length);
    frame[0] = CMD_TX_RAW_CCX_CBOR;
    frame[1] = cbor.length;
    cbor.copy(frame, 2);

    this.socket.send(frame, this.port, this.host, (err) => {
      if (err) {
        this.log(`  [nucleo] DEVICE_REPORT error: ${err.message}`);
      } else {
        this.log(
          `  [nucleo] DEVICE_REPORT zone=${e.zoneId} serial=${serial} level=${Math.round(e.level)}%`,
        );
      }
    });
  }
}
