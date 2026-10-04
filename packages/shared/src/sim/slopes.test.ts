import { afterEach, describe, expect, it } from 'vitest';
import { BALL_RADIUS, DT, FIELD_H, FIELD_W, FORCED_STOP_TICKS, FRICTION_SLOPE, PENETRATION_SLOP, SLOPE_ACCEL, STOP_SPEED, TILE } from '../constants';
import { Surface } from '../course/types';
import { createShotIterator, simulateShot } from './simulate';
import { applySlope } from './surfaces';
import { blankRows, borderRows, buildLayers, freshWorld, shotFor, start } from './testCourses';
import { resetSimTuning } from './tuning';
import { cloneWorld, createBallAt } from './worldState';

const R = BALL_RADIUS;

afterEach(() => resetSimTuning());

function slopeCourse(ch: string) {
  return buildLayers(blankRows(ch), borderRows(), [start(24, 12)]);
}

describe('slopes', () => {
  it('applySlope adds SLOPE_ACCEL * DT along the downhill direction', () => {
    const ball = createBallAt({ x: 0, y: 0 });
    applySlope(ball, Surface.SlopeN);
    expect(ball.vy).toBeCloseTo(-SLOPE_ACCEL * DT, 12);
    applySlope(ball, Surface.SlopeE);
    expect(ball.vx).toBeCloseTo(SLOPE_ACCEL * DT, 12);
    applySlope(ball, Surface.Grass);
    expect(ball.vx).toBeCloseTo(SLOPE_ACCEL * DT, 12);
  });

  it('an uphill shot slows, returns and rolls down to the bottom wall where it wedges and rests', () => {
    const layers = slopeCourse('2'); // SlopeS: downhill is +y
    const start = { x: 367.5, y: 187.5 };
    const it = createShotIterator(layers, freshWorld(layers), createBallAt(start), shotFor(0, -200));
    let minY = Infinity;
    while (!it.done) {
      it.step();
      minY = Math.min(minY, it.ball.y);
    }
    expect(it.result).toBe('stopped');
    const uphill = (200 * 200) / (2 * (FRICTION_SLOPE + SLOPE_ACCEL));
    expect(Math.abs(start.y - minY - uphill)).toBeLessThan(200 * DT + 0.5);
    expect(it.ball.x).toBe(start.x);
    expect(it.ball.y).toBeGreaterThan(FIELD_H - TILE - R - 0.5);
    expect(it.ball.y).toBeLessThanOrEqual(FIELD_H - TILE - R - PENETRATION_SLOP + 1e-9);
    expect(it.ball.slowTicks).toBeGreaterThanOrEqual(FORCED_STOP_TICKS);
    expect(it.ctx.tick).toBeLessThan(1200);
  });

  it('the four directions are symmetric', () => {
    const shots: [string, number, number][] = [['8', 0, 150], ['2', 0, -150], ['6', -150, 0], ['4', 150, 0]];
    const finals = shots.map(([ch, vx, vy]) => {
      const layers = slopeCourse(ch);
      const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 367.5, y: 187.5 }), shotFor(vx, vy));
      expect(o.result).toBe('stopped');
      return { ticks: o.ticks, x: o.ball.x, y: o.ball.y };
    });
    const [n, s, e, w] = finals as [typeof finals[0], typeof finals[0], typeof finals[0], typeof finals[0]];
    expect(n.ticks).toBe(s.ticks);
    expect(e.ticks).toBe(w.ticks);
    expect(n.x).toBe(367.5);
    expect(s.x).toBe(367.5);
    expect(e.y).toBe(187.5);
    expect(w.y).toBe(187.5);
    // mirrored about the centre lines; the wedged phase jitters by a few 1/1000 px, so compare to 0.01 px
    expect(Math.abs(n.y + s.y - FIELD_H)).toBeLessThan(0.01);
    expect(Math.abs(e.x + w.x - FIELD_W)).toBeLessThan(0.01);
    expect(n.y).toBeCloseTo(TILE + R + PENETRATION_SLOP, 1);
  });

  it('a ball wedged against a wall on a slope rests after FORCED_STOP_TICKS slow ticks', () => {
    const layers = slopeCourse('2');
    const ball = createBallAt({ x: 367.5, y: FIELD_H - TILE - R - 0.02 });
    const it = createShotIterator(layers, freshWorld(layers), ball, shotFor(0, 40));
    let slowRun = 0;
    let maxSlowRun = 0;
    while (!it.done) {
      const status = it.step();
      const speed = Math.hypot(it.ball.vx, it.ball.vy);
      if (status === 'moving') {
        slowRun = speed < STOP_SPEED ? slowRun + 1 : 0;
        maxSlowRun = Math.max(maxSlowRun, slowRun);
      }
    }
    expect(it.result).toBe('stopped');
    expect(it.ctx.tick).toBeGreaterThanOrEqual(FORCED_STOP_TICKS);
    expect(it.ctx.tick).toBeLessThan(FORCED_STOP_TICKS * 4);
    expect(maxSlowRun).toBeGreaterThanOrEqual(FORCED_STOP_TICKS - 1);
    expect(it.ball.vx).toBe(0);
    expect(it.ball.vy).toBe(0);
  });

  it('a ball resting on a slope is not moved by another ball\'s shot and simulateShot leaves its inputs intact', () => {
    const layers = slopeCourse('6');
    const world = freshWorld(layers);
    const worldCopy = cloneWorld(world);
    const resting = { x: 500, y: 100 }; // another player's ball parked on the slope
    const shooter = createBallAt({ x: 367.5, y: 187.5 });
    const shooterCopy = { ...shooter };
    const o = simulateShot(layers, world, shooter, shotFor(100, 0), [resting]);
    expect(o.result).toBe('stopped');
    expect(resting).toEqual({ x: 500, y: 100 });
    expect(shooter).toEqual(shooterCopy);
    expect(world.walls).toEqual(worldCopy.walls);
    expect(world.breakHits).toEqual(worldCopy.breakHits);
    expect(world.minesArmed).toEqual(worldCopy.minesArmed);
    expect(o.ball).not.toBe(shooter);
    expect(o.world).not.toBe(world);
  });
});
