import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  getPacketLayout,
  type LogEntry,
  type PacketRow,
  parseFilter,
  visibleLines,
} from "../cli/core/packets";
import { Store } from "../cli/ui/store";

const row = (over: Partial<PacketRow>): PacketRow => ({
  ts: "00:00:00.000",
  proto: "A",
  protoColor: "",
  direction: "RX",
  dirColor: "",
  rssi: "-60",
  seq: "1",
  opcode: "81",
  typeAction: "BTN_SHORT_A",
  typeActionColor: "",
  device: "0595E68D",
  zone: "",
  state: "ON",
  raw: "81 01 02",
  delta: "",
  ...over,
});

const plain = (lines: string[]) =>
  lines.map((l) => stripVTControlCharacters(l).trim());

test("parseFilter: bare, field, negated terms are ANDed", () => {
  const a = row({ device: "0595E68D", typeAction: "BTN_SHORT_A" });
  const b = row({ proto: "X", device: "Kitchen", typeAction: "LEVEL" });
  assert.equal(parseFilter("0595")(a), true);
  assert.equal(parseFilter("0595")(b), false);
  assert.equal(parseFilter("proto=x")(b), true);
  assert.equal(parseFilter("-proto=x")(b), false);
  assert.equal(parseFilter("dev=kitch type=level")(b), true);
  assert.equal(parseFilter("dev=kitch type=btn")(b), false);
  assert.throws(() => parseFilter("bogus=1"), /unknown field 'bogus'/);
});

test("visibleLines: tail window, offset, verbose detail, filter keeps text", () => {
  const entries: LogEntry[] = [
    row({ device: "AAAA", verboseLine: "detail-a" }),
    { text: "text line" },
    row({ device: "BBBB" }),
  ];
  const quiet = getPacketLayout(true, 160, false);
  const verbose = getPacketLayout(true, 160, true);

  let out = plain(visibleLines(entries, quiet, null, 10, 0));
  assert.equal(out.length, 3);
  assert.match(out[0], /AAAA/);

  out = plain(visibleLines(entries, verbose, null, 10, 0));
  assert.equal(out.length, 4);
  assert.equal(out[1], "detail-a");

  // Offset 1 drops the newest line; height 2 keeps the two above it.
  out = plain(visibleLines(entries, verbose, null, 2, 1));
  assert.deepEqual(out, ["detail-a", "text line"]);

  out = plain(visibleLines(entries, quiet, parseFilter("dev=bbbb"), 10, 0));
  assert.equal(out.length, 2);
  assert.equal(out[0], "text line");
  assert.match(out[1], /BBBB/);
});

test("raw off: row with no decoded state shows its hex in STATE", () => {
  const layout = getPacketLayout(false, 160, false);
  const [line] = plain(
    visibleLines([row({ state: "", raw: "de ad" })], layout, null, 1, 0),
  );
  assert.match(line, /de ad/);
});

test("Store: scrolled-back viewport holds still as filtered packets arrive", () => {
  const s = new Store();
  for (let i = 0; i < 20; i++) s.append([row({ device: `D${i}` })]);
  s.setFilter("dev=d1");
  s.scrollBy(-1, 3);
  const before = s.getState().scrollOffset;
  s.append([row({ device: "ZZZ" })]); // hidden by filter: no shift
  assert.equal(s.getState().scrollOffset, before);
  s.append([row({ device: "D1x" }), { text: "text" }]); // 2 visible lines
  assert.equal(s.getState().scrollOffset, before - 2);
  s.setDisplay({ verbose: true });
  assert.equal(s.getState().scrollOffset, 0);
  assert.throws(() => s.setFilter("nope=1"));
  assert.equal(s.getState().filter?.spec, "dev=d1");
});
