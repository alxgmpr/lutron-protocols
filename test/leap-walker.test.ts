import assert from "node:assert/strict";
import test from "node:test";
import { LEAP_REGISTRY, walkEndpoints } from "../lib/leap-client";

// Mock LeapConnection that returns canned responses
class MockLeap {
  private responses: Record<string, any>;

  constructor(responses: Record<string, any>) {
    this.responses = responses;
  }

  async readBody(url: string): Promise<any | null> {
    return this.responses[url] ?? null;
  }
}

test("walkEndpoints fetches top-level collection", async () => {
  const mock = new MockLeap({
    "/server": { Servers: [{ Type: "LEAP", ProtocolVersion: "03.247" }] },
  });

  const registry = [
    { path: "/server", key: "server", core: true, itemsField: "Servers" },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.deepStrictEqual(result.server, [
    { Type: "LEAP", ProtocolVersion: "03.247" },
  ]);
});

test("walkEndpoints skips non-core endpoints when full=false", async () => {
  const mock = new MockLeap({
    "/server": { Servers: [{ Type: "LEAP" }] },
    "/system": { TimeZone: "America/New_York" },
  });

  const registry = [
    { path: "/server", key: "server", core: true, itemsField: "Servers" },
    { path: "/system", key: "system", itemsField: null },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: false,
    log: () => {},
  });

  assert.ok(result.server);
  assert.strictEqual(result.system, undefined);
});

test("walkEndpoints handles singleton endpoints (itemsField=null)", async () => {
  const mock = new MockLeap({
    "/system": { TimeZone: "America/New_York", Coordinates: { Lat: 40 } },
  });

  const registry = [
    { path: "/system", key: "system", core: true, itemsField: null },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.system.TimeZone, "America/New_York");
});

test("walkEndpoints silently skips null responses", async () => {
  const mock = new MockLeap({});

  const registry = [
    {
      path: "/occupancygroup",
      key: "occupancyGroups",
      core: true,
      itemsField: "OccupancyGroups",
    },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.occupancyGroups, undefined);
});

test("walkEndpoints fetches children per item", async () => {
  const mock = new MockLeap({
    "/area": {
      Areas: [
        { href: "/area/1", Name: "Office", IsLeaf: true },
        { href: "/area/2", Name: "Lobby", IsLeaf: true },
      ],
    },
    "/area/1/associatedzone": {
      Zones: [{ href: "/zone/10", Name: "Light" }],
    },
    "/area/2/associatedzone": {
      Zones: [{ href: "/zone/20", Name: "Fan" }],
    },
  });

  const registry = [
    {
      path: "/area",
      key: "areas",
      core: true,
      itemsField: "Areas",
      children: [
        { path: "/associatedzone", key: "zones", itemsField: "Zones" },
      ],
    },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.areas.length, 2);
  assert.deepStrictEqual(result.areas[0].zones, [
    { href: "/zone/10", Name: "Light" },
  ]);
  assert.deepStrictEqual(result.areas[1].zones, [
    { href: "/zone/20", Name: "Fan" },
  ]);
});

test("walkEndpoints fetches perItem sub-resources", async () => {
  const mock = new MockLeap({
    "/zone": {
      Zones: [{ href: "/zone/518", Name: "Light" }],
    },
    "/zone/518/status": { Level: 75, FanSpeed: null },
  });

  const registry = [
    {
      path: "/zone",
      key: "zones",
      core: true,
      itemsField: "Zones",
      perItem: [{ path: "/status", key: "status" }],
    },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.zones.length, 1);
  assert.deepStrictEqual(result.zones[0].status, {
    Level: 75,
    FanSpeed: null,
  });
});

test("walkEndpoints handles children returning null gracefully", async () => {
  const mock = new MockLeap({
    "/area": {
      Areas: [{ href: "/area/1", Name: "Office", IsLeaf: true }],
    },
    // /area/1/associatedzone returns null (204/404)
  });

  const registry = [
    {
      path: "/area",
      key: "areas",
      core: true,
      itemsField: "Areas",
      children: [
        { path: "/associatedzone", key: "zones", itemsField: "Zones" },
      ],
    },
  ];

  const result = await walkEndpoints(mock as any, registry, {
    full: true,
    log: () => {},
  });

  assert.strictEqual(result.areas.length, 1);
  assert.deepStrictEqual(result.areas[0].zones, undefined);
});

test("LEAP_REGISTRY is a non-empty array with required fields", () => {
  assert.ok(Array.isArray(LEAP_REGISTRY));
  assert.ok(
    LEAP_REGISTRY.length > 20,
    `Expected 20+ entries, got ${LEAP_REGISTRY.length}`,
  );

  for (const entry of LEAP_REGISTRY) {
    assert.ok(
      typeof entry.path === "string",
      `Missing path: ${JSON.stringify(entry)}`,
    );
    assert.ok(
      typeof entry.key === "string",
      `Missing key: ${JSON.stringify(entry)}`,
    );
    assert.ok(
      entry.itemsField === null || typeof entry.itemsField === "string",
      `Invalid itemsField: ${JSON.stringify(entry)}`,
    );
  }
});
