import { afterEach, describe, expect, it } from 'vitest';
import { DT, FRICTION_GRASS, MAX_TELEPORTS_PER_SHOT, TELEPORT_EXIT_OFFSET } from '../constants';
import { tileIndex } from '../course/grid';
import { createShotIterator, simulateShot } from './simulate';
import { blankRows, borderRows, buildLayers, freshWorld, paint, shotFor, start, teleport } from './testCourses';
import { resetSimTuning, setSimTuning } from './tuning';
import type { SimEvent } from './types';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

const A = { tile: tileIndex(10, 12), x: 157.5, y: 187.5 };
const B = { tile: tileIndex(30, 12), x: 457.5, y: 187.5 };
const ORIGIN = { x: 52.5, y: 187.5 };

function padCourse(extraWalls: [number, number][] = []) {
  const w = borderRows();
  for (const [x, y] of extraWalls) paint(w, x, y, '#');
  return buildLayers(blankRows('.'), w, [start(3, 12), teleport(10, 12, 0), teleport(30, 12, 0)]);
}

describe('teleport', () => {
  it('moves the ball to the partner pad plus the exit offset, keeping its velocity', () => {
    const layers = padCourse();
    const it = createShotIterator(layers, freshWorld(layers), createBallAt(ORIGIN), shotFor(300, 0));
    let before = { vx: 0, vy: 0, x: 0 };
    let seen: Extract<SimEvent, { type: 'teleport' }> | null = null;
    while (!it.done && seen === null) {
      before = { vx: it.ball.vx, vy: it.ball.vy, x: it.ball.x };
      const n = it.events.length;
      it.step();
      const ev = it.events[n];
      if (ev !== undefined && ev.type === 'teleport') seen = ev;
    }
    expect(seen).toEqual({ tick: it.ctx.tick - 1, type: 'teleport', from: A.tile, to: B.tile });
    expect(before.x).toBeLessThan(A.x);
    expect(it.ball.x).toBe(B.x + TELEPORT_EXIT_OFFSET);
    expect(it.ball.y).toBe(B.y);
    expect(it.ball.vx).toBeCloseTo(before.vx - FRICTION_GRASS * DT, 9); // only that tick's friction
    expect(it.ball.vy).toBe(0);
    expect(it.ball.teleportCooldownTile).toBe(B.tile);
    expect(it.ball.lastTile).toBe(B.tile);
    expect(it.ctx.teleportCount).toBe(1);
  });

  it('the cooldown prevents an immediate return trip and clears once the ball leaves the pad tile', () => {
    const layers = padCourse();
    const o = simulateShot(layers, freshWorld(layers), createBallAt(ORIGIN), shotFor(300, 0));
    expect(o.result).toBe('stopped');
    expect(o.events.filter((e) => e.type === 'teleport')).toHaveLength(1);
    expect(o.ball.x).toBeGreaterThan(B.x + 15);
    expect(o.ball.teleportCooldownTile).toBe(-1);
  });

  it('a ball that bounces back onto the exit pad after leaving its tile is teleported again', () => {
    const layers = padCourse([[32, 12]]); // wall just east of B
    const o = simulateShot(layers, freshWorld(layers), createBallAt(ORIGIN), shotFor(400, 0));
    const tp = o.events.filter((e) => e.type === 'teleport') as Extract<SimEvent, { type: 'teleport' }>[];
    expect(tp.map((e) => [e.from, e.to])).toEqual([[A.tile, B.tile], [B.tile, A.tile]]);
    expect(o.result).toBe('stopped');
    expect(o.ball.x).toBeLessThan(A.x);
  });

  it('after MAX_TELEPORTS_PER_SHOT the pads are ignored for the rest of the shot', () => {
    setSimTuning({ RESTITUTION_WALL: 1, FRICTION_GRASS: 0 }); // lossless ping-pong between two dead ends
    const layers = padCourse([[32, 12], [8, 12]]);
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 145, y: 187.5 }), shotFor(300, 0));
    expect(o.events.filter((e) => e.type === 'teleport')).toHaveLength(MAX_TELEPORTS_PER_SHOT);
    expect(o.result).toBe('timeout');
    expect(o.ticks).toBe(3600);
    expect(o.ball.vx).toBe(0);
    expect(o.ball.vy).toBe(0);
  });
});
