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

test("identifyPacket names 5-byte short ACKs by their XOR check", () => {
  // Captured reply to SET_LEVEL 0xCB7C from an HQR-3LD: status = level high byte
  const identified = identifyPacket([0x07, 0x05, 0xcb, 0x2d, 0xf7]);

  assert.equal(identified.typeName, "ACK_07");
  assert.equal(identified.category, "ACK");
  const status = identified.fields.find((f) => f.name === "status");
  assert.equal(status?.offset, 2);
});

test("identifyPacket accepts a short ACK with the tail older firmware appends", () => {
  // Pre-fix firmware streamed short ACKs through the CRC-optional fallback,
  // padding them with whatever followed on air.
  const hex = "072831000d617c614c3924fa";
  const identified = identifyPacket(Buffer.from(hex, "hex"));

  assert.equal(identified.typeName, "ACK_07");
});

test("identifyPacket leaves a short type unknown when its check fails", () => {
  // Same type byte, check bytes off by one bit: a CRC-failed frame, not an ACK
  const identified = identifyPacket([0x07, 0x05, 0xcb, 0x2d, 0xf6]);

  assert.equal(identified.typeName, "0x07");
  assert.equal(identified.category, "unknown");
});

test("identifyPacket names segmented-transfer frames, long and short", () => {
  // Last of 3 segments (fmt 0x22), broadcast to every link (target 0x7F)
  const long = new Uint8Array(53).fill(0xcc);
  long.set([0xa6, 0x01, 0x21, 0x12, 0x34, 0x00, 0x7f, 0x22]);
  const a6 = identifyPacket(long);
  assert.equal(a6.typeName, "SEGMENT_A6");
  assert.equal(a6.category, "CONFIG");
  assert.equal(a6.fields.find((f) => f.name === "segment")?.offset, 7);
  assert.equal(a6.fields.find((f) => f.name === "crc")?.offset, 51);

  // 9-byte tail of a 6-segment body (fmt 0x55) fits a short frame
  const short = new Uint8Array(24).fill(0xcc);
  short.set([0x87, 0x85, 0x21, 0x12, 0x34, 0x00, 0x7f, 0x55]);
  const s87 = identifyPacket(short);
  assert.equal(s87.typeName, "SEGMENT_87");
  assert.equal(s87.fields.find((f) => f.name === "crc")?.offset, 22);
});

test("identifyPacket splits B1-B3 into device discovery and OTA TransferData", () => {
  const discovery = new Uint8Array(53).fill(0xcc);
  discovery.set([0xb1, 0x01, 0xa1, 0x12, 0x34, 0x7f, 0x21, 0x13, 0x00]);
  discovery.set([0xff, 0xff, 0xff, 0xff, 0xff, 0x08, 0x05], 9);
  assert.equal(identifyPacket(discovery).typeName, "PAIR_B1");

  const ota = new Uint8Array(53);
  ota.set([0xb2, 0x01, 0xa1, 0x12, 0x34, 0x00, 0x21, 0x2b, 0x00]);
  ota.set(
    [0x01, 0x02, 0x03, 0x04, 0xfe, 0x06, 0x02, 0x00, 0x00, 0x1f, 0x1f],
    9,
  );
  const data = identifyPacket(ota);
  assert.equal(data.typeName, "OTA_DATA");
  assert.equal(data.isVirtual, true);
  assert.equal(data.fields.find((f) => f.name === "chunk")?.offset, 20);
});
