import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { classifyTagReuse, type SubscribeLog } from "../lib/subscribe-log";

const log = (tag: string, frameTags: (string | undefined)[]): SubscribeLog => ({
  url: "/zone/status",
  requestTag: tag,
  subscribeStatus: "200 OK",
  frames: frameTags.map((t, i) => ({
    seq: i,
    receivedMsAfterSubscribe: i * 100,
    communiqueType: "ReadResponse",
    header: t === undefined ? {} : { ClientTag: t },
  })),
});

describe("classifyTagReuse", () => {
  test("reports no-frames when nothing arrived", () => {
    assert.equal(classifyTagReuse(log("7", [])), "no-frames");
  });

  test("reports reuses when every frame carries the request tag", () => {
    assert.equal(classifyTagReuse(log("7", ["7", "7"])), "reuses");
  });

  test("reports does-not-reuse when a frame lacks the tag", () => {
    assert.equal(
      classifyTagReuse(log("7", ["7", undefined])),
      "does-not-reuse",
    );
  });

  test("reports does-not-reuse when a frame carries a different tag", () => {
    assert.equal(classifyTagReuse(log("7", ["9"])), "does-not-reuse");
  });
});
