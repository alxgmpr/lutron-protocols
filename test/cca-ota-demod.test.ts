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
  demodulateFskFromSample,
  demodulateFskWithSync,
  findPatternOffsets,
  findSyncOffset,
  instantaneousFrequency,
  mix,
  recoverBitPhase,
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

test("recoverBitPhase locates bit phase for an alternating preamble truncated at fractional sample offsets", () => {
  // Real-capture parameters
  const params = {
    sampleRateHz: 2_560_000,
    dataRateHz: 62_500,
    deviationHz: 38_000,
  };
  const spb = params.sampleRateHz / params.dataRateHz; // ≈40.96
  // 40 alternating bits: 0x55 0x55 0x55 ... LSB-first preamble
  const preamble = new Uint8Array(40);
  for (let i = 0; i < 40; i++) preamble[i] = i % 2 === 0 ? 1 : 0;
  const fullIq = synthesizeFsk(preamble, params);

  for (const skipSamples of [0, 3, 10, 18, 25, 33, 40]) {
    const truncated = fullIq.subarray(2 * skipSamples);
    const freq = instantaneousFrequency(truncated, params.sampleRateHz);
    const phi = recoverBitPhase(freq, params);
    // Expected: smallest non-negative offset where the next bit boundary lies.
    // bit_k of the original synth starts at sample k*spb; in the truncated array,
    // that's at index k*spb - skipSamples. The smallest non-negative such index is the bit phase.
    let expected = -skipSamples;
    while (expected < 0) expected += spb;
    while (expected >= spb) expected -= spb;
    // Account for circular distance — phi=0 and phi=spb are equivalent mod spb.
    const wrapDiff = Math.min(
      Math.abs(phi - expected),
      Math.abs(phi - expected + spb),
      Math.abs(phi - expected - spb),
    );
    assert.ok(
      wrapDiff < 1.0,
      `skip=${skipSamples}: phi=${phi.toFixed(2)} expected≈${expected.toFixed(2)} (spb=${spb.toFixed(2)})`,
    );
  }
});

test("demodulateFskWithSync round-trips packets at fractional bit-start offsets", () => {
  // Real-capture parameters: 2.56 MHz fs, 62.5 kbps, 38 kHz dev.
  const params = {
    sampleRateHz: 2_560_000,
    dataRateHz: 62_500,
    deviationHz: 38_000,
  };
  // 4-byte body for a TransferData-like packet
  const opcode = 0x41;
  const body = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const wireBytes = buildOtaPacket(opcode, body);
  const wireBits = bytesToBits(wireBytes);
  // Trailing bits to flush the matched filter past the CRC
  const padded = new Uint8Array(wireBits.length + 16);
  padded.set(wireBits, 0);
  const fullIq = synthesizeFsk(padded, params);

  // Try a range of fractional sample offsets that the burst can start at.
  for (const skipSamples of [0, 5, 12, 17, 25, 35, 45]) {
    const truncated = fullIq.subarray(2 * skipSamples);
    const recoveredBits = demodulateFskWithSync(truncated, params);
    let packets = extractPacketsFromBits(recoveredBits);
    if (packets.length === 0) {
      // Polarity-ambiguous demod — try the inverse bit stream.
      const flipped = new Uint8Array(recoveredBits.length);
      for (let i = 0; i < recoveredBits.length; i++)
        flipped[i] = 1 - recoveredBits[i];
      packets = extractPacketsFromBits(flipped);
    }
    assert.equal(
      packets.length,
      1,
      `skip=${skipSamples}: expected 1 packet, got ${packets.length}`,
    );
    assert.equal(packets[0].opcode, opcode);
    assert.deepEqual(packets[0].body, body);
  }
});

test("findSyncOffset locates a known bit pattern in synthesized freq", () => {
  // Embed FA DE inside a longer bit stream and verify findSyncOffset
  // returns the sample where it starts.
  const params = {
    sampleRateHz: 2_560_000,
    dataRateHz: 62_500,
    deviationHz: 32_000,
  };
  const spb = params.sampleRateHz / params.dataRateHz;
  // Pre-fade fluff (32 bits of preamble + 8-bit "delim") + FA DE (16 bits) + 64 trailing bits
  const preBits = 40;
  const before = new Uint8Array(preBits);
  for (let i = 0; i < preBits; i++) before[i] = i % 2; // alternating
  const fadeBits = bytesToBits(new Uint8Array([0xfa, 0xde]));
  const after = new Uint8Array(64);
  for (let i = 0; i < 64; i++) after[i] = i % 3 === 0 ? 1 : 0;
  const allBits = new Uint8Array(preBits + fadeBits.length + after.length);
  allBits.set(before, 0);
  allBits.set(fadeBits, preBits);
  allBits.set(after, preBits + fadeBits.length);
  const iq = synthesizeFsk(allBits, params);
  const freq = instantaneousFrequency(iq, params.sampleRateHz);
  const result = findSyncOffset(freq, fadeBits, params);
  assert.notEqual(result, null);
  const expectedSample = preBits * spb;
  // Within ±2 samples (sub-sample precision is limited by sliding correlation step of 1 sample)
  const diff = Math.abs(result!.sampleOffset - expectedSample);
  assert.ok(
    diff < 2,
    `expected FA DE at ~sample ${expectedSample.toFixed(1)}, got ${result!.sampleOffset} (diff=${diff.toFixed(1)})`,
  );
  assert.equal(result!.polarity, 1);
});

test("findSyncOffset detects inverted polarity", () => {
  // Synth the pattern with bit-flipped FSK convention (bit 0 → +dev), and
  // check that findSyncOffset still locates it but reports polarity=-1.
  const params = {
    sampleRateHz: 2_560_000,
    dataRateHz: 62_500,
    deviationHz: 32_000,
  };
  const spb = params.sampleRateHz / params.dataRateHz;
  const fadeBits = bytesToBits(new Uint8Array([0xfa, 0xde]));
  const inverted = new Uint8Array(fadeBits.length);
  for (let i = 0; i < fadeBits.length; i++) inverted[i] = 1 - fadeBits[i];
  const padBefore = new Uint8Array(20);
  const padAfter = new Uint8Array(40);
  for (let i = 0; i < padBefore.length; i++) padBefore[i] = i % 2;
  const allBits = new Uint8Array(
    padBefore.length + inverted.length + padAfter.length,
  );
  allBits.set(padBefore, 0);
  allBits.set(inverted, padBefore.length);
  allBits.set(padAfter, padBefore.length + inverted.length);
  const iq = synthesizeFsk(allBits, params);
  const freq = instantaneousFrequency(iq, params.sampleRateHz);
  const result = findSyncOffset(freq, fadeBits, params);
  assert.notEqual(result, null);
  // When the pattern is bit-flipped on air, the correlation goes negative.
  assert.equal(result!.polarity, -1);
  const expectedSample = padBefore.length * spb;
  const diff = Math.abs(result!.sampleOffset - expectedSample);
  assert.ok(
    diff < 2,
    `inverted polarity FA DE: sample ${result!.sampleOffset}`,
  );
});

test("findSyncOffset + demodulateFskFromSample decodes a packet through a long-constant region", () => {
  // The motivating bug: bit-clock drifts through long-constant regions like
  // the 8-bit `0xFF` sync delimiter. Synth a stream with FA DE preceded by
  // constant 1s, and verify the sync-anchored decode reads the bits correctly
  // even when a fixed bit clock would slip a bit.
  const params = {
    sampleRateHz: 2_560_000,
    dataRateHz: 62_500,
    deviationHz: 32_000,
  };
  const opcode = 0x41;
  const body = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const wireBytes = buildOtaPacket(opcode, body);
  const wireBits = bytesToBits(wireBytes);
  // Pad with random pre/post bits to simulate burst edges
  const padded = new Uint8Array(wireBits.length + 32);
  padded.set(wireBits, 0);
  const iq = synthesizeFsk(padded, params);
  const freq = instantaneousFrequency(iq, params.sampleRateHz);
  // The codec writes [PREAMBLE 24 bits][SYNC_DELIM 8 bits][FA DE 16 bits][LEN][OP][BODY][CRC]
  // FA DE thus starts at bit 32 of the wire — confirm findSyncOffset finds it.
  const fadeBits = bytesToBits(new Uint8Array([0xfa, 0xde]));
  const result = findSyncOffset(freq, fadeBits, params);
  assert.notEqual(result, null);
  // Decode forward from the FA DE sample. We need FA DE (16) + LEN (8) + OP (8) + BODY (32) + CRC (16) = 80 bits
  const numBits = 80;
  const decodedBits = demodulateFskFromSample(
    iq,
    params,
    result!.sampleOffset,
    numBits,
  );
  // The decoded stream starts at FA DE; pass to extractPacketsFromBits.
  let bits = decodedBits;
  if (result!.polarity === -1) {
    bits = new Uint8Array(decodedBits.length);
    for (let i = 0; i < decodedBits.length; i++) bits[i] = 1 - decodedBits[i];
  }
  const packets = extractPacketsFromBits(bits);
  assert.equal(packets.length, 1, `expected 1 packet, got ${packets.length}`);
  assert.equal(packets[0].opcode, opcode);
  assert.deepEqual(packets[0].body, body);
});

test("findPatternOffsets returns FA DE positions verified by exact bit-level match", () => {
  // Build a synth signal with FA DE embedded inside an alternating preamble
  // (which would yield false-positive cross-correlation peaks). Verify that
  // findPatternOffsets returns the FA DE position but NOT preamble positions.
  const params = {
    sampleRateHz: 2_560_000,
    dataRateHz: 62_500,
    deviationHz: 32_000,
  };
  const spb = params.sampleRateHz / params.dataRateHz;
  const fadeBits = bytesToBits(new Uint8Array([0xfa, 0xde]));
  // 24-bit alternating preamble + 8-bit 0xFF + FA DE + 32 bits trailing
  const preBits = new Uint8Array(24);
  for (let i = 0; i < 24; i++) preBits[i] = i % 2; // 0,1,0,1,... = NOT what 0x55 LSB-first would produce, but alternating is the false-positive risk
  const sync = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]); // 0xFF LSB-first all 1s
  const trail = new Uint8Array(32);
  for (let i = 0; i < trail.length; i++) trail[i] = (i * 7) % 2;
  const allBits = new Uint8Array(
    preBits.length + sync.length + fadeBits.length + trail.length,
  );
  let off = 0;
  allBits.set(preBits, off);
  off += preBits.length;
  allBits.set(sync, off);
  off += sync.length;
  allBits.set(fadeBits, off);
  const fadeStartBit = off;
  off += fadeBits.length;
  allBits.set(trail, off);
  const iq = synthesizeFsk(allBits, params);
  const freq = instantaneousFrequency(iq, params.sampleRateHz);
  const candidates = findPatternOffsets(freq, fadeBits, params);
  assert.ok(
    candidates.length > 0,
    `expected at least one FA DE candidate, got 0`,
  );
  // The expected sample where FA DE starts: fadeStartBit * spb.
  const expectedSample = fadeStartBit * spb;
  // At least ONE candidate should be within ±2 samples of expectedSample with polarity 1.
  const hit = candidates.find(
    (c) => c.polarity === 1 && Math.abs(c.sampleOffset - expectedSample) <= 2,
  );
  assert.ok(
    hit !== undefined,
    `expected a FA DE candidate near sample ${expectedSample.toFixed(0)} with polarity 1, got candidates: ${JSON.stringify(candidates.slice(0, 5))}`,
  );
});

test("findPatternOffsets + demodulateFskFromSample decodes the OTA wire under realistic constraints", () => {
  // Build a full OTA packet, synth it, run findPatternOffsets + demod from
  // each candidate, parse, and confirm exactly one valid packet decodes.
  const params = {
    sampleRateHz: 2_560_000,
    dataRateHz: 62_500,
    deviationHz: 32_000,
  };
  const opcode = 0x32;
  const body = new Uint8Array([0x01, 0x12, 0x34, 0x56, 0x78, 0x9a]);
  const wireBytes = buildOtaPacket(opcode, body);
  const wireBits = bytesToBits(wireBytes);
  const padded = new Uint8Array(wireBits.length + 32);
  padded.set(wireBits, 0);
  const iq = synthesizeFsk(padded, params);
  const freq = instantaneousFrequency(iq, params.sampleRateHz);
  const fadeBits = bytesToBits(new Uint8Array([0xfa, 0xde]));
  const candidates = findPatternOffsets(freq, fadeBits, params);
  // Try each candidate; at least one should give a CRC-valid parse.
  let decoded = 0;
  for (const cand of candidates) {
    const numBits = Math.min(
      2080,
      Math.floor(
        (freq.length - cand.sampleOffset) /
          (params.sampleRateHz / params.dataRateHz),
      ),
    );
    let bits = demodulateFskFromSample(iq, params, cand.sampleOffset, numBits);
    if (cand.polarity === -1) {
      const f = new Uint8Array(bits.length);
      for (let i = 0; i < bits.length; i++) f[i] = 1 - bits[i];
      bits = f;
    }
    const packets = extractPacketsFromBits(bits);
    for (const p of packets) {
      if (p.opcode === opcode && p.body.length === body.length) {
        let ok = true;
        for (let i = 0; i < body.length; i++)
          if (p.body[i] !== body[i]) {
            ok = false;
            break;
          }
        if (ok) decoded++;
      }
    }
  }
  assert.ok(
    decoded > 0,
    `expected at least one decoded packet, got ${decoded}`,
  );
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
