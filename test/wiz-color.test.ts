import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cctToRgbwc,
  cctToPilotParams,
  xyToRgbwc,
  rgbwcToPilotParams,
} from "../lib/wiz-color";

describe("cctToRgbwc", () => {
  it("matches CCT table at exact points", () => {
    // 1500K: r=255 g=0 b=0 w=65 c=0
    const ch = cctToRgbwc(1500, 100);
    assert.equal(ch.r, 255);
    assert.equal(ch.g, 0);
    assert.equal(ch.b, 0);
    assert.equal(ch.w, 65);
    assert.equal(ch.c, 0);
  });

  it("matches CCT table at 2700K", () => {
    const ch = cctToRgbwc(2700, 100);
    assert.equal(ch.r, 35);
    assert.equal(ch.g, 25);
    assert.equal(ch.b, 0);
    assert.equal(ch.w, 255);
    assert.equal(ch.c, 100);
  });

  it("matches CCT table at 6500K", () => {
    const ch = cctToRgbwc(6500, 100);
    assert.equal(ch.r, 0);
    assert.equal(ch.g, 90);
    assert.equal(ch.b, 70);
    assert.equal(ch.w, 0);
    assert.equal(ch.c, 255);
  });

  it("interpolates between table points", () => {
    // 2550K is halfway between 2400 and 2700
    const ch = cctToRgbwc(2550, 100);
    // r: 80 → 35, midpoint ~58
    assert.ok(ch.r > 35 && ch.r < 80, `r=${ch.r} should be between 35-80`);
    // w should stay 255 (both endpoints are 255)
    assert.equal(ch.w, 255);
    // c: 45 → 100, midpoint ~73
    assert.ok(ch.c > 45 && ch.c < 100, `c=${ch.c} should be between 45-100`);
  });

  it("clamps CCT below table minimum", () => {
    const ch = cctToRgbwc(1000, 100);
    // Should clamp to 1500K values
    assert.equal(ch.r, 255);
    assert.equal(ch.w, 65);
  });

  it("clamps CCT above table maximum", () => {
    const ch = cctToRgbwc(8000, 100);
    // Should clamp to 6500K values
    assert.equal(ch.g, 90);
    assert.equal(ch.c, 255);
  });

  it("scales channels by brightness", () => {
    const full = cctToRgbwc(2700, 100);
    const half = cctToRgbwc(2700, 50);
    // r=35 at 100% → ~18 at 50%
    assert.ok(half.r < full.r, `half.r=${half.r} should be less than full.r=${full.r}`);
    // w=255 at 100% → ~128 at 50%
    assert.ok(half.w > 120 && half.w < 136, `half.w=${half.w} should be ~128`);
  });

  it("floors active channels at 2", () => {
    // At very low brightness, active channels should be at least 2
    const ch = cctToRgbwc(2700, 1);
    // r=35 at 1% → 0.35 rounds to 0, but floor kicks in → 2
    assert.ok(ch.r >= 2, `r=${ch.r} should be >= 2 (active channel floor)`);
    // b=0 at 2700K should stay 0
    assert.equal(ch.b, 0);
  });

  it("returns all zeros at 0% brightness", () => {
    const ch = cctToRgbwc(2700, 0);
    assert.equal(ch.r, 0);
    assert.equal(ch.g, 0);
    assert.equal(ch.b, 0);
    assert.equal(ch.w, 0);
    assert.equal(ch.c, 0);
  });
});

describe("rgbwcToPilotParams", () => {
  it("returns state:false for all-zero channels", () => {
    const params = rgbwcToPilotParams({ r: 0, g: 0, b: 0, w: 0, c: 0 });
    assert.equal(params.state, false);
    assert.equal(params.r, undefined);
  });

  it("returns channel values with state:true and dimming:100", () => {
    const params = rgbwcToPilotParams({ r: 10, g: 20, b: 0, w: 200, c: 100 });
    assert.equal(params.state, true);
    assert.equal(params.r, 10);
    assert.equal(params.g, 20);
    assert.equal(params.b, 0);
    assert.equal(params.w, 200);
    assert.equal(params.c, 100);
    assert.equal(params.dimming, 100);
  });
});

describe("cctToPilotParams", () => {
  it("returns state:false at 0%", () => {
    const params = cctToPilotParams(2700, 0);
    assert.equal(params.state, false);
  });

  it("returns RGBWC params at full brightness", () => {
    const params = cctToPilotParams(2700, 100);
    assert.equal(params.state, true);
    assert.equal(params.r, 35);
    assert.equal(params.w, 255);
    assert.equal(params.dimming, 100);
    // Should NOT have temp
    assert.equal((params as any).temp, undefined);
  });
});

describe("xyToRgbwc", () => {
  it("returns all zeros at 0% brightness", () => {
    const ch = xyToRgbwc(0.3127, 0.329, 0);
    assert.equal(ch.r, 0);
    assert.equal(ch.g, 0);
    assert.equal(ch.b, 0);
    assert.equal(ch.w, 0);
    assert.equal(ch.c, 0);
  });

  it("returns all zeros when y=0", () => {
    const ch = xyToRgbwc(0.3, 0, 100);
    assert.equal(ch.r, 0);
    assert.equal(ch.g, 0);
  });

  it("never uses white channels (color mode is RGB only)", () => {
    const ch = xyToRgbwc(0.3127, 0.329, 100);
    assert.equal(ch.w, 0);
    assert.equal(ch.c, 0);
  });

  it("maps D65 white to balanced RGB", () => {
    const ch = xyToRgbwc(0.3127, 0.329, 100);
    // D65 should produce roughly equal R, G, B
    assert.ok(ch.r > 200, `r=${ch.r} should be high`);
    assert.ok(ch.g > 200, `g=${ch.g} should be high`);
    assert.ok(ch.b > 200, `b=${ch.b} should be high`);
  });

  it("maps pure green (CIE) to dominant green channel", () => {
    // x=0.3064 y=0.6561 — captured from Ketra, deep in green region
    const ch = xyToRgbwc(0.3064, 0.6561, 100);
    assert.equal(ch.g, 255);
    assert.ok(ch.r < ch.g, `r=${ch.r} should be less than g=${ch.g}`);
    assert.ok(ch.b < ch.g, `b=${ch.b} should be less than g=${ch.g}`);
  });

  it("maps blue region to dominant blue channel", () => {
    // x=0.2282 y=0.1949 — captured from Ketra, blue/violet region
    const ch = xyToRgbwc(0.2282, 0.1949, 100);
    assert.equal(ch.b, 255);
  });

  it("maps red region to dominant red channel", () => {
    // x=0.4780 y=0.1817 — captured from Ketra, deep red
    const ch = xyToRgbwc(0.478, 0.1817, 100);
    assert.equal(ch.r, 255);
    assert.ok(ch.r > ch.g, `r=${ch.r} should be greater than g=${ch.g}`);
  });

  it("scales by brightness", () => {
    const full = xyToRgbwc(0.3127, 0.329, 100);
    const half = xyToRgbwc(0.3127, 0.329, 50);
    assert.ok(half.r < full.r, `half.r=${half.r} should be less than full.r=${full.r}`);
    assert.ok(half.r > 100 && half.r < 140, `half.r=${half.r} should be ~128`);
  });

  it("floors active channels at 2 for very low brightness", () => {
    const ch = xyToRgbwc(0.3127, 0.329, 1);
    // All RGB channels active for white → should be floored at 2
    assert.ok(ch.r >= 2, `r=${ch.r} should be >= 2`);
    assert.ok(ch.g >= 2, `g=${ch.g} should be >= 2`);
    assert.ok(ch.b >= 2, `b=${ch.b} should be >= 2`);
  });
});
