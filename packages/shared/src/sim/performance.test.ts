import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SHOT_TICKS } from '../constants';
import { simulateShot } from './simulate';
import { freshWorld, testCourse } from './testCourses';
import { resetSimTuning, setSimTuning } from './tuning';
import type { ShotInput } from './types';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

// The §15 acceptance criterion is "simulateShot of a 30 s shot < 5 ms in Node"; measured plain-Node figures are
// 2.4-2.8 ms. Under Vitest's module runner (instrumented ESM, a concurrent tsc or lint run on the same box) the same
// shot takes longer and the wall clock becomes noisy, so this guard asserts a wider budget and is skipped on CI
// (process.env.CI) where shared runners make any wall-clock assertion flaky. It still catches a real regression
// (an allocation in the hot path or an accidental extra segment query shows up as a multiple, not as 20 %).
const BUDGET_MS = 10;
const ON_CI = process.env['CI'] !== undefined && process.env['CI'] !== '' && process.env['CI'] !== 'false';

/** Best-of-N wall time of a full 30 s shot (friction zeroed so the ball never rests). */
function bestOf(name: string, shot: ShotInput, runs: number): { ms: number; ticks: number } {
  const layers = testCourse(name);
  const world = freshWorld(layers);
  const ball = createBallAt(layers.start);
  let ticks = 0;
  for (let i = 0; i < 3; i++) ticks = simulateShot(layers, world, ball, shot).ticks; // warm up the JIT
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    simulateShot(layers, world, ball, shot);
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, ticks };
}

describe('performance', () => {
  it('a 30 s shot on the ice course with bumpers runs the full MAX_SHOT_TICKS', () => {
    setSimTuning({ FRICTION_ICE: 0 });
    expect(bestOf('ice', { dx: 10000, dy: 3700 }, 1).ticks).toBe(MAX_SHOT_TICKS);
  });

  it.skipIf(ON_CI)(`a 30 s shot simulates in under ${BUDGET_MS} ms (best of 10, ice course with bumpers)`, () => {
    setSimTuning({ FRICTION_ICE: 0 });
    const r = bestOf('ice', { dx: 10000, dy: 3700 }, 10);
    expect(r.ticks).toBe(MAX_SHOT_TICKS);
    expect(r.ms).toBeLessThan(BUDGET_MS);
  });

  it.skipIf(ON_CI)(`a 30 s shot on the open course simulates in under ${BUDGET_MS} ms (best of 10)`, () => {
    setSimTuning({ FRICTION_GRASS: 0 });
    const r = bestOf('open', { dx: 10000, dy: 3700 }, 10);
    expect(r.ticks).toBe(MAX_SHOT_TICKS);
    expect(r.ms).toBeLessThan(BUDGET_MS);
  });
});
