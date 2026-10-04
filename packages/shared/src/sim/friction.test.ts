import { afterEach, describe, expect, it } from 'vitest';
import { DT, FRICTION_GRASS, FRICTION_ICE, FRICTION_SAND, STOP_SPEED } from '../constants';
import { Surface } from '../course/types';
import { simulateShot, createShotIterator } from './simulate';
import { applyFriction, frictionFor } from './surfaces';
import { blankRows, borderRows, buildLayers, freshWorld, shotFor, start } from './testCourses';
import { resetSimTuning } from './tuning';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

function flatCourse(surfaceChar: string) {
  return buildLayers(blankRows(surfaceChar), borderRows(), [start(3, 12)]);
}

/** Travelled distance of a straight shot east at v0 px/s on the given surface. */
function rollDistance(surfaceChar: string, v0: number): number {
  const layers = flatCourse(surfaceChar);
  const ball = createBallAt({ x: 52.5, y: 187.5 });
  const o = simulateShot(layers, freshWorld(layers), ball, shotFor(v0, 0));
  expect(o.result).toBe('stopped');
  expect(o.ball.y).toBe(187.5);
  return o.ball.x - 52.5;
}

describe('friction', () => {
  it('frictionFor maps surfaces to the tunables (tar/water/acid use the grass value)', () => {
    expect(frictionFor(Surface.Grass)).toBe(FRICTION_GRASS);
    expect(frictionFor(Surface.Tar)).toBe(FRICTION_GRASS);
    expect(frictionFor(Surface.Water)).toBe(FRICTION_GRASS);
    expect(frictionFor(Surface.Acid)).toBe(FRICTION_GRASS);
    expect(frictionFor(Surface.Sand)).toBe(FRICTION_SAND);
    expect(frictionFor(Surface.Ice)).toBe(FRICTION_ICE);
  });

  it('applyFriction removes a constant speed per tick opposing the velocity and halts below it', () => {
    const ball = createBallAt({ x: 0, y: 0 });
    ball.vx = 300;
    ball.vy = 400; // speed 500
    applyFriction(ball, FRICTION_GRASS);
    const k = (500 - FRICTION_GRASS * DT) / 500;
    expect(ball.vx).toBeCloseTo(300 * k, 12);
    expect(ball.vy).toBeCloseTo(400 * k, 12);
    ball.vx = 1;
    ball.vy = 1; // speed 1.41 < 200/120 = 1.67
    applyFriction(ball, FRICTION_GRASS);
    expect(ball.vx).toBe(0);
    expect(ball.vy).toBe(0);
  });

  it('stopping distance is v^2 / (2a) within one tick of travel on grass, sand and ice', () => {
    const cases: [string, number, number][] = [['.', 300, FRICTION_GRASS], ['s', 300, FRICTION_SAND], ['i', 100, FRICTION_ICE]];
    for (const [ch, v0, a] of cases) {
      const d = rollDistance(ch, v0);
      const analytic = (v0 * v0) / (2 * a);
      // discrete integration loses about half a tick of travel, the STOP_SPEED cutoff the last STOP_SPEED^2 / (2a)
      expect(Math.abs(d - analytic), `surface '${ch}'`).toBeLessThanOrEqual(v0 * DT + (STOP_SPEED * STOP_SPEED) / (2 * a));
    }
  });

  it('ice slides far longer than sand', () => {
    const sand = rollDistance('s', 300);
    const ice = rollDistance('i', 100);
    expect(ice).toBeGreaterThan(sand * 3);
  });

  it('the ball rests as soon as it is slower than STOP_SPEED and never moves slower than that', () => {
    const layers = flatCourse('.');
    const it = createShotIterator(layers, freshWorld(layers), createBallAt({ x: 52.5, y: 187.5 }), shotFor(250, 0));
    let lastMovingSpeed = Infinity;
    while (!it.done) {
      const status = it.step();
      const speed = Math.hypot(it.ball.vx, it.ball.vy);
      if (status === 'moving') {
        expect(speed).toBeGreaterThanOrEqual(STOP_SPEED);
        lastMovingSpeed = speed;
      }
    }
    expect(it.result).toBe('stopped');
    expect(it.ball.moving).toBe(false);
    expect(it.ball.vx).toBe(0);
    expect(it.ball.vy).toBe(0);
    // the last moving speed was at most one tick of friction above the threshold
    expect(lastMovingSpeed).toBeLessThan(STOP_SPEED + FRICTION_GRASS * DT);
    expect(it.events.at(-1)).toEqual({ tick: it.ctx.tick, type: 'stopped' });
  });
});
