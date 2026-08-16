/**
 * Nucleo status blob parser — tests.
 *
 * The blob is built by send_status_response() in firmware/src/net/stream.cpp.
 * Layout drift there is silent, so the second suite reads that file and asserts
 * the offsets against it rather than trusting a hand-copied table.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseNucleoStatus,
  STATUS_BLOB_V1_SIZE,
  STATUS_BLOB_V2_SIZE,
  STATUS_FIELD_OFFSETS,
} from "../lib/nucleo-status";

const STREAM_CPP = fileURLToPath(
  new URL("../firmware/src/net/stream.cpp", import.meta.url),
);

/** Build a v2-sized blob with a distinct value at every documented offset. */
function buildBlob(overrides: Record<number, number> = {}, size = 112): Buffer {
  const blob = Buffer.alloc(size);
  for (const [off, val] of Object.entries(overrides)) {
    const o = Number(off);
    // Byte-wide fields live at 40..43; everything else is u32 LE.
    if (o >= 40 && o <= 43) blob[o] = val;
    else blob.writeUInt32LE(val >>> 0, o);
  }
  return blob;
}

describe("parseNucleoStatus", () => {
  it("parses the v1 core counters", () => {
    const status = parseNucleoStatus(
      buildBlob({
        0: 123456, // uptime_ms
        4: 900, // cca_rx
        8: 12, // cca_tx
        12: 3, // cca_drop
        16: 7, // cca_crc_fail
        20: 5, // cca_n81_err
        24: 2, // cc1101_overflow
        28: 4, // cc1101_runt
        32: 400, // ccx_rx
        36: 9, // ccx_tx
        44: 65536, // heap_free
      }),
    );

    assert.ok(status);
    assert.equal(status.uptimeMs, 123456);
    assert.equal(status.ccaRx, 900);
    assert.equal(status.ccaTx, 12);
    assert.equal(status.ccaDrop, 3);
    assert.equal(status.ccaCrcFail, 7);
    assert.equal(status.ccaN81Err, 5);
    assert.equal(status.cc1101Overflow, 2);
    assert.equal(status.cc1101Runt, 4);
    assert.equal(status.ccxRx, 400);
    assert.equal(status.ccxTx, 9);
    assert.equal(status.heapFree, 65536);
  });

  it("decodes the byte-wide link and role fields", () => {
    const status = parseNucleoStatus(buildBlob({ 40: 1, 41: 4, 42: 1, 43: 3 }));

    assert.ok(status);
    assert.equal(status.ccxThreadJoined, true);
    assert.equal(status.ccxThreadRole, 4);
    assert.equal(status.ethLinkUp, true);
    assert.equal(status.numClients, 3);
  });

  it("reports a down link and an unjoined mesh as false, not zero", () => {
    const status = parseNucleoStatus(buildBlob({ 40: 0, 42: 0 }));

    assert.ok(status);
    assert.equal(status.ccxThreadJoined, false);
    assert.equal(status.ethLinkUp, false);
  });

  it("parses the v2 radio telemetry", () => {
    const status = parseNucleoStatus(
      buildBlob({
        48: 11, // rx_restart_timeout
        52: 12, // rx_restart_overflow
        56: 13, // rx_restart_manual
        60: 14, // rx_restart_packet
        64: 950, // sync_peek_hit
        68: 50, // sync_peek_miss
        72: 256, // ring_max_occupancy
        76: 40000, // ring_bytes_in
        80: 128, // ring_bytes_dropped
        84: 21, // cca_ack
        88: 22, // cca_crc_optional
        92: 1000, // cca_irq
        96: 30, // isr_latency_min_us
        100: 90, // isr_latency_p95_us
        104: 400, // isr_latency_max_us
        108: 512, // isr_latency_samples
      }),
    );

    assert.ok(status?.radio);
    assert.deepEqual(status.radio, {
      rxRestartTimeout: 11,
      rxRestartOverflow: 12,
      rxRestartManual: 13,
      rxRestartPacket: 14,
      syncHit: 950,
      syncMiss: 50,
      ringMaxOccupancy: 256,
      ringBytesIn: 40000,
      ringBytesDropped: 128,
      ccaAck: 21,
      ccaCrcOptional: 22,
      ccaIrq: 1000,
      isrLatencyMinUs: 30,
      isrLatencyP95Us: 90,
      isrLatencyMaxUs: 400,
      isrLatencySamples: 512,
    });
  });

  it("returns null radio telemetry when the firmware predates the v2 blob", () => {
    const status = parseNucleoStatus(
      buildBlob({ 4: 900 }, STATUS_BLOB_V1_SIZE),
    );

    assert.ok(status);
    assert.equal(status.ccaRx, 900);
    assert.equal(status.radio, null);
  });

  it("rejects a blob too short to hold the core counters", () => {
    assert.equal(
      parseNucleoStatus(buildBlob({}, STATUS_BLOB_V1_SIZE - 1)),
      null,
    );
  });

  it("exposes the blob sizes the firmware emits", () => {
    assert.equal(STATUS_BLOB_V1_SIZE, 48);
    assert.equal(STATUS_BLOB_V2_SIZE, 112);
  });
});

/**
 * The counters are append-only in firmware and nothing links the two sides at
 * compile time. These read stream.cpp so a new counter, a renumbered offset or
 * a resized blob fails here instead of silently decoding as garbage.
 */
describe("status blob layout vs firmware", () => {
  const source = readFileSync(STREAM_CPP, "utf8");

  /** Every offset send_status_response() writes, from the source itself. */
  function firmwareOffsets(): number[] {
    const body = source.slice(
      source.indexOf("static void send_status_response("),
    );
    const end = body.indexOf("\n}");
    const fn = body.slice(0, end);

    const offsets = new Set<number>();
    for (const m of fn.matchAll(/put_le32\(blob \+ (\d+),/g)) {
      offsets.add(Number(m[1]));
    }
    for (const m of fn.matchAll(/blob\[(\d+)\]\s*=/g)) {
      offsets.add(Number(m[1]));
    }
    return [...offsets].sort((a, b) => a - b);
  }

  it("reads every offset the firmware writes, and no others", () => {
    const expected = firmwareOffsets();
    const actual = [...new Set(Object.values(STATUS_FIELD_OFFSETS))].sort(
      (a, b) => a - b,
    );

    // Guard against the regex silently matching nothing.
    assert.ok(
      expected.length >= 25,
      `only found ${expected.length} offsets in stream.cpp — parser regex is stale`,
    );
    assert.deepEqual(actual, expected);
  });

  it("matches the firmware's STATUS_BLOB_SIZE", () => {
    const m = source.match(/#define STATUS_BLOB_SIZE (\d+)/);
    assert.ok(m, "STATUS_BLOB_SIZE not found in stream.cpp");
    assert.equal(STATUS_BLOB_V2_SIZE, Number(m[1]));
  });
});
