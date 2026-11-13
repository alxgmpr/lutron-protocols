/**
 * Packet detail pane — hex dump coloured by protocol field, plus decoded
 * field values (CCA) or the raw CBOR structure (CCX). Bytes that changed
 * since the same device's previous packet are underlined.
 *
 * Pure: takes a PacketRow with bytes, returns ANSI lines for the Ink pane.
 */

import { decode as cborDecode } from "cbor-x";
import { type CborMap, type CborValue, isBigInt } from "../../lib/data-values";
import { identifyPacket, parseFieldValue } from "../../protocol/protocol-ui";
import {
  BLUE,
  BOLD,
  CYAN,
  DIM,
  GREEN,
  isText,
  type LogEntry,
  MAGENTA,
  type PacketRow,
  RED,
  RESET,
  YELLOW,
} from "./packets";

const FIELD_COLORS = [CYAN, YELLOW, GREEN, MAGENTA, BLUE, RED];
const CELL_WIDTH = 28;
/** Marks a changed byte/field; orthogonal to the field colour. */
const CHANGED = "\x1b[4m\x1b[1m";

export interface FieldSpan {
  name: string;
  offset: number;
  size: number;
  /** Decoded value if the format has one, else the raw hex. */
  value: string;
  color: string;
}

const hex = (b: number) => b.toString(16).padStart(2, "0");

/** CCA field spans from the protocol definitions, clipped to the bytes. */
export function ccaSpans(bytes: Uint8Array): FieldSpan[] {
  const hexBytes = Array.from(bytes, hex);
  return identifyPacket(bytes)
    .fields.filter((f) => f.offset < bytes.length)
    .map((f, i) => {
      const size = Math.min(f.size, bytes.length - f.offset);
      const { raw, decoded } = parseFieldValue(
        hexBytes,
        f.offset,
        size,
        f.format,
        f.name,
      );
      return {
        name: f.name,
        offset: f.offset,
        size,
        value: decoded ?? raw,
        color: FIELD_COLORS[i % FIELD_COLORS.length],
      };
    });
}

/**
 * The nearest earlier packet from the same device with the same length (so
 * byte offsets line up), or null. Rows without a device never match.
 */
export function previousFromDevice(
  entries: readonly LogEntry[],
  row: PacketRow,
): PacketRow | null {
  if (!row.device || !row.bytes) return null;
  for (let i = entries.lastIndexOf(row) - 1; i >= 0; i--) {
    const e = entries[i];
    if (
      !isText(e) &&
      e.proto === row.proto &&
      e.device === row.device &&
      e.bytes?.length === row.bytes.length
    ) {
      return e;
    }
  }
  return null;
}

/** Offsets where `bytes` differs from `prev` (same length assumed). */
export function changedOffsets(bytes: Uint8Array, prev: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== prev[i]) out.push(i);
  return out;
}

/** Hex dump, each byte coloured by the first span covering it. */
export function hexDump(
  bytes: Uint8Array,
  spans: readonly FieldSpan[],
  width: number,
  changed: ReadonlySet<number> = new Set(),
): string[] {
  const perLine = width >= 6 + 16 * 3 ? 16 : 8;
  const colorAt = (i: number) =>
    spans.find((s) => i >= s.offset && i < s.offset + s.size)?.color ?? DIM;
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += perLine) {
    const cells: string[] = [];
    for (let i = start; i < Math.min(start + perLine, bytes.length); i++) {
      const mark = changed.has(i) ? CHANGED : "";
      cells.push(`${colorAt(i)}${mark}${hex(bytes[i])}${RESET}`);
    }
    lines.push(`${DIM}${hex(start)}${RESET}  ${cells.join(" ")}`);
  }
  return lines;
}

/** Pack `name value` cells into rows that fit the width. */
function fieldGrid(
  spans: readonly FieldSpan[],
  width: number,
  changed: ReadonlySet<string>,
): string[] {
  const perRow = Math.max(1, Math.floor(width / CELL_WIDTH));
  const cell = (s: FieldSpan) => {
    const text = `${s.name} ${s.value}`;
    const clipped =
      text.length > CELL_WIDTH - 1
        ? `${text.slice(0, CELL_WIDTH - 2)}…`
        : text.padEnd(CELL_WIDTH - 1);
    const mark = changed.has(s.name) ? CHANGED : "";
    return `${s.color}${mark}${clipped.slice(0, s.name.length)}${RESET}${clipped.slice(s.name.length)}`;
  };
  const rows: string[] = [];
  for (let i = 0; i < spans.length; i += perRow) {
    rows.push(
      spans
        .slice(i, i + perRow)
        .map(cell)
        .join(" "),
    );
  }
  return rows;
}

/** Compact CBOR rendering: byte strings as h'..', bigints as hex, bare keys. */
export function fmtCbor(value: CborValue): string {
  // Read the holder's original value: JSON.stringify has already applied
  // Buffer.toJSON to `v` by the time the replacer sees it.
  const json = JSON.stringify(
    value,
    function (this: CborMap, key: string, v: CborValue) {
      const orig = this[key];
      if (orig instanceof Uint8Array)
        return `h'${Array.from(orig, hex).join("")}'`;
      if (isBigInt(orig)) return `0x${orig.toString(16)}`;
      return v;
    },
  );
  return json.replace(/"(\w+)":/g, "$1:").replace(/"(h'[0-9a-f]*')"/g, "$1");
}

function wrap(text: string, width: number): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += w) out.push(text.slice(i, i + w));
  return out;
}

/** Summary line for the diff against `prev`. */
function diffLine(
  row: PacketRow,
  prev: PacketRow | null,
  offsets: readonly number[],
  fields: readonly string[],
): string {
  if (!prev) {
    return row.device
      ? `${DIM}Δ no earlier ${row.bytes?.length}-byte packet from ${row.device}${RESET}`
      : `${DIM}Δ no device to compare against${RESET}`;
  }
  if (offsets.length === 0) return `${DIM}Δ identical to ${prev.ts}${RESET}`;
  const what = fields.length ? `: ${fields.join(", ")}` : "";
  return `${CHANGED}Δ${RESET} ${DIM}vs ${prev.ts} · ${offsets.length} byte${offsets.length === 1 ? "" : "s"} changed${what}${RESET}`;
}

/** Lines for the detail pane of one packet, diffed against `prev` if given. */
export function renderDetail(
  row: PacketRow,
  width: number,
  prev: PacketRow | null = null,
): string[] {
  const isCca = row.proto === "A";
  const bytes = row.bytes;
  const title = `${BOLD}${isCca ? "CCA" : "CCX"} ${row.typeAction}${RESET}`;
  const meta = [row.direction, row.ts, row.device, row.zone]
    .filter(Boolean)
    .join("  ");
  if (!bytes) return [`${title}  ${DIM}${meta}  (no bytes captured)${RESET}`];

  const offsets =
    prev?.bytes?.length === bytes.length
      ? changedOffsets(bytes, prev.bytes)
      : [];
  const changed = new Set(offsets);
  const lines: string[] = [];
  if (isCca) {
    const spans = ccaSpans(bytes);
    const { description } = identifyPacket(bytes);
    const changedFields = spans
      .filter((s) =>
        offsets.some((o) => o >= s.offset && o < s.offset + s.size),
      )
      .map((s) => s.name);
    // Changes no defined field covers: candidates for undocumented fields.
    const unmapped = offsets.filter(
      (o) => !spans.some((s) => o >= s.offset && o < s.offset + s.size),
    );
    if (unmapped.length) {
      changedFields.push(`unmapped @${unmapped.map(hex).join(",")}`);
    }
    lines.push(
      `${title}  ${DIM}${description} · ${bytes.length} bytes · ${meta}${RESET}`,
    );
    lines.push(diffLine(row, prev, offsets, changedFields));
    lines.push(...hexDump(bytes, spans, width, changed));
    lines.push(...fieldGrid(spans, width, new Set(changedFields)));
  } else {
    lines.push(`${title}  ${DIM}${bytes.length} bytes · ${meta}${RESET}`);
    lines.push(diffLine(row, prev, offsets, []));
    lines.push(...hexDump(bytes, [], width, changed));
    try {
      lines.push(...wrap(fmtCbor(cborDecode(bytes)), width));
    } catch {
      lines.push(`${DIM}(not valid CBOR)${RESET}`);
    }
  }
  if (row.verboseLine) lines.push(`${DIM}${row.verboseLine}${RESET}`);
  return lines;
}
