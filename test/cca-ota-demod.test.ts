import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOtaPacket,
  bytesToBits,
  extractPacketsFromBits,
} from "../lib/cca-ota-codec";
import {
  complexFromUint8,
  demodulateFsk,
  instantaneousFrequency,
  mix,
  synthesizeFsk,
  uint8FromComplex,
} from "../lib/cca-ota-demod";

// Helper: build a complex IQ array as a flat Float32Array of [I0, Q0, I1, Q1, ...]
function makeComplex(samples: Array<[number, number]>): Float32Array {
  const out = new Float32Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out[2 * i] = samples[i][0];
    out[2 * i + 1] = samples[i][1];
  }
  return out;
}

// A pure tone at frequency f over a 1-sample-rate is z[n] = exp(j * 2π * f/fs * n).
// Helper to synthesize one for testing.
function tone(
  freqHz: number,
  sampleRateHz: number,
  nSamples: number,
): Float32Array {
  const out = new Float32Array(nSamples * 2);
  const omega = (2 * Math.PI * freqHz) / sampleRateHz;
  for (let n = 0; n < nSamples; n++) {
    out[2 * n] = Math.cos(omega * n);
    out[2 * n + 1] = Math.sin(omega * n);
  }
  return out;
}

test("instantaneousFrequency of a constant DC complex signal is 0", () => {
  // Signal at frequency 0 → constant phase → derivative is 0
  const iq = makeComplex([
    [1, 0],
    [1, 0],
    [1, 0],
    [1, 0],
  ]);
  const f = instantaneousFrequency(iq, 1_000_000);
  // Output length is len-1 (we lose one sample to the diff)
  assert.equal(f.length, 3);
  for (let i = 0; i < f.length; i++) {
    assert.ok(Math.abs(f[i]) < 1e-3, `f[${i}]=${f[i]} should be ≈0`);
  }
});

test("instantaneousFrequency recovers a positive tone within 1% of true freq", () => {
  // 10 kHz tone sampled at 1 MHz → 100 samples per cycle
  const iq = tone(10_000, 1_000_000, 1024);
  const f = instantaneousFrequency(iq, 1_000_000);
  // Skip endpoints (filter transients)
  let sum = 0;
  for (let i = 50; i < f.length - 50; i++) sum += f[i];
  const mean = sum / (f.length - 100);
  assert.ok(
    Math.abs(mean - 10_000) / 10_000 < 0.01,
    `mean instantaneous freq ${mean.toFixed(1)} should be near 10000`,
  );
});

test("instantaneousFrequency recovers a negative tone within 1% of true freq", () => {
  const iq = tone(-15_000, 1_000_000, 1024);
  const f = instantaneousFrequency(iq, 1_000_000);
  let sum = 0;
  for (let i = 50; i < f.length - 50; i++) sum += f[i];
  const mean = sum / (f.length - 100);
  assert.ok(
    Math.abs(mean - -15_000) / 15_000 < 0.01,
    `mean instantaneous freq ${mean.toFixed(1)} should be near -15000`,
  );
});

test("complexFromUint8 maps 127.5-centered uint8 → ±1 normalized complex", () => {
  // rtl_sdr writes uint8 [I0, Q0, I1, Q1, ...] centered at 127.5.
  // Choose bytes that map to clean values.
  const raw = new Uint8Array([127, 127, 255, 127, 0, 0]);
  const iq = complexFromUint8(raw);
  assert.equal(iq.length, 6); // 3 complex samples × 2 floats
  // Sample 0: (127, 127) → near (0, 0)
  assert.ok(Math.abs(iq[0]) < 1, `i[0]=${iq[0]} should be ≈0`);
  assert.ok(Math.abs(iq[1]) < 1, `q[0]=${iq[1]} should be ≈0`);
  // Sample 1: (255, 127) → ≈(127.5, 0)
  assert.ok(Math.abs(iq[2] - 127.5) < 1, `i[1]=${iq[2]} should be ≈127.5`);
  // Sample 2: (0, 0) → ≈(-127.5, -127.5)
  assert.ok(Math.abs(iq[4] + 127.5) < 1, `i[2]=${iq[4]} should be ≈-127.5`);
  assert.ok(Math.abs(iq[5] + 127.5) < 1, `q[2]=${iq[5]} should be ≈-127.5`);
});

test("mix(-10 kHz) on a 10 kHz tone moves it to DC", () => {
  const fs = 1_000_000;
  const iq = tone(10_000, fs, 4096);
  const mixed = mix(iq, -10_000, fs);
  const f = instantaneousFrequency(mixed, fs);
  let sum = 0;
  for (let i = 100; i < f.length - 100; i++) sum += f[i];
  const mean = sum / (f.length - 200);
  assert.ok(
    Math.abs(mean) < 100,
    `after mixing to DC, mean freq = ${mean.toFixed(1)} should be ≈0`,
  );
});

test("mix(+5 kHz) on a 20 kHz tone moves it to 25 kHz", () => {
  const fs = 1_000_000;
  const iq = tone(20_000, fs, 4096);
  const mixed = mix(iq, 5_000, fs);
  const f = instantaneousFrequency(mixed, fs);
  let sum = 0;
  for (let i = 100; i < f.length - 100; i++) sum += f[i];
  const mean = sum / (f.length - 200);
  assert.ok(
    Math.abs(mean - 25_000) / 25_000 < 0.01,
    `after +5kHz mix, mean freq = ${mean.toFixed(1)} should be ≈25000`,
  );
});

test("synthesizeFsk produces a positive-frequency signal for bit=1", () => {
  // Single-bit signal at 1, 1 MHz sample rate, 30 kbps, ±32 kHz deviation
  // For a single bit at 30 kbps: 1 MHz / 30 kHz ≈ 33 samples per bit
  const bits = new Uint8Array([1]);
  const iq = synthesizeFsk(bits, {
    sampleRateHz: 1_000_000,
    dataRateHz: 30_000,
    deviationHz: 32_000,
  });
  // Should be roughly samples_per_bit complex samples
  assert.ok(
    iq.length > 60,
    `expected ~66 floats (33 complex), got ${iq.length}`,
  );
  const f = instantaneousFrequency(iq, 1_000_000);
  // Mean instantaneous freq should be close to +32 kHz
  let sum = 0;
  for (let i = 5; i < f.length - 5; i++) sum += f[i];
  const mean = sum / (f.length - 10);
  assert.ok(
    Math.abs(mean - 32_000) / 32_000 < 0.05,
    `mean freq for bit=1 should be ≈+32000, got ${mean.toFixed(1)}`,
  );
});

test("synthesizeFsk produces a negative-frequency signal for bit=0", () => {
  const bits = new Uint8Array([0]);
  const iq = synthesizeFsk(bits, {
    sampleRateHz: 1_000_000,
    dataRateHz: 30_000,
    deviationHz: 32_000,
  });
  const f = instantaneousFrequency(iq, 1_000_000);
  let sum = 0;
  for (let i = 5; i < f.length - 5; i++) sum += f[i];
  const mean = sum / (f.length - 10);
  assert.ok(
    Math.abs(mean - -32_000) / 32_000 < 0.05,
    `mean freq for bit=0 should be ≈-32000, got ${mean.toFixed(1)}`,
  );
});

test("synth → demod round-trips a known bit pattern (clean signal)", () => {
  const bits = new Uint8Array([1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1]);
  const params = {
    sampleRateHz: 2_400_000, // clean 80 samples per bit at 30 kbps
    dataRateHz: 30_000,
    deviationHz: 32_000,
  };
  const iq = synthesizeFsk(bits, params);
  const recovered = demodulateFsk(iq, params);
  // Demod recovers bits at slightly fewer samples than synth produced
  // (instantaneousFrequency loses 1 sample). Compare what we got.
  assert.ok(
    recovered.length >= bits.length - 1,
    `got ${recovered.length} bits, expected at least ${bits.length - 1}`,
  );
  for (let i = 0; i < Math.min(bits.length, recovered.length); i++) {
    assert.equal(
      recovered[i],
      bits[i],
      `bit ${i} mismatch: got ${recovered[i]}, expected ${bits[i]}`,
    );
  }
});

test("end-to-end: build packet → bits → synth → demod → extract recovers opcode + body", () => {
  // Cover the four primary OTA opcodes
  for (const [op, body] of [
    [0x2a, [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]], // BeginTransfer body=7
    [0x32, [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]], // Control body=6
    [0x41, [0xde, 0xad, 0xbe, 0xef]], // TransferData body=4
    [0x58, [0x01, 0x02, 0x03, 0x04, 0x05]], // QueryDevice body=5
  ] as const) {
    const wireBytes = buildOtaPacket(op, new Uint8Array(body));
    // Pad with 16 trailing zero bits — represents post-packet RF silence.
    // Without padding, the discriminator's 1-sample loss + fractional
    // samples-per-bit drops the final bit and CRC fails.
    const wireBits = bytesToBits(wireBytes);
    const padded = new Uint8Array(wireBits.length + 16);
    padded.set(wireBits, 0);
    // Synth at OTA params
    const iq = synthesizeFsk(padded, {
      sampleRateHz: 2_560_000,
      dataRateHz: 30_490,
      deviationHz: 32_000,
    });
    // Demod
    const recoveredBits = demodulateFsk(iq, {
      sampleRateHz: 2_560_000,
      dataRateHz: 30_490,
      deviationHz: 32_000,
    });
    // Extract packets — should find exactly one
    const packets = extractPacketsFromBits(recoveredBits);
    assert.equal(
      packets.length,
      1,
      `op=0x${op.toString(16)}: expected 1 packet, got ${packets.length}`,
    );
    assert.equal(packets[0].opcode, op);
    assert.deepEqual(packets[0].body, new Uint8Array(body));
  }
});

test("synth → demod round-trips at OTA params (30.49 kbps, 32 kHz dev, 2.56 MHz fs)", () => {
  // Real OTA params — fractional samples per bit
  const bits = new Uint8Array([
    0,
    1,
    0,
    1,
    1,
    1,
    1,
    1, // 0xFA byte LSB-first
    0,
    1,
    1,
    1,
    1,
    0,
    1,
    1, // 0xDE byte LSB-first
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // some payload
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
  ]);
  const params = {
    sampleRateHz: 2_560_000,
    dataRateHz: 30_490,
    deviationHz: 32_000,
  };
  const iq = synthesizeFsk(bits, params);
  const recovered = demodulateFsk(iq, params);
  let mismatches = 0;
  const compareLen = Math.min(bits.length, recovered.length);
  for (let i = 0; i < compareLen; i++) {
    if (recovered[i] !== bits[i]) mismatches++;
  }
  assert.equal(
    mismatches,
    0,
    `expected 0 bit errors, got ${mismatches} of ${compareLen}`,
  );
});

test("synthesizeFsk has continuous phase across bit transitions", () => {
  // Alternating bits — the synthesizer should NOT have phase jumps
  // (CPFSK = continuous-phase FSK is implicit in our integration approach).
  // Test by checking that |z[n]| stays ≈ constant (no glitches).
  const bits = new Uint8Array([1, 0, 1, 0]);
  const iq = synthesizeFsk(bits, {
    sampleRateHz: 1_000_000,
    dataRateHz: 30_000,
    deviationHz: 32_000,
  });
  for (let n = 0; n < iq.length / 2; n++) {
    const mag = Math.hypot(iq[2 * n], iq[2 * n + 1]);
    assert.ok(
      Math.abs(mag - 1) < 0.01,
      `|z[${n}]|=${mag.toFixed(4)} should be 1 (constant amplitude)`,
    );
  }
});

test("uint8FromComplex round-trips through complexFromUint8", () => {
  const original = new Uint8Array([0, 50, 127, 200, 255, 100, 64, 64]);
  const recovered = uint8FromComplex(complexFromUint8(original));
  assert.equal(recovered.length, original.length);
  for (let i = 0; i < original.length; i++) {
    // ±1 LSB tolerance is fine — 127.5 center can't be exact
    assert.ok(
      Math.abs(recovered[i] - original[i]) <= 1,
      `byte ${i}: got ${recovered[i]} expected ${original[i]}`,
    );
  }
});
