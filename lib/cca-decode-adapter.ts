/**
 * CCA frame → decode observation.
 *
 * Wraps identifyPacket/parseFieldValue so capture tooling measures decode
 * depth the same way the CLI displays it, instead of each caller inventing
 * its own idea of what "decoded" means.
 */

import { identifyPacket, parseFieldValue } from "../protocol/protocol-ui";
import type { DecodedFrame } from "./capture-metrics";

export interface CcaObservation extends DecodedFrame {
  /** Sequence number, carried in the second byte of every CCA frame. */
  seq: number | null;
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
    fieldsDefined: info.fields.length,
    fieldsPresent,
    fieldsNamed,
  };
}
