import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { expandTemplate, harvestIds } from "../lib/id-harvest";

describe("harvestIds", () => {
  test("collects ids from href values at any depth", () => {
    const idx = harvestIds({
      Zones: [{ href: "/zone/518" }, { href: "/zone/519" }],
      Nested: { deep: { href: "/area/32" } },
    });
    assert.deepEqual([...(idx.get("zone") ?? [])].sort(), ["518", "519"]);
    assert.deepEqual([...(idx.get("area") ?? [])], ["32"]);
  });

  test("collects the last id of a multi-segment href", () => {
    const idx = harvestIds({ href: "/device/1020/linknode/1022" });
    assert.deepEqual([...(idx.get("device") ?? [])], ["1020"]);
    assert.deepEqual([...(idx.get("linknode") ?? [])], ["1022"]);
  });

  test("ignores non-numeric trailing segments", () => {
    const idx = harvestIds({ href: "/zone/status" });
    assert.equal(idx.get("zone"), undefined);
  });

  test("accumulates into a provided index", () => {
    const idx = harvestIds({ href: "/zone/1" });
    harvestIds({ href: "/zone/2" }, idx);
    assert.deepEqual([...(idx.get("zone") ?? [])].sort(), ["1", "2"]);
  });

  test("tolerates null and primitives", () => {
    const idx = harvestIds(null);
    assert.equal(idx.size, 0);
    harvestIds(42, idx);
    harvestIds("text", idx);
    assert.equal(idx.size, 0);
  });
});

describe("expandTemplate", () => {
  const idx = new Map([
    ["zone", new Set(["1", "2", "3"])],
    ["device", new Set(["10"])],
    ["linknode", new Set(["20", "21"])],
  ]);

  test("substitutes a single placeholder", () => {
    assert.deepEqual(expandTemplate("/zone/{id}/status", idx, 10), [
      "/zone/1/status",
      "/zone/2/status",
      "/zone/3/status",
    ]);
  });

  test("respects the limit", () => {
    assert.equal(expandTemplate("/zone/{id}", idx, 2).length, 2);
  });

  test("substitutes multiple placeholders as a cross product, capped", () => {
    const out = expandTemplate("/device/{id}/linknode/{id}", idx, 10);
    assert.deepEqual(out.sort(), [
      "/device/10/linknode/20",
      "/device/10/linknode/21",
    ]);
  });

  test("returns the template unchanged when it has no placeholder", () => {
    assert.deepEqual(expandTemplate("/zone", idx, 10), ["/zone"]);
  });

  test("returns nothing when no id was harvested for the resource", () => {
    assert.deepEqual(expandTemplate("/unknown/{id}", idx, 10), []);
  });
});
