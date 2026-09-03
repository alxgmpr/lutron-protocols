import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../lib/data-values";

// ccx/config.ts memoizes each disk read on first access, so each test builds a
// temp data dir, sets the env var, then imports a fresh module instance.
function withIsolatedConfig<T>(
  files: JsonObject,
  body: (mod: typeof import("../ccx/config")) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ccx-config-test-"));
  for (const [name, payload] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(payload));
  }
  process.env.CCX_DATA_DIR = dir;
  const cacheBuster = `../ccx/config?${Date.now()}-${Math.random()}`;
  return import(cacheBuster).then((mod) => body(mod));
}

/**
 * Import the module against an empty data dir, THEN repoint CCX_DATA_DIR at a
 * populated one. An eager module (filesystem read at import time) sees only the
 * empty dir; a lazy one reads on first accessor call and sees the populated dir.
 */
async function importThenRepoint(
  files: JsonObject,
): Promise<typeof import("../ccx/config")> {
  const emptyDir = mkdtempSync(join(tmpdir(), "ccx-config-empty-"));
  const populatedDir = mkdtempSync(join(tmpdir(), "ccx-config-lazy-"));
  for (const [name, payload] of Object.entries(files)) {
    writeFileSync(join(populatedDir, name), JSON.stringify(payload));
  }
  process.env.CCX_DATA_DIR = emptyDir;
  const cacheBuster = `../ccx/config?lazy-${Date.now()}-${Math.random()}`;
  // SAFETY: The test controls this fixture and intentionally uses the asserted test-only shape.
  const mod = (await import(cacheBuster)) as typeof import("../ccx/config");
  process.env.CCX_DATA_DIR = populatedDir;
  return mod;
}

test("LEAP dump is read on first lookup, not at import time", async () => {
  const mod = await importThenRepoint({
    "leap-test.json": { zones: { 7: { name: "Lamp", area: "Study" } } },
  });
  assert.equal(mod.getZoneName(7), "Study Lamp");
});

test("device map is read on first lookup, not at import time", async () => {
  const mod = await importThenRepoint({
    "ccx-device-map.json": {
      meshLocalPrefix: "fd0d:2ef:a82c:0",
      devices: [
        {
          serial: 999,
          eui64: "46:9f:da:ff:fe:7e:cc:62",
          secondaryMleid: "fd00::449f:daff:fe7e:cc62",
          name: "Lazy Device",
          area: "Test",
          station: "Test",
          deviceType: "SunnataDimmer",
          zones: [],
        },
      ],
    },
  });
  assert.equal(mod.getDeviceBySerial(999)?.name, "Lazy Device");
});

test("preset-zones scene names are read on first lookup, not at import time", async () => {
  const mod = await importThenRepoint({
    "preset-zones.json": { "3116": { name: "Evening", zones: {} } },
  });
  assert.equal(mod.getSceneName(3116), "Evening");
});

test("CCX_CONFIG reads Thread link params on access, not at import time", async () => {
  // Short stand-in, not a plausible 16-byte Thread key — the accessor just
  // base64-decodes and hex-uppercases whatever the dump carries.
  const fakeKeyHex = "deadbeef";
  const mod = await importThenRepoint({
    "leap-test.json": {
      zones: {},
      link: {
        ccx: {
          channel: 21,
          panId: 0x1234,
          masterKey: Buffer.from(fakeKeyHex, "hex").toString("base64"),
        },
      },
    },
  });
  assert.equal(mod.CCX_CONFIG.channel, 21);
  assert.equal(mod.CCX_CONFIG.panId, 0x1234);
  assert.equal(mod.CCX_CONFIG.masterKey, fakeKeyHex.toUpperCase());
});

test("getDeviceAddress returns the secondaryMleid (stable fd00::) for the serial", async () => {
  await withIsolatedConfig(
    {
      "ccx-device-map.json": {
        meshLocalPrefix: "fd0d:2ef:a82c:0",
        devices: [
          {
            serial: 71148018,
            eui64: "e2:79:8d:ff:fe:92:85:fe",
            secondaryMleid: "fd00::e079:8dff:fe92:85fe",
            primaryMleid: "fd0d:2ef:a82c:0:dead:beef:1234:5678",
            name: "Dining Room Back Doorway",
            area: "Dining Room",
            station: "Back Doorway",
            deviceType: "SunnataDimmer",
            zones: [],
          },
        ],
      },
    },
    (mod) => {
      assert.equal(mod.getDeviceAddress(71148018), "fd00::e079:8dff:fe92:85fe");
    },
  );
});

test("getDeviceName resolves both secondaryMleid and primaryMleid to the same device", async () => {
  await withIsolatedConfig(
    {
      "ccx-device-map.json": {
        meshLocalPrefix: "fd0d:2ef:a82c:0",
        devices: [
          {
            serial: 71148018,
            eui64: "e2:79:8d:ff:fe:92:85:fe",
            secondaryMleid: "fd00::e079:8dff:fe92:85fe",
            primaryMleid: "fd0d:2ef:a82c:0:dead:beef:1234:5678",
            name: "Dining Room Back Doorway",
            area: "Dining Room",
            station: "Back Doorway",
            deviceType: "SunnataDimmer",
            zones: [],
          },
        ],
      },
    },
    (mod) => {
      assert.equal(
        mod.getDeviceName("fd00::e079:8dff:fe92:85fe"),
        "Dining Room Back Doorway",
      );
      assert.equal(
        mod.getDeviceName("fd0d:2ef:a82c:0:dead:beef:1234:5678"),
        "Dining Room Back Doorway",
      );
    },
  );
});

test("getDeviceName tolerates a differently-spelled form of the same address", async () => {
  // Addresses recovered from raw packet bytes (the Nucleo stream source
  // trailer) are canonicalized, while LEAP-sourced strings keep whatever the
  // processor wrote. Both must resolve.
  await withIsolatedConfig(
    {
      "ccx-device-map.json": {
        meshLocalPrefix: "fd0d:2ef:a82c:0",
        devices: [
          {
            serial: 71148018,
            eui64: "e2:79:8d:ff:fe:92:85:fe",
            secondaryMleid: "fd00::e079:8dff:fe92:85fe",
            primaryMleid: "FD0D:02EF:A82C:0000:DEAD:BEEF:1234:5678",
            name: "Dining Room Back Doorway",
            area: "Dining Room",
            station: "Back Doorway",
            deviceType: "SunnataDimmer",
            zones: [],
          },
        ],
      },
    },
    (mod) => {
      // Fully expanded form of the secondary ML-EID
      assert.equal(
        mod.getDeviceName("fd00:0000:0000:0000:e079:8dff:fe92:85fe"),
        "Dining Room Back Doorway",
      );
      // Canonical form of an upper-case, zero-padded primary ML-EID
      assert.equal(
        mod.getDeviceName("fd0d:2ef:a82c:0:dead:beef:1234:5678"),
        "Dining Room Back Doorway",
      );
      assert.equal(mod.getDeviceName("fd00::1"), undefined);
      assert.equal(mod.getDeviceName("not-an-address"), undefined);
    },
  );
});

test("getDeviceAddress derives secondaryMleid from eui64 when the field is missing", async () => {
  await withIsolatedConfig(
    {
      "ccx-device-map.json": {
        meshLocalPrefix: "fd0d:2ef:a82c:0",
        devices: [
          {
            serial: 12345,
            eui64: "46:9f:da:ff:fe:7e:cc:62",
            // secondaryMleid intentionally omitted
            name: "Test",
            area: "Test",
            station: "Test",
            deviceType: "SunnataKeypad",
            zones: [],
          },
        ],
      },
    },
    (mod) => {
      assert.equal(mod.getDeviceAddress(12345), "fd00::449f:daff:fe7e:cc62");
    },
  );
});
