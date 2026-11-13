/**
 * Per-device sparklines — RSSI and inter-packet gap for the most recently
 * heard devices, plus each device's CCA slot-tracker state, derived from
 * the log entries at render time.
 *
 * Pure: entries in, ANSI lines out.
 */

import {
  CYAN,
  DIM,
  GREEN,
  isText,
  type LogEntry,
  RED,
  RESET,
  type RowFilter,
  type SlotInfo,
  YELLOW,
} from "./packets";

const BARS = "▁▂▃▄▅▆▇█";

/** One bar per value, scaled to [lo, hi]; NaN draws a gap. */
export function spark(values: readonly number[], lo: number, hi: number) {
  const span = hi - lo || 1;
  return values
    .map((v) => {
      if (Number.isNaN(v)) return " ";
      const i = Math.round(((v - lo) / span) * (BARS.length - 1));
      return BARS[Math.max(0, Math.min(BARS.length - 1, i))];
    })
    .join("");
}

export interface DeviceStats {
  proto: string;
  device: string;
  count: number;
  /** Oldest first; NaN where the packet had no RSSI (TX). */
  rssi: number[];
  /** Milliseconds since the device's previous packet, oldest first. */
  gaps: number[];
  /** Latest slot-tracker reading, if any packet had one. */
  slot?: SlotInfo;
  /** Packets the slot tracker inferred missing, summed over the buffer. */
  missed: number;
}

/** "HH:MM:SS.mmm" → ms since midnight. */
const tsMs = (ts: string) => {
  const [h, m, s] = ts.split(":").map(Number);
  return (h * 60 + m) * 60_000 + s * 1000;
};

/**
 * The `maxDevices` most recently heard devices (newest first), each with
 * its last `samples` RSSI readings and gaps.
 */
export function deviceStats(
  entries: readonly LogEntry[],
  match: RowFilter | null,
  maxDevices: number,
  samples: number,
): DeviceStats[] {
  const byKey = new Map<string, DeviceStats>();
  const lastMs = new Map<string, number>();
  for (const e of entries) {
    if (isText(e) || !e.device || (match && !match(e))) continue;
    const key = `${e.proto}:${e.device}`;
    const ms = tsMs(e.ts);
    const prevMs = lastMs.get(key);
    const d = byKey.get(key) ?? {
      proto: e.proto,
      device: e.device,
      count: 0,
      rssi: [],
      gaps: [],
      missed: 0,
    };
    // Skip gaps across midnight (ts wraps).
    if (prevMs !== undefined && ms >= prevMs) d.gaps.push(ms - prevMs);
    lastMs.set(key, ms);
    // Re-insert so Map order tracks recency.
    byKey.delete(key);
    byKey.set(key, d);
    d.count++;
    d.rssi.push(e.rssi ? Number.parseFloat(e.rssi) : Number.NaN);
    if (e.slot) {
      d.slot = e.slot;
      d.missed += e.slot.missedPackets ?? 0;
    }
  }
  return [...byKey.values()]
    .reverse()
    .slice(0, maxDevices)
    .map((d) => ({
      ...d,
      rssi: d.rssi.slice(-samples),
      gaps: d.gaps.slice(-samples),
    }));
}

const finite = (xs: number[]) => xs.filter((x) => !Number.isNaN(x));

const SLOT_COLOR = { LOCK: GREEN, TRACK: YELLOW, LEARN: DIM };

/** Columns the panel uses besides the two sparklines. */
export const PANEL_FIXED_WIDTH = 52;

/** e.g. "LOCK  92% s6", padded to 12. */
function slotCell(slot: SlotInfo | undefined): string {
  if (!slot) return "".padEnd(12);
  const stride = slot.stride ? ` s${slot.stride}` : "";
  const text =
    `${slot.status.padEnd(5)}${`${slot.confidencePct}%`.padStart(4)}${stride}`.padEnd(
      12,
    );
  return `${SLOT_COLOR[slot.status]}${text}${RESET}`;
}

/**
 * Panel lines: a header, then one line per device. RSSI and gap bars share
 * one scale across all devices so rows compare; gaps are log-scaled since
 * they span retransmits (~75ms) to idle seconds.
 */
export function renderDevicePanel(
  stats: readonly DeviceStats[],
  samples: number,
): string[] {
  const allRssi = finite(stats.flatMap((d) => d.rssi));
  const allGaps = stats.flatMap((d) => d.gaps).map((g) => Math.log10(g + 1));
  const rLo = Math.min(...allRssi);
  const rHi = Math.max(...allRssi);
  const gLo = Math.min(...allGaps);
  const gHi = Math.max(...allGaps);
  const fmtGap = (ms: number | undefined) =>
    ms === undefined
      ? ""
      : ms >= 1000
        ? `${(ms / 1000).toFixed(1)}s`
        : `${ms}ms`;

  const header = `${DIM}${"DEVICE".padEnd(12)}${"PKTS".padStart(5)}  ${"RSSI".padEnd(samples)} ${"dBm".padStart(4)}  ${"GAP".padEnd(samples)} ${"last".padStart(6)}  ${"SLOT".padEnd(12)} ${"MISS".padStart(4)}${RESET}`;
  const lines = stats.map((d) => {
    const lastRssi = finite(d.rssi).at(-1);
    const rssiBars = spark(d.rssi, rLo, rHi).padStart(samples);
    const gapBars = spark(
      d.gaps.map((g) => Math.log10(g + 1)),
      gLo,
      gHi,
    ).padStart(samples);
    return [
      `${d.proto} ${d.device}`.slice(0, 11).padEnd(12),
      String(d.count).padStart(5),
      `  ${CYAN}${rssiBars}${RESET}`,
      ` ${lastRssi === undefined ? "".padStart(4) : String(lastRssi).padStart(4)}`,
      `  ${YELLOW}${gapBars}${RESET}`,
      ` ${fmtGap(d.gaps.at(-1)).padStart(6)}`,
      `  ${slotCell(d.slot)}`,
      d.slot
        ? ` ${d.missed ? RED : DIM}${String(d.missed).padStart(4)}${RESET}`
        : "",
    ].join("");
  });
  return [header, ...lines];
}
