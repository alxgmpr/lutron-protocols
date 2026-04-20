import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyOutputSetLevel,
  bodyOutputStartLowering,
  bodyOutputStartRaising,
  bodyOutputStopRaiseLower,
  OutputAction,
} from "../lib/ipl";

test("bodyOutputSetLevel emits #OUTPUT,id,1,pct\\n", () => {
  assert.equal(bodyOutputSetLevel(5, 50).toString("ascii"), "#OUTPUT,5,1,50\n");
});

test("bodyOutputSetLevel adds fade when given", () => {
  assert.equal(
    bodyOutputSetLevel(5, 50, { fadeSec: 2 }).toString("ascii"),
    "#OUTPUT,5,1,50,2\n",
  );
});

test("bodyOutputSetLevel adds fade and delay together", () => {
  assert.equal(
    bodyOutputSetLevel(5, 50, { fadeSec: 2, delaySec: 1 }).toString("ascii"),
    "#OUTPUT,5,1,50,2,1\n",
  );
});

test("bodyOutputStartRaising emits #OUTPUT,id,2\\n", () => {
  assert.equal(bodyOutputStartRaising(5).toString("ascii"), "#OUTPUT,5,2\n");
});

test("bodyOutputStartLowering emits #OUTPUT,id,3\\n", () => {
  assert.equal(bodyOutputStartLowering(5).toString("ascii"), "#OUTPUT,5,3\n");
});

test("bodyOutputStopRaiseLower emits #OUTPUT,id,4\\n", () => {
  assert.equal(bodyOutputStopRaiseLower(5).toString("ascii"), "#OUTPUT,5,4\n");
});

test("OutputAction codes match firmware jump table", () => {
  assert.equal(OutputAction.SetLevel, 1);
  assert.equal(OutputAction.StartRaising, 2);
  assert.equal(OutputAction.StartLowering, 3);
  assert.equal(OutputAction.StopRaiseLower, 4);
});
