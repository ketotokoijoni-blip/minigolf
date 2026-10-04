// Collision resolution (DESIGN §8.5). Deepest-penetration-first over the segments of the 3x3 neighbourhood, up to
// RESOLVE_ITERATIONS passes, re-querying the segments after every push (the push may move the ball to another tile and
// the response may change the walls: breakable destroyed, movable block moved). The tangential velocity component is
// never touched, so a ball grazing a wall slides along it.
//
// Push-through rule (§8.5 "centre behind an interior point"), made precise: a face may only push a ball that lies in
// front of its line. When the ball centre is inside the solid of a tile (which the 2.5 px substep bound makes a rare
// safety case), the ball is pushed out through the nearest emitted face of that solid by R + dist. Taking the literal
// "behind the line" test instead would treat a ball resting above a block as 21 px behind the block's south face and
// catapult it through the block.
import { BALL_RADIUS, FIELD_H, FIELD_W, TILE } from '../constants';
import { DIR_DX, DIR_DY, breakableHits } from '../course/chars';
import { centreInsideTile, inBounds, tileIndex, tileOf, tileX, tileY } from '../course/grid';
import { Surface, WallShape } from '../course/types';
import type { CourseLayers, Vec2 } from '../course/types';
import { len } from '../math/vec';
import { collectSegments, createSegmentBuffer } from './segments';
import type { Segment } from './segments';
import { simTuning } from './tuning';
import type { BallState, SimContext, SimEvent, WorldState } from './types';

export interface ClosestPoint { x: number; y: number; t: number }

// Scratch results of closest() (allocation-free hot path); the exported closestPointOnSegment wraps them in an object.
let qx = 0;
let qy = 0;
let qt = 0;

function closest(px: number, py: number, ax: number, ay: number, bx: number, by: number): void {
  const ex = bx - ax;
  const ey = by - ay;
  const l2 = ex * ex + ey * ey; // > 0 for every wall segment (15 px legs, 15*sqrt2 px hypotenuses)
  let t = ((px - ax) * ex + (py - ay) * ey) / l2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  qt = t;
  qx = ax + t * ex;
  qy = ay + t * ey;
}

/** t = clamp(((p-a)·(b-a)) / |b-a|^2, 0, 1); q = a + t (b-a). */
export function closestPointOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): ClosestPoint {
  closest(px, py, ax, ay, bx, by);
  return { x: qx, y: qy, t: qt };
}

const SEGS = createSegmentBuffer();

// Module-local aliases of the grid helpers used per segment / per iteration (hot path; a module-local binding is a
// plain variable for every bundler and test runner, an imported one may be a live-binding getter).
const tileOfL = tileOf;
const tileXL = tileX;
const tileYL = tileY;
const centreInsideTileL = centreInsideTile;
const R = BALL_RADIUS;
// Reach of the cheap bounding-box prefilter. A segment farther than R from the centre cannot touch the ball, and a
// centre inside a solid tile is at most TILE/2 = 7.5 px from that tile's nearest face, so REACH >= 7.5 skips nothing.
const REACH = BALL_RADIUS + 2;
const FW = FIELD_W;
const FH = FIELD_H;
const T = TILE;

/** True when the point lies inside the solid part of the segment's tile (the whole tile for blocks, the solid half for
 *  triangles, anything outside the field for border segments). */
export function centreInsideSolid(walls: Uint8Array, seg: Segment, x: number, y: number): boolean {
  if (seg.tile < 0) return x < 0 || y < 0 || x >= FW || y >= FH;
  if (!centreInsideTileL(x, y, seg.tile)) return false;
  const lx = x - tileXL(seg.tile) * T;
  const ly = y - tileYL(seg.tile) * T;
  switch (walls[seg.tile]) {
    case WallShape.TriNW:
      return lx + ly < T;
    case WallShape.TriNE:
      return lx > ly;
    case WallShape.TriSE:
      return lx + ly > T;
    case WallShape.TriSW:
      return ly > lx;
    default:
      return true;
  }
}

function otherBallInTile(balls: readonly Vec2[], tile: number): boolean {
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b !== undefined && centreInsideTile(b.x, b.y, tile)) return true;
  }
  return false;
}

function reflect(ball: BallState, nx: number, ny: number, vn: number, e: number): void {
  ball.vx -= (1 + e) * vn * nx;
  ball.vy -= (1 + e) * vn * ny;
}

/** Velocity response of the chosen contact; `vn` (< 0) is the normal velocity before the response. */
function respond(
  layers: CourseLayers, world: WorldState, ball: BallState, ctx: SimContext, events: SimEvent[],
  seg: Segment, nx: number, ny: number, vn: number,
): void {
  const t = simTuning;
  const impact = -vn;
  const tile = seg.tile;
  // Border segments (the implicit out-of-bounds ring, §8.4) carry tile = -1 with material 'border'; consumers must branch
  // on material === 'border' (or tile < 0) before deriving tile coordinates from a bounce event.
  if (impact >= t.BOUNCE_EVENT_MIN_SPEED) {
    events.push({ tick: ctx.tick, type: 'bounce', x: ball.x, y: ball.y, nx, ny, speed: impact, tile, material: seg.material });
  }
  switch (seg.material) {
    case 'bumper': {
      reflect(ball, nx, ny, vn, t.RESTITUTION_BUMPER);
      const speed = len(ball.vx, ball.vy);
      const min = t.BUMPER_MIN_EXIT_SPEED;
      if (speed < min) {
        if (speed > 1e-9) {
          const k = min / speed;
          ball.vx *= k;
          ball.vy *= k;
        } else {
          ball.vx = nx * min;
          ball.vy = ny * min;
        }
      }
      return;
    }
    case 'breakable': {
      reflect(ball, nx, ny, vn, t.RESTITUTION_BREAKABLE);
      const debounced = ctx.lastBreakTile === tile && ctx.tick - ctx.lastBreakTick < t.BREAK_DEBOUNCE_TICKS;
      if (impact >= t.BREAK_MIN_IMPACT_SPEED && !debounced) {
        const hits = (world.breakHits[tile] ?? 0) + 1;
        world.breakHits[tile] = hits;
        ctx.lastBreakTile = tile;
        ctx.lastBreakTick = ctx.tick;
        const needed = breakableHits(world.walls[tile] ?? 0);
        if (hits >= needed) {
          world.walls[tile] = WallShape.None;
          events.push({ tick: ctx.tick, type: 'destroyed', tile });
        } else {
          events.push({ tick: ctx.tick, type: 'break', tile, hitsLeft: needed - hits });
        }
      }
      return;
    }
    case 'movable': {
      let moved = false;
      if (impact >= t.MOVABLE_MIN_IMPACT_SPEED) {
        // Push direction = dominant axis of -n (ties -> horizontal).
        const px = -nx;
        const py = -ny;
        let dx = 0;
        let dy = 0;
        if (Math.abs(px) >= Math.abs(py)) dx = px > 0 ? 1 : -1;
        else dy = py > 0 ? 1 : -1;
        const x = tileX(tile) + dx;
        const y = tileY(tile) + dy;
        if (inBounds(x, y)) {
          const target = tileIndex(x, y);
          const surf = layers.surface[target];
          if (
            world.walls[target] === WallShape.None &&
            layers.objectAt[target] === -1 &&
            surf !== Surface.Water && surf !== Surface.Acid &&
            !otherBallInTile(ctx.otherBalls, target)
          ) {
            world.walls[target] = WallShape.Movable;
            world.walls[tile] = WallShape.None;
            moved = true;
            events.push({ tick: ctx.tick, type: 'blockMoved', from: tile, to: target });
          }
        }
      }
      reflect(ball, nx, ny, vn, moved ? t.RESTITUTION_MOVABLE : t.RESTITUTION_WALL);
      return;
    }
    default: // 'wall' | 'border' | 'oneway'
      reflect(ball, nx, ny, vn, t.RESTITUTION_WALL);
      return;
  }
}

/**
 * Pushes the ball out of the deepest contact and reflects its normal velocity, up to RESOLVE_ITERATIONS times.
 * One-way faces are ignored while the centre is inside the block (or the ball is still flagged insideOneWay for it),
 * and the entry and exit faces are open while the ball moves along the arrow; the side faces are always solid.
 */
export function resolveCollisions(
  layers: CourseLayers, world: WorldState, ball: BallState, ctx: SimContext, events: SimEvent[],
): void {
  const slop = simTuning.PENETRATION_SLOP;
  const iterations = simTuning.RESOLVE_ITERATIONS;
  const walls = world.walls;
  let tile = tileOfL(ball.x, ball.y);
  let n = collectSegments(walls, tileXL(tile), tileYL(tile), SEGS);
  for (let iter = 0; iter < iterations; iter++) {
    let best: Segment | null = null;     // deepest regular contact (centre in front of the face)
    let bestPen = 0;
    let bestNx = 0;
    let bestNy = 0;
    let inside: Segment | null = null;   // nearest emitted face of a solid the centre is inside of
    let insideDist = 0;
    for (let k = 0; k < n; k++) {
      const seg = SEGS[k];
      if (seg === undefined) break;
      const ax = seg.ax;
      const bx = seg.bx;
      const ay = seg.ay;
      const by = seg.by;
      if (ball.x < (ax < bx ? ax : bx) - REACH || ball.x > (ax > bx ? ax : bx) + REACH) continue;
      if (ball.y < (ay < by ? ay : by) - REACH || ball.y > (ay > by ? ay : by) + REACH) continue;
      if (seg.material === 'oneway') {
        if (ball.insideOneWay === seg.tile || centreInsideTileL(ball.x, ball.y, seg.tile)) continue;
        const along = ball.vx * (DIR_DX[seg.dir] ?? 0) + ball.vy * (DIR_DY[seg.dir] ?? 0);
        if (along > 0 && (seg.side === (seg.dir + 2) % 4 || seg.side === seg.dir)) continue;
      }
      closest(ball.x, ball.y, ax, ay, bx, by);
      const dx = ball.x - qx;
      const dy = ball.y - qy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dx * seg.nx + dy * seg.ny < 0) {
        // Centre behind the face line. The printed §8.5 rule ("0 < t < 1 and behind => pen = R + dist") would also fire for
        // a ball resting on top of an isolated block (21 px behind its S face) and push it through the block, so a face
        // only pushes a centre that is in front of its line; a centre truly inside this tile's solid (whole block, solid
        // half of a triangle, off-field for the border) is ejected through the nearest emitted face by R + dist below.
        if (centreInsideSolid(walls, seg, ball.x, ball.y) && (inside === null || dist < insideDist)) {
          inside = seg;
          insideDist = dist;
        }
        continue;
      }
      const pen = R - dist;
      if (pen <= 0) continue;
      let nx: number;
      let ny: number;
      if (dist > 1e-9) {
        nx = dx / dist; // endpoint => corner normal
        ny = dy / dist;
      } else {
        nx = seg.nx;
        ny = seg.ny;
      }
      if (best === null || pen > bestPen) { // strict '>' => first in scan order wins ties
        best = seg;
        bestPen = pen;
        bestNx = nx;
        bestNy = ny;
      }
    }
    if (inside !== null) {
      best = inside;
      bestPen = R + insideDist;
      bestNx = inside.nx;
      bestNy = inside.ny;
    }
    if (best === null) return;
    ball.x += bestNx * (bestPen + slop);
    ball.y += bestNy * (bestPen + slop);
    const vn = ball.vx * bestNx + ball.vy * bestNy;
    if (vn < 0) respond(layers, world, ball, ctx, events, best, bestNx, bestNy, vn);
    tile = tileOfL(ball.x, ball.y);
    n = collectSegments(walls, tileXL(tile), tileYL(tile), SEGS);
  }
}
