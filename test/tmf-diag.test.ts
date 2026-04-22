import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAG_TLV_EXT_MAC,
  DIAG_TLV_IPV6_LIST,
  DIAG_TLV_RLOC16,
  decodeDiagResponse,
  encodeDiagTypeList,
} from "../ccx/tmf-diag";

test("encodeDiagTypeList wraps the request types with type 0x12 + count", () => {
  // [0x12, count=3, 0x00 (ExtMac), 0x01 (RLOC16), 0x08 (IPv6 List)]
  assert.equal(
    encodeDiagTypeList([
      DIAG_TLV_EXT_MAC,
      DIAG_TLV_RLOC16,
      DIAG_TLV_IPV6_LIST,
    ]).toString("hex"),
    "1203000108",
  );
  // [0x12, count=1, 0x01]
  assert.equal(encodeDiagTypeList([DIAG_TLV_RLOC16]).toString("hex"), "120101");
});

test("encodeDiagTypeList rejects empty and out-of-range types", () => {
  assert.throws(() => encodeDiagTypeList([]));
  assert.throws(() => encodeDiagTypeList([256]));
  assert.throws(() => encodeDiagTypeList([-1]));
});

test("decodeDiagResponse parses ExtMacAddress, RLOC16, and IPv6 list TLVs", () => {
  // 00 08 <8 bytes EUI-64>  01 02 <RLOC16>  08 20 <2 * 16 bytes IPv6>
  const body = Buffer.concat([
    Buffer.from("00", "hex"),
    Buffer.from("08", "hex"),
    Buffer.from("e2798dfffe9285fe", "hex"),
    Buffer.from("01", "hex"),
    Buffer.from("02", "hex"),
    Buffer.from("4800", "hex"),
    Buffer.from("08", "hex"),
    Buffer.from("20", "hex"), // length 32 = 2 addresses
    Buffer.from("fd0d02efa82c0000aaaaaaaaaaaaaaaa", "hex"),
    Buffer.from("fd00000000000000e0798dfffe9285fe", "hex"),
  ]);
  const r = decodeDiagResponse(body);
  assert.equal(r.eui64, "e2:79:8d:ff:fe:92:85:fe");
  assert.equal(r.rloc16, 0x4800);
  // RFC 5952: single zero groups are NOT collapsed to `::` (only runs of 2+).
  assert.deepEqual(r.ipv6Addresses, [
    "fd0d:2ef:a82c:0:aaaa:aaaa:aaaa:aaaa",
    "fd00::e079:8dff:fe92:85fe",
  ]);
});

test("decodeDiagResponse handles missing TLVs gracefully", () => {
  const body = Buffer.concat([
    Buffer.from("01", "hex"),
    Buffer.from("02", "hex"),
    Buffer.from("1234", "hex"),
  ]);
  const r = decodeDiagResponse(body);
  assert.equal(r.rloc16, 0x1234);
  assert.equal(r.eui64, undefined);
  assert.deepEqual(r.ipv6Addresses, []);
});

test("decodeDiagResponse throws on truncated TLV length", () => {
  const body = Buffer.from("0008e2798dff", "hex"); // claims 8 bytes, only 4 given
  assert.throws(() => decodeDiagResponse(body));
});
