import { afterEach, describe, expect, it } from 'vitest';
import { BALL_RADIUS, BREAK_DEBOUNCE_TICKS, BREAK_MIN_IMPACT_SPEED, RESTITUTION_BREAKABLE } from '../constants';
import { tileIndex } from '../course/grid';
import { WallShape } from '../course/types';
import { resolveCollisions } from './collision';
import { collectSegments, createSegmentBuffer } from './segments';
import { simulateShot } from './simulate';
import { blankRows, borderRows, buildLayers, freshWorld, launch, makeContext, paint, shotFor, start } from './testCourses';
import { resetSimTuning } from './tuning';
import type { ShotOutcome, SimEvent } from './types';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

const R = BALL_RADIUS;
const T11 = tileIndex(20, 11); // 'y' two hits
const T12 = tileIndex(20, 12); // 'x' one hit
const T13 = tileIndex(20, 13); // 'z' three hits

function course() {
  const w = borderRows();
  paint(w, 20, 11, 'y');
  paint(w, 20, 12, 'x');
  paint(w, 20, 13, 'z');
  return buildLayers(blankRows('.'), w, [start(3, 12)]);
}

const bounces = (o: ShotOutcome) => o.events.filter((e) => e.type === 'bounce') as Extract<SimEvent, { type: 'bounce' }>[];

describe('breakable blocks', () => {
  it('a one-hit block is destroyed, the ball still bounces with RESTITUTION_BREAKABLE, and the gap opens', () => {
    const layers = course();
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 52.5, y: 187.5 }), shotFor(400, 0));
    const b = bounces(o);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ material: 'breakable', tile: T12, nx: -1, ny: 0 });
    expect(b[0]!.speed).toBeGreaterThan(BREAK_MIN_IMPACT_SPEED);
    expect(o.events.filter((e) => e.type === 'destroyed')).toEqual([{ tick: b[0]!.tick, type: 'destroyed', tile: T12 }]);
    expect(o.world.walls[T12]).toBe(WallShape.None);
    expect(o.world.breakHits[T12]).toBe(1);
    expect(o.worldDelta).toEqual({ tiles: [{ i: T12, wall: WallShape.None, hits: 1 }], minesDisarmed: [] });
    expect(o.ball.x).toBeLessThan(300 - R);
    // the next shot rolls through the gap
    const o2 = simulateShot(layers, o.world, o.ball, shotFor(400, 0));
    expect(bounces(o2).filter((e) => e.material === 'breakable')).toHaveLength(0);
    expect(o2.ball.x).toBeGreaterThan(315);
  });

  it('two- and three-hit blocks count hits across shots and report hitsLeft', () => {
    const layers = course();
    let world = freshWorld(layers);
    let ball = createBallAt({ x: 52.5, y: 172.5 }); // row 11 -> 'y'
    let o = simulateShot(layers, world, ball, shotFor(400, 0));
    expect(o.events.filter((e) => e.type === 'break')).toEqual([{ tick: bounces(o)[0]!.tick, type: 'break', tile: T11, hitsLeft: 1 }]);
    expect(o.world.walls[T11]).toBe(WallShape.Breakable2);
    expect(o.world.breakHits[T11]).toBe(1);
    expect(o.worldDelta.tiles).toEqual([{ i: T11, wall: WallShape.Breakable2, hits: 1 }]);
    o = simulateShot(layers, o.world, o.ball, shotFor(400, 0));
    expect(o.events.filter((e) => e.type === 'destroyed')).toHaveLength(1);
    expect(o.world.walls[T11]).toBe(WallShape.None);

    world = freshWorld(layers);
    ball = createBallAt({ x: 52.5, y: 202.5 }); // row 13 -> 'z'
    const left: number[] = [];
    for (let i = 0; i < 3; i++) {
      o = simulateShot(layers, world, ball, shotFor(400, 0));
      for (const e of o.events) if (e.type === 'break') left.push(e.hitsLeft);
      world = o.world;
      ball = o.ball;
    }
    expect(left).toEqual([2, 1]);
    expect(world.walls[T13]).toBe(WallShape.None);
    expect(world.breakHits[T13]).toBe(3);
  });

  it('an impact below BREAK_MIN_IMPACT_SPEED bounces without counting', () => {
    const layers = course();
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 52.5, y: 187.5 }), shotFor(320, 0));
    const b = bounces(o);
    expect(b).toHaveLength(1);
    expect(b[0]!.material).toBe('breakable');
    expect(b[0]!.speed).toBeLessThan(BREAK_MIN_IMPACT_SPEED);
    expect(o.events.filter((e) => e.type === 'break' || e.type === 'destroyed')).toHaveLength(0);
    expect(o.world.breakHits[T12]).toBe(0);
    expect(o.world.walls[T12]).toBe(WallShape.Breakable1);
    expect(o.worldDelta.tiles).toEqual([]);
  });

  it('repeated hits on the same tile within BREAK_DEBOUNCE_TICKS count once; another tile counts at once', () => {
    const layers = course();
    const world = freshWorld(layers);
    const ball = createBallAt({ x: 300 - R + 1, y: 202.5 });
    const ctx = makeContext(layers, ball);
    const events: SimEvent[] = [];
    const hit = (tick: number, y: number) => {
      ball.x = 300 - R + 1;
      ball.y = y;
      launch(ball, 300, 0);
      ctx.tick = tick;
      resolveCollisions(layers, world, ball, ctx, events);
      expect(ball.vx).toBeCloseTo(-RESTITUTION_BREAKABLE * 300, 9);
    };
    hit(0, 202.5);
    expect(world.breakHits[T13]).toBe(1);
    hit(BREAK_DEBOUNCE_TICKS - 1, 202.5);
    expect(world.breakHits[T13]).toBe(1); // debounced
    hit(BREAK_DEBOUNCE_TICKS, 202.5);
    expect(world.breakHits[T13]).toBe(2);
    hit(BREAK_DEBOUNCE_TICKS + 1, 172.5); // 'y' above: a different tile is never debounced
    expect(world.breakHits[T11]).toBe(1);
    expect(events.filter((e) => e.type === 'break').map((e) => (e as { hitsLeft: number }).hitsLeft)).toEqual([2, 1, 1]);
    expect(events.filter((e) => e.type === 'bounce')).toHaveLength(4);
  });

  it('a destroyed tile disappears from the segments on re-query', () => {
    const layers = course();
    const buf = createSegmentBuffer();
    const before = collectSegments(layers.walls, 19, 12, buf);
    expect(buf.slice(0, before).some((s) => s.tile === T12)).toBe(true);
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 52.5, y: 187.5 }), shotFor(400, 0));
    const after = collectSegments(o.world.walls, 19, 12, buf);
    const segs = buf.slice(0, after);
    expect(segs.some((s) => s.tile === T12)).toBe(false);
    // the neighbours now expose the faces that used to be shared with the destroyed block
    expect(segs.some((s) => s.tile === T11 && s.side === 2)).toBe(true);
    expect(segs.some((s) => s.tile === T13 && s.side === 0)).toBe(true);
  });
});
