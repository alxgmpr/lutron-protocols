import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// ccx/config.ts evaluates CCX_DATA_DIR at import time, so each test builds a
// temp data dir first, sets the env var, then dynamically imports the module.
function withIsolatedConfig<T>(
  files: Record<string, object>,
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
