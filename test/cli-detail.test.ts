import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ccaSpans, fmtCbor, hexDump, renderDetail } from "../cli/core/detail";
import {
  CYAN,
  DIM,
  getPacketLayout,
  INVERSE,
  type PacketRow,
  visibleLines,
} from "../cli/core/packets";
import { Store } from "../cli/ui/store";

// DIM_STEP from the CCA corpus (synthetic deadbeef IDs).
const DIM_STEP = Uint8Array.from(
  Buffer.from("8007deadbeef210b00deadbeefef40002000deadbeef3661", "hex"),
);

const row = (over: Partial<PacketRow>): PacketRow => ({
  ts: "00:00:00.000",
  proto: "A",
  protoColor: "",
  direction: "RX",
  dirColor: "",
  rssi: "",
  seq: "",
  opcode: "",
  typeAction: "DIM_STEP",
  typeActionColor: "",
  device: "",
  zone: "",
  state: "",
  raw: "",
  delta: "",
  ...over,
});

test("ccaSpans: protocol field layout, decoded values, clipped to length", () => {
  const spans = ccaSpans(DIM_STEP);
  const src = spans.find((s) => s.name === "source_id");
  assert.deepEqual(
    { offset: src?.offset, size: src?.size },
    { offset: 2, size: 4 },
  );
  assert.match(src?.value ?? "", /DEADBEEF/i);
  // Truncated (format byte kept, so same type): fields past the end drop,
  // target_id@9+4 straddles the end and clips to 2.
  const short = ccaSpans(DIM_STEP.slice(0, 11));
  assert.equal(short.at(-1)?.name, "target_id");
  assert.equal(short.at(-1)?.size, 2);
  assert.ok(short.every((s) => s.offset < 11));
});

test("hexDump: bytes take their field's colour, uncovered bytes are dim", () => {
  const spans = [{ name: "a", offset: 1, size: 2, value: "", color: CYAN }];
  const [line] = hexDump(Uint8Array.of(0x10, 0x20, 0x30, 0x40), spans, 80);
  assert.ok(line.includes(`${DIM}10`));
  assert.ok(line.includes(`${CYAN}20`) && line.includes(`${CYAN}30`));
  assert.ok(line.includes(`${DIM}40`));
  assert.equal(hexDump(new Uint8Array(24), [], 80).length, 2); // 16 per line
  assert.equal(hexDump(new Uint8Array(24), [], 40).length, 3); // 8 when narrow
});

test("renderDetail: CCA shows hex and fields; CCX decodes CBOR", () => {
  const cca = renderDetail(row({ bytes: DIM_STEP }), 120)
    .map((l) => stripVTControlCharacters(l))
    .join("\n");
  assert.match(cca, /^CCA DIM_STEP/);
  assert.match(cca, /00 {2}80 07 de ad be ef/);
  assert.match(cca, /target_id/);

  // [0, {1: h'0102', 3: 4}]
  const ccx = renderDetail(
    row({ proto: "X", bytes: Buffer.from("8200a2014201020304", "hex") }),
    120,
  ).map((l) => stripVTControlCharacters(l));
  assert.ok(ccx.includes(`[0,{1:h'0102',3:4}]`), ccx.join("\n"));
  assert.match(
    stripVTControlCharacters(renderDetail(row({}), 80)[0]),
    /no bytes captured/,
  );
});

test("fmtCbor: byte strings and bigints survive JSON.stringify", () => {
  assert.equal(
    fmtCbor({ 1: Buffer.from([0xab]), 2: 2n ** 70n }),
    `{1:h'ab',2:"0x400000000000000000"}`,
  );
});

test("Store selection: newest first, steps over text/filtered, stays in view", () => {
  const s = new Store();
  const a = row({ device: "AAAA" });
  const b = row({ device: "BBBB" });
  const c = row({ device: "CCCC" });
  s.append([a, { text: "t" }, b, c]);
  s.setFilter("-dev=bbbb");
  s.moveSelection(0, 10);
  assert.equal(s.getState().selected, c);
  s.moveSelection(-1, 10);
  assert.equal(s.getState().selected, a); // skipped text line and filtered b
  s.moveSelection(-5, 10);
  assert.equal(s.getState().selected, a); // clamped

  // Window of 1 line: selecting `a` must scroll it to the bottom line.
  s.moveSelection(0, 1);
  assert.equal(s.getState().scrollOffset, -2); // "t" and c below it

  // Arrivals while selecting don't move the viewport.
  s.append([row({ device: "DDDD" })]);
  assert.equal(s.getState().scrollOffset, -3);

  const layout = getPacketLayout(true, 160, false);
  const [line] = visibleLines(
    s.getState().entries,
    layout,
    s.getState().filter?.match ?? null,
    1,
    3,
    a,
  );
  assert.ok(line.startsWith(INVERSE));
  s.clearSelection();
  assert.equal(s.getState().selected, null);
});
