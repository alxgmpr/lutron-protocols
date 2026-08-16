/**
 * CCA decode-coverage regression.
 *
 * Replays the committed corpus and fails if this push decodes less than the
 * last one did. No radio involved, so unlike capture-rate this runs in CI.
 *
 * The corpus is redacted (tools/cca/build-corpus.ts); the assertions below
 * that check redaction are the ones that still work without the secret
 * inventory, so a rebuild that forgot to redact fails here rather than in a
 * public commit.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { summarizeDecode } from "../lib/capture-metrics";
import { REDACTED_ID } from "../lib/capture-redact";
import { decodeCcaFrame } from "../lib/cca-decode-adapter";
import { identifyPacket } from "../protocol/protocol-ui";

const read = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)),
    "utf8",
  );

const corpus: Buffer[] = read("cca-corpus.jsonl")
  .trim()
  .split("\n")
  .map((line) => Buffer.from(JSON.parse(line).hex, "hex"));

const baseline = JSON.parse(read("cca-corpus-baseline.json"));

const frames = corpus.map(decodeCcaFrame);
const summary = summarizeDecode(frames);
const total = (key: "fieldsDefined" | "fieldsPresent" | "fieldsNamed") =>
  frames.reduce((a, f) => a + f[key], 0);

describe("CCA decode coverage", () => {
  it("still holds every frame the baseline was taken over", () => {
    assert.equal(
      summary.frames,
      baseline.frames,
      "corpus changed size — rerun tools/cca/build-corpus.ts and review the baseline",
    );
  });

  it("identifies at least as many frames as the baseline", () => {
    assert.ok(
      summary.identified >= baseline.identified,
      `identified ${summary.identified} < baseline ${baseline.identified}`,
    );
  });

  it("leaves no more frames unidentified than the baseline", () => {
    assert.ok(
      summary.unidentified <= baseline.unidentified,
      `unidentified ${summary.unidentified} > baseline ${baseline.unidentified}`,
    );
  });

  it("decodes at least as many fields to a symbolic value", () => {
    // The number this ticket exists to protect: a refactor that stops parsing
    // a field moves this and nothing else.
    assert.ok(
      total("fieldsNamed") >= baseline.fieldsNamed,
      `fieldsNamed ${total("fieldsNamed")} < baseline ${baseline.fieldsNamed}`,
    );
  });

  it("reads every field the baseline could reach", () => {
    assert.ok(
      total("fieldsPresent") >= baseline.fieldsPresent,
      `fieldsPresent ${total("fieldsPresent")} < baseline ${baseline.fieldsPresent}`,
    );
  });

  it("never drops a message type the baseline knew about", () => {
    const missing = Object.keys(baseline.byType).filter(
      (type) => !(type in summary.byType),
    );
    assert.deepEqual(missing, [], `types no longer produced: ${missing}`);
  });
});

describe("corpus redaction", () => {
  it("carries only the placeholder in every device_id field", () => {
    const offenders: string[] = [];

    for (const frame of corpus) {
      const info = identifyPacket(frame);
      if (info.category === "unknown") continue;

      for (const field of info.fields) {
        if (!/device_id/.test(String(field.format))) continue;
        if (field.offset + field.size > frame.length) continue;

        const span = frame.subarray(field.offset, field.offset + field.size);
        const expected = Buffer.alloc(field.size);
        for (let i = 0; i < field.size; i++) {
          expected[i] = REDACTED_ID[i % REDACTED_ID.length];
        }
        if (!span.equals(expected)) {
          offenders.push(
            `${info.typeName}@${field.offset}=${span.toString("hex")}`,
          );
        }
      }
    }

    assert.deepEqual(
      offenders.slice(0, 5),
      [],
      `${offenders.length} device_id field(s) not redacted`,
    );
  });

  it("keeps nothing but type, format and length of an unidentified frame", () => {
    const offenders: string[] = [];

    for (const frame of corpus) {
      if (identifyPacket(frame).category !== "unknown") continue;

      for (let i = 1; i < frame.length; i++) {
        if (i === 7) continue; // format byte is deliberately kept
        if (frame[i] !== 0) {
          offenders.push(`${frame.toString("hex")}@${i}`);
          break;
        }
      }
    }

    assert.deepEqual(
      offenders.slice(0, 5),
      [],
      `${offenders.length} unidentified frame(s) retain body bytes`,
    );
  });
});
