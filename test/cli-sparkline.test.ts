import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type PacketRow, parseFilter } from "../cli/core/packets";
import { deviceStats, renderDevicePanel, spark } from "../cli/core/sparkline";

const row = (ts: string, device: string, rssi = ""): PacketRow => ({
  ts,
  proto: "A",
  protoColor: "",
  direction: rssi ? "RX" : "TX",
  dirColor: "",
  rssi,
  seq: "",
  opcode: "",
  typeAction: "",
  typeActionColor: "",
  device,
  zone: "",
  state: "",
  raw: "",
  delta: "",
});

test("spark: scales to range, clamps, NaN is a gap", () => {
  assert.equal(spark([0, 7, 14], 0, 14), "▁▅█");
  assert.equal(spark([-5, 99], 0, 10), "▁█");
  assert.equal(spark([1, Number.NaN, 1], 1, 1), "▁ ▁");
});

test("deviceStats: newest device first, per-device gaps, RSSI, filter", () => {
  const entries = [
    row("10:00:00.000", "AAAA", "-50"),
    row("10:00:00.075", "AAAA", "-40"),
    { text: "t" },
    row("10:00:01.000", "BBBB"),
    row("10:00:02.000", "AAAA", "-60"),
    row("10:00:03.000", ""),
  ];
  const [a, b] = deviceStats(entries, null, 5, 10);
  assert.equal(a.device, "AAAA"); // heard last
  assert.equal(a.count, 3);
  assert.deepEqual(a.gaps, [75, 1925]);
  assert.deepEqual(a.rssi, [-50, -40, -60]);
  assert.equal(b.device, "BBBB");
  assert.ok(Number.isNaN(b.rssi[0])); // TX: no RSSI
  assert.equal(deviceStats(entries, null, 1, 10).length, 1);
  assert.deepEqual(deviceStats(entries, null, 5, 2)[0].rssi, [-40, -60]);
  assert.deepEqual(
    deviceStats(entries, parseFilter("dev=bbbb"), 5, 10).map((d) => d.device),
    ["BBBB"],
  );
});

test("renderDevicePanel: header plus one line per device", () => {
  const stats = deviceStats(
    [row("10:00:00.000", "AAAA", "-50"), row("10:00:01.500", "AAAA", "-40")],
    null,
    5,
    8,
  );
  const [header, line] = renderDevicePanel(stats, 8).map((l) =>
    stripVTControlCharacters(l),
  );
  assert.match(header, /^DEVICE\s+PKTS\s+RSSI/);
  assert.match(line, /^A AAAA\s+2\s+▁█\s+-40\s+.\s+1\.5s$/);
});
