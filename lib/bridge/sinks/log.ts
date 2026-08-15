/**
 * Log sink — renders resolved commands as the human-readable lines the bridge
 * has always printed. Formatting lives here rather than in the model so the
 * model can stay a pure state machine emitting structured events.
 */

import type { BridgeSink, CommandEvent, SinkHost } from "../types";

export interface LogSinkOptions {
  log: (msg: string) => void;
  /** Timestamp renderer, injectable so output is assertable in tests. */
  timestamp?: () => string;
}

export class LogSink implements BridgeSink {
  readonly name = "log";

  private log: (msg: string) => void;
  private timestamp: () => string;

  constructor(opts: LogSinkOptions) {
    this.log = opts.log;
    this.timestamp =
      opts.timestamp ?? (() => new Date().toISOString().slice(11, 23));
  }

  attach(model: SinkHost): void {
    model.on("command", (e) => this.onCommand(e));
  }

  detach(): void {}

  private onCommand(e: CommandEvent): void {
    const time = this.timestamp();
    const where = `${e.zoneName} (zone=${e.zoneId})`;

    switch (e.kind) {
      case "level": {
        const levelStr =
          e.level !== null ? `${e.level.toFixed(1)}%` : "color-only";
        const fadeSec = e.fade / 4;
        const fadeStr = fadeSec > 0.25 ? ` fade=${fadeSec}s` : "";
        const colorStr = e.colorXy
          ? ` xy=(${(e.colorXy[0] / 10000).toFixed(4)},${(e.colorXy[1] / 10000).toFixed(4)})`
          : "";
        this.log(
          `\n${time} ** ${e.origin} → ${where} ${levelStr}${fadeStr}${colorStr}`,
        );
        return;
      }
      case "ramp-start":
        this.log(
          `\n${time} ** RAMP ${e.direction.toUpperCase()} → ${where} from ${e.fromLevel.toFixed(0)}%`,
        );
        return;
      case "ramp-stop":
        this.log(
          `${time} ** RAMP STOP → ${where} at ${e.atLevel.toFixed(0)}% (${e.elapsedMs}ms)`,
        );
    }
  }
}
