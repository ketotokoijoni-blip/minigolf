import { afterEach, describe, expect, it } from 'vitest';
import { BALL_RADIUS } from '../constants';
import { tileIndex } from '../course/grid';
import { createShotIterator, simulateShot } from './simulate';
import { blankRows, borderRows, buildLayers, freshWorld, magnet, paint, paintCol, shotFor, start } from './testCourses';
import { resetSimTuning } from './tuning';
import type { ShotOutcome, SimEvent } from './types';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

const R = BALL_RADIUS;
const GATE = tileIndex(20, 12); // '>' in a wall column; tile spans x 300..315

function gateCourse() {
  const w = borderRows();
  paintCol(w, 20, 1, 23, '#');
  paint(w, 20, 12, '>');
  return buildLayers(blankRows('.'), w, [start(3, 12)]);
}

const onewayBounces = (o: ShotOutcome) =>
  o.events.filter((e) => e.type === 'bounce' && e.material === 'oneway') as Extract<SimEvent, { type: 'bounce' }>[];

describe('one-way blocks', () => {
  it('lets the ball through along the arrow', () => {
    const layers = gateCourse();
    const it = createShotIterator(layers, freshWorld(layers), createBallAt({ x: 52.5, y: 187.5 }), shotFor(500, 0));
    let inside = false;
    while (!it.done) {
      it.step();
      if (it.ball.x >= 300 && it.ball.x < 315) {
        inside = true;
        expect(it.ball.insideOneWay).toBe(GATE);
      }
    }
    expect(inside).toBe(true);
    expect(it.ball.x).toBeGreaterThan(315 + R);
    expect(it.ball.insideOneWay).toBe(-1);
    expect(onewayBounces({ events: it.events } as ShotOutcome)).toHaveLength(0);
    expect(it.result).toBe('stopped');
  });

  it('is solid against the arrow', () => {
    const layers = gateCourse();
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 457.5, y: 187.5 }), shotFor(-400, 0));
    const b = onewayBounces(o);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ tile: GATE, nx: 1, ny: 0 });
    expect(o.ball.x).toBeGreaterThan(315 + R);
  });

  it('its side faces are solid', () => {
    const w = borderRows();
    paint(w, 20, 12, '>');
    const layers = buildLayers(blankRows('.'), w, [start(3, 12)]);
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 307.5, y: 97.5 }), shotFor(0, 300));
    const b = onewayBounces(o);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ tile: GATE, nx: 0, ny: -1 });
    expect(o.ball.y).toBeLessThan(180 - R);
  });

  it('a ball that stopped inside can leave backwards (no trap), with or without the insideOneWay flag', () => {
    const layers = gateCourse();
    for (const flag of [GATE, -1]) {
      const ball = createBallAt({ x: 307.5, y: 187.5 });
      ball.insideOneWay = flag;
      const o = simulateShot(layers, freshWorld(layers), ball, shotFor(-300, 0));
      expect(o.result).toBe('stopped');
      expect(o.ball.x).toBeLessThan(300 - R);
      expect(onewayBounces(o)).toHaveLength(0);
    }
  });

  it('a ball reversed by a magnet while inside exits through the entry face', () => {
    const w = borderRows();
    paintCol(w, 20, 1, 23, '#');
    paint(w, 20, 12, '>');
    paint(w, 23, 12, '#'); // repelling magnet right behind the gate (strength kept below STOP_SPEED / DT = 600 px/s^2)
    const layers = buildLayers(blankRows('.'), w, [start(3, 12), magnet(23, 12, -1, 500, 150)]);
    let reversals = 0;
    for (const v0 of [215, 225, 235, 245, 255]) {
      const it = createShotIterator(layers, freshWorld(layers), createBallAt({ x: 262.5, y: 187.5 }), shotFor(v0, 0));
      let entered = false;
      let reversedInside = false;
      while (!it.done) {
        it.step();
        if (it.ball.x >= 300 && it.ball.x < 315) {
          entered = true;
          if (it.ball.vx < 0) reversedInside = true;
        }
      }
      expect(it.result, `v0 ${v0}`).toBe('stopped');
      if (entered) {
        // never left resting inside the gate: it either rolled on east (and may then be pushed back onto the gate's
        // solid back face) or came back out west
        expect(it.ball.x < 300 - R || it.ball.x > 315 + R, `v0 ${v0}: rests at ${it.ball.x}`).toBe(true);
      }
      if (reversedInside) {
        reversals++;
        expect(it.ball.x, `v0 ${v0}`).toBeLessThan(300 - R);
        expect(onewayBounces({ events: it.events } as ShotOutcome), `v0 ${v0}`).toHaveLength(0); // left through the entry face
      }
    }
    expect(reversals).toBeGreaterThan(0);
  });
});
