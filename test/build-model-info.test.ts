import assert from "node:assert/strict";
import test from "node:test";
import { buildModelInfoOutput, parseModelInfo } from "../lib/build-model-info";

test("parseModelInfo ignores headers and malformed rows", () => {
  const parsed = parseModelInfo(`
MODEL|NAME
-----|-----
461|RRD-3LD
bad|ignored
462|RRD-PRO
`);

  assert.deepEqual(parsed, [
    { id: 461, name: "RRD-3LD" },
    { id: 462, name: "RRD-PRO" },
  ]);
});

test("buildModelInfoOutput sorts models and groups duplicate names", () => {
  const output = buildModelInfoOutput(
    [
      { id: 9, name: "B" },
      { id: 2, name: "A" },
      { id: 5, name: "B" },
    ],
    { extractedAt: "2026-03-19T00:00:00.000Z", version: "test-version" },
  );

  assert.deepEqual(output.models, [
    { id: 2, name: "A" },
    { id: 9, name: "B" },
    { id: 5, name: "B" },
  ]);
  assert.deepEqual(output.duplicateNames, [{ name: "B", ids: [5, 9] }]);
  assert.equal(output._version, "test-version");
});
