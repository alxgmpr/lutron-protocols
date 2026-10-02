import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommandFrame,
  CommandOp,
  decodeRuntimeTelemetry,
  MsgType,
  parseAllFrames,
  parseFrame,
} from "../lib/ipl";

// V1 omits systemId; V2 carries one byte; V3 carries two bytes.
const runtimeBody = "000004d2000f01feff";
const v1Runtime = Buffer.from(`4c45490500ff000500010009${runtimeBody}`, "hex");

test("Version1 runtime telemetry keeps operation and payload aligned", () => {
  const frame = parseFrame(v1Runtime);
  assert.ok(frame);
  assert.equal(frame.version, 1);
  assert.equal(frame.systemId, 0);
  assert.equal(frame.senderId, 0);
  assert.equal(frame.receiverId, 255);
  assert.equal(frame.messageId, 5);
  assert.equal(frame.operationId, 1);
  const update = decodeRuntimeTelemetry(frame.body);
  assert.ok(update);
  assert.equal(update.objectId, 1234);
  assert.equal(update.propertyNumber, 1);
  assert.equal(update.value.readUInt16BE(0), 0xfeff);
  assert.equal(frame.nextOffset, v1Runtime.length);
});

test("Version1 acknowledgements are complete at eight bytes", () => {
  const frame = parseFrame(Buffer.from("4c45490100ff002a", "hex"));
  assert.ok(frame);
  assert.equal(frame.msgType, MsgType.Acknowledgement);
  assert.equal(frame.messageId, 42);
  assert.equal(frame.nextOffset, 8);
  assert.equal(frame.operationId, undefined);
});

test("Version2 reads its one-byte system ID", () => {
  const frame = parseFrame(
    Buffer.from(`4c4549250700ff000500010009${runtimeBody}`, "hex"),
  );
  assert.ok(frame);
  assert.equal(frame.version, 2);
  assert.equal(frame.systemId, 7);
  assert.equal(frame.receiverId, 255);
  assert.equal(frame.operationId, 1);
  assert.equal(frame.body.toString("hex"), runtimeBody);
});

test("mixed Version1 and Version3 frames preserve stream boundaries", () => {
  const ping = buildCommandFrame(CommandOp.Ping, Buffer.alloc(0));
  const { frames, remainder } = parseAllFrames(
    Buffer.concat([Buffer.from("4c45490100ff002a", "hex"), v1Runtime, ping]),
  );
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((frame) => frame.version),
    [1, 1, 3],
  );
  assert.equal(frames[2].operationId, CommandOp.Ping);
  assert.equal(remainder.length, 0);
});

test("fragmented Version1 payloads wait for the whole frame", () => {
  for (let end = 0; end < v1Runtime.length; end++) {
    assert.equal(parseFrame(v1Runtime.subarray(0, end)), null, `split ${end}`);
  }
  assert.ok(parseFrame(v1Runtime));
});

// Captured Ping response with serial/GUID anonymized; no operation ID.
const pingResponseBody =
  "010203040000000000000000000000000000000000000000000000000000000008020100000000001a060000900001890d40";
const v3PingResponse = Buffer.from(
  `4c4549420001000100010032${pingResponseBody}`,
  "hex",
);

test("Version3 Ping response reads its length without an operation ID", () => {
  const frame = parseFrame(v3PingResponse);
  assert.ok(frame);
  assert.equal(frame.version, 3);
  assert.equal(frame.msgType, MsgType.Response);
  assert.equal(frame.messageId, 1);
  assert.equal(frame.operationId, undefined);
  assert.equal(frame.body.toString("hex"), pingResponseBody);
  assert.equal(frame.nextOffset, 62);
});

test("Ping responses preserve the following telemetry frame", () => {
  const { frames, remainder } = parseAllFrames(
    Buffer.concat([v3PingResponse, v1Runtime]),
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0].nextOffset, 62);
  assert.equal(frames[1].operationId, 1);
  assert.equal(frames[1].body.toString("hex"), runtimeBody);
  assert.equal(remainder.length, 0);
});

test("Version1 response length follows its eight-byte base header", () => {
  const frame = parseFrame(Buffer.from("4c4549020001002a0002aabb", "hex"));
  assert.ok(frame);
  assert.equal(frame.version, 1);
  assert.equal(frame.msgType, MsgType.Response);
  assert.equal(frame.messageId, 42);
  assert.equal(frame.operationId, undefined);
  assert.equal(frame.body.toString("hex"), "aabb");
  assert.equal(frame.nextOffset, 12);
});
