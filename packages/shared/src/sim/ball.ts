// Ball helpers (DESIGN §8.1). createBallAt lives in worldState.ts (WP0).
import { SHOT_QUANTUM } from '../constants';
import { tileOf } from '../course/grid';
import { simTuning } from './tuning';
import type { BallState, ShotInput } from './types';

export function cloneBall(b: BallState): BallState {
  return {
    x: b.x,
    y: b.y,
    vx: b.vx,
    vy: b.vy,
    moving: b.moving,
    lastTile: b.lastTile,
    teleportCooldownTile: b.teleportCooldownTile,
    insideOneWay: b.insideOneWay,
    slowTicks: b.slowTicks,
  };
}

/**
 * Launches the ball: vx = dx / SHOT_QUANTUM * POWER_SCALE (vy likewise), moving = true, slowTicks = 0.
 * lastTile is normalised to the tile under the resting ball (R5: "tile at the end of the previous tick"), so a shot
 * that starts on tar leaves the tile normally (`entered` is false for the start tile, §8.3 step 7c).
 */
export function applyShot(ball: BallState, shot: ShotInput): void {
  ball.vx = (shot.dx / SHOT_QUANTUM) * simTuning.POWER_SCALE;
  ball.vy = (shot.dy / SHOT_QUANTUM) * simTuning.POWER_SCALE;
  ball.moving = true;
  ball.slowTicks = 0;
  ball.lastTile = tileOf(ball.x, ball.y);
}
