/**
 * nRF 802.15.4 Sniffer — Direct serial driver
 *
 * Talks to the nRF sniffer dongle over serial (115200 baud) using the
 * text-based shell protocol. Eliminates the need for tshark/Wireshark/extcap.
 *
 * Protocol:
 *   Init: sleep → shell echo off → channel <N> → receive
 *   Output: "received: <hex> power: <rssi> lqi: <lqi> time: <ts>"
 *
 * Usage:
 *   const sniffer = new SerialSniffer({ port: "/dev/ttyACM0", channel: 25 });
 *   sniffer.on("frame", (frame: Buffer) => { ... });
 *   await sniffer.start();
 */

import { EventEmitter } from "events";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";

export interface SerialSnifferOptions {
  /** Serial port path (e.g. /dev/ttyACM0, /dev/cu.usbmodem201401) */
  port: string;
  /** 802.15.4 channel number (11-26) */
  channel: number;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnect delay in ms (default: 5000) */
  reconnectDelay?: number;
}

export interface SerialSnifferEvents {
  /** Raw 802.15.4 frame with FCS stripped */
  frame: (frame: Buffer) => void;
  /** Sniffer started and receiving */
  ready: () => void;
  /** Serial port error */
  error: (err: Error) => void;
  /** Serial port closed (before reconnect) */
  closed: () => void;
}

export class SerialSniffer extends EventEmitter {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private opts: Required<SerialSnifferOptions>;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: SerialSnifferOptions) {
    super();
    this.opts = {
      autoReconnect: true,
      reconnectDelay: 5000,
      ...opts,
    };
  }

  /** Open serial port and start receiving frames */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /** Stop receiving and close port */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.port?.isOpen) {
      this.port.close();
    }
    this.port = null;
    this.parser = null;
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort(
        {
          path: this.opts.port,
          baudRate: 115200,
          autoOpen: false,
        },
      );

      const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));

      port.on("error", (err) => {
        this.emit("error", err);
        if (!this.stopped && this.opts.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      port.on("close", () => {
        this.emit("closed");
        if (!this.stopped && this.opts.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      parser.on("data", (line: string) => {
        this.handleLine(line);
      });

      port.open((err) => {
        if (err) {
          if (!this.stopped && this.opts.autoReconnect) {
            this.emit("error", new Error(`Open failed: ${err.message}`));
            this.scheduleReconnect();
            resolve(); // Don't reject — reconnect will retry
          } else {
            reject(err);
          }
          return;
        }

        this.port = port;
        this.parser = parser;
        this.initSniffer(resolve);
      });
    });
  }

  private initSniffer(onReady: () => void): void {
    const port = this.port!;

    // Phase 1: send sleep + echo off, flush, wait for shell to settle
    // (any shell response lines are silently ignored by handleLine)
    port.write("sleep\r\n", () => {
      port.write("shell echo off\r\n", () => {
        port.drain(() => {
          // Wait for shell responses to arrive and be discarded by the parser
          setTimeout(() => {
            // Phase 2: set channel and start receiving
            port.write(`channel ${this.opts.channel}\r\n`, () => {
              port.write("receive\r\n", () => {
                port.drain(() => {
                  this.emit("ready");
                  onReady();
                });
              });
            });
          }, 500);
        });
      });
    });
  }

  private handleLine(line: string): void {
    // Format: "\x1b[Jreceived: <hex> power: <rssi> lqi: <lqi> time: <ts>"
    // Strip ANSI escape sequences and \r before matching
    const clean = line.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "").replace(/\r/g, "");
    const match = clean.match(/received:\s+([0-9a-fA-F]+)\s+power:/);
    if (!match) return;

    const hex = match[1];
    const raw = Buffer.from(hex, "hex");

    // Strip 2-byte FCS (CRC) at end
    if (raw.length < 3) return;
    const frame = raw.subarray(0, raw.length - 2);

    this.emit("frame", frame);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      try {
        // Clean up old port
        if (this.port?.isOpen) {
          this.port.close();
        }
        this.port = null;
        this.parser = null;
        await this.connect();
      } catch {
        // connect() handles its own retry via autoReconnect
      }
    }, this.opts.reconnectDelay);
  }
}

/** Auto-detect nRF sniffer serial device */
export function detectSnifferPort(): string {
  const { readdirSync, existsSync } = require("fs") as typeof import("fs");

  // Linux defaults
  for (const path of ["/dev/ttyACM0", "/dev/ttyACM1"]) {
    if (existsSync(path)) return path;
  }

  // macOS: scan for usbmodem devices
  const candidates = [
    "/dev/cu.usbmodem201401",
    "/dev/cu.usbmodem0004401800001",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  try {
    const entries = readdirSync("/dev")
      .filter((e: string) => e.startsWith("cu.usbmodem") || e.startsWith("ttyACM"))
      .sort();
    if (entries.length > 0) return `/dev/${entries[0]}`;
  } catch {}

  return "/dev/ttyACM0"; // fallback
}
