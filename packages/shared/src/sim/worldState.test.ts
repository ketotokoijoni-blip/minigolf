import { describe, expect, it } from 'vitest';
import { COURSE_H, COURSE_W, TILE, TILE_COUNT } from '../constants';
import { tileIndex, tileOf } from '../course/grid';
import { WallShape } from '../course/types';
import type { Course } from '../course/types';
import {
  applyWorldDelta,
  cloneWorld,
  createBallAt,
  createWorld,
  createWorldFromCourse,
  diffWorld,
  startCentre,
} from './worldState';

const SHAPE_ROW = 5;
const SHAPES: [number, string, WallShape][] = [
  [10, '7', WallShape.TriNW],
  [11, '9', WallShape.TriNE],
  [12, '3', WallShape.TriSE],
  [13, '1', WallShape.TriSW],
  [14, 'x', WallShape.Breakable1],
  [15, 'y', WallShape.Breakable2],
  [16, 'z', WallShape.Breakable3],
  [17, 'M', WallShape.Movable],
  [18, 'O', WallShape.Bumper],
  [19, '^', WallShape.OneWayN],
  [20, '>', WallShape.OneWayE],
  [21, 'v', WallShape.OneWayS],
  [22, '<', WallShape.OneWayW],
  [23, '#', WallShape.Full],
];

function makeCourse(): Course {
  const surface = Array.from({ length: COURSE_H }, () => '.'.repeat(COURSE_W));
  const walls = Array.from({ length: COURSE_H }, (_, y) =>
    y === 0 || y === COURSE_H - 1 ? '#'.repeat(COURSE_W) : '#' + '.'.repeat(COURSE_W - 2) + '#',
  );
  const row = walls[SHAPE_ROW]!.split('');
  for (const [x, ch] of SHAPES) row[x] = ch;
  walls[SHAPE_ROW] = row.join('');
  return {
    format: 'puttipeli-course',
    formatVersion: 1,
    id: 'c_0000000000000000',
    name: 'Testirata',
    author: '',
    description: '',
    width: 49,
    height: 25,
    rules: { maxStrokes: 20, par: 3 },
    surface,
    walls,
    objects: [
      { type: 'hole', x: 44, y: 12 },
      { type: 'mine', x: 20, y: 8 },
      { type: 'start', x: 3, y: 12 },
      { type: 'mine', x: 30, y: 16 },
      { type: 'teleport', x: 10, y: 20, group: 0 },
      { type: 'teleport', x: 38, y: 4, group: 0 },
    ],
  };
}

describe('createWorld', () => {
  it('copies the walls, starts with zero hits and every mine armed', () => {
    const src = new Uint8Array(TILE_COUNT);
    src[7] = WallShape.Full;
    const w = createWorld(src, 3);
    expect(w.walls).not.toBe(src);
    expect(w.walls.length).toBe(TILE_COUNT);
    expect(w.walls[7]).toBe(WallShape.Full);
    expect(w.breakHits.length).toBe(TILE_COUNT);
    expect(w.breakHits.every((h) => h === 0)).toBe(true);
    expect(Array.from(w.minesArmed)).toEqual([1, 1, 1]);
    src[7] = WallShape.None; // mutating the source afterwards does not touch the world
    expect(w.walls[7]).toBe(WallShape.Full);
    expect(createWorld(src, 0).minesArmed.length).toBe(0);
  });
});

describe('createWorldFromCourse', () => {
  it('decodes the wall rows row-major with wallFromChar and counts mine objects', () => {
    const course = makeCourse();
    const w = createWorldFromCourse(course);
    expect(w.walls.length).toBe(TILE_COUNT);
    expect(w.walls[tileIndex(0, 0)]).toBe(WallShape.Full);
    expect(w.walls[tileIndex(COURSE_W - 1, COURSE_H - 1)]).toBe(WallShape.Full);
    expect(w.walls[tileIndex(0, 12)]).toBe(WallShape.Full);
    expect(w.walls[tileIndex(1, 12)]).toBe(WallShape.None);
    expect(w.walls[tileIndex(24, SHAPE_ROW)]).toBe(WallShape.None);
    for (const [x, , code] of SHAPES) expect(w.walls[tileIndex(x, SHAPE_ROW)]).toBe(code);
    expect(w.breakHits.every((h) => h === 0)).toBe(true);
    expect(Array.from(w.minesArmed)).toEqual([1, 1]);
    // the course itself is not retained or mutated
    expect(course.walls[SHAPE_ROW]!.charAt(10)).toBe('7');
  });

  it('equals the createWorld path for the same wall codes', () => {
    const course = makeCourse();
    const codes = new Uint8Array(TILE_COUNT).fill(WallShape.None);
    for (let y = 0; y < COURSE_H; y++) {
      for (let x = 0; x < COURSE_W; x++) {
        if (y === 0 || y === COURSE_H - 1 || x === 0 || x === COURSE_W - 1) codes[tileIndex(x, y)] = WallShape.Full;
      }
    }
    for (const [x, , code] of SHAPES) codes[tileIndex(x, SHAPE_ROW)] = code;
    expect(createWorldFromCourse(course)).toEqual(createWorld(codes, 2));
  });

  it('throws on malformed rows instead of repairing them', () => {
    const bad = makeCourse();
    bad.walls[3] = bad.walls[3]!.slice(0, 20) + '?' + bad.walls[3]!.slice(21);
    expect(() => createWorldFromCourse(bad)).toThrow(/bad wall char/);
    const short = makeCourse();
    short.walls[4] = short.walls[4]!.slice(0, COURSE_W - 1);
    expect(() => createWorldFromCourse(short)).toThrow(/row 4/);
    const missing = makeCourse();
    missing.walls = missing.walls.slice(0, COURSE_H - 1);
    expect(() => createWorldFromCourse(missing)).toThrow(/wall rows/);
  });
});

describe('cloneWorld / diffWorld / applyWorldDelta', () => {
  function worlds() {
    const before = createWorldFromCourse(makeCourse());
    const after = cloneWorld(before);
    const destroyed = tileIndex(14, SHAPE_ROW); // Breakable1 destroyed
    const hit = tileIndex(16, SHAPE_ROW); // Breakable3 hit once
    const movedFrom = tileIndex(17, SHAPE_ROW); // Movable slid one tile down
    const movedTo = tileIndex(17, SHAPE_ROW + 1);
    after.walls[destroyed] = WallShape.None;
    after.breakHits[destroyed] = 1;
    after.breakHits[hit] = 1;
    after.walls[movedFrom] = WallShape.None;
    after.walls[movedTo] = WallShape.Movable;
    after.minesArmed[1] = 0;
    return { before, after, destroyed, hit, movedFrom, movedTo };
  }

  it('cloneWorld is a deep, independent copy', () => {
    const w = createWorldFromCourse(makeCourse());
    const c = cloneWorld(w);
    expect(c).toEqual(w);
    expect(c).not.toBe(w);
    expect(c.walls).not.toBe(w.walls);
    expect(c.breakHits).not.toBe(w.breakHits);
    expect(c.minesArmed).not.toBe(w.minesArmed);
    c.walls[tileIndex(5, 5)] = WallShape.Bumper;
    c.breakHits[1] = 2;
    c.minesArmed[0] = 0;
    expect(w.walls[tileIndex(5, 5)]).toBe(WallShape.None);
    expect(w.breakHits[1]).toBe(0);
    expect(w.minesArmed[0]).toBe(1);
  });

  it('diffWorld of identical worlds is empty', () => {
    const w = createWorldFromCourse(makeCourse());
    expect(diffWorld(w, cloneWorld(w))).toEqual({ tiles: [], minesDisarmed: [] });
  });

  it('diffWorld lists changed tiles ascending with both values, and disarmed mines', () => {
    const { before, after, destroyed, hit, movedFrom, movedTo } = worlds();
    const d = diffWorld(before, after);
    expect(d.tiles).toEqual([
      { i: destroyed, wall: WallShape.None, hits: 1 },
      { i: hit, wall: WallShape.Breakable3, hits: 1 },
      { i: movedFrom, wall: WallShape.None, hits: 0 },
      { i: movedTo, wall: WallShape.Movable, hits: 0 },
    ]);
    expect(d.minesDisarmed).toEqual([1]);
    expect(d).toEqual(JSON.parse(JSON.stringify(d))); // wire-safe: plain numbers only
  });

  it('diffWorld does not report a mine that became armed', () => {
    const before = createWorld(new Uint8Array(TILE_COUNT), 2);
    before.minesArmed[0] = 0;
    const after = createWorld(new Uint8Array(TILE_COUNT), 2);
    expect(diffWorld(before, after).minesDisarmed).toEqual([]);
    expect(diffWorld(after, before).minesDisarmed).toEqual([0]);
  });

  it('applyWorldDelta(before, diffWorld(before, after)) reproduces after without touching before', () => {
    const { before, after } = worlds();
    const beforeCopy = cloneWorld(before);
    const result = applyWorldDelta(before, diffWorld(before, after));
    expect(result).toEqual(after);
    expect(result).not.toBe(before);
    expect(result.walls).not.toBe(before.walls);
    expect(before).toEqual(beforeCopy);
    // applying an empty delta yields an equal but distinct world
    const same = applyWorldDelta(before, { tiles: [], minesDisarmed: [] });
    expect(same).toEqual(before);
    expect(same).not.toBe(before);
  });
});

describe('createBallAt / startCentre', () => {
  it('createBallAt builds a resting ball with lastTile under its centre', () => {
    const b = createBallAt({ x: 52.5, y: 187.5 });
    expect(b).toEqual({
      x: 52.5,
      y: 187.5,
      vx: 0,
      vy: 0,
      moving: false,
      lastTile: tileOf(52.5, 187.5),
      teleportCooldownTile: -1,
      insideOneWay: -1,
      slowTicks: 0,
    });
    expect(b.lastTile).toBe(tileIndex(3, 12));
    expect(createBallAt({ x: 0, y: 0 }).lastTile).toBe(0);
  });

  it('startCentre is the centre of the start tile and throws when the course has no start', () => {
    const course = makeCourse();
    expect(startCentre(course)).toEqual({ x: 3.5 * TILE, y: 12.5 * TILE });
    expect(startCentre(course)).toEqual({ x: 52.5, y: 187.5 });
    const noStart = { ...course, objects: course.objects.filter((o) => o.type !== 'start') };
    expect(() => startCentre(noStart)).toThrow(/no start/);
  });
});
