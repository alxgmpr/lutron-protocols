/**
 * Device identity — tests.
 *
 * These ids end up as Home Assistant `unique_id`s, so their shape is a
 * commitment: changing it later orphans every entity built on it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deviceIdFor, wireIdOf } from "../lib/bridge/device-id";

describe("device identity", () => {
  it("namespaces a wire id by its transport", () => {
    assert.equal(deviceIdFor("ccx", "0c2cef20"), "ccx_0c2cef20");
    assert.equal(deviceIdFor("cca", "deadbeef"), "cca_deadbeef");
  });

  it("keeps two transports apart on identical wire bytes", () => {
    // The whole point: both ids are four undifferentiated bytes, and without
    // the namespace these two physical controls would become one HA entity.
    assert.notEqual(
      deviceIdFor("ccx", "deadbeef"),
      deviceIdFor("cca", "deadbeef"),
    );
  });

  it("recovers the wire id for lookups that predate the namespace", () => {
    assert.equal(wireIdOf("ccx_0c2cef20"), "0c2cef20");
    assert.equal(wireIdOf("cca_deadbeef"), "deadbeef");
  });

  it("leaves an unprefixed id alone", () => {
    // Ids from before the namespace existed, and ids from tests that build
    // events directly, must still resolve.
    assert.equal(wireIdOf("0c2cef20"), "0c2cef20");
  });

  it("strips only a known transport, not any underscore", () => {
    // `wiz_` is not a transport that observes devices; treating it as one would
    // silently rewrite an id that means something else.
    assert.equal(wireIdOf("wiz_0c2cef20"), "wiz_0c2cef20");
  });
});
