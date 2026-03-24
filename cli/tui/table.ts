/**
 * PacketTable — column layout, row rendering, and ring buffer for the TUI.
 *
 * Extracted from nucleo.ts. Handles layout calculation, cell clipping/coloring,
 * header rendering, row rendering, and a ring buffer for scroll-back.
 */

import { stripVTControlCharacters } from "util";

// ============================================================================
// ANSI colors (re-exported for use by other modules)
// ============================================================================
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const BLUE = "\x1b[34m";
export const MAGENTA = "\x1b[35m";
export const CYAN = "\x1b[36m";
export const WHITE = "\x1b[37m";

// ============================================================================
// Layout constants
// ============================================================================
const MIN_PACKET_STATE_WIDTH = 10;
const MIN_PACKET_RAW_WIDTH = 24;
const MIN_PACKET_DELTA_WIDTH = 6;
const MIN_PACKET_SEQ_WIDTH = 3;

const RING_BUFFER_SIZE = 5000;

// ============================================================================
// Types
// ============================================================================
export interface PacketLayout {
  showRaw: boolean;
  showVerbose: boolean;
  totalWidth: number;
  time: number;
  proto: number;
  dir: number;
  rssi: number;
  seq: number;
  opcode: number;
  typeAction: number;
  device: number;
  zone: number;
  state: number;
  raw: number;
  delta: number;
}

export interface PacketRow {
  ts: string;
  proto: string;
  protoColor: string;
  direction: string;
  dirColor: string;
  rssi: string;
  seq: string;
  opcode: string;
  typeAction: string;
  typeActionColor: string;
  device: string;
  deviceColor?: string;
  zone: string;
  zoneColor?: string;
  state: string;
  raw: string;
  delta: string;
  isDetail?: boolean;
  verboseLine?: string;
}

// ============================================================================
// Cell utilities
// ============================================================================
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

export function clipCell(
  text: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  const clipped =
    plain.length > width
      ? width <= 3
        ? plain.slice(0, width)
        : `${plain.slice(0, width - 3)}...`
      : plain;

  if (align === "right") return clipped.padStart(width);
  if (align === "center") {
    const left = Math.floor((width - clipped.length) / 2);
    const right = width - clipped.length - left;
    return `${" ".repeat(Math.max(0, left))}${clipped}${" ".repeat(Math.max(0, right))}`;
  }
  return clipped.padEnd(width);
}

export function colorCell(text: string, color: string, bold = false): string {
  if (!color) return text;
  return `${bold ? BOLD : ""}${color}${text}${RESET}`;
}

// ============================================================================
// Layout calculation
// ============================================================================
export function getPacketLayout(
  showRaw: boolean,
  termWidth?: number,
  showVerbose?: boolean,
): PacketLayout {
  const width =
    termWidth ??
    (typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? process.stdout.columns
      : 120);

  const layout: PacketLayout = {
    showRaw,
    showVerbose: showVerbose ?? false,
    totalWidth: 0,
    time: 12,
    proto: 1,
    dir: 2,
    rssi: 4,
    seq: 3,
    opcode: 2,
    typeAction: 20,
    device: 8,
    zone: 14,
    state: MIN_PACKET_STATE_WIDTH,
    raw: 0,
    delta: 8,
  };

  // Column count: fixed columns + state + (raw if shown)
  const columns = showRaw ? 11 : 10;
  const spaces = columns - 1;

  // Sum of all fixed-width columns (everything except state and raw)
  const fixed =
    layout.time +
    layout.proto +
    layout.dir +
    layout.rssi +
    layout.seq +
    layout.opcode +
    layout.typeAction +
    layout.device +
    layout.zone +
    layout.delta;

  let available = width - fixed - spaces;

  // Shrink fixed columns if needed to fit minimum flexibles
  const minFlex = showRaw
    ? MIN_PACKET_STATE_WIDTH + MIN_PACKET_RAW_WIDTH
    : MIN_PACKET_STATE_WIDTH;
  while (available < minFlex) {
    if (layout.zone > 6) {
      layout.zone--;
      available++;
      continue;
    }
    if (layout.delta > MIN_PACKET_DELTA_WIDTH) {
      layout.delta--;
      available++;
      continue;
    }
    if (layout.seq > MIN_PACKET_SEQ_WIDTH) {
      layout.seq--;
      available++;
      continue;
    }
    if (layout.typeAction > 12) {
      layout.typeAction--;
      available++;
      continue;
    }
    if (layout.time > 8) {
      layout.time--;
      available++;
      continue;
    }
    break;
  }

  if (showRaw) {
    // Split available space: 40% to state, 60% to raw (hex needs more room)
    const rawShare = Math.max(
      MIN_PACKET_RAW_WIDTH,
      Math.floor(available * 0.6),
    );
    layout.raw = rawShare;
    layout.state = Math.max(MIN_PACKET_STATE_WIDTH, available - rawShare);
  } else {
    layout.state = Math.max(MIN_PACKET_STATE_WIDTH, available);
  }

  layout.totalWidth =
    layout.time +
    layout.proto +
    layout.dir +
    layout.rssi +
    layout.seq +
    layout.opcode +
    layout.typeAction +
    layout.device +
    layout.zone +
    layout.state +
    layout.raw +
    layout.delta +
    spaces;

  return layout;
}

/** Compute the indentation width to align with the typeAction column. */
export function getDetailIndent(layout: PacketLayout): number {
  // TIME + P + D + dBm + S + OP + 6 separators
  return (
    layout.time +
    layout.proto +
    layout.dir +
    layout.rssi +
    layout.seq +
    layout.opcode +
    6
  );
}

// ============================================================================
// Rendering
// ============================================================================
export function renderHeader(layout: PacketLayout): [string, string] {
  const headerCells: string[] = [
    clipCell("TIME", layout.time),
    clipCell("P", layout.proto, "center"),
    clipCell("D", layout.dir, "center"),
    clipCell("dBm", layout.rssi, "right"),
    clipCell("S", layout.seq, "right"),
    clipCell("OP", layout.opcode),
    clipCell("TYPE", layout.typeAction),
    clipCell("DEVICE", layout.device),
    clipCell("ZONE", layout.zone),
    clipCell("STATE", layout.state),
  ];
  if (layout.showRaw) {
    headerCells.push(clipCell("RAW", layout.raw, "right"));
  }
  headerCells.push(clipCell("DELTA", layout.delta, "right"));
  const labels = `${DIM}${headerCells.join(" ")}${RESET}`;
  const separator = `${DIM}${"─".repeat(layout.totalWidth)}${RESET}`;
  return [labels, separator];
}

export function renderRow(row: PacketRow, layout: PacketLayout): string {
  if (row.isDetail) {
    if (!layout.showVerbose || !row.verboseLine) return "";
    const indent = getDetailIndent(layout);
    return " ".repeat(indent) + `${DIM}${row.verboseLine}${RESET}`;
  }
  const cells: string[] = [
    clipCell(row.ts, layout.time),
    colorCell(clipCell(row.proto, layout.proto, "center"), row.protoColor),
    colorCell(clipCell(row.direction, layout.dir, "center"), row.dirColor),
    colorCell(clipCell(row.rssi, layout.rssi, "right"), row.rssi ? DIM : ""),
    clipCell(row.seq, layout.seq, "right"),
    clipCell(row.opcode, layout.opcode),
    colorCell(
      clipCell(row.typeAction, layout.typeAction),
      row.typeActionColor,
      true,
    ),
    colorCell(clipCell(row.device, layout.device), row.deviceColor ?? YELLOW),
    colorCell(clipCell(row.zone, layout.zone), row.zoneColor ?? WHITE),
    clipCell(row.state, layout.state),
  ];
  if (layout.showRaw) {
    cells.push(clipCell(row.raw, layout.raw, "right"));
  }
  cells.push(clipCell(row.delta, layout.delta, "right"));

  return cells.join(" ");
}

// ============================================================================
// PacketTable — ring buffer + layout management
// ============================================================================
export class PacketTable {
  private rows: (PacketRow | null)[] = new Array(RING_BUFFER_SIZE).fill(null);
  private rendered: (string | null)[] = new Array(RING_BUFFER_SIZE).fill(null);
  private head = 0; // next write index
  private _count = 0;
  private scrollOffset = 0; // 0 = live (bottom), negative = scrolled back

  get count(): number {
    return this._count;
  }

  getLayout(showRaw: boolean, termWidth: number): PacketLayout {
    return getPacketLayout(showRaw, termWidth);
  }

  renderHeader(layout: PacketLayout): [string, string] {
    return renderHeader(layout);
  }

  renderRow(row: PacketRow, layout: PacketLayout): string {
    return renderRow(row, layout);
  }

  addRow(row: PacketRow, renderedLine: string): void {
    this.rows[this.head] = row;
    this.rendered[this.head] = renderedLine;
    this.head = (this.head + 1) % RING_BUFFER_SIZE;
    if (this._count < RING_BUFFER_SIZE) this._count++;
    // If we're at live position, stay live (offset remains 0).
    // If scrolled back, shift offset to keep viewing the same rows.
    if (this.scrollOffset < 0) this.scrollOffset--;
  }

  /** Get visible lines for the table area. */
  getVisibleLines(height: number, offset?: number): string[] {
    const off = offset ?? this.scrollOffset;
    const lines: string[] = [];
    const total = this._count;
    if (total === 0) return lines;

    // "end" is the index of the newest visible row (exclusive)
    // At live (offset=0), end = _count. Negative offset scrolls back.
    const end = Math.max(0, total + off);
    const start = Math.max(0, end - height);

    for (let i = start; i < end; i++) {
      const bufIdx =
        this._count < RING_BUFFER_SIZE
          ? i
          : (this.head - this._count + i + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
      const line = this.rendered[bufIdx];
      if (line !== null && line !== "") lines.push(line);
    }
    return lines;
  }

  /** Re-render all stored rows with a new layout (e.g. on resize). */
  rerender(showRaw: boolean, termWidth: number, showVerbose?: boolean): void {
    const layout = getPacketLayout(showRaw, termWidth, showVerbose);
    for (let i = 0; i < this._count; i++) {
      const bufIdx =
        this._count < RING_BUFFER_SIZE
          ? i
          : (this.head - this._count + i + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
      const row = this.rows[bufIdx];
      if (row) {
        this.rendered[bufIdx] = renderRow(row, layout);
      }
    }
  }

  /** Scroll back by pages. Returns the new offset. */
  scrollBack(pages: number, pageSize: number): number {
    const maxBack = -(this._count - pageSize);
    this.scrollOffset = Math.max(
      maxBack,
      Math.min(0, this.scrollOffset + pages * pageSize),
    );
    return this.scrollOffset;
  }

  scrollToLive(): void {
    this.scrollOffset = 0;
  }

  isLive(): boolean {
    return this.scrollOffset === 0;
  }
}
