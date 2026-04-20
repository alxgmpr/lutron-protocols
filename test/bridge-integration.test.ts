import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import type { CCXPacket } from "../ccx/types";

// ── Helper: construct a LEVEL_CONTROL packet ─────────────────────

function makeLevelControlPacket(opts: {
  zoneId: number;
  level: number;
  fade?: number;
  sequence?: number;
  cct?: number;
}): CCXPacket {
  const level16 = Math.round((opts.level * 0xfeff) / 100);
  const inner: Record<number, unknown> = { 0: level16, 3: opts.fade ?? 1 };
  if (opts.cct != null) inner[6] = opts.cct;
  return {
    timestamp: new Date().toISOString(),
    srcAddr: "fd00::1",
    dstAddr: "ff03::1",
    srcEui64: "",
    dstEui64: "",
    msgType: 0,
    body: { 0: inner, 1: [16, opts.zoneId], 5: opts.sequence ?? 0 },
    parsed: {
      type: "LEVEL_CONTROL",
      level: level16,
      levelPercent: opts.level,
      zoneType: 16,
      zoneId: opts.zoneId,
      fade: opts.fade ?? 1,
      delay: 0,
      cct: opts.cct,
      sequence: opts.sequence ?? 0,
      rawBody: { 0: inner, 1: [16, opts.zoneId], 5: opts.sequence ?? 0 },
    },
    rawHex: "",
  };
}

// ── WiZ UDP output assertion ──────────────────────────────────────

describe("bridge WiZ output (live UDP)", () => {
  test("LEVEL_CONTROL triggers a setPilot UDP packet to the paired WiZ IP", async () => {
    // Bind a UDP listener to capture what the bridge sends
    const listener = createSocket("udp4");
    const received: Buffer[] = [];
    const ready = new Promise<number>((resolve) => {
      listener.once("listening", () => resolve(listener.address().port));
    });
    const firstMessage = new Promise<Buffer>((resolve) => {
      listener.once("message", (msg) => {
        received.push(msg);
        resolve(msg);
      });
    });
    listener.bind(0, "127.0.0.1");
    const port = await ready;

    // Bridge with one pairing pointing at the listener
    const { BridgeCore } = await import("../lib/bridge-core");
    const bridge = new BridgeCore({
      pairings: [
        {
          name: "TestZone",
          zoneId: 100,
          wizIps: ["127.0.0.1"],
          wizPort: port,
        },
      ],
      presetZones: new Map(),
      watchedZones: new Set([100]),
    });

    // Instant level change (fade=1 → idle) marks zone dirty; tick loop (50ms) sends
    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 50, fade: 1 }),
    );

    const msg = await firstMessage;

    const parsed = JSON.parse(msg.toString());
    assert.equal(parsed.method, "setPilot");
    assert.equal(parsed.params.state, true);
    // Default CCT path at ~50% brightness should produce non-zero channels
    const p = parsed.params as {
      r: number;
      g: number;
      b: number;
      w: number;
      c: number;
      dimming: number;
    };
    assert.ok(
      p.r + p.g + p.b + p.w + p.c > 0,
      "expected at least one active channel",
    );
    assert.equal(p.dimming, 100); // raw channels always send dimming=100

    bridge.destroy();
    listener.close();
  });

  test("explicit CCT=2700K routes through warm-white channel mix", async () => {
    const listener = createSocket("udp4");
    const ready = new Promise<number>((resolve) => {
      listener.once("listening", () => resolve(listener.address().port));
    });
    const firstMessage = new Promise<Buffer>((resolve) => {
      listener.once("message", (msg) => resolve(msg));
    });
    listener.bind(0, "127.0.0.1");
    const port = await ready;

    const { BridgeCore } = await import("../lib/bridge-core");
    const bridge = new BridgeCore({
      pairings: [
        {
          name: "Warm",
          zoneId: 200,
          wizIps: ["127.0.0.1"],
          wizPort: port,
        },
      ],
      presetZones: new Map(),
      watchedZones: new Set([200]),
    });

    bridge.handlePacket(
      makeLevelControlPacket({
        zoneId: 200,
        level: 60,
        fade: 1,
        cct: 2700,
      }),
    );

    const msg = await firstMessage;
    const parsed = JSON.parse(msg.toString());
    const p = parsed.params as {
      r: number;
      g: number;
      w: number;
      c: number;
    };
    // At 2700K, W channel should dominate (warm white path); cool C should be small
    assert.ok(p.w > p.c, `expected W > C for 2700K, got w=${p.w} c=${p.c}`);
    assert.ok(p.w > 0, "W channel should be active");

    bridge.destroy();
    listener.close();
  });
});

// ── Config source equivalence ─────────────────────────────────────

describe("bridge config loaders produce equivalent pairings", () => {
  test("loadBridgeConfig (YAML) and loadBridgeConfigFromOptions (HA) match for same inputs", async () => {
    const { loadBridgeConfig, loadBridgeConfigFromOptions } = await import(
      "../lib/bridge-core"
    );

    // Same logical config in both shapes
    const haOptions = {
      wiz_port: 38899,
      pairings: [
        { zone_id: 100, name: "Kitchen", wiz_ips: ["10.0.0.10", "10.0.0.11"] },
        { zone_id: 200, name: "Living", wiz_ips: ["10.0.0.20"] },
      ],
    };

    const yamlText = `
defaults:
  wizPort: 38899
  warmDimCurve: halogen
pairings:
  - zoneId: 100
    name: Kitchen
    wiz:
      - 10.0.0.10
      - 10.0.0.11
  - zoneId: 200
    name: Living
    wiz: 10.0.0.20
`;

    // Write YAML to temp file
    const dir = mkdtempSync(join(tmpdir(), "bridge-cfg-"));
    const yamlPath = join(dir, "ccx-bridge.yaml");
    writeFileSync(yamlPath, yamlText);

    try {
      const haResult = loadBridgeConfigFromOptions(haOptions);
      const yamlResult = loadBridgeConfig(yamlPath);

      assert.equal(haResult.pairings.length, 2);
      assert.equal(yamlResult.pairings.length, 2);

      // Same zone IDs, names, IPs, port
      for (let i = 0; i < 2; i++) {
        const h = haResult.pairings[i];
        const y = yamlResult.pairings[i];
        assert.equal(h.zoneId, y.zoneId, `pairing ${i} zoneId mismatch`);
        assert.equal(h.name, y.name, `pairing ${i} name mismatch`);
        assert.deepEqual(h.wizIps, y.wizIps, `pairing ${i} wizIps mismatch`);
        assert.equal(h.wizPort, y.wizPort, `pairing ${i} wizPort mismatch`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("YAML loader accepts both 'wiz: string' and 'wiz: string[]' forms", async () => {
    const { loadBridgeConfig } = await import("../lib/bridge-core");
    const yamlText = `
pairings:
  - zoneId: 1
    wiz: 10.0.0.1
  - zoneId: 2
    wiz:
      - 10.0.0.2
      - 10.0.0.3
`;
    const dir = mkdtempSync(join(tmpdir(), "bridge-cfg-"));
    const path = join(dir, "cfg.yaml");
    writeFileSync(path, yamlText);
    try {
      const { pairings } = loadBridgeConfig(path);
      assert.deepEqual(pairings[0].wizIps, ["10.0.0.1"]);
      assert.deepEqual(pairings[1].wizIps, ["10.0.0.2", "10.0.0.3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HA loader defaults wizPort to 38899 when omitted", async () => {
    const { loadBridgeConfigFromOptions } = await import("../lib/bridge-core");
    const { pairings } = loadBridgeConfigFromOptions({
      pairings: [{ zone_id: 1, wiz_ips: ["10.0.0.1"] }],
    });
    assert.equal(pairings[0].wizPort, 38899);
  });

  test("HA loader falls back to 'Zone N' when name is omitted", async () => {
    const { loadBridgeConfigFromOptions } = await import("../lib/bridge-core");
    const { pairings } = loadBridgeConfigFromOptions({
      pairings: [{ zone_id: 42, wiz_ips: ["10.0.0.1"] }],
    });
    assert.equal(pairings[0].name, "Zone 42");
  });

  test("loadBridgeConfig throws when path does not exist", async () => {
    const { loadBridgeConfig } = await import("../lib/bridge-core");
    assert.throws(
      () => loadBridgeConfig("/nonexistent/path/to/config.yaml"),
      /Config not found/,
    );
  });
});
