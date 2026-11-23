/**
 * Which way to turn the phone to face the Qibla, from the needle's
 * rotation (Qibla bearing minus current heading, 0–360 clockwise
 * from the phone's front).
 *
 * The needle is read against the phone-front marker: a needle at 90°
 * means the Qibla is 90° clockwise from where the phone points, so the
 * reader turns right; at 270° it is 90° the other way, so they turn
 * left. Within a few degrees either way the phone counts as facing
 * the Qibla — a magnetometer never sits perfectly still, and asking
 * for an exact zero would keep the guidance flickering.
 */

/** Within this many degrees of the Qibla the phone counts as facing it. */
export const ALIGNED_WITHIN_DEG = 5;

export type TurnGuidance =
  | { direction: 'aligned'; degrees: 0 }
  | { direction: 'right' | 'left'; degrees: number };

/**
 * The turn that faces the Qibla, from the needle's rotation. The
 * returned degrees are always the short way round (0–180); the
 * aligned case reports 0.
 */
export function describeTurn(needleDeg: number): TurnGuidance {
  const norm = ((needleDeg % 360) + 360) % 360;
  if (norm <= ALIGNED_WITHIN_DEG || norm >= 360 - ALIGNED_WITHIN_DEG) {
    return { direction: 'aligned', degrees: 0 };
  }
  if (norm <= 180) return { direction: 'right', degrees: Math.round(norm) };
  return { direction: 'left', degrees: Math.round(360 - norm) };
}
