// Surfaces (DESIGN §8.2): friction as a constant deceleration opposing velocity, slope acceleration along the downhill
// direction, and the stop rule of §8.3 step 4. Tar, water and acid are triggers handled in step.ts; their friction is
// the grass value (it never matters: the trigger fires the tick the ball is on the tile).
import { DT } from '../constants';
import { DIR_DX, DIR_DY, isSlope, slopeDir } from '../course/chars';
import { Surface } from '../course/types';
import { len } from '../math/vec';
import { simTuning } from './tuning';
import type { BallState } from './types';

/** Deceleration (px/s^2) of the surface under the ball centre. */
export function frictionFor(surface: number): number {
  if (surface === Surface.Sand) return simTuning.FRICTION_SAND;
  if (surface === Surface.Ice) return simTuning.FRICTION_ICE;
  if (isSlope(surface)) return simTuning.FRICTION_SLOPE;
  return simTuning.FRICTION_GRASS;
}

/** decel = friction * DT; if speed <= decel the ball halts, else the velocity shrinks by decel keeping its direction. */
export function applyFriction(ball: BallState, friction: number): void {
  const speed = len(ball.vx, ball.vy);
  const decel = friction * DT;
  if (speed <= decel) {
    ball.vx = 0;
    ball.vy = 0;
  } else {
    const k = (speed - decel) / speed;
    ball.vx *= k;
    ball.vy *= k;
  }
}

/** v += SLOPE_ACCEL * DT along the downhill direction of the slope surface (no-op for other surfaces). */
export function applySlope(ball: BallState, surface: number): void {
  if (!isSlope(surface)) return;
  const d = slopeDir(surface);
  const a = simTuning.SLOPE_ACCEL * DT;
  ball.vx += a * (DIR_DX[d] ?? 0);
  ball.vy += a * (DIR_DY[d] ?? 0);
}

/**
 * Stop rule (§8.3 step 4). `forced` is true while a slope or magnet force acts: the ball then rests only after
 * FORCED_STOP_TICKS consecutive ticks below STOP_SPEED (wedged against a wall or held by a magnet); otherwise it rests
 * as soon as it is slower than STOP_SPEED. Updates ball.slowTicks; returns true when the ball should rest.
 */
export function shouldStop(ball: BallState, speed: number, forced: boolean): boolean {
  if (forced) {
    ball.slowTicks = speed < simTuning.STOP_SPEED ? ball.slowTicks + 1 : 0;
    return ball.slowTicks >= simTuning.FORCED_STOP_TICKS;
  }
  ball.slowTicks = 0;
  return speed < simTuning.STOP_SPEED;
}
