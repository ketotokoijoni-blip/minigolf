import { afterEach, describe, expect, it } from 'vitest';
import { BUMPER_MIN_EXIT_SPEED, MAX_SPEED, RESTITUTION_BUMPER } from '../constants';
import { tileIndex } from '../course/grid';
import { createShotIterator } from './simulate';
import { blankRows, borderRows, buildLayers, freshWorld, paint, shotFor, start } from './testCourses';
import { resetSimTuning } from './tuning';
import type { SimEvent } from './types';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

const BUMPER = tileIndex(24, 12); // west face at x = 360

function course() {
  const w = borderRows();
  paint(w, 24, 12, 'O');
  return buildLayers(blankRows('.'), w, [start(3, 12)]);
}

/** Runs a shot east from x0 and returns the first bumper bounce plus the velocity right after that tick. */
function hitBumper(x0: number, v0: number) {
  const layers = course();
  const it = createShotIterator(layers, freshWorld(layers), createBallAt({ x: x0, y: 187.5 }), shotFor(v0, 0));
  let bounce: Extract<SimEvent, { type: 'bounce' }> | null = null;
  let after = { vx: 0, vy: 0 };
  while (!it.done && bounce === null) {
    const n = it.events.length;
    it.step();
    const ev = it.events.slice(n).find((e) => e.type === 'bounce');
    if (ev !== undefined && ev.type === 'bounce') {
      bounce = ev;
      after = { vx: it.ball.vx, vy: it.ball.vy };
    }
  }
  while (!it.done) it.step();
  expect(bounce).not.toBeNull();
  expect(bounce).toMatchObject({ material: 'bumper', tile: BUMPER, nx: -1, ny: 0 });
  return { impact: bounce!.speed, after, result: it.result };
}

describe('bumper', () => {
  it('returns the ball faster than it arrived', () => {
    const { impact, after } = hitBumper(52.5, 500);
    expect(impact).toBeGreaterThan(BUMPER_MIN_EXIT_SPEED / RESTITUTION_BUMPER);
    expect(-after.vx).toBeCloseTo(RESTITUTION_BUMPER * impact, 9);
    expect(-after.vx).toBeGreaterThan(impact);
    expect(after.vy).toBe(0);
  });

  it('never returns the ball slower than BUMPER_MIN_EXIT_SPEED', () => {
    const { impact, after } = hitBumper(52.5, 364);
    expect(impact * RESTITUTION_BUMPER).toBeLessThan(BUMPER_MIN_EXIT_SPEED);
    expect(-after.vx).toBeCloseTo(BUMPER_MIN_EXIT_SPEED, 9);
  });

  it('is capped at MAX_SPEED after the substep', () => {
    const { impact, after } = hitBumper(337.5, 660);
    expect(impact * RESTITUTION_BUMPER).toBeGreaterThan(MAX_SPEED);
    expect(Math.hypot(after.vx, after.vy)).toBeCloseTo(MAX_SPEED, 9);
    expect(after.vx).toBeLessThan(0);
  });
});
