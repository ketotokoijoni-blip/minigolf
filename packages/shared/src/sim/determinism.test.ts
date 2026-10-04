import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SHOT_TICKS } from '../constants';
import { xorshift32 } from '../math/rng';
import { hashSimState } from './checksum';
import { quantizeShot } from './shot';
import { createShotIterator, outcomeOf, simulateShot, toShotSummary } from './simulate';
import { freshWorld, testCourse } from './testCourses';
import { resetSimTuning, setSimTuning } from './tuning';
import type { BallState, ShotInput, WorldState } from './types';
import { createBallAt } from './worldState';

afterEach(() => resetSimTuning());

function roundTripBall(b: BallState): BallState {
  return JSON.parse(JSON.stringify(b)) as BallState;
}
function roundTripWorld(w: WorldState): WorldState {
  const j = JSON.parse(JSON.stringify({ walls: Array.from(w.walls), breakHits: Array.from(w.breakHits), minesArmed: Array.from(w.minesArmed) })) as {
    walls: number[]; breakHits: number[]; minesArmed: number[];
  };
  return { walls: Uint8Array.from(j.walls), breakHits: Uint8Array.from(j.breakHits), minesArmed: Uint8Array.from(j.minesArmed) };
}

describe('determinism', () => {
  it('repeated runs give identical checksums, outcomes and events', () => {
    const layers = testCourse('arena');
    const shot: ShotInput = { dx: 11000, dy: -2500 };
    const a = simulateShot(layers, freshWorld(layers), createBallAt(layers.start), shot);
    const b = simulateShot(layers, freshWorld(layers), createBallAt(layers.start), shot);
    expect(b.checksum).toBe(a.checksum);
    expect(b.events).toEqual(a.events);
    expect(b.ball).toEqual(a.ball);
    expect(b.ticks).toBe(a.ticks);
    expect(hashSimState(a.ball, a.world)).toBe(a.checksum);
  });

  it('is unchanged by a JSON round trip of the ball and the world', () => {
    const layers = testCourse('arena');
    const world = freshWorld(layers);
    const ball = createBallAt(layers.start);
    const shot: ShotInput = { dx: 9000, dy: 4000 };
    const first = simulateShot(layers, world, ball, shot);
    const second = simulateShot(layers, roundTripWorld(first.world), roundTripBall(first.ball), shot);
    const reference = simulateShot(layers, first.world, first.ball, shot);
    expect(second.checksum).toBe(reference.checksum);
    expect(second.events).toEqual(reference.events);
    expect(hashSimState(roundTripBall(first.ball), roundTripWorld(first.world))).toBe(first.checksum);
  });

  it('1 000 random quantized shots replay identically across two independent worlds', () => {
    const layers = testCourse('arena');
    const run = () => {
      const rnd = xorshift32(777);
      let world = freshWorld(layers);
      let ball = createBallAt(layers.start);
      const sums: number[] = [];
      let eventCount = 0;
      for (let i = 0; i < 1000; i++) {
        const angle = rnd() * Math.PI * 2;
        const pull = 3 + rnd() * 117;
        const shot = quantizeShot(Math.cos(angle) * pull, Math.sin(angle) * pull);
        const o = simulateShot(layers, world, ball, shot);
        sums.push(o.checksum);
        eventCount += o.events.length;
        world = o.world;
        ball = o.result === 'holed' ? createBallAt(layers.start) : o.ball;
      }
      return { sums, eventCount, world, ball };
    };
    const a = run();
    const b = run();
    expect(b.sums).toEqual(a.sums);
    expect(b.eventCount).toBe(a.eventCount);
    expect(b.ball).toEqual(a.ball);
    expect(Array.from(b.world.walls)).toEqual(Array.from(a.world.walls));
    expect(new Set(a.sums).size).toBeGreaterThan(900); // the checksum actually varies with the state
  });

  it('createShotIterator stepped by hand equals simulateShot, tick for tick', () => {
    const layers = testCourse('corridors');
    const world = freshWorld(layers);
    const ball = createBallAt(layers.start);
    const shot: ShotInput = { dx: 12000, dy: 1500 };
    const it = createShotIterator(layers, world, ball, shot);
    let steps = 0;
    while (!it.done) {
      expect(it.step()).toBe(it.result ?? 'moving');
      steps++;
    }
    expect(it.step()).toBe(it.result); // no-op once done
    // §8.3 increments ctx.tick only in step 8, so a shot that ends on its N-th step() reports N - 1 ticks (timeout: N)
    expect(it.ctx.tick).toBe(it.result === 'timeout' ? steps : steps - 1);
    const viaIterator = outcomeOf(it, world);
    const direct = simulateShot(layers, world, ball, shot);
    expect(viaIterator).toEqual(direct);
    expect(direct.ticks).toBe(it.ctx.tick);
  });

  it('outcomeOf refuses an unfinished shot', () => {
    const layers = testCourse('open');
    const it = createShotIterator(layers, freshWorld(layers), createBallAt(layers.start), { dx: 12000, dy: 0 });
    expect(() => outcomeOf(it, freshWorld(layers))).toThrow();
  });

  it('MAX_SHOT_TICKS yields timeout with zero velocity and the ball where it was', () => {
    setSimTuning({ FRICTION_ICE: 0 });
    const layers = testCourse('ice');
    const o = simulateShot(layers, freshWorld(layers), createBallAt(layers.start), { dx: 10000, dy: 3700 });
    expect(o.result).toBe('timeout');
    expect(o.ticks).toBe(MAX_SHOT_TICKS);
    expect(o.penalty).toBe(0);
    expect(o.ball).toMatchObject({ vx: 0, vy: 0, moving: false });
    expect(o.events.at(-1)).toEqual({ tick: MAX_SHOT_TICKS - 1, type: 'timeout' });
    expect(o.ball.x).toBeGreaterThan(0);
  });

  it('toShotSummary drops events and the world and copies the ball and the delta', () => {
    const layers = testCourse('arena');
    const o = simulateShot(layers, freshWorld(layers), createBallAt(layers.start), { dx: 12000, dy: 0 });
    const s = toShotSummary(o);
    expect(Object.keys(s).sort()).toEqual(['ball', 'checksum', 'holeIndex', 'penalty', 'result', 'ticks', 'worldDelta']);
    expect(s.ball).toEqual(o.ball);
    expect(s.ball).not.toBe(o.ball);
    expect(s.worldDelta).toEqual(o.worldDelta);
    expect(s.worldDelta).not.toBe(o.worldDelta);
    expect(s.worldDelta.tiles).not.toBe(o.worldDelta.tiles);
    expect(s.checksum).toBe(o.checksum);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});
