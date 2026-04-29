import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiagGetRequest,
  buildPropGet,
  buildPropSet,
  decodeResponse,
  encodePackedUint,
  parseArgs,
  parseNeighborTable,
  SPINEL_CMD_PROP_VALUE_GET,
  SPINEL_CMD_PROP_VALUE_INSERTED,
  SPINEL_CMD_PROP_VALUE_SET,
  SPINEL_PROP_VENDOR_DIAG_GET_REQUEST,
  SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE,
  SPINEL_PROP_VENDOR_NEIGHBOR_TABLE,
} from "../tools/nrf/nrf-ncp-probe";

test("buildPropGet emits [header][cmd][prop-encoded]", () => {
  const f = buildPropGet(0x81, SPINEL_PROP_VENDOR_NEIGHBOR_TABLE);
  assert.equal(f[0], 0x81);
  assert.equal(f[1], SPINEL_CMD_PROP_VALUE_GET);
  // 0x3C04 encodes as two packed-uint bytes (value > 0x7F).
  const propBytes = encodePackedUint(SPINEL_PROP_VENDOR_NEIGHBOR_TABLE);
  assert.equal(propBytes.length, 2);
  assert.deepEqual(f.subarray(2), propBytes);
  assert.equal(f.length, 2 + propBytes.length);
});

test("buildPropSet emits [header][cmd][prop][value]", () => {
  const value = Buffer.from("deadbeef", "hex");
  const f = buildPropSet(0x81, SPINEL_PROP_VENDOR_DIAG_GET_REQUEST, value);
  assert.equal(f[0], 0x81);
  assert.equal(f[1], SPINEL_CMD_PROP_VALUE_SET);
  const propBytes = encodePackedUint(SPINEL_PROP_VENDOR_DIAG_GET_REQUEST);
  assert.deepEqual(f.subarray(2, 2 + propBytes.length), propBytes);
  assert.deepEqual(f.subarray(2 + propBytes.length), value);
  assert.equal(f.length, 2 + propBytes.length + value.length);
});

test("buildDiagGetRequest packs [dst:16][count:1][types:N]", () => {
  const dst = Buffer.from("ff030000000000000000000000000001", "hex");
  const req = buildDiagGetRequest(dst, [0, 1, 8]);
  const propBytes = encodePackedUint(SPINEL_PROP_VENDOR_DIAG_GET_REQUEST);
  // header(1) + cmd(1) + prop(2) + dst(16) + count(1) + 3 types(3) = 24
  assert.equal(req.length, 2 + propBytes.length + 16 + 1 + 3);
  const value = req.subarray(2 + propBytes.length);
  assert.equal(value.length, 20);
  assert.deepEqual(value.subarray(0, 16), dst);
  assert.equal(value[16], 3);
  assert.deepEqual(Array.from(value.subarray(17, 20)), [0, 1, 8]);
});

test("decodeResponse identifies PROP_VALUE_INSERTED(DIAG_GET_RESPONSE)", () => {
  // Build the prop key with our own encoder so the test doesn't depend on
  // hand-crafted packed-uint bytes.
  const propBytes = encodePackedUint(SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE);
  // Sanity check: 0x3C01 must be two bytes [0x81, 0x78] in Spinel packed-uint.
  assert.deepEqual(Array.from(propBytes), [0x81, 0x78]);

  const value = Buffer.concat([
    Buffer.alloc(16, 0x22), // fake src IPv6 address
    Buffer.from([0x08, 0x00]), // tlv_len = 8, no truncation bit
    Buffer.from("0008e2798dfffe92", "hex"), // 8 bytes of TLV payload (truncated for test)
  ]);
  const pkt = Buffer.concat([
    Buffer.from([0x81, SPINEL_CMD_PROP_VALUE_INSERTED]),
    propBytes,
    value,
  ]);

  const r = decodeResponse(pkt);
  assert.ok(r && r.kind === "insert");
  assert.equal(r.prop, SPINEL_PROP_VENDOR_DIAG_GET_RESPONSE);
  assert.equal(r.value.length, value.length);
  assert.deepEqual(r.value, value);
});

test("parseNeighborTable deserializes count + fixed-size entries", () => {
  const body = Buffer.concat([
    Buffer.from([0x01]), // count = 1
    Buffer.from("e2798dfffe9285fe", "hex"), // ext_addr
    Buffer.from([0x00, 0x48]), // rloc16 LE = 0x4800
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // age_s LE = 0
    Buffer.from([0xce]), // avg_rssi = -50 (0xCE)
    Buffer.from([0xd3]), // last_rssi = -45 (0xD3)
    Buffer.from([0x01]), // mode_flags: bit0=child
  ]);
  const entries = parseNeighborTable(body);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].rloc16, 0x4800);
  assert.equal(entries[0].ageSec, 0);
  assert.equal(entries[0].avgRssi, -50);
  assert.equal(entries[0].lastRssi, -45);
  assert.equal(entries[0].isChild, true);
  assert.equal(entries[0].rxOnWhenIdle, false);
  assert.equal(entries[0].fullThreadDevice, false);
});

test("argument parser treats --host <value> as a flag, not a positional", () => {
  const r = parseArgs([
    "--host",
    "10.0.0.4",
    "diag-get",
    "ff03::1",
    "0",
    "1",
    "8",
  ]);
  assert.equal(r.host, "10.0.0.4");
  assert.equal(r.cmd, "diag-get");
  assert.deepEqual(r.rest, ["ff03::1", "0", "1", "8"]);
});

test("argument parser defaults cmd to 'neighbors' when none given", () => {
  const r = parseArgs(["--host", "10.0.0.4"]);
  assert.equal(r.cmd, "neighbors");
  assert.deepEqual(r.rest, []);
});

test("argument parser works without --host (fall back to config)", () => {
  const r = parseArgs(["diag-get", "ff03::1", "0"]);
  assert.equal(r.host, undefined);
  assert.equal(r.cmd, "diag-get");
  assert.deepEqual(r.rest, ["ff03::1", "0"]);
});
