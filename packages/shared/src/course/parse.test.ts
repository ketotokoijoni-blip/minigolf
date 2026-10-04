import { describe, expect, it } from 'vitest';
import { MAGNET_MAX_RADIUS, MAGNET_MAX_STRENGTH, MAGNET_MIN_RADIUS, MAGNET_MIN_STRENGTH, TILE, TILE_COUNT } from '../constants';
import { BUILTIN_COURSES } from './builtin';
import { tileIndex } from './grid';
import { DecodeError, decodeLayers, encodeLayers } from './parse';
import { Surface, WallShape } from './types';
import { everyCharCourse, putChar, testCourse } from './fixtures.test';

describe('decodeLayers / encodeLayers', () => {
  it('round-trips the row layers of every built-in course', () => {
    for (const c of BUILTIN_COURSES) {
      const layers = decodeLayers(c);
      expect(layers.surface.length).toBe(TILE_COUNT);
      expect(layers.walls.length).toBe(TILE_COUNT);
      const rows = encodeLayers(layers.surface, layers.walls);
      expect(rows.surface).toEqual(c.surface);
      expect(rows.walls).toEqual(c.walls);
    }
  });

  it('round-trips a fixture containing every character of both alphabets', () => {
    const c = everyCharCourse();
    const layers = decodeLayers(c);
    expect(layers.surface[tileIndex(10, 20)]).toBe(Surface.Sand);
    expect(layers.surface[tileIndex(18, 20)]).toBe(Surface.SlopeW);
    expect(layers.walls[tileIndex(10, 5)]).toBe(WallShape.TriNW);
    expect(layers.walls[tileIndex(22, 5)]).toBe(WallShape.OneWayW);
    expect(encodeLayers(layers.surface, layers.walls)).toEqual({ surface: c.surface, walls: c.walls });
  });

  it('builds the object tables: start centre, holes in course order, mines in course order, objectAt', () => {
    const c = everyCharCourse();
    const l = decodeLayers(c);
    expect(l.startTile).toBe(tileIndex(3, 12));
    expect(l.start).toEqual({ x: 3.5 * TILE, y: 12.5 * TILE });
    expect(l.holes.map((h) => h.tile)).toEqual([tileIndex(45, 12), tileIndex(40, 3)]);
    expect(l.holes[1]).toEqual({ tile: tileIndex(40, 3), cx: 40.5 * TILE, cy: 3.5 * TILE });
    expect(l.mines.map((m) => m.tile)).toEqual([tileIndex(25, 12), tileIndex(25, 14)]);
    expect(l.objectAt[tileIndex(25, 14)]).toBe(7);
    expect(l.objectAt[tileIndex(0, 0)]).toBe(-1);
    expect(l.objects).toEqual(c.objects);
    expect(l.objects).not.toBe(c.objects);
    expect(l.par).toBe(c.rules.par);
    expect(l.maxStrokes).toBe(c.rules.maxStrokes);
  });

  it('pairs teleport pads by group with partner tile and index', () => {
    const c = testCourse([
      { type: 'start', x: 3, y: 12 },
      { type: 'hole', x: 45, y: 12 },
      { type: 'teleport', x: 10, y: 10, group: 3 },
      { type: 'teleport', x: 20, y: 2, group: 0 },
      { type: 'teleport', x: 30, y: 10, group: 3 },
      { type: 'teleport', x: 40, y: 20, group: 0 },
    ]);
    const l = decodeLayers(c);
    expect(l.teleports.length).toBe(4);
    expect(l.teleports[0]!.partnerIndex).toBe(2);
    expect(l.teleports[2]!.partnerIndex).toBe(0);
    expect(l.teleports[0]!.partnerTile).toBe(tileIndex(30, 10));
    expect(l.teleports[1]!.partnerIndex).toBe(3);
    expect(l.teleports[3]!.partnerTile).toBe(tileIndex(20, 2));
    expect(l.teleports[1]!.group).toBe(0);
  });

  it('clamps magnet strength and radius into the allowed range', () => {
    const walls = putChar(putChar(testCourse().walls, 20, 5, '#'), 24, 5, '#');
    const c = testCourse([
      { type: 'start', x: 3, y: 12 },
      { type: 'hole', x: 45, y: 12 },
      { type: 'magnet', x: 20, y: 5, polarity: 1, strength: 1, radius: 1 },
      { type: 'magnet', x: 24, y: 5, polarity: -1, strength: 99999, radius: 99999 },
    ], { walls });
    const l = decodeLayers(c);
    expect(l.magnets[0]).toMatchObject({ strength: MAGNET_MIN_STRENGTH, radius: MAGNET_MIN_RADIUS, polarity: 1 });
    expect(l.magnets[1]).toMatchObject({ strength: MAGNET_MAX_STRENGTH, radius: MAGNET_MAX_RADIUS, polarity: -1 });
  });

  it('throws DecodeError on malformed input instead of repairing it', () => {
    const base = testCourse();
    expect(() => decodeLayers({ ...base, surface: base.surface.slice(1) })).toThrow(DecodeError);
    expect(() => decodeLayers({ ...base, walls: putChar(base.walls, 5, 5, '?') })).toThrow(/bad char/);
    expect(() => decodeLayers({ ...base, surface: putChar(base.surface, 5, 5, 'Q') })).toThrow(/bad char/);
    expect(() => decodeLayers(testCourse([{ type: 'hole', x: 45, y: 12 }]))).toThrow(/no start/);
    expect(() => decodeLayers(testCourse([{ type: 'start', x: 3, y: 12 }]))).toThrow(/no hole/);
    expect(() => decodeLayers(testCourse([{ type: 'start', x: 3, y: 12 }, { type: 'start', x: 4, y: 12 }, { type: 'hole', x: 45, y: 12 }])))
      .toThrow(/second start/);
    expect(() => decodeLayers(testCourse([{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 3, y: 12 }]))).toThrow(/overlaps/);
    expect(() => decodeLayers(testCourse([{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 49, y: 12 }]))).toThrow(/out of bounds/);
    expect(() => decodeLayers(testCourse([{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 45, y: 12 }, { type: 'teleport', x: 10, y: 10, group: 1 }])))
      .toThrow(/only 1 pad/);
    expect(() => decodeLayers(testCourse([
      { type: 'start', x: 3, y: 12 }, { type: 'hole', x: 45, y: 12 },
      { type: 'teleport', x: 10, y: 10, group: 1 }, { type: 'teleport', x: 11, y: 10, group: 1 }, { type: 'teleport', x: 12, y: 10, group: 1 },
    ]))).toThrow(/more than 2/);
  });

  it('encodeLayers rejects arrays of the wrong size', () => {
    expect(() => encodeLayers(new Uint8Array(10), new Uint8Array(TILE_COUNT))).toThrow(DecodeError);
  });
});
