/**
 * Packet layout, cell rendering, and row types.
 *
 * Pure helpers migrated from cli/tui/table.ts — no screen coupling.
 * Used by Ink components to render packet rows into ANSI-colored strings.
 */

import { stripVTControlCharacters } from "util";

// ============================================================================
// ANSI colors
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

export const RING_BUFFER_SIZE = 5000;

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

  const columns = showRaw ? 11 : 10;
  const spaces = columns - 1;

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

export function getDetailIndent(layout: PacketLayout): number {
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
