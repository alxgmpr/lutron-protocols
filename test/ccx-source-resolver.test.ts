/**
 * CCX source attribution — turning a stream frame's source IPv6 into something
 * a human (or an HA entity) can key on. GLAB-78.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CcxSourceResolver } from "../cli/core/ccx-source";

const RLOC = "fd0d:1122:3344:5566:0:ff:fe00:8401";
const MLEID = "fd00::449f:daff:fe7e:cc62";

/** Resolver wired to a fixed device map instead of the on-disk one. */
function makeResolver(
  names: {
    byAddr?: Record<string, string>;
    bySerial?: Record<number, string>;
  } = {},
) {
  return new CcxSourceResolver({
    deviceNameByAddr: (a) => names.byAddr?.[a],
    deviceNameBySerial: (s) => names.bySerial?.[s],
  });
}

describe("CcxSourceResolver", () => {
  it("resolves a device name directly from the ML-EID", () => {
    const r = makeResolver({ byAddr: { [MLEID]: "Office Keypad" } });
    const label = r.label({ srcAddr: MLEID, srcKind: "attributed" });

    assert.equal(label.name, "Office Keypad");
    assert.equal(label.text, "Office Keypad");
    assert.equal(label.addr, MLEID);
  });

  it("resolves an RLOC source via the peer table once a serial is seen", () => {
    const r = makeResolver({ bySerial: { 12345: "Kitchen Dimmer" } });

    // Before the peer table has learned anything, the RLOC is all we can show.
    assert.equal(
      r.label({ srcAddr: RLOC, srcKind: "attributed" }).text,
      "0x8401",
    );

    // A DEVICE_REPORT/STATUS from that RLOC binds it to a serial.
    r.observe(RLOC, { serial: 12345 });

    const label = r.label({ srcAddr: RLOC, srcKind: "attributed" });
    assert.equal(label.rloc16, 0x8401);
    assert.equal(label.name, "Kitchen Dimmer");
    assert.equal(label.text, "Kitchen Dimmer");
  });

  it("binds a device id from BUTTON_PRESS-style messages", () => {
    const r = makeResolver({ bySerial: { 0xdeadbeef: "Pico" } });
    r.observe(RLOC, { deviceId: 0xdeadbeef });

    assert.equal(
      r.label({ srcAddr: RLOC, srcKind: "attributed" }).name,
      "Pico",
    );
  });

  it("prefers the direct address match over the peer table", () => {
    const r = makeResolver({
      byAddr: { [RLOC]: "By Address" },
      bySerial: { 12345: "By Serial" },
    });
    r.observe(RLOC, { serial: 12345 });

    assert.equal(
      r.label({ srcAddr: RLOC, srcKind: "attributed" }).name,
      "By Address",
    );
  });

  it("falls back to a shortened address when there is no RLOC and no name", () => {
    const r = makeResolver();
    const label = r.label({ srcAddr: MLEID, srcKind: "attributed" });

    assert.equal(label.name, undefined);
    assert.equal(label.rloc16, undefined);
    assert.equal(label.text, MLEID);
  });

  it("labels locally-originated frames as local", () => {
    const r = makeResolver();
    const label = r.label({ srcAddr: null, srcKind: "local" });

    assert.equal(label.text, "local");
    assert.equal(label.addr, undefined);
  });

  it("labels frames from firmware without the trailer as unknown", () => {
    const r = makeResolver();
    const label = r.label({ srcAddr: null, srcKind: "unsupported" });

    assert.equal(label.text, "?");
    assert.equal(label.name, undefined);
  });

  it("does not learn from a source it cannot key on", () => {
    const r = makeResolver({ bySerial: { 7: "Nope" } });
    // An ML-EID has no RLOC16, so there is nothing to bind the serial to.
    r.observe(MLEID, { serial: 7 });

    assert.equal(
      r.label({ srcAddr: MLEID, srcKind: "attributed" }).name,
      undefined,
    );
  });

  it("re-binds an RLOC when a device's serial changes under it", () => {
    // RLOC16 is a routing address; it can be reassigned across reboots.
    const r = makeResolver({ bySerial: { 1: "Old", 2: "New" } });
    r.observe(RLOC, { serial: 1 });
    r.observe(RLOC, { serial: 2 });

    assert.equal(r.label({ srcAddr: RLOC, srcKind: "attributed" }).name, "New");
  });

  it("reports whether the connected firmware sends source addresses", () => {
    const r = makeResolver();
    assert.equal(r.firmwareSendsSource, false);

    r.label({ srcAddr: null, srcKind: "unsupported" });
    assert.equal(r.firmwareSendsSource, false);

    r.label({ srcAddr: RLOC, srcKind: "attributed" });
    assert.equal(r.firmwareSendsSource, true);
  });
});
