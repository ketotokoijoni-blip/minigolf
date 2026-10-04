// One tick of the simulation (DESIGN §8.3), executed only while ball.moving. ctx.tick follows the printed algorithm
// exactly: it is the 0-based index of the current tick while the tick runs (every event emitted during it carries that
// value) and is incremented only in step 8, i.e. after a tick that leaves the ball moving. A shot that ends on its N-th
// step() call therefore reports ticks = N - 1 (the terminal event carries tick === ticks); only a timeout reports
// ticks === MAX_SHOT_TICKS.
import { MAX_SHOT_TICKS, SUBSTEPS, SUB_DT } from '../constants';
import { isOneWay, isSlope } from '../course/chars';
import { tileOf } from '../course/grid';
import { Surface } from '../course/types';
import type { CourseLayers } from '../course/types';
import { len } from '../math/vec';
import { resolveCollisions } from './collision';
import { applyHolePull, applyMagnets, findCapturingHole, findTriggeredMine, resetBall, tryTeleport } from './objects';
import { applyFriction, applySlope, frictionFor, shouldStop } from './surfaces';
import { simTuning } from './tuning';
import type { BallState, SimContext, SimEvent, StepStatus, WorldState } from './types';

// Module-local aliases for the per-tick hot path (see collision.ts for the rationale).
const N_SUB = SUBSTEPS;
const H_SUB = SUB_DT;
const MAX_TICKS = MAX_SHOT_TICKS;
const GRASS = Surface.Grass;
const TAR = Surface.Tar;
const WATER = Surface.Water;
const ACID = Surface.Acid;
const tileOfL = tileOf;
const lenL = len;
const resolve = resolveCollisions;

function halt(ball: BallState): void {
  ball.vx = 0;
  ball.vy = 0;
  ball.moving = false;
}

function clampSpeed(ball: BallState, max: number): void {
  const speed = lenL(ball.vx, ball.vy);
  if (speed > max) {
    const k = max / speed;
    ball.vx *= k;
    ball.vy *= k;
  }
}

/** Advances the ball by exactly one tick. Precondition: ball.moving (returns 'stopped' without side effects otherwise). */
export function stepTick(
  layers: CourseLayers, world: WorldState, ball: BallState, ctx: SimContext, events: SimEvent[],
): StepStatus {
  if (!ball.moving) return 'stopped';
  const t = simTuning;

  // 1-2  surface under the centre, forces
  let tile = tileOfL(ball.x, ball.y);
  const surf = layers.surface[tile] ?? GRASS;
  const onSlope = isSlope(surf);
  if (onSlope) applySlope(ball, surf);
  const magnetForce = layers.magnets.length > 0 && applyMagnets(layers, ball);
  applyHolePull(layers, ball);

  // 3  friction
  applyFriction(ball, frictionFor(surf));

  // 4  stop rule
  const speed = lenL(ball.vx, ball.vy);
  if (shouldStop(ball, speed, onSlope || magnetForce)) {
    halt(ball);
    events.push({ tick: ctx.tick, type: 'stopped' });
    return 'stopped';
  }

  // 5  clamp
  const maxSpeed = t.MAX_SPEED;
  if (speed > maxSpeed) {
    const k = maxSpeed / speed;
    ball.vx *= k;
    ball.vy *= k;
  }

  // 6  substeps
  for (let s = 0; s < N_SUB; s++) {
    ball.x += ball.vx * H_SUB;
    ball.y += ball.vy * H_SUB;
    resolve(layers, world, ball, ctx, events);
    clampSpeed(ball, maxSpeed);
  }

  // 7  object checks at the ball centre
  tile = tileOfL(ball.x, ball.y);
  const entered = tile !== ball.lastTile;
  if (ball.teleportCooldownTile !== -1 && tile !== ball.teleportCooldownTile) ball.teleportCooldownTile = -1;
  ball.insideOneWay = isOneWay(world.walls[tile] ?? 0) ? tile : -1;
  const surfNow = layers.surface[tile] ?? GRASS;
  if (surfNow === TAR && entered) {
    halt(ball);
    events.push({ tick: ctx.tick, type: 'tar', tile });
    ball.lastTile = tile;
    return 'stopped';
  }
  if (surfNow === WATER) {
    events.push({ tick: ctx.tick, type: 'water', tile });
    resetBall(ball, ctx.shotOrigin);
    return 'water';
  }
  if (surfNow === ACID) {
    events.push({ tick: ctx.tick, type: 'acid', tile });
    resetBall(ball, ctx.startPos);
    return 'acid';
  }
  if (layers.mines.length > 0) {
    const mine = findTriggeredMine(layers, world, ball);
    if (mine !== -1) {
      world.minesArmed[mine] = 0;
      events.push({ tick: ctx.tick, type: 'mine', index: mine });
      resetBall(ball, ctx.shotOrigin);
      return 'mine';
    }
  }
  if (layers.teleports.length > 0) {
    const teleportedTo = tryTeleport(layers, ball, ctx, events);
    if (teleportedTo !== -1) tile = teleportedTo;
  }
  const hole = findCapturingHole(layers, ball);
  if (hole !== -1) {
    const h = layers.holes[hole];
    if (h !== undefined) {
      ball.x = h.cx;
      ball.y = h.cy;
      ball.lastTile = h.tile;
    }
    halt(ball);
    events.push({ tick: ctx.tick, type: 'holed', hole });
    return 'holed';
  }
  ball.lastTile = tile;

  // 8  tick count and the 30 s cap
  ctx.tick++;
  if (ctx.tick >= MAX_TICKS) {
    halt(ball);
    events.push({ tick: ctx.tick - 1, type: 'timeout' });
    return 'timeout';
  }
  return 'moving';
}
