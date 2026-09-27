import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeLevelControl, encodeMessage } from "../ccx/encoder";
import {
  bitsToBytes,
  buildOtaPacket,
  bytesToBits,
  crc16,
  parseOtaPacket,
} from "../lib/cca-ota-codec";
import { percentToLevel16, qsToSeconds, secondsToQs } from "../protocol/shared";
import {
  checkLeapDetach,
  checkLeapSubscriptionReuse,
  checkLeapTagReuse,
  checkLeapTrace,
} from "./lean/check-leap";

const cwd = fileURLToPath(new URL("../verification/lean/", import.meta.url));
const elanLake = join(homedir(), ".elan", "bin", "lake");
const lake = existsSync(elanLake) ? elanLake : "lake";
execFileSync(lake, ["build"], { cwd, stdio: "inherit", timeout: 120_000 });
const output = execFileSync(join(cwd, ".lake", "build", "bin", "vectors"), {
  cwd,
  encoding: "utf8",
  timeout: 30_000,
});
const counts = {
  level: 0,
  fade: 0,
  bits: 0,
  cca: 0,
  ccx: 0,
  leap: 0,
  batch: 0,
  reset: 0,
  detach: 0,
};
const numbers = (s: string) => (s === "" ? [] : s.split(",").map(Number));
const allBits: number[] = [];
const allBytes: number[] = [];
for (const line of output.trim().split("\n")) {
  const [kind, input, expected, decoded] = line.split("\t");
  const value = Number(input);
  switch (kind) {
    case "level":
      assert.equal(value, counts.level++);
      assert.equal(percentToLevel16(value), Number(expected), line);
      break;
    case "fade":
      assert.equal(value, counts.fade++);
      assert.equal(secondsToQs(qsToSeconds(value)), Number(expected), line);
      assert.equal(qsToSeconds(value), value / 4, line);
      break;
    case "bits": {
      assert.equal(value, counts.bits++);
      const bits = expected.split(",").map(Number);
      assert.deepEqual(
        Array.from(bytesToBits(Uint8Array.of(value))),
        bits,
        line,
      );
      assert.deepEqual(Array.from(bitsToBytes(Uint8Array.from(bits))), [
        Number(decoded),
      ]);
      allBits.push(...bits);
      allBytes.push(value);
      break;
    }
    case "cca": {
      assert.equal(value, counts.cca++);
      const body = Uint8Array.from(numbers(expected));
      const wire = Uint8Array.from(numbers(decoded));
      assert.deepEqual(
        buildOtaPacket(value, body),
        wire,
        `CCA opcode ${value}`,
      );
      const packet = wire.subarray(6);
      assert.equal(
        crc16(packet.subarray(0, -2)),
        (packet.at(-2)! << 8) | packet.at(-1)!,
      );
      const parsed = { ok: true, opcode: value, body, consumed: packet.length };
      assert.deepEqual(parseOtaPacket(packet), parsed);
      assert.deepEqual(
        parseOtaPacket(Uint8Array.from([...packet, 0xfa, 0xde, 0])),
        parsed,
      );
      for (let length = 0; length < packet.length; length++) {
        assert.equal(parseOtaPacket(packet.subarray(0, length)).ok, false);
      }
      const corrupt = packet.slice();
      corrupt[corrupt.length - 1] ^= 1;
      assert.equal(parseOtaPacket(corrupt).ok, false);
      assert.equal(
        parseOtaPacket(Uint8Array.from([0, ...packet.subarray(1)])).ok,
        false,
      );
      break;
    }
    case "ccx":
      counts.ccx++;
      assert.deepEqual(Array.from(encodeMessage(value, {})), [
        0x82,
        ...numbers(expected),
        0xa0,
      ]);
      assert.deepEqual(
        Array.from(
          encodeLevelControl({ zoneId: value, level: 65279, sequence: value }),
        ),
        numbers(decoded),
      );
      break;
    case "leap":
    case "leap-batch":
      if (kind === "leap") counts.leap++;
      else counts.batch++;
      await checkLeapTrace(
        value === 1,
        numbers(expected),
        decoded.split(";").map(numbers),
        kind === "leap-batch",
      );
      break;
    case "leap-reset":
      counts.reset++;
      await checkLeapTagReuse(numbers(expected));
      await checkLeapSubscriptionReuse();
      break;
    case "leap-detach":
      counts.detach++;
      await checkLeapDetach(numbers(expected));
      break;
    default:
      throw new Error(`Unknown Lean vector: ${line}`);
  }
}
assert.deepEqual(counts, {
  level: 101,
  fade: 256,
  bits: 256,
  cca: 256,
  ccx: 17,
  leap: 432,
  batch: 2,
  reset: 1,
  detach: 1,
});
assert.deepEqual(Array.from(bytesToBits(Uint8Array.from(allBytes))), allBits);
assert.deepEqual(Array.from(bitsToBytes(Uint8Array.from(allBits))), allBytes);
for (let trailing = 1; trailing < 8; trailing++) {
  assert.deepEqual(
    Array.from(
      bitsToBytes(Uint8Array.from([...allBits, ...Array(trailing).fill(1)])),
    ),
    allBytes,
    `Trailing ${trailing} bits must be discarded`,
  );
}
console.log(
  `Lean proofs and production differential checks passed: ${JSON.stringify(counts)}`,
);
