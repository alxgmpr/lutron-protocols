/**
 * CCA frame → decode observation.
 *
 * Wraps identifyPacket/parseFieldValue so capture tooling measures decode
 * depth the same way the CLI displays it, instead of each caller inventing
 * its own idea of what "decoded" means.
 */

import {
  identifyPacket,
  parseDeviceId,
  parseFieldValue,
} from "../protocol/protocol-ui";
import type { DecodedFrame } from "./capture-metrics";

/**
 * Fields that name the *originator*, most specific first.
 *
 * `source_id` wins over `device_id` because a command frame carries both a
 * source and a target: keying on the wrong one files every controller's
 * traffic under whichever load it addressed. `load_id` is the beacon's own
 * identity.
 */
const SENDER_ID_FIELDS = ["source_id", "device_id", "load_id"] as const;

/**
 * State reports carry no 32-bit id — link address, subnet and zone are the
 * whole of their identity, and zone alone repeats across subnets.
 */
const STATE_ADDRESS_FIELDS = ["link_addr", "subnet", "zone"] as const;

/**
 * Who sent this frame, as a key stable enough to group a sequence run by.
 *
 * Null when the type is unidentified: with no field definitions there is no
 * honest way to say who sent it, and guessing an offset would fabricate
 * senders for the large share of traffic we still cannot name (GLAB-114).
 */
export function ccaSender(data: Buffer): string | null {
  if (data.length < 2) return null;
  const info = identifyPacket(data);
  if (info.category === "unknown") return null;

  const bytes = [...data].map((b) => b.toString(16).padStart(2, "0"));

  for (const name of SENDER_ID_FIELDS) {
    const field = info.fields.find((f) => f.name === name);
    if (!field || field.offset + field.size > data.length) continue;
    // Wire order, deliberately ignoring `usesBigEndianDeviceId`.
    //
    // That flag is a display convention and packet types disagree on it: a
    // single plug-in dimmer sends DEVICE_CTRL (marked big-endian) and
    // SET_LEVEL (marked little-endian) carrying the identical bytes
    // a3 98 43 00 at offset 2. Honouring it here files one device under two
    // sender keys, splits its bursts between them, and reports the split as
    // packet loss — measured at 55% on the bench rig. A grouping key only
    // has to be stable, so the raw bytes are the right thing to use.
    const id = parseDeviceId(bytes, field.offset, "big");
    if (id) return id;
  }

  const parts: string[] = [];
  for (const name of STATE_ADDRESS_FIELDS) {
    const field = info.fields.find((f) => f.name === name);
    if (!field || field.offset + field.size > data.length) return null;
    parts.push(bytes.slice(field.offset, field.offset + field.size).join(""));
  }
  return parts.length === STATE_ADDRESS_FIELDS.length
    ? parts.join("-").toUpperCase()
    : null;
}

export interface CcaObservation extends DecodedFrame {
  /** Sequence number, carried in the second byte of every CCA frame. */
  seq: number | null;
  /** Originating device, or null when the frame cannot be attributed. */
  sender: string | null;
  /** Fields the protocol defines for this packet type. */
  fieldsDefined: number;
  /** Of those, how many had their bytes present in this frame. */
  fieldsPresent: number;
  /**
   * Of those present, how many decoded to a symbolic value.
   *
   * Deliberately not the same as `fieldsPresent`: raw-hex fields like `crc`
   * and `protocol` are read in full but have no symbolic meaning, so a gap
   * between the two is normal. A *drop* in this number is the regression.
   */
  fieldsNamed: number;
}

export function decodeCcaFrame(data: Buffer): CcaObservation {
  if (data.length === 0) {
    return {
      band: "cca",
      decoded: false,
      identified: false,
      typeName: null,
      seq: null,
      sender: null,
      fieldsDefined: 0,
      fieldsPresent: 0,
      fieldsNamed: 0,
    };
  }

  const info = identifyPacket(data);
  // An unrecognized type byte still comes back with a name — its own hex —
  // so the category is the only honest signal.
  const identified = info.category !== "unknown";

  const bytes = [...data].map((b) => b.toString(16).padStart(2, "0"));
  let fieldsPresent = 0;
  let fieldsNamed = 0;
  for (const field of info.fields) {
    if (field.offset + field.size > data.length) continue;
    fieldsPresent++;

    const { decoded } = parseFieldValue(
      bytes,
      field.offset,
      field.size,
      field.format,
      field.name,
    );
    if (decoded !== null) fieldsNamed++;
  }

  return {
    band: "cca",
    decoded: true,
    identified,
    typeName: info.typeName,
    seq: data.length > 1 ? data[1] : null,
    sender: ccaSender(data),
    fieldsDefined: info.fields.length,
    fieldsPresent,
    fieldsNamed,
  };
}
