/**
 * Thread Management Framework (TMF) Network Diagnostic — TLV codec.
 *
 * Wire format reference: Thread 1.3 specification, section "Network Diagnostic"
 * (MLE / TMF). CoAP path `/d/dg` on UDP port 61631. Request payload is a single
 * TLV of type 0x12 (Type List), whose value is the list of TLV types to request.
 * Each responder replies with a payload containing the requested TLVs in
 * type|length|value format.
 *
 * This module only implements the small subset needed for EUI-64 ↔ RLOC ↔ IPv6
 * enumeration: types 0 (ExtMacAddress), 1 (Address16/RLOC16), and 8
 * (IPv6 Address List).
 */

import { canonicalizeIpv6 } from "./addressing";

export const DIAG_TLV_EXT_MAC = 0;
export const DIAG_TLV_RLOC16 = 1;
export const DIAG_TLV_IPV6_LIST = 8;
export const DIAG_TLV_TYPE_LIST = 0x12;

/**
 * Encode a Type List request: `[0x12, count, type_1, …, type_N]`.
 * Each type must fit in one byte (0..255). At least one type is required.
 */
export function encodeDiagTypeList(types: readonly number[]): Buffer {
  if (!types.length) {
    throw new Error("encodeDiagTypeList: types must be non-empty");
  }
  for (const t of types) {
    if (!Number.isInteger(t) || t < 0 || t > 0xff) {
      throw new Error(`encodeDiagTypeList: type out of range 0..255: ${t}`);
    }
  }
  const buf = Buffer.alloc(2 + types.length);
  buf[0] = DIAG_TLV_TYPE_LIST;
  buf[1] = types.length;
  for (let i = 0; i < types.length; i++) buf[2 + i] = types[i];
  return buf;
}

export interface DiagResponse {
  eui64?: string;
  rloc16?: number;
  ipv6Addresses: string[];
}

/**
 * Decode a Diagnostic response payload: sequence of `type(1) | len(1) | value(len)`
 * TLVs. Unknown TLVs are skipped silently; the caller can extend the struct as
 * more types become useful.
 */
export function decodeDiagResponse(body: Buffer): DiagResponse {
  const out: DiagResponse = { ipv6Addresses: [] };
  let i = 0;
  while (i + 2 <= body.length) {
    const type = body[i++];
    const len = body[i++];
    if (i + len > body.length) {
      throw new Error(
        `Truncated TLV: type=${type} len=${len} at offset ${i - 2}, only ${body.length - i} bytes remaining`,
      );
    }
    const value = body.subarray(i, i + len);
    switch (type) {
      case DIAG_TLV_EXT_MAC:
        if (len === 8) {
          out.eui64 = Array.from(value)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(":");
        }
        break;
      case DIAG_TLV_RLOC16:
        if (len === 2) out.rloc16 = (value[0] << 8) | value[1];
        break;
      case DIAG_TLV_IPV6_LIST:
        if (len % 16 === 0) {
          for (let off = 0; off < len; off += 16) {
            const groups: string[] = [];
            for (let g = 0; g < 8; g++) {
              const pair = value.readUInt16BE(off + g * 2);
              groups.push(pair.toString(16));
            }
            out.ipv6Addresses.push(canonicalizeIpv6(groups.join(":")));
          }
        }
        break;
      default:
        // Unknown TLV — skip.
        break;
    }
    i += len;
  }
  return out;
}
