import { afterEach, describe, expect, it } from 'vitest';
import { BALL_RADIUS, MOVABLE_MIN_IMPACT_SPEED, RESTITUTION_MOVABLE, RESTITUTION_WALL } from '../constants';
import { tileIndex } from '../course/grid';
import { WallShape } from '../course/types';
import type { CourseObject, Vec2 } from '../course/types';
import { createShotIterator, simulateShot } from './simulate';
import { blankRows, borderRows, buildLayers, centreOf, freshWorld, hole, paint, shotFor, start } from './testCourses';
import { resetSimTuning } from './tuning';
import type { ShotOutcome, SimEvent } from './types';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

const R = BALL_RADIUS;
const T20 = tileIndex(20, 12);
const T21 = tileIndex(21, 12);
const T22 = tileIndex(22, 12);

function course(opts: { eastWall?: boolean; eastObject?: CourseObject; eastSurface?: string } = {}) {
  const w = borderRows();
  paint(w, 20, 12, 'M');
  if (opts.eastWall) paint(w, 21, 12, '#');
  const s = blankRows('.');
  if (opts.eastSurface) paint(s, 21, 12, opts.eastSurface);
  const objects = [start(3, 12)];
  if (opts.eastObject) objects.push(opts.eastObject);
  return buildLayers(s, w, objects);
}

const FROM = { x: 52.5, y: 187.5 };
const movableBounces = (o: ShotOutcome) =>
  o.events.filter((e) => e.type === 'bounce' && e.material === 'movable') as Extract<SimEvent, { type: 'bounce' }>[];
const moves = (o: ShotOutcome) => o.events.filter((e) => e.type === 'blockMoved') as Extract<SimEvent, { type: 'blockMoved' }>[];

function shootAt(layers: ReturnType<typeof course>, others: readonly Vec2[] = []) {
  return simulateShot(layers, freshWorld(layers), createBallAt(FROM), shotFor(400, 0), others);
}

describe('movable blocks', () => {
  it('slides one tile away from the ball when the target is free; the ball bounces with RESTITUTION_MOVABLE', () => {
    const layers = course();
    const it = createShotIterator(layers, freshWorld(layers), createBallAt(FROM), shotFor(400, 0));
    let afterBounce = 0;
    while (!it.done) {
      const n = it.events.length;
      it.step();
      if (it.events.slice(n).some((e) => e.type === 'bounce') && afterBounce === 0) afterBounce = it.ball.vx;
    }
    const o = { ...it, events: it.events } as unknown as ShotOutcome;
    const b = movableBounces(o);
    expect(b).toHaveLength(1);
    expect(b[0]!.speed).toBeGreaterThan(MOVABLE_MIN_IMPACT_SPEED);
    expect(afterBounce).toBeCloseTo(-RESTITUTION_MOVABLE * b[0]!.speed, 9);
    expect(moves(o)).toEqual([{ tick: b[0]!.tick, type: 'blockMoved', from: T20, to: T21 }]);
    expect(it.world.walls[T20]).toBe(WallShape.None);
    expect(it.world.walls[T21]).toBe(WallShape.Movable);
    expect(it.ball.x).toBeLessThan(300 - R);
  });

  it('reports both tiles in the world delta', () => {
    const o = shootAt(course());
    expect(o.worldDelta).toEqual({
      tiles: [{ i: T20, wall: WallShape.None, hits: 0 }, { i: T21, wall: WallShape.Movable, hits: 0 }],
      minesDisarmed: [],
    });
  });

  it('refuses to move out of bounds and bounces like a wall', () => {
    const w = blankRows('.');
    paint(w, 0, 12, 'M'); // on the field edge, open border course
    const layers = buildLayers(blankRows('.'), w, [start(3, 12)]);
    const it = createShotIterator(layers, freshWorld(layers), createBallAt({ x: 37.5, y: 187.5 }), shotFor(-300, 0));
    let afterBounce = 0;
    while (!it.done) {
      const n = it.events.length;
      it.step();
      if (it.events.slice(n).some((e) => e.type === 'bounce') && afterBounce === 0) afterBounce = it.ball.vx;
    }
    const b = movableBounces({ events: it.events } as ShotOutcome);
    expect(b).toHaveLength(1);
    expect(afterBounce).toBeCloseTo(RESTITUTION_WALL * b[0]!.speed, 9);
    expect(moves({ events: it.events } as ShotOutcome)).toEqual([]);
    expect(it.world.walls[tileIndex(0, 12)]).toBe(WallShape.Movable);
  });

  it('refuses a wall, an object, water, acid and another ball in the target tile', () => {
    const refused = [
      shootAt(course({ eastWall: true })),
      shootAt(course({ eastObject: hole(21, 12) })),
      shootAt(course({ eastSurface: 'w' })),
      shootAt(course({ eastSurface: 'a' })),
      shootAt(course(), [centreOf(21, 12)]),
      shootAt(course(), [{ x: 21 * 15 + 0.5, y: 12 * 15 + 14.5 }]), // ball centre just inside the target tile's corner
    ];
    for (const o of refused) {
      expect(moves(o)).toEqual([]);
      expect(movableBounces(o)).toHaveLength(1);
      expect(o.world.walls[T20]).toBe(WallShape.Movable);
      expect(o.worldDelta.tiles).toEqual([]);
    }
    const allowed = shootAt(course({ eastSurface: 's' }), [centreOf(22, 12), centreOf(21, 11)]);
    expect(moves(allowed)).toHaveLength(1);
  });

  it('a too-slow impact leaves the block in place', () => {
    const layers = course();
    // launch so the arrival speed is below MOVABLE_MIN_IMPACT_SPEED: v0^2 = 2*200*241.5 + 50^2
    const o = simulateShot(layers, freshWorld(layers), createBallAt(FROM), shotFor(315, 0));
    const b = movableBounces(o);
    expect(b).toHaveLength(1);
    expect(b[0]!.speed).toBeLessThan(MOVABLE_MIN_IMPACT_SPEED);
    expect(moves(o)).toEqual([]);
    expect(o.world.walls[T20]).toBe(WallShape.Movable);
  });

  it('the moved block collides at its new place in the same shot and can be pushed again', () => {
    const w = borderRows();
    paint(w, 17, 12, '#'); // backstop west of the ball
    paint(w, 20, 12, 'M');
    const layers = buildLayers(blankRows('.'), w, [start(3, 12)]);
    const o = simulateShot(layers, freshWorld(layers), createBallAt({ x: 277.5, y: 187.5 }), shotFor(600, 0));
    const mv = moves(o);
    expect(mv.length).toBeGreaterThanOrEqual(2);
    expect([mv[0]!.from, mv[0]!.to]).toEqual([T20, T21]);
    expect([mv[1]!.from, mv[1]!.to]).toEqual([T21, T22]);
    const b = movableBounces(o);
    expect(b.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(b[0]!.x - (300 - R))).toBeLessThan(0.05);
    expect(Math.abs(b[1]!.x - (315 - R))).toBeLessThan(0.05);
    expect(o.world.walls[T22]).toBe(WallShape.Movable);
    expect(o.world.walls[T20]).toBe(WallShape.None);
    expect(o.world.walls[T21]).toBe(WallShape.None);
  });
});
