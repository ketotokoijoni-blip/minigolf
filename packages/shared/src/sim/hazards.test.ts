import { afterEach, describe, expect, it } from 'vitest';
import { tileIndex } from '../course/grid';
import { simulateShot } from './simulate';
import { blankRows, borderRows, buildLayers, freshWorld, mine, paint, paintCol, shotFor, start } from './testCourses';
import { resetSimTuning } from './tuning';
import { createBallAt, createWorld } from './worldState';

afterEach(() => resetSimTuning());

const ORIGIN = { x: 52.5, y: 187.5 }; // start tile (3, 12)

describe('hazards', () => {
  it('water returns the ball to the shot origin with a penalty', () => {
    const s = blankRows('.');
    paintCol(s, 12, 1, 23, 'w');
    const layers = buildLayers(s, borderRows(), [start(3, 12)]);
    const o = simulateShot(layers, freshWorld(layers), createBallAt(ORIGIN), shotFor(300, 0));
    expect(o.result).toBe('water');
    expect(o.penalty).toBe(1);
    expect(o.ball).toMatchObject({ x: ORIGIN.x, y: ORIGIN.y, vx: 0, vy: 0, moving: false, lastTile: tileIndex(3, 12), slowTicks: 0 });
    const ev = o.events.at(-1);
    expect(ev).toMatchObject({ type: 'water', tick: o.ticks });
    expect(Math.floor(((ev as { tile: number }).tile) % 49)).toBe(12);
    expect(o.ticks).toBeLessThan(80);
  });

  it('acid returns the ball to the course start', () => {
    const s = blankRows('.');
    paintCol(s, 25, 1, 23, 'a');
    const layers = buildLayers(s, borderRows(), [start(3, 12)]);
    const from = { x: 307.5, y: 82.5 }; // tile (20, 5), far from the start
    const o = simulateShot(layers, freshWorld(layers), createBallAt(from), shotFor(300, 0));
    expect(o.result).toBe('acid');
    expect(o.penalty).toBe(1);
    expect(o.ball).toMatchObject({ x: ORIGIN.x, y: ORIGIN.y, vx: 0, vy: 0, moving: false });
    expect(o.events.at(-1)).toMatchObject({ type: 'acid' });
  });

  it('tar stops the ball on entry; a ball that starts on tar leaves normally', () => {
    const s = blankRows('.');
    paint(s, 10, 12, 't');
    const layers = buildLayers(s, borderRows(), [start(3, 12)]);
    const o = simulateShot(layers, freshWorld(layers), createBallAt(ORIGIN), shotFor(300, 0));
    expect(o.result).toBe('stopped');
    expect(o.penalty).toBe(0);
    expect(o.ball.x).toBeGreaterThanOrEqual(150);
    expect(o.ball.x).toBeLessThan(165);
    expect(o.ball).toMatchObject({ vx: 0, vy: 0, moving: false, lastTile: tileIndex(10, 12) });
    expect(o.events.at(-1)).toEqual({ tick: o.ticks, type: 'tar', tile: tileIndex(10, 12) });
    expect(o.events.filter((e) => e.type === 'stopped')).toHaveLength(0);
    // next shot from the tar tile
    const o2 = simulateShot(layers, o.world, o.ball, shotFor(300, 0));
    expect(o2.result).toBe('stopped');
    expect(o2.ball.x).toBeGreaterThan(200);
    expect(o2.events.filter((e) => e.type === 'tar')).toHaveLength(0);
  });

  it('a mine is consumed once per hole and re-armed by createWorld', () => {
    const layers = buildLayers(blankRows('.'), borderRows(), [start(3, 12), mine(10, 12)]);
    const world = freshWorld(layers);
    expect(Array.from(world.minesArmed)).toEqual([1]);
    const o = simulateShot(layers, world, createBallAt(ORIGIN), shotFor(300, 0));
    expect(o.result).toBe('mine');
    expect(o.penalty).toBe(1);
    expect(o.ball).toMatchObject({ x: ORIGIN.x, y: ORIGIN.y, vx: 0, vy: 0, moving: false });
    expect(o.events.at(-1)).toEqual({ tick: o.ticks, type: 'mine', index: 0 });
    expect(Array.from(o.world.minesArmed)).toEqual([0]);
    expect(o.worldDelta).toEqual({ tiles: [], minesDisarmed: [0] });
    expect(Array.from(world.minesArmed)).toEqual([1]); // input untouched
    // the disarmed mine lets the next shot roll over it
    const o2 = simulateShot(layers, o.world, o.ball, shotFor(300, 0));
    expect(o2.result).toBe('stopped');
    expect(o2.ball.x).toBeGreaterThan(200);
    expect(o2.worldDelta.minesDisarmed).toEqual([]);
    // a fresh hole re-arms it
    expect(Array.from(createWorld(layers.walls, layers.mines.length).minesArmed)).toEqual([1]);
  });
});
