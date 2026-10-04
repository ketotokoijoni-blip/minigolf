import { afterEach, describe, expect, it } from 'vitest';
import { BALL_RADIUS, DT, FORCED_STOP_TICKS, MAGNET_DEAD_ZONE, MAX_SHOT_TICKS } from '../constants';
import type { Polarity } from '../course/types';
import { applyMagnets } from './objects';
import { simulateShot } from './simulate';
import { blankRows, borderRows, buildLayers, freshWorld, magnet, paint, shotFor, start } from './testCourses';
import { resetSimTuning } from './tuning';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

const C = { x: 367.5, y: 187.5 }; // tile (24, 12)

function magnetCourse(polarity: Polarity | 0) {
  const w = borderRows();
  paint(w, 24, 12, '#');
  const objects = [start(3, 12)];
  if (polarity !== 0) objects.push(magnet(24, 12, polarity, 350, 90));
  return buildLayers(blankRows('.'), w, objects);
}

/** Magnet object on a plain tile (no block), so the ball can reach the centre. */
function bareMagnet(x: number, y: number, polarity: Polarity) {
  return buildLayers(blankRows('.'), borderRows(), [start(3, 3), magnet(x, y, polarity, 350, 90)]);
}

describe('magnet', () => {
  it('attract bends the path toward the block, repel away from it', () => {
    const from = { x: 52.5, y: 112.5 }; // passes 75 px north of the centre
    const none = simulateShot(magnetCourse(0), freshWorld(magnetCourse(0)), createBallAt(from), shotFor(500, 0));
    const attract = simulateShot(magnetCourse(1), freshWorld(magnetCourse(1)), createBallAt(from), shotFor(500, 0));
    const repel = simulateShot(magnetCourse(-1), freshWorld(magnetCourse(-1)), createBallAt(from), shotFor(500, 0));
    expect(none.ball.y).toBe(from.y);
    expect(none.result).toBe('stopped');
    expect(attract.ball.y).toBeGreaterThan(from.y + 5);
    expect(repel.ball.y).toBeLessThan(from.y - 5);
    expect(attract.result).toBe('stopped');
    expect(repel.result).toBe('stopped');
  });

  it('no force beyond the radius, none inside the dead zone, linear falloff in between', () => {
    const layers = bareMagnet(24, 12, 1);
    const far = createBallAt({ x: C.x + 100, y: C.y });
    far.vx = 10;
    expect(applyMagnets(layers, far)).toBe(false);
    expect(far.vx).toBe(10);
    const edge = createBallAt({ x: C.x + 90, y: C.y });
    expect(applyMagnets(layers, edge)).toBe(false);
    const dead = createBallAt({ x: C.x + 2, y: C.y });
    expect(applyMagnets(layers, dead)).toBe(false);
    expect(dead.vx).toBe(0);
    expect(dead.vy).toBe(0);
    const onEdge = createBallAt({ x: C.x + MAGNET_DEAD_ZONE, y: C.y });
    expect(applyMagnets(layers, onEdge)).toBe(false);
    const near = createBallAt({ x: C.x + 4, y: C.y });
    expect(applyMagnets(layers, near)).toBe(true);
    expect(near.vx).toBeCloseTo(-350 * (1 - 4 / 90) * DT, 12);
    expect(near.vy).toBe(0);
    const mid = createBallAt({ x: C.x, y: C.y - 45 });
    expect(applyMagnets(layers, mid)).toBe(true);
    expect(mid.vy).toBeCloseTo(350 * 0.5 * DT, 12);
    const repel = createBallAt({ x: C.x, y: C.y - 45 });
    applyMagnets(bareMagnet(24, 12, -1), repel);
    expect(repel.vy).toBeCloseTo(-350 * 0.5 * DT, 12);
  });

  it('two magnets sum their accelerations', () => {
    const both = buildLayers(blankRows('.'), borderRows(), [start(3, 3), magnet(20, 12, 1, 350, 90), magnet(28, 12, 1, 350, 90)]);
    const p = { x: 367.5, y: 150 };
    const a = createBallAt(p);
    applyMagnets(bareMagnet(20, 12, 1), a);
    const b = createBallAt(p);
    applyMagnets(bareMagnet(28, 12, 1), b);
    const sum = createBallAt(p);
    expect(applyMagnets(both, sum)).toBe(true);
    expect(sum.vx).toBeCloseTo(a.vx + b.vx, 12);
    expect(sum.vy).toBeCloseTo(a.vy + b.vy, 12);
    expect(Math.abs(sum.vx)).toBeLessThan(1e-9); // symmetric pair cancels sideways
    expect(sum.vy).toBeGreaterThan(0);
  });

  it('a slow ball pulled against an attracting block rests through the forced-stop rule', () => {
    const layers = magnetCourse(1);
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 307.5, y: 187.5 }), shotFor(100, 0));
    expect(o.result).toBe('stopped');
    expect(o.ticks).toBeGreaterThanOrEqual(FORCED_STOP_TICKS);
    expect(o.ticks).toBeLessThan(MAX_SHOT_TICKS / 6);
    expect(Math.abs(o.ball.x - (360 - BALL_RADIUS))).toBeLessThan(1);
    expect(o.ball.y).toBe(187.5);
    expect(o.ball.slowTicks).toBeGreaterThanOrEqual(FORCED_STOP_TICKS);
    expect(o.ball.vx).toBe(0);
  });

  // Contract gap reported to the lead (not fixable in WP-B files): constants.ts allows MAGNET_MAX_STRENGTH = 1200, but
  // at contact distance (R + TILE/2 = 13.5 px, radius 90) any attract strength above ~550 px/s^2 adds more than
  // STOP_SPEED per tick, so the §8.3 forced-stop rule never sees FORCED_STOP_TICKS consecutive slow ticks and such a
  // shot runs to the 30 s cap. Either MAGNET_MAX_STRENGTH drops to <= ~500 or §5.4/§8.3 gain a displacement-based
  // wedge test. The todo below becomes a real test once the lead has ruled.
  it.todo('a slow ball pulled against an attracting block of MAGNET_MAX_STRENGTH rests through the forced-stop rule');
});
