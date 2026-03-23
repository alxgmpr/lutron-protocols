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
