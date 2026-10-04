// Shot encoding shared by client input (WP-D), protocol validation (WP-C) and the sim (WP-B). DESIGN §5.7.
// A shot is an integer pull vector in 1/100 px; the ball travels in the direction of (dx, dy).
import { MAX_PULL_PX, MIN_PULL_PX, SHOT_QUANTUM } from '../constants';
import { simTuning } from './tuning';
import type { ShotInput } from './types';

/** -0 -> 0, so a shot that went through JSON and one that did not produce bit-identical velocities (checksums). */
const noNegZero = (v: number): number => (v === 0 ? 0 : v);

/**
 * Client side: clamp |pull| to simTuning.MAX_PULL_PX (sqrt), then Math.round(component * SHOT_QUANTUM).
 * (0,0) when |pull| < MIN_PULL_PX (simTuning.MIN_PULL_PX), when the input is not finite, and when rounding would
 * leave the quantized vector shorter than MIN_PULL_PX * SHOT_QUANTUM (so every non-null result passes validateShot
 * with default tuning).
 */
export function quantizeShot(pullX: number, pullY: number): ShotInput {
  const l = Math.sqrt(pullX * pullX + pullY * pullY);
  const min = simTuning.MIN_PULL_PX;
  if (!Number.isFinite(l) || l < min) return { dx: 0, dy: 0 };
  const max = simTuning.MAX_PULL_PX;
  let x = pullX;
  let y = pullY;
  if (l > max) {
    const k = max / l;
    x = pullX * k;
    y = pullY * k;
  }
  const dx = noNegZero(Math.round(x * SHOT_QUANTUM));
  const dy = noNegZero(Math.round(y * SHOT_QUANTUM));
  const minUnits = min * SHOT_QUANTUM;
  if (dx * dx + dy * dy < minUnits * minUnits) return { dx: 0, dy: 0 };
  return { dx, dy };
}

const MIN_UNITS = MIN_PULL_PX * SHOT_QUANTUM;      // 300
const MAX_UNITS = MAX_PULL_PX * SHOT_QUANTUM + 1;  // 12001: one unit of rounding tolerance
const MIN_SQ = MIN_UNITS * MIN_UNITS;
const MAX_SQ = MAX_UNITS * MAX_UNITS;

/** Integers, finite, (MIN_PULL_PX*SHOT_QUANTUM)^2 <= dx^2+dy^2 <= (MAX_PULL_PX*SHOT_QUANTUM + 1)^2. Uses the constants, never simTuning
 *  (the server validates against the fixed values). Extra properties are ignored. -0 is rejected: JSON.parse('-0') yields -0 but
 *  JSON.stringify(-0) is '0', so a -0 component would make the server sim run with a bit pattern no peer replays; quantizeShot
 *  never emits -0, so no legitimate client is affected. */
export function validateShot(s: unknown): s is ShotInput {
  if (typeof s !== 'object' || s === null) return false;
  const { dx, dy } = s as { dx?: unknown; dy?: unknown };
  if (typeof dx !== 'number' || typeof dy !== 'number') return false;
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) return false;
  if (Object.is(dx, -0) || Object.is(dy, -0)) return false;
  const sq = dx * dx + dy * dy;
  return sq >= MIN_SQ && sq <= MAX_SQ;
}

export const isNullShot = (s: ShotInput): boolean => s.dx === 0 && s.dy === 0;
