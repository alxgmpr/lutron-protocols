import assert from "node:assert/strict";
import test from "node:test";
import { entryAtLine, type PacketRow } from "../cli/core/packets";
import { Store } from "../cli/ui/store";
import { parseMouse } from "../cli/ui/useLineEditor";

const row = (device: string, verboseLine?: string): PacketRow => ({
  ts: "00:00:00.000",
  proto: "A",
  protoColor: "",
  direction: "RX",
  dirColor: "",
  rssi: "",
  seq: "",
  opcode: "",
  typeAction: "",
  typeActionColor: "",
  device,
  zone: "",
  state: "",
  raw: "",
  delta: "",
  verboseLine,
});

test("parseMouse: SGR press/release, several per chunk, keys are not mouse", () => {
  // Ink hands over the first report with its ESC stripped.
  assert.deepEqual(parseMouse("[<0;12;5M\x1b[<65;1;2m"), [
    { button: 0, x: 12, y: 5, press: true },
    { button: 65, x: 1, y: 2, press: false },
  ]);
  assert.deepEqual(parseMouse("[A"), []);
});

test("entryAtLine: counts verbose lines, skips filtered, null past oldest", () => {
  const a = row("AAAA", "detail");
  const b = row("BBBB");
  const c = row("CCCC");
  const entries = [a, { text: "t" }, b, c];
  assert.equal(entryAtLine(entries, false, null, 0), c);
  assert.equal(entryAtLine(entries, false, null, 2), entries[1]);
  assert.equal(entryAtLine(entries, true, null, 4), a); // a's verbose line
  assert.equal(entryAtLine(entries, true, null, 5), null);
  const notB = (r: PacketRow) => r !== b;
  assert.equal(entryAtLine(entries, false, notB, 1), entries[1]);
});

test("Store: clicked row stays in view; scroll stops at the oldest line", () => {
  const s = new Store();
  const rows = Array.from({ length: 10 }, (_, i) => row(`D${i}`));
  s.append(rows);
  s.selectRow(rows[2], 3); // 7 lines below it
  assert.equal(s.getState().selected, rows[2]);
  assert.equal(s.getState().scrollOffset, -5);

  s.clearSelection();
  s.scrollToLive();
  for (let i = 0; i < 10; i++) s.scrollBy(-1, 3, 4);
  assert.equal(s.getState().scrollOffset, -6); // 10 lines, window of 4
});
