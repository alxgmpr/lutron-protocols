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
 * Planckian locus reference points in CIE xy for distance measurement.
 * Used to determine how "white" an xy chromaticity is — points near the
 * locus should use dedicated white LEDs (W/C) instead of RGB mixing.
 * [CCT in Kelvin, x, y]
 */
const PLANCKIAN_LOCUS: [number, number, number][] = [
  [1500, 0.5857, 0.3931],
  [2000, 0.5267, 0.4133],
  [2500, 0.4770, 0.4137],
  [3000, 0.4369, 0.4041],
  [3500, 0.4053, 0.3907],
  [4000, 0.3805, 0.3768],
  [4500, 0.3608, 0.3636],
  [5000, 0.3451, 0.3516],
  [5500, 0.3325, 0.3411],
  [6000, 0.3221, 0.3318],
  [6500, 0.3135, 0.3237],
];

/** Distance threshold below which xy is treated as pure white (CCT mode) */
const PLANCKIAN_NEAR = 0.01;
/**
 * Distance threshold at which xy is treated as fully saturated (RGB only).
 * The gamut boundary is ~0.15-0.30 from the locus depending on hue.
 * 0.15 covers the pastel region where white+tint looks better than pure RGB.
 */
const PLANCKIAN_FAR = 0.15;

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
 * Estimate correlated color temperature from CIE xy using McCamy's approximation.
 * Accurate within ~2% for chromaticities near the Planckian locus.
 * Returns Kelvin, clamped to 1500-6500 (the bulb's usable range).
 */
export function xyToCct(x: number, y: number): number {
  const n = (x - 0.332) / (0.1858 - y);
  const cct = 449 * n * n * n + 3525 * n * n + 6823.3 * n + 5520.33;
  return Math.max(1500, Math.min(6500, cct));
}

/**
 * Compute Euclidean distance from a CIE xy point to the nearest point
 * on the Planckian locus (interpolated from reference table).
 * Small distance = near-white, large distance = saturated color.
 */
export function planckianDistance(x: number, y: number): number {
  let minDist = Infinity;
  for (let i = 0; i < PLANCKIAN_LOCUS.length - 1; i++) {
    const [, ax, ay] = PLANCKIAN_LOCUS[i];
    const [, bx, by] = PLANCKIAN_LOCUS[i + 1];
    // Project (x,y) onto line segment [a, b], clamp t to [0,1]
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const dist = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

/**
 * Convert CIE 1931 xy chromaticity + brightness to raw RGBWC channel values.
 *
 * Near the Planckian locus (white region), uses the CCT table with dedicated
 * warm/cold white LEDs for high-quality whites. Far from the locus (saturated
 * colors), uses RGB LEDs. Blends smoothly between the two modes.
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

  const dist = planckianDistance(x, y);

  // Near the Planckian locus → use CCT pathway (white LEDs)
  if (dist <= PLANCKIAN_NEAR) {
    return cctToRgbwc(xyToCct(x, y), brightnessPercent);
  }

  // Far from locus → pure RGB
  if (dist >= PLANCKIAN_FAR) {
    return xyToRgb(x, y, brightnessPercent);
  }

  // Blend zone: decompose brightness into white + color components.
  // Instead of blending channel values (which creates muddy colors because
  // normalized RGB overwhelms the white), we split the brightness budget:
  // white LEDs carry the desaturated portion, RGB LEDs carry the color accent.
  const sat = (dist - PLANCKIAN_NEAR) / (PLANCKIAN_FAR - PLANCKIAN_NEAR);
  const white = cctToRgbwc(xyToCct(x, y), brightnessPercent * (1 - sat));
  const color = xyToRgb(x, y, brightnessPercent * sat);
  return {
    r: Math.min(255, white.r + color.r),
    g: Math.min(255, white.g + color.g),
    b: Math.min(255, white.b + color.b),
    w: white.w,
    c: white.c,
  };
}

/** Pure RGB conversion from CIE xy (no white channel blending) */
function xyToRgb(
  x: number,
  y: number,
  brightnessPercent: number,
): RgbwcChannels {
  // CIE xy → XYZ (normalized to Y = 1)
  const X = x / y;
  const Y = 1;
  const Z = (1 - x - y) / y;

  // XYZ → linear sRGB
  const dot = (row: readonly [number, number, number]) =>
    row[0] * X + row[1] * Y + row[2] * Z;
  let lr = Math.max(0, dot(XYZ_TO_SRGB[0]));
  let lg = Math.max(0, dot(XYZ_TO_SRGB[1]));
  let lb = Math.max(0, dot(XYZ_TO_SRGB[2]));

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
