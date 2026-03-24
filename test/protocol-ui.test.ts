import assert from "node:assert/strict";
import test from "node:test";
import {
  identifyPacket,
  parseDeviceId,
  parseFieldValue,
} from "../protocol/protocol-ui";

test("identifyPacket resolves virtual unpair packets from state format", () => {
  const packet = new Uint8Array(24);
  packet[0] = 0x81;
  packet[7] = 0x0c;
  // Broadcast at bytes 9-13 distinguishes UNPAIR from DIM_STOP
  packet[9] = 0xff;
  packet[10] = 0xff;
  packet[11] = 0xff;
  packet[12] = 0xff;
  packet[13] = 0xff;

  const identified = identifyPacket(packet);

  assert.equal(identified.typeName, "UNPAIR");
  assert.equal(identified.isVirtual, true);
  assert.equal(identified.category, "CONFIG");
});

test("identifyPacket resolves DIM_STOP for non-broadcast format 0x0C on state types", () => {
  const packet = new Uint8Array(24);
  packet[0] = 0x82;
  packet[7] = 0x0c;
  // Target device at bytes 9-12, NOT broadcast
  packet[9] = 0x08;
  packet[10] = 0x4b;

  const identified = identifyPacket(packet);

  assert.equal(identified.typeName, "DIM_STOP");
  assert.equal(identified.isVirtual, true);
  assert.equal(identified.category, "STATE");
});

test("identifyPacket resolves PICO_RESET vs PICO_HOLD vs SENSOR_VACANT", () => {
  // PICO_RESET: broadcast at bytes 9-13
  const reset = new Uint8Array(24);
  reset[0] = 0x8b;
  reset[7] = 0x0c;
  reset[9] = 0xff;
  reset[10] = 0xff;
  reset[11] = 0xff;
  reset[12] = 0xff;
  reset[13] = 0xff;
  assert.equal(identifyPacket(reset).typeName, "PICO_RESET");

  // PICO_HOLD: pico_frame=0x03 at byte 8
  const hold = new Uint8Array(24);
  hold[0] = 0x89;
  hold[7] = 0x0c;
  hold[8] = 0x03;
  assert.equal(identifyPacket(hold).typeName, "PICO_HOLD");

  // SENSOR_VACANT: fallback (no broadcast, no pico_frame)
  const vacant = new Uint8Array(24);
  vacant[0] = 0x8b;
  vacant[7] = 0x0c;
  vacant[8] = 0x04;
  assert.equal(identifyPacket(vacant).typeName, "SENSOR_VACANT");
});

test("parseFieldValue resolves named hex fields from constant groups", () => {
  assert.deepEqual(parseFieldValue(["42"], 0, 1, "hex", "cmd_class"), {
    raw: "42",
    decoded: "DIM",
  });
  assert.deepEqual(parseFieldValue(["00"], 0, 1, "hex", "cmd_type"), {
    raw: "00",
    decoded: "HOLD",
  });
  assert.deepEqual(parseFieldValue(["fe"], 0, 1, "hex", "addr_mode"), {
    raw: "fe",
    decoded: "COMPONENT",
  });
  assert.deepEqual(parseFieldValue(["03"], 0, 1, "hex", "direction"), {
    raw: "03",
    decoded: "RAISE",
  });
  // Unknown field name falls through to raw hex
  assert.deepEqual(parseFieldValue(["42"], 0, 1, "hex", "flags"), {
    raw: "42",
    decoded: null,
  });
});

test("identifyPacket falls back to hex string for unknown packet types", () => {
  const identified = identifyPacket(Uint8Array.from([0xee]));

  assert.equal(identified.typeName, "0xEE");
  assert.equal(identified.category, "unknown");
});

test("parseDeviceId handles both endiannesses", () => {
  const bytes = ["11", "22", "33", "44"];

  assert.equal(parseDeviceId(bytes, 0, "little"), "44332211");
  assert.equal(parseDeviceId(bytes, 0, "big"), "11223344");
});

test("parseFieldValue decodes broadcast and level fields", () => {
  assert.deepEqual(
    parseFieldValue(["FF", "FF", "FF", "FF", "FF"], 0, 5, "hex"),
    { raw: "FF FF FF FF FF", decoded: "BROADCAST" },
  );

  assert.deepEqual(parseFieldValue(["FE"], 0, 1, "level_byte"), {
    raw: "FE",
    decoded: "100%",
  });
});
