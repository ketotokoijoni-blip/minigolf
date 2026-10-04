import { describe, expect, it } from 'vitest';
import { tileIndex } from './grid';
import { decodeLayers } from './parse';
import { isHoleReachable, isPotentiallyPassable, reachableTiles } from './reachability';
import { Surface, WallShape } from './types';
import { putRect, testCourse } from './fixtures.test';

describe('isHoleReachable', () => {
  it('is true on an open course', () => {
    expect(isHoleReachable(decodeLayers(testCourse()))).toBe(true);
  });

  it('is false when a full wall separates start and hole', () => {
    const c = testCourse();
    c.walls = putRect(c.walls, 24, 1, 24, 23, '#');
    expect(isHoleReachable(decodeLayers(c))).toBe(false);
  });

  it('treats triangles as blocking and breakable / movable / one-way as passable', () => {
    for (const ch of ['7', '9', '3', '1']) {
      const c = testCourse();
      c.walls = putRect(c.walls, 24, 1, 24, 23, ch);
      expect(isHoleReachable(decodeLayers(c)), `wall ${ch}`).toBe(false);
    }
    for (const ch of ['x', 'y', 'z', 'M', '^', '>', 'v', '<']) {
      const c = testCourse();
      c.walls = putRect(c.walls, 24, 1, 24, 23, '#');
      c.walls = putRect(c.walls, 24, 12, 24, 12, ch);
      expect(isHoleReachable(decodeLayers(c)), `wall ${ch}`).toBe(true);
    }
  });

  it('bumpers block', () => {
    const c = testCourse();
    c.walls = putRect(c.walls, 24, 1, 24, 23, 'O');
    expect(isHoleReachable(decodeLayers(c))).toBe(false);
  });

  it('is false across a water moat and an acid moat, true across tar', () => {
    for (const [ch, expected] of [['w', false], ['a', false], ['t', true], ['s', true], ['i', true], ['8', true]] as const) {
      const c = testCourse();
      c.surface = putRect(c.surface, 24, 1, 24, 23, ch);
      expect(isHoleReachable(decodeLayers(c)), `surface ${ch}`).toBe(expected);
    }
  });

  it('crosses a wall through a teleporter pair', () => {
    const c = testCourse([
      { type: 'start', x: 3, y: 12 },
      { type: 'hole', x: 45, y: 12 },
      { type: 'teleport', x: 10, y: 5, group: 0 },
      { type: 'teleport', x: 40, y: 20, group: 0 },
    ]);
    c.walls = putRect(c.walls, 24, 1, 24, 23, '#');
    expect(isHoleReachable(decodeLayers(c))).toBe(true);
  });

  it('is true when any one of several holes is reachable', () => {
    const c = testCourse([
      { type: 'start', x: 3, y: 12 },
      { type: 'hole', x: 45, y: 12 },
      { type: 'hole', x: 10, y: 3 },
    ]);
    c.walls = putRect(c.walls, 24, 1, 24, 23, '#');
    expect(isHoleReachable(decodeLayers(c))).toBe(true);
  });

  it('a hole completely enclosed by walls is unreachable even next to the start', () => {
    const c = testCourse([{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 6, y: 12 }]);
    c.walls = putRect(c.walls, 5, 11, 7, 13, '#');
    c.walls = putRect(c.walls, 6, 12, 6, 12, '.');
    expect(isHoleReachable(decodeLayers(c))).toBe(false);
  });

  it('reachableTiles never includes solid or liquid tiles', () => {
    const c = testCourse();
    c.surface = putRect(c.surface, 10, 10, 12, 12, 'w');
    const l = decodeLayers(c);
    const seen = reachableTiles(l);
    expect(seen[tileIndex(11, 11)]).toBe(0);
    expect(seen[tileIndex(0, 0)]).toBe(0);
    expect(seen[tileIndex(3, 12)]).toBe(1);
    expect(seen[tileIndex(45, 12)]).toBe(1);
  });

  it('isPotentiallyPassable follows the §7.6 rule', () => {
    expect(isPotentiallyPassable(WallShape.None, Surface.Grass)).toBe(true);
    expect(isPotentiallyPassable(WallShape.OneWayS, Surface.Ice)).toBe(true);
    expect(isPotentiallyPassable(WallShape.Breakable3, Surface.Grass)).toBe(true);
    expect(isPotentiallyPassable(WallShape.Movable, Surface.Tar)).toBe(true);
    expect(isPotentiallyPassable(WallShape.Full, Surface.Grass)).toBe(false);
    expect(isPotentiallyPassable(WallShape.Bumper, Surface.Grass)).toBe(false);
    expect(isPotentiallyPassable(WallShape.TriNE, Surface.Grass)).toBe(false);
    expect(isPotentiallyPassable(WallShape.None, Surface.Water)).toBe(false);
    expect(isPotentiallyPassable(WallShape.None, Surface.Acid)).toBe(false);
  });
});
