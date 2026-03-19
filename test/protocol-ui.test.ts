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

  const identified = identifyPacket(packet);

  assert.equal(identified.typeName, "UNPAIR");
  assert.equal(identified.isVirtual, true);
  assert.equal(identified.category, "CONFIG");
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
