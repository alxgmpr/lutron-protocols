/**
 * Corpus redaction — strip installation identity from captured CCA frames so
 * a decode-coverage corpus can live in a public repo.
 *
 * The rule is safety by construction, not by inventory. Scrubbing only the
 * serials we know about is not enough: of 119 distinct device IDs observed
 * across the local captures, 95 are absent from the LEAP dump. So identified
 * frames have their device_id fields overwritten *positionally* — which
 * catches devices we have never heard of — and unidentified frames, where no
 * field definition tells us where an id would sit, keep only the bytes the
 * coverage metric actually reads.
 *
 * Both paths are checked to leave every decode metric unchanged, so the
 * committed baseline still describes frames as they were received.
 */

import { identifyPacket } from "../protocol/protocol-ui";

/** Fixed stand-in written over every redacted device id. */
export const REDACTED_ID = Buffer.from("deadbeef", "hex");

/**
 * Bytes an unidentified frame is allowed to keep: the type byte, and the
 * format byte that drives virtual-type reclassification. Everything the
 * coverage metric reads, and nothing else.
 */
const UNIDENTIFIED_KEEP_OFFSETS = [0, 7];

/**
 * Fields blanked whole. A segmented transfer's payload is the device table:
 * serials packed back to back, and split across segment boundaries, so no
 * positional or by-value scrub can find them all.
 */
const OPAQUE_FIELDS = new Set(["payload"]);

export interface RedactOptions {
  /** Serials to scrub wherever they appear, in either byte order. */
  knownSerials?: number[];
}

/**
 * Smallest value treated as a real device id. A device_id field whose offset
 * lands on padding reads as a tiny number, and scrubbing those would corrupt
 * unrelated payload bytes wherever they happened to collide.
 */
const MIN_PLAUSIBLE_ID = 0x100000;

/**
 * Collect every value seen in a device_id field position across a set of
 * frames.
 *
 * Structural redaction only fixes the frame types whose layout we know. The
 * same id also turns up inside *other* types at offsets no field definition
 * covers, where nothing would touch it — and 95 of the 119 ids observed
 * locally are absent from the LEAP dump, so an inventory-driven scrub misses
 * them. Harvesting from the traffic and then scrubbing by value everywhere
 * closes that gap: an id that is identifiable anywhere is removed everywhere.
 */
export function harvestDeviceIds(frames: Buffer[]): number[] {
  const ids = new Set<number>();

  for (const frame of frames) {
    const info = identifyPacket(frame);
    if (info.category === "unknown") continue;

    for (const field of info.fields) {
      if (!/device_id/.test(String(field.format))) continue;
      if (field.offset + 4 > frame.length) continue;

      const value = frame.readUInt32BE(field.offset);
      if (value < MIN_PLAUSIBLE_ID) continue;
      if (isUniform(value)) continue;
      ids.add(value);
    }
  }

  return [...ids];
}

/** All four bytes equal — broadcast (ff ff ff ff) and filler, not identity. */
function isUniform(value: number): boolean {
  const b0 = (value >>> 24) & 0xff;
  return (
    ((value >>> 16) & 0xff) === b0 &&
    ((value >>> 8) & 0xff) === b0 &&
    (value & 0xff) === b0
  );
}

export function redactCcaFrame(data: Buffer, opts: RedactOptions = {}): Buffer {
  const info = identifyPacket(data);

  if (info.category === "unknown") {
    const out = Buffer.alloc(data.length);
    for (const off of UNIDENTIFIED_KEEP_OFFSETS) {
      if (off < data.length) out[off] = data[off];
    }
    return out;
  }

  const out = Buffer.from(data);

  // By value first. A layout can put a device_id field a few bytes off
  // where this frame really carries its id (an occupancy-sensor frame
  // decoded as DIM_STEP: field at 9, id at 12). Filling that first
  // overwrites one byte of the real id and hides the other three from
  // the scrub.
  for (const serial of opts.knownSerials ?? []) {
    scrubValue(out, serial);
  }

  for (const field of info.fields) {
    // A truncated frame still holds the leading bytes of a cut-off field.
    const end = Math.min(field.offset + field.size, out.length);
    if (OPAQUE_FIELDS.has(field.name)) {
      out.fill(0, field.offset, end);
    } else if (/device_id/.test(String(field.format))) {
      fillPlaceholder(out, field.offset, end - field.offset);
    }
  }

  return out;
}

/** Write the placeholder across a span, repeating or truncating to fit. */
function fillPlaceholder(buf: Buffer, offset: number, size: number): void {
  for (let i = 0; i < size; i++) {
    buf[offset + i] = REDACTED_ID[i % REDACTED_ID.length];
  }
}

/** Overwrite every occurrence of a 32-bit serial, big- or little-endian. */
function scrubValue(buf: Buffer, serial: number): void {
  const be = Buffer.alloc(4);
  be.writeUInt32BE(serial >>> 0);
  const le = Buffer.alloc(4);
  le.writeUInt32LE(serial >>> 0);

  for (const pattern of [be, le]) {
    let from = 0;
    for (;;) {
      const at = buf.indexOf(pattern, from);
      if (at === -1) break;
      fillPlaceholder(buf, at, pattern.length);
      from = at + pattern.length;
    }
  }
}
