import assert from "node:assert/strict";
import test from "node:test";
import {
  bucketIdToToken,
  buildCoapAck,
  buildCoapPacket,
  buildIpv6UdpPacket,
  coapCodeFromName,
  decodeMaybeCbor,
  encodeCborValue,
  fromB64Url,
  getUriPath,
  parseCoapPacket,
  parseIpv6,
} from "../ccx/coap";

test("coap packet round-trips path, token, and payload", () => {
  const packet = buildCoapPacket({
    type: 0,
    code: 1,
    mid: 0x1234,
    token: Buffer.from("beef", "hex"),
    path: "/zone/123/status",
    payload: Buffer.from("hello"),
  });

  const parsed = parseCoapPacket(packet);
  assert.ok(parsed);
  assert.equal(parsed.type, 0);
  assert.equal(parsed.code, 1);
  assert.equal(parsed.mid, 0x1234);
  assert.equal(parsed.token.toString("hex"), "beef");
  assert.equal(getUriPath(parsed.options), "/zone/123/status");
  assert.equal(parsed.payload.toString(), "hello");
});

test("coap ack omits uri-path and preserves token", () => {
  const packet = buildCoapAck(7, Buffer.from("aa", "hex"));
  const parsed = parseCoapPacket(packet);
  assert.ok(parsed);
  assert.equal(parsed.type, 2);
  assert.equal(parsed.mid, 7);
  assert.equal(parsed.token.toString("hex"), "aa");
  assert.equal(parsed.options.length, 0);
});

test("CBOR encode/decode handles nested objects and numeric keys", () => {
  const encoded = encodeCborValue({
    1: "one",
    nested: [true, false, null, Buffer.from("ff", "hex")],
  });

  assert.deepEqual(decodeMaybeCbor(encoded), {
    1: "one",
    nested: [true, false, null, "ff"],
  });
});

test("parseIpv6 expands shorthand and raw UDP packet embeds addresses", () => {
  const src = "fd00::1";
  const dst = "fd00::abcd";
  assert.equal(parseIpv6(src).length, 16);

  const packet = buildIpv6UdpPacket({
    src,
    dst,
    srcPort: 1234,
    dstPort: 5683,
    udpPayload: Buffer.from("abcd", "hex"),
  });

  assert.equal(packet.length, 50);
  assert.equal(
    packet.subarray(8, 24).toString("hex"),
    parseIpv6(src).toString("hex"),
  );
  assert.equal(
    packet.subarray(24, 40).toString("hex"),
    parseIpv6(dst).toString("hex"),
  );
});

test("bucket tokens are url-safe and reversible", () => {
  const token = bucketIdToToken(513);
  assert.equal(fromB64Url(token).readUInt16BE(0), 513);
});

test("coapCodeFromName accepts verbs and numeric codes", () => {
  assert.equal(coapCodeFromName("get"), 1);
  assert.equal(coapCodeFromName("69"), 69);
});
