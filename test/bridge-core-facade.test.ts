/**
 * BridgeCore is now a composition over DeviceModel + CcxSource + sinks. These
 * tests pin the seams the façade is responsible for: which pieces get wired,
 * what the counters mean, and the order log lines come out in.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { CCXPacket } from "../ccx/types";
import type {
  BridgeSink,
  CommandEvent,
  SinkHost,
  ZoneChangedEvent,
} from "../lib/bridge/types";

function makeLevelControlPacket(opts: {
  zoneId: number;
  level?: number;
  fade?: number;
  sequence?: number;
}): CCXPacket {
  const level = opts.level ?? 50;
  const inner: Record<number, unknown> = {
    0: Math.round((level * 0xfeff) / 100),
    3: opts.fade ?? 1,
  };
  return {
    timestamp: "2026-08-15T12:00:00.000Z",
    srcAddr: "fd00::1",
    dstAddr: "ff03::1",
    srcEui64: "",
    dstEui64: "",
    msgType: 0,
    body: { 0: inner, 1: [16, opts.zoneId], 5: opts.sequence ?? 0 },
    parsed: {
      type: "LEVEL_CONTROL",
      level: inner[0] as number,
      levelPercent: level,
      zoneType: 16,
      zoneId: opts.zoneId,
      fade: opts.fade ?? 1,
      delay: 0,
      sequence: opts.sequence ?? 0,
      rawBody: { 0: inner, 1: [16, opts.zoneId], 5: opts.sequence ?? 0 },
    },
    rawHex: "",
  };
}

async function makeBridge(pairings: Array<{ zoneId: number; name?: string }>) {
  const { BridgeCore } = await import("../lib/bridge-core");
  const built = pairings.map((p) => ({
    name: p.name ?? `Zone ${p.zoneId}`,
    zoneId: p.zoneId,
    wizIps: [] as string[],
    wizPort: 38899,
  }));
  return new BridgeCore({
    pairings: built,
    presetZones: new Map(),
    watchedZones: new Set(built.map((p) => p.zoneId)),
  });
}

describe("BridgeCore composition", () => {
  test("logs the raw packet before the command it resolved to", async () => {
    // The packet line has always come first. The model resolves the command
    // synchronously inside apply(), so the façade has to keep that order.
    const bridge = await makeBridge([{ zoneId: 100 }]);
    const lines: string[] = [];
    bridge.on("log", (m: string) => lines.push(m));

    bridge.handlePacket(makeLevelControlPacket({ zoneId: 100, level: 75 }));

    const packetLine = lines.findIndex((l) => l.includes("LEVEL_CONTROL"));
    const commandLine = lines.findIndex((l) => l.includes("** LEVEL"));
    assert.ok(packetLine >= 0, "packet line missing");
    assert.ok(commandLine >= 0, "command line missing");
    assert.ok(
      packetLine < commandLine,
      `packet line (${packetLine}) should precede command line (${commandLine})`,
    );
    bridge.destroy();
  });

  test("packetCount counts packets and matchCount counts driven zones", async () => {
    const bridge = await makeBridge([{ zoneId: 100 }]);

    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 10, sequence: 1 }),
    );
    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 100, level: 10, sequence: 1 }),
    ); // duplicate
    bridge.handlePacket(
      makeLevelControlPacket({ zoneId: 999, level: 10, sequence: 2 }),
    ); // unwatched

    assert.equal(bridge.packetCount, 3);
    assert.equal(bridge.matchCount, 1);
    bridge.destroy();
  });

  test("exposes the model so another sink can be added without touching it", async () => {
    const bridge = await makeBridge([{ zoneId: 100 }]);

    const seen: ZoneChangedEvent[] = [];
    const commands: CommandEvent[] = [];
    const sink: BridgeSink = {
      name: "test",
      attach(model: SinkHost) {
        model.on("zone:changed", (e) => seen.push(e));
        model.on("command", (e) => commands.push(e));
      },
      detach() {},
    };
    bridge.addSink(sink);

    bridge.handlePacket(makeLevelControlPacket({ zoneId: 100, level: 75 }));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].zoneId, 100);
    assert.equal(seen[0].level, 75);
    assert.equal(commands.length, 1);
    bridge.destroy();
  });

  test("warm dim configured on a pairing reaches the model", async () => {
    const { BridgeCore } = await import("../lib/bridge-core");
    const bridge = new BridgeCore({
      pairings: [
        {
          name: "Warm",
          zoneId: 100,
          wizIps: [],
          wizPort: 38899,
          warmDimCurve: "halogen",
        },
      ],
      presetZones: new Map(),
      watchedZones: new Set([100]),
    });

    bridge.handlePacket(makeLevelControlPacket({ zoneId: 100, level: 30 }));

    const zone = bridge.getZoneState(100);
    assert.ok(zone);
    assert.equal(zone.colorMode, "cct");
    assert.ok(zone.cct, "warm dim curve should have produced a cct");
    bridge.destroy();
  });
});
