/**
 * WiZ Color Math — CCT to RGBWC channel conversion with full-range dimming.
 *
 * Interpolates the WiZ bulb's 14-point CCT table to compute raw LED channel
 * values (R, G, B, W, C) for any target color temperature and brightness.
 *
 * By sending raw channel values via setPilot({r,g,b,w,c}) instead of
 * {dimming, temp}, we bypass the bulb's 10% dimming floor and get direct
 * PWM control down to ~0.8% brightness (channel value 2/255).
 */

export interface RgbwcChannels {
  r: number;
  g: number;
  b: number;
  w: number;
  c: number;
}

/** CCT table point: [kelvin, R, G, B, W, C] */
type CctPoint = [number, number, number, number, number, number];

/**
 * Default 14-point CCT table from WiZ ESP24_SHRGB_01 bulbs (BP5758D driver).
 * Extracted via getCctTable UDP command. All current bulbs share this table.
 */
const DEFAULT_CCT_TABLE: CctPoint[] = [
  [1500, 255, 0, 0, 65, 0],
  [1800, 255, 0, 0, 160, 0],
  [2000, 225, 15, 0, 255, 0],
  [2200, 180, 40, 0, 255, 0],
  [2400, 80, 20, 0, 255, 45],
  [2700, 35, 25, 0, 255, 100],
  [3000, 10, 15, 0, 255, 255],
  [3200, 0, 15, 0, 195, 255],
  [3500, 0, 15, 3, 100, 255],
  [4000, 0, 0, 0, 0, 255],
  [4500, 0, 25, 20, 15, 255],
  [5000, 0, 30, 30, 0, 255],
  [6000, 0, 65, 65, 0, 255],
  [6500, 0, 90, 70, 0, 255],
];

/** Minimum non-zero channel value — below 2 the bulb turns off */
const MIN_CHANNEL = 2;

/**
 * XYZ → linear sRGB conversion matrix (D65 illuminant, IEC 61966-2-1).
 * Each row converts [X, Y, Z] to one sRGB channel.
 */
const XYZ_TO_SRGB = [
  [3.2404542, -1.5371385, -0.4985314], // R
  [-0.969266, 1.8760108, 0.041556], // G
  [0.0556434, -0.2040259, 1.0572252], // B
] as const;

/**
 * Convert CCT (Kelvin) + brightness (0-100%) to raw RGBWC channel values.
 *
 * Linearly interpolates the CCT table for the target temperature, then
 * scales all channels by brightness. Active channels are floored at 2
 * (the minimum value that keeps the bulb on).
 *
 * @param cct Color temperature in Kelvin (clamped to 1500-6500)
 * @param brightnessPercent Brightness 0-100 (0 = off)
 * @param table Optional custom CCT table (default: built-in WiZ table)
 * @returns RGBWC channel values (each 0-255)
 */
export function cctToRgbwc(
  cct: number,
  brightnessPercent: number,
  table: CctPoint[] = DEFAULT_CCT_TABLE,
): RgbwcChannels {
  if (brightnessPercent <= 0) return { r: 0, g: 0, b: 0, w: 0, c: 0 };

  // Clamp CCT to table range
  const minK = table[0][0];
  const maxK = table[table.length - 1][0];
  const k = Math.max(minK, Math.min(maxK, cct));

  // Find the two surrounding table points
  let lo = 0;
  for (let i = 1; i < table.length; i++) {
    if (table[i][0] >= k) {
      lo = i - 1;
      break;
    }
    lo = i;
  }
  const hi = Math.min(lo + 1, table.length - 1);

  // Interpolation factor (0 = lo point, 1 = hi point)
  const range = table[hi][0] - table[lo][0];
  const t = range > 0 ? (k - table[lo][0]) / range : 0;

  // Interpolate each channel at full brightness
  const lerp = (ch: number) =>
    table[lo][ch] + t * (table[hi][ch] - table[lo][ch]);
  const fullR = lerp(1);
  const fullG = lerp(2);
  const fullB = lerp(3);
  const fullW = lerp(4);
  const fullC = lerp(5);

  // Scale by brightness
  const scale = Math.max(0, Math.min(100, brightnessPercent)) / 100;

  return {
    r: scaleChannel(fullR, scale),
    g: scaleChannel(fullG, scale),
    b: scaleChannel(fullB, scale),
    w: scaleChannel(fullW, scale),
    c: scaleChannel(fullC, scale),
  };
}

/** Scale a channel value by brightness, flooring active channels at MIN_CHANNEL */
function scaleChannel(fullValue: number, scale: number): number {
  if (fullValue <= 0) return 0;
  // Channel is active at full brightness — ensure it stays on at any non-zero scale
  const scaled = Math.round(fullValue * scale);
  return Math.max(MIN_CHANNEL, Math.min(255, scaled));
}

/**
 * Build setPilot params from RGBWC channels.
 * Returns {state, r, g, b, w, c} — no dimming or temp params.
 */
export function rgbwcToPilotParams(
  channels: RgbwcChannels,
): Record<string, number | boolean> {
  const allZero =
    channels.r === 0 &&
    channels.g === 0 &&
    channels.b === 0 &&
    channels.w === 0 &&
    channels.c === 0;
  if (allZero) return { state: false };
  return {
    state: true,
    r: channels.r,
    g: channels.g,
    b: channels.b,
    w: channels.w,
    c: channels.c,
    dimming: 100,
  };
}

/**
 * Convert CIE 1931 xy chromaticity + brightness to raw RGBWC channel values.
 *
 * Uses xy → XYZ → linear sRGB conversion, then maps to the bulb's 5-channel
 * RGBWC output. White channels are not used for color mode — only RGB LEDs.
 *
 * @param x CIE x (0-1 range, raw protocol value / 10000)
 * @param y CIE y (0-1 range, raw protocol value / 10000)
 * @param brightnessPercent Brightness 0-100
 * @returns RGBWC channel values (each 0-255)
 */
export function xyToRgbwc(
  x: number,
  y: number,
  brightnessPercent: number,
): RgbwcChannels {
  if (brightnessPercent <= 0 || y <= 0)
    return { r: 0, g: 0, b: 0, w: 0, c: 0 };

  // CIE xy → XYZ (normalized to Y = 1)
  const X = x / y;
  const Y = 1;
  const Z = (1 - x - y) / y;

  // XYZ → linear sRGB
  const dot = (row: readonly [number, number, number]) =>
    row[0] * X + row[1] * Y + row[2] * Z;
  let lr = dot(XYZ_TO_SRGB[0]);
  let lg = dot(XYZ_TO_SRGB[1]);
  let lb = dot(XYZ_TO_SRGB[2]);

  // Clamp negatives (out-of-gamut colors)
  lr = Math.max(0, lr);
  lg = Math.max(0, lg);
  lb = Math.max(0, lb);

  // Normalize so the max channel = 255, then scale by brightness
  const maxCh = Math.max(lr, lg, lb);
  if (maxCh <= 0) return { r: 0, g: 0, b: 0, w: 0, c: 0 };

  const scale = (brightnessPercent / 100) * (255 / maxCh);

  return {
    r: scaleChannel(lr * scale, 1),
    g: scaleChannel(lg * scale, 1),
    b: scaleChannel(lb * scale, 1),
    w: 0,
    c: 0,
  };
}

/**
 * Convenience: CCT + brightness → ready-to-send setPilot params.
 */
export function cctToPilotParams(
  cct: number,
  brightnessPercent: number,
): Record<string, number | boolean> {
  return rgbwcToPilotParams(cctToRgbwc(cct, brightnessPercent));
}
