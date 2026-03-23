/**
 * Warm Dimming — Evaluate Lutron's B-spline curves to map brightness → CCT (Kelvin).
 *
 * Curves extracted from Designer's SqlModelInfo.mdf v26.1.0.112, table TBLDimCurveDefinition.
 * All curves are clamped quadratic B-splines (degree 2), 11 knots, up to 8 coefficients.
 * Domain: 0–0x7FFF (32767). Trailing 0xFFFF values in knot arrays are padding.
 */

export interface WarmDimCurve {
  name: string;
  knots: number[];
  coeffs: (number | null)[];
}

/** Built-in curves from Designer DB */
export const WARM_DIM_CURVES: Record<string, WarmDimCurve> = {
  default: {
    name: "Default Warm Dim",
    knots: [32, 32, 32, 187, 607, 2162, 4713, 8223, 32767, 32767, 65535],
    coeffs: [1800, 1859, 1944, 2086, 2239, 2417, 2683, 2800],
  },
  halogen: {
    name: "Modified Halogen",
    knots: [3, 3, 3, 208, 639, 1305, 2206, 8489, 32639, 32639, 65535],
    coeffs: [1798, 1794, 1940, 2047, 2117, 2397, 2691, 2802],
  },
  finire2700: {
    name: "Finiré 2700K",
    knots: [32, 32, 32, 1948, 4345, 7663, 18518, 32767, 32767, 65535, 65535],
    coeffs: [1784, 1760, 1999, 2226, 2520, 2688, 2720, null],
  },
  finire3000: {
    name: "Finiré 3000K",
    knots: [32, 32, 32, 1756, 7243, 18570, 32767, 32767, 65535, 65535, 65535],
    coeffs: [1794, 1764, 2278, 2759, 2991, 3040, null, null],
  },
};

/** Filter null coefficients and trim knots to match valid coefficient count */
function getValidSpline(curve: WarmDimCurve) {
  const validCoeffs = curve.coeffs.filter((c): c is number => c !== null);
  const numKnots = validCoeffs.length + 3; // degree 2: knots = coeffs + degree + 1
  const knots = curve.knots.slice(0, numKnots);
  const domainStart = knots[2];
  const domainEnd = knots[numKnots - 3]; // start of end-clamp repetition
  return { knots, coeffs: validCoeffs, domainStart, domainEnd };
}

/** Recursive B-spline basis function (Cox–de Boor) */
function bsplineBasis(
  knots: number[],
  i: number,
  p: number,
  t: number,
): number {
  if (p === 0) {
    // Include right endpoint for last span
    if (i === knots.length - 2)
      return t >= knots[i] && t <= knots[i + 1] ? 1 : 0;
    return t >= knots[i] && t < knots[i + 1] ? 1 : 0;
  }
  let left = 0;
  let right = 0;
  const d1 = knots[i + p] - knots[i];
  if (d1 > 0)
    left = ((t - knots[i]) / d1) * bsplineBasis(knots, i, p - 1, t);
  const d2 = knots[i + p + 1] - knots[i + 1];
  if (d2 > 0)
    right =
      ((knots[i + p + 1] - t) / d2) * bsplineBasis(knots, i + 1, p - 1, t);
  return left + right;
}

/** Evaluate B-spline at parameter t */
function evalBSpline(knots: number[], coeffs: number[], t: number): number {
  const degree = knots.length - coeffs.length - 1;
  let val = 0;
  for (let i = 0; i < coeffs.length; i++) {
    val += coeffs[i] * bsplineBasis(knots, i, degree, t);
  }
  return val;
}

/** Evaluate a warm dim curve: brightness percent (0–100) → CCT in Kelvin */
export function evalWarmDimCurve(
  curve: WarmDimCurve,
  brightnessPercent: number,
): number {
  const { knots, coeffs, domainStart, domainEnd } = getValidSpline(curve);
  const pct = Math.max(0, Math.min(100, brightnessPercent)) / 100;
  const t = domainStart + pct * (domainEnd - domainStart);
  return Math.round(evalBSpline(knots, coeffs, t));
}

/** Get a curve by name, falling back to "default" */
export function getWarmDimCurve(name: string): WarmDimCurve {
  return WARM_DIM_CURVES[name] ?? WARM_DIM_CURVES.default;
}

/**
 * Generate a 101-entry lookup table (index 0–100 = brightness percent → CCT Kelvin).
 * Optionally remap the curve's native CCT range to a custom min/max.
 */
export function generateWarmDimTable(
  curve: WarmDimCurve,
  outMin?: number,
  outMax?: number,
): number[] {
  const table: number[] = new Array(101);
  const { coeffs } = getValidSpline(curve);
  const nativeMin = coeffs[0];
  const nativeMax = coeffs[coeffs.length - 1];
  const remap = outMin != null || outMax != null;
  const targetMin = outMin ?? nativeMin;
  const targetMax = outMax ?? nativeMax;

  for (let pct = 0; pct <= 100; pct++) {
    const native = evalWarmDimCurve(curve, pct);
    if (remap) {
      const t = (native - nativeMin) / (nativeMax - nativeMin);
      table[pct] = Math.round(targetMin + t * (targetMax - targetMin));
    } else {
      table[pct] = native;
    }
  }

  return table;
}
