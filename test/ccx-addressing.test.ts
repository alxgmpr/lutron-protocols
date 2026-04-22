import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalizeIpv6,
  eui64ToSecondaryMleid,
  expandIpv6,
  secondaryMleidToEui64,
} from "../ccx/addressing";

test("eui64ToSecondaryMleid flips the U/L bit and prepends fd00::", () => {
  assert.equal(
    eui64ToSecondaryMleid("e2:79:8d:ff:fe:92:85:fe"),
    "fd00::e079:8dff:fe92:85fe",
  );
  assert.equal(
    eui64ToSecondaryMleid("46:9f:da:ff:fe:7e:cc:62"),
    "fd00::449f:daff:fe7e:cc62",
  );
  assert.equal(
    eui64ToSecondaryMleid("96:b2:16:ff:fe:ac:e1:ec"),
    "fd00::94b2:16ff:feac:e1ec",
  );
});

test("eui64ToSecondaryMleid tolerates hyphen and case variants", () => {
  assert.equal(
    eui64ToSecondaryMleid("E2-79-8D-FF-FE-92-85-FE"),
    "fd00::e079:8dff:fe92:85fe",
  );
  assert.equal(
    eui64ToSecondaryMleid("e2798dfffe9285fe"),
    "fd00::e079:8dff:fe92:85fe",
  );
});

test("eui64ToSecondaryMleid accepts a 48-bit MAC by inserting ff:fe", () => {
  // MAC e2:79:8d:92:85:fe → EUI-64 e2:79:8d:ff:fe:92:85:fe → same IID as above
  assert.equal(
    eui64ToSecondaryMleid("e2:79:8d:92:85:fe"),
    "fd00::e079:8dff:fe92:85fe",
  );
});

test("eui64ToSecondaryMleid rejects malformed input", () => {
  assert.throws(() => eui64ToSecondaryMleid("not-an-eui"));
  assert.throws(() => eui64ToSecondaryMleid("aa:bb:cc:dd:ee")); // 5 bytes
  assert.throws(() => eui64ToSecondaryMleid("")); // empty
});

test("secondaryMleidToEui64 is the inverse of eui64ToSecondaryMleid", () => {
  const fixture: Array<{ eui64: string; secondaryMleid: string }> = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "fixtures/designer-ccx-sample.json"),
      "utf8",
    ),
  );
  for (const row of fixture) {
    assert.equal(eui64ToSecondaryMleid(row.eui64), row.secondaryMleid);
    assert.equal(secondaryMleidToEui64(row.secondaryMleid), row.eui64);
  }
});

test("expandIpv6 pads and handles :: shorthand", () => {
  assert.equal(
    expandIpv6("fd00::1"),
    "fd00:0000:0000:0000:0000:0000:0000:0001",
  );
  assert.equal(
    expandIpv6("fd00::e079:8dff:fe92:85fe"),
    "fd00:0000:0000:0000:e079:8dff:fe92:85fe",
  );
  assert.equal(
    expandIpv6("2001:db8:0:0:0:0:0:1"),
    "2001:0db8:0000:0000:0000:0000:0000:0001",
  );
});

test("canonicalizeIpv6 lower-cases, compresses zeros, strips leading zeros", () => {
  assert.equal(
    canonicalizeIpv6("FD00:0000:0000:0000:E079:8DFF:FE92:85FE"),
    "fd00::e079:8dff:fe92:85fe",
  );
  assert.equal(canonicalizeIpv6("fd00:0:0:0:0:0:0:1"), "fd00::1");
  // already canonical passes through
  assert.equal(canonicalizeIpv6("fd00::1"), "fd00::1");
});
