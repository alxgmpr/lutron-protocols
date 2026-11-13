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
export const INVERSE = "\x1b[7m";

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
  /** Packet bytes, kept for the detail pane. */
  bytes?: Uint8Array;
}

// ============================================================================
// Cell utilities
// ============================================================================
function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

function clipCell(
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

function colorCell(text: string, color: string, bold = false): string {
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
  const terminalColumns = process.stdout.columns;
  const width =
    termWidth ??
    (terminalColumns && terminalColumns > 0 ? terminalColumns : 120);

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

  // Target width-1 so rendered rows never fill the last terminal column —
  // avoids Ink/terminal edge-case wrapping that would push DELTA onto a
  // second line.
  let available = width - 1 - fixed - spaces;

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

function getDetailIndent(layout: PacketLayout): number {
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
    // With the RAW column hidden, a row with no decoded state shows its hex.
    clipCell(row.state || (layout.showRaw ? "" : row.raw), layout.state),
  ];
  if (layout.showRaw) {
    cells.push(clipCell(row.raw, layout.raw, "right"));
  }
  cells.push(clipCell(row.delta, layout.delta, "right"));

  return cells.join(" ");
}

// ============================================================================
// Log entries, filtering, and viewport
// ============================================================================

/** A pre-rendered text line (shell output, notices) in the packet log. */
export interface TextEntry {
  text: string;
}
/** A log entry: a structured packet row, or a text line. */
export type LogEntry = TextEntry | PacketRow;
export const isText = (e: LogEntry): e is TextEntry => "text" in e;
export type RowFilter = (row: PacketRow) => boolean;

const FILTER_FIELDS = {
  proto: (r) => r.proto,
  dir: (r) => r.direction,
  rssi: (r) => r.rssi,
  seq: (r) => r.seq,
  op: (r) => r.opcode,
  type: (r) => r.typeAction,
  dev: (r) => r.device,
  device: (r) => r.device,
  zone: (r) => r.zone,
  state: (r) => r.state,
  raw: (r) => r.raw,
} satisfies Record<string, (r: PacketRow) => string>;
const isFilterField = (k: string): k is keyof typeof FILTER_FIELDS =>
  Object.hasOwn(FILTER_FIELDS, k);

const rowText = (r: PacketRow) =>
  [
    r.proto,
    r.direction,
    r.opcode,
    r.typeAction,
    r.device,
    r.zone,
    r.state,
    r.raw,
    r.verboseLine ?? "",
  ].join(" ");

/**
 * Parse a filter spec into a row predicate. Space-separated terms, all must
 * match (case-insensitive substring): `term` searches every field,
 * `field=value` one field, and a leading `-` negates. Throws on unknown field.
 */
export function parseFilter(spec: string): RowFilter {
  const tests = spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => {
      const negate = term.startsWith("-");
      const body = (negate ? term.slice(1) : term).toLowerCase();
      const eq = body.indexOf("=");
      let get = rowText;
      let needle = body;
      if (eq > 0) {
        const key = body.slice(0, eq);
        if (!isFilterField(key)) {
          throw new Error(
            `unknown field '${key}' (${Object.keys(FILTER_FIELDS).join(", ")})`,
          );
        }
        get = FILTER_FIELDS[key];
        needle = body.slice(eq + 1);
      }
      return (r: PacketRow) => get(r).toLowerCase().includes(needle) !== negate;
    });
  return (r) => tests.every((t) => t(r));
}

/** Inverse-video a rendered line, re-applying it after each embedded reset. */
const highlight = (line: string) =>
  `${INVERSE}${line.replaceAll(RESET, RESET + INVERSE)}${RESET}`;

/** Display lines an entry occupies under the current filter/verbose state. */
export function entryLineCount(
  e: LogEntry,
  verbose: boolean,
  match: RowFilter | null,
): number {
  if (isText(e)) return 1;
  if (match && !match(e)) return 0;
  return verbose && e.verboseLine ? 2 : 1;
}

/**
 * The entry drawn `linesUp` display lines above the tail (0 = newest line),
 * or null past the oldest. Inverse of visibleLines, for mouse hit-testing.
 */
export function entryAtLine(
  entries: readonly LogEntry[],
  verbose: boolean,
  match: RowFilter | null,
  linesUp: number,
): LogEntry | null {
  let seen = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    seen += entryLineCount(entries[i], verbose, match);
    if (seen > linesUp) return entries[i];
  }
  return null;
}

/**
 * Render the `height` display lines that end `offset` lines (>= 0) above the
 * tail. Walks backward from the newest entry so cost scales with the window,
 * not the buffer. Text lines are always shown; the filter hides packets only.
 */
export function visibleLines(
  entries: readonly LogEntry[],
  layout: PacketLayout,
  match: RowFilter | null,
  height: number,
  offset: number,
  selected: PacketRow | null = null,
): string[] {
  const out: string[] = [];
  let skip = offset;
  for (let i = entries.length - 1; i >= 0 && out.length < height; i--) {
    const e = entries[i];
    let lines: string[];
    if (isText(e)) lines = [e.text];
    else if (match && !match(e)) continue;
    else if (layout.showVerbose && e.verboseLine)
      lines = [
        renderRow(e, layout),
        renderRow({ ...e, isDetail: true }, layout),
      ];
    else lines = [renderRow(e, layout)];
    if (e === selected) lines[0] = highlight(lines[0]);
    for (let j = lines.length - 1; j >= 0 && out.length < height; j--) {
      if (skip > 0) skip--;
      else out.push(lines[j]);
    }
  }
  return out.reverse();
}
