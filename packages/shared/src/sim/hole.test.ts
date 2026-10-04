import { afterEach, describe, expect, it } from 'vitest';
import { HOLE_CAPTURE_MAX_SPEED, HOLE_PULL_MAX_SPEED } from '../constants';
import { tileIndex } from '../course/grid';
import { createShotIterator, simulateShot } from './simulate';
import { blankRows, borderRows, buildLayers, freshWorld, hole, shotFor, start } from './testCourses';
import { resetSimTuning } from './tuning';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

const CUP = { x: 367.5, y: 187.5 }; // tile (24, 12)
const withHole = () => buildLayers(blankRows('.'), borderRows(), [start(3, 12), hole(24, 12)]);
const noHole = () => buildLayers(blankRows('.'), borderRows(), [start(3, 12)]);

describe('hole', () => {
  it('a slow ball is captured and snapped to the cup centre', () => {
    const layers = withHole();
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 300, y: 187.5 }), shotFor(200, 0));
    expect(o.result).toBe('holed');
    expect(o.holeIndex).toBe(0);
    expect(o.penalty).toBe(0);
    expect(o.ball).toMatchObject({ x: CUP.x, y: CUP.y, vx: 0, vy: 0, moving: false, lastTile: tileIndex(24, 12) });
    expect(o.events.at(-1)).toEqual({ tick: o.ticks, type: 'holed', hole: 0 });
    expect(o.ticks).toBeLessThan(120);
  });

  it('the funnel pulls a slightly off-centre slow ball in', () => {
    const layers = withHole();
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 300, y: 187.5 + 4 }), shotFor(200, 0));
    expect(o.result).toBe('holed');
  });

  it('a ball faster than the capture speed over the cup is deflected but rolls on (the lip)', () => {
    const layers = withHole();
    const ball = createBallAt({ x: 300, y: 187.5 + 4 });
    const it = createShotIterator(layers, freshWorld(layers), ball, shotFor(400, 0));
    let speedOverCup = 0;
    while (!it.done) {
      it.step();
      if (Math.abs(it.ball.x - CUP.x) < 2) speedOverCup = Math.hypot(it.ball.vx, it.ball.vy);
    }
    expect(speedOverCup).toBeGreaterThan(HOLE_CAPTURE_MAX_SPEED);
    expect(speedOverCup).toBeLessThan(HOLE_PULL_MAX_SPEED);
    expect(it.result).toBe('stopped');
    const reference = simulateShot(noHole(), freshWorld(noHole()), ball, shotFor(400, 0));
    expect(reference.ball.y).toBe(187.5 + 4);
    expect(Math.abs(it.ball.y - reference.ball.y)).toBeGreaterThan(1); // bent by the pull
  });

  it('a ball faster than HOLE_PULL_MAX_SPEED is unaffected: bit-identical to the hole-less course', () => {
    const a = createShotIterator(withHole(), freshWorld(withHole()), createBallAt({ x: 300, y: 191.5 }), shotFor(660, 0));
    const b = createShotIterator(noHole(), freshWorld(noHole()), createBallAt({ x: 300, y: 191.5 }), shotFor(660, 0));
    let passed = false;
    while (!a.done && !b.done && a.ball.x < 450) {
      a.step();
      b.step();
      expect(a.ball).toEqual(b.ball);
      if (a.ball.x > CUP.x) passed = true;
    }
    expect(passed).toBe(true);
    expect(Math.hypot(a.ball.vx, a.ball.vy)).toBeGreaterThan(HOLE_PULL_MAX_SPEED);
  });

  it('multiple holes each capture with their own holeIndex', () => {
    const layers = buildLayers(blankRows('.'), borderRows(), [start(3, 12), hole(24, 12), hole(24, 6)]);
    const second = simulateShot(layers, freshWorld(layers), createBallAt({ x: 367.5, y: 160 }), shotFor(0, -150));
    expect(second.result).toBe('holed');
    expect(second.holeIndex).toBe(1);
    expect(second.ball).toMatchObject({ x: 367.5, y: 97.5 });
    const first = simulateShot(layers, freshWorld(layers), createBallAt({ x: 300, y: 187.5 }), shotFor(200, 0));
    expect(first.holeIndex).toBe(0);
  });
});
