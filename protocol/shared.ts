/**
 * Cross-protocol encoding constants and utilities.
 *
 * Shared between CCA and CCX protocols. Single source of truth for
 * level encoding (percent ↔ 16-bit / 8-bit) and fade encoding (seconds ↔ quarter-seconds).
 */

/** 16-bit level encoding: 0x0000 = 0%, 0xFEFF = 100% */
export const LEVEL_MAX_16 = 0xfeff;

/** 8-bit level encoding: 0x00 = 0%, 0xFE = 100% */
export const LEVEL_MAX_8 = 0xfe;

/** Convert percentage (0-100) to 16-bit level (0x0000-0xFEFF) */
export function percentToLevel16(percent: number): number {
  return Math.round((percent * LEVEL_MAX_16) / 100);
}

/** Convert 16-bit level (0x0000-0xFEFF) to percentage (0-100) */
export function level16ToPercent(level: number): number {
  return (level / LEVEL_MAX_16) * 100;
}

/** Convert seconds to quarter-seconds (CCA fade byte, CCX fade/delay) */
export function secondsToQs(seconds: number): number {
  return Math.round(seconds * 4);
}

/** Convert quarter-seconds to seconds */
export function qsToSeconds(qs: number): number {
  return qs / 4;
}
