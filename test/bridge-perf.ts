#!/usr/bin/env npx tsx
/**
 * Bridge performance test — measures latency from handlePacket() to WiZ UDP send.
 * Run: npx tsx test/bridge-perf.ts
 */

import { createSocket } from "dgram";
import type { CCXPacket } from "../ccx/types";
import { BridgeCore } from "../lib/bridge-core";

function makeLevelControlPacket(
  zoneId: number,
  level: number,
  fade: number,
  seq: number,
): CCXPacket {
  const levelRaw = Math.round((level * 0xfeff) / 100);
  const inner: Record<number, unknown> = { 0: levelRaw, 3: fade };
  return {
    timestamp: new Date().toISOString(),
    srcAddr: "fd00::1",
    dstAddr: "ff03::1",
    srcEui64: "",
    dstEui64: "",
    msgType: 0,
    body: { 0: inner, 1: [16, zoneId], 5: seq },
    parsed: {
      type: "LEVEL_CONTROL",
      level: levelRaw,
      levelPercent: level,
      zoneType: 16,
      zoneId,
      fade,
      delay: 0,
      sequence: seq,
      rawBody: { 0: inner, 1: [16, zoneId], 5: seq },
    },
    rawHex: "",
  };
}

function makeButtonPressPacket(presetId: number, seq: number): CCXPacket {
  const hi = (presetId >> 8) & 0xff;
  const lo = presetId & 0xff;
  const deviceId = new Uint8Array([hi, lo, 0xef, 0x20]);
  return {
    timestamp: new Date().toISOString(),
    srcAddr: "fd00::1",
    dstAddr: "ff03::1",
    srcEui64: "",
    dstEui64: "",
    msgType: 1,
    body: { 0: { 0: deviceId, 1: [1, 2, 3] }, 5: seq },
    parsed: {
      type: "BUTTON_PRESS",
      deviceId,
      buttonZone: lo,
      cmdType: hi,
      counters: [1, 2, 3],
      sequence: seq,
      rawBody: { 0: { 0: deviceId, 1: [1, 2, 3] }, 5: seq },
    },
    rawHex: "",
  };
}

// ── Intercept UDP sends to measure timing ────────────────

const sendTimes: number[] = [];
let firstSendTime = 0;

const realCreateSocket = createSocket;

async function main() {
  // Create bridge with a real pairing (but fake IP)
  const bridge = new BridgeCore({
    pairings: [
      {
        name: "Test Zone A",
        zoneId: 3978,
        wizIps: ["127.0.0.1"],
        wizPort: 19999,
      },
      {
        name: "Test Zone B",
        zoneId: 8238,
        wizIps: ["127.0.0.1"],
        wizPort: 19999,
      },
    ],
    presetZones: new Map([
      [
        4163,
        {
          name: "On [Hallway Table]",
          zones: {
            "3978": { level: 100, fade: 1 },
            "8238": { level: 100, fade: 1 },
          },
        },
      ],
    ]),
    watchedZones: new Set([3978, 8238]),
  });

  // Suppress log spam
  bridge.on("log", () => {});

  // Listen for UDP sends on a local socket
  const listener = realCreateSocket("udp4");
  listener.bind(19999, "127.0.0.1");

  listener.on("message", () => {
    const now = performance.now();
    if (firstSendTime === 0) firstSendTime = now;
    sendTimes.push(now);
  });

  // Wait for socket to bind
  await new Promise<void>((r) => listener.once("listening", r));

  console.log("=== Bridge Performance Test ===\n");

  // ── Test 1: Instant LEVEL_CONTROL ──────────────────────
  {
    sendTimes.length = 0;
    firstSendTime = 0;
    const t0 = performance.now();
    bridge.handlePacket(makeLevelControlPacket(3978, 100, 1, 1));
    const dispatchTime = performance.now() - t0;

    // Wait for tick to fire and UDP to arrive
    await new Promise((r) => setTimeout(r, 200));

    console.log(`Test 1: Instant LEVEL_CONTROL (fade=1)`);
    console.log(`  dispatch() time:     ${dispatchTime.toFixed(2)}ms`);
    console.log(`  UDP send count:      ${sendTimes.length}`);
    if (sendTimes.length > 0) {
      console.log(
        `  dispatch→UDP delay:  ${(sendTimes[0] - (t0 + dispatchTime - dispatchTime)).toFixed(2)}ms`,
      );
      console.log(`  total (call→UDP):    ${(sendTimes[0] - t0).toFixed(2)}ms`);
    }
    console.log("");
  }

  // ── Test 2: BUTTON_PRESS (2 zones) ─────────────────────
  {
    sendTimes.length = 0;
    firstSendTime = 0;
    const t0 = performance.now();
    bridge.handlePacket(makeButtonPressPacket(4163, 2));
    const dispatchTime = performance.now() - t0;

    await new Promise((r) => setTimeout(r, 200));

    console.log(`Test 2: BUTTON_PRESS → 2 zones (instant preset)`);
    console.log(`  dispatch() time:     ${dispatchTime.toFixed(2)}ms`);
    console.log(`  UDP send count:      ${sendTimes.length}`);
    if (sendTimes.length > 0) {
      console.log(
        `  first UDP at:        +${(sendTimes[0] - t0).toFixed(2)}ms`,
      );
      if (sendTimes.length > 1) {
        console.log(
          `  last UDP at:         +${(sendTimes[sendTimes.length - 1] - t0).toFixed(2)}ms`,
        );
        console.log(
          `  inter-zone gap:      ${(sendTimes[1] - sendTimes[0]).toFixed(2)}ms`,
        );
      }
    }
    console.log("");
  }

  // ── Test 3: Faded LEVEL_CONTROL ────────────────────────
  {
    sendTimes.length = 0;
    firstSendTime = 0;
    const t0 = performance.now();
    bridge.handlePacket(makeLevelControlPacket(3978, 50, 4, 3)); // 1 second fade
    const dispatchTime = performance.now() - t0;

    // Wait for fade to complete + margin
    await new Promise((r) => setTimeout(r, 1500));

    console.log(`Test 3: Faded LEVEL_CONTROL (fade=4, 1s)`);
    console.log(`  dispatch() time:     ${dispatchTime.toFixed(2)}ms`);
    console.log(`  UDP send count:      ${sendTimes.length}`);
    if (sendTimes.length > 0) {
      console.log(
        `  first UDP at:        +${(sendTimes[0] - t0).toFixed(2)}ms`,
      );
      console.log(
        `  last UDP at:         +${(sendTimes[sendTimes.length - 1] - t0).toFixed(2)}ms`,
      );
      const intervals = sendTimes.slice(1).map((t, i) => t - sendTimes[i]);
      if (intervals.length > 0) {
        const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        console.log(`  avg tick interval:   ${avg.toFixed(1)}ms`);
      }
    }
    console.log("");
  }

  // ── Test 4: Rapid-fire (simulating Thread retransmissions) ──
  {
    sendTimes.length = 0;
    firstSendTime = 0;
    const t0 = performance.now();
    // 15 copies of the same packet (same seq) — should dedup to 1
    for (let i = 0; i < 15; i++) {
      bridge.handlePacket(makeLevelControlPacket(8238, 75, 1, 10));
    }
    const dispatchTime = performance.now() - t0;

    await new Promise((r) => setTimeout(r, 200));

    console.log(`Test 4: 15x duplicate packets (seq=10, dedup test)`);
    console.log(`  total dispatch time: ${dispatchTime.toFixed(2)}ms`);
    console.log(`  UDP send count:      ${sendTimes.length} (should be 1)`);
    console.log("");
  }

  bridge.destroy();
  listener.close();
  console.log("Done.");
}

main().catch(console.error);
