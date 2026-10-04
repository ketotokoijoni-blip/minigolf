import { describe, expect, it } from 'vitest';
import { courseId } from './canonical';
import { cellValue, fillRect, floodFill, line, objectAt, placeObject, removeObjectAt, setMeta, setSurface, setWall } from './edit';
import { Surface, WallShape, type Course } from './types';
import { validateCourse } from './validate';
import { deepFreeze, testCourse } from './fixtures.test';

const frozen = (c: Course = testCourse()): Course => deepFreeze(JSON.parse(JSON.stringify(c)) as Course);
const wallAt = (c: Course, x: number, y: number): number => cellValue(c, 'walls', x, y);
const surfAt = (c: Course, x: number, y: number): number => cellValue(c, 'surface', x, y);

describe('edit ops: immutability and identity', () => {
  it('every op returns a new course, leaves the frozen input untouched and recomputes the id', () => {
    const c = frozen();
    const before = JSON.stringify(c);
    const results = [
      setSurface(c, 10, 10, Surface.Sand),
      setWall(c, 10, 10, WallShape.Full),
      placeObject(c, { type: 'mine', x: 10, y: 10 }),
      removeObjectAt(c, 45, 12),
      fillRect(c, 'surface', 5, 5, 8, 8, Surface.Ice),
      floodFill(c, 'surface', 10, 10, Surface.Sand),
      line(c, 'walls', 5, 5, 20, 9, WallShape.Full),
      setMeta(c, { name: 'Uusi' }),
    ];
    expect(JSON.stringify(c)).toBe(before);
    for (const r of results) {
      expect(r).not.toBe(c);
      expect(r.id).toBe(courseId({ ...r, id: '' }));
      expect(r.id).not.toBe(c.id);
    }
  });

  it('out-of-bounds single-tile ops return the input unchanged', () => {
    const c = frozen();
    expect(setSurface(c, -1, 0, Surface.Sand)).toBe(c);
    expect(setWall(c, 49, 0, WallShape.Full)).toBe(c);
    expect(placeObject(c, { type: 'mine', x: 0, y: 25 })).toBe(c);
    expect(placeObject(c, { type: 'mine', x: 1.5, y: 2 })).toBe(c);
    expect(removeObjectAt(c, 10, 10)).toBe(c);
  });
});

describe('setSurface', () => {
  it('paints the tile and keeps objects on harmless surfaces', () => {
    const c = setSurface(frozen(), 45, 12, Surface.Ice);
    expect(surfAt(c, 45, 12)).toBe(Surface.Ice);
    expect(objectAt(c, 45, 12)?.type).toBe('hole');
  });

  it('water/acid/tar under start/hole/teleport remove the object; water/acid under a mine remove the mine, tar keeps it', () => {
    for (const s of [Surface.Water, Surface.Acid, Surface.Tar]) {
      expect(objectAt(setSurface(frozen(), 45, 12, s), 45, 12)).toBeUndefined();
      expect(objectAt(setSurface(frozen(), 3, 12, s), 3, 12)).toBeUndefined();
    }
    const withMine = placeObject(frozen(), { type: 'mine', x: 10, y: 10 });
    expect(objectAt(setSurface(withMine, 10, 10, Surface.Water), 10, 10)).toBeUndefined();
    expect(objectAt(setSurface(withMine, 10, 10, Surface.Acid), 10, 10)).toBeUndefined();
    expect(objectAt(setSurface(withMine, 10, 10, Surface.Tar), 10, 10)?.type).toBe('mine');
    const withTele = placeObject(placeObject(frozen(), { type: 'teleport', x: 10, y: 10, group: 0 }), { type: 'teleport', x: 20, y: 10, group: 0 });
    expect(objectAt(setSurface(withTele, 10, 10, Surface.Tar), 10, 10)).toBeUndefined();
  });
});

describe('setWall', () => {
  it('any wall removes a non-magnet object; None keeps it', () => {
    expect(objectAt(setWall(frozen(), 45, 12, WallShape.Breakable2), 45, 12)).toBeUndefined();
    expect(objectAt(setWall(frozen(), 45, 12, WallShape.OneWayN), 45, 12)).toBeUndefined();
    expect(objectAt(setWall(frozen(), 45, 12, WallShape.None), 45, 12)?.type).toBe('hole');
  });

  it('None or a non-Full wall under a magnet removes the magnet; Full keeps it', () => {
    const m = placeObject(frozen(), { type: 'magnet', x: 20, y: 5, polarity: 1, strength: 350, radius: 90 });
    expect(objectAt(setWall(m, 20, 5, WallShape.None), 20, 5)).toBeUndefined();
    expect(wallAt(setWall(m, 20, 5, WallShape.None), 20, 5)).toBe(WallShape.None);
    expect(objectAt(setWall(m, 20, 5, WallShape.TriNE), 20, 5)).toBeUndefined();
    expect(objectAt(setWall(m, 20, 5, WallShape.Full), 20, 5)?.type).toBe('magnet');
  });
});

describe('placeObject', () => {
  it('placing a magnet sets the wall to Full; other objects set it to None', () => {
    const m = placeObject(frozen(), { type: 'magnet', x: 20, y: 5, polarity: -1, strength: 350, radius: 90 });
    expect(wallAt(m, 20, 5)).toBe(WallShape.Full);
    const walled = setWall(frozen(), 20, 5, WallShape.Bumper);
    const h = placeObject(walled, { type: 'hole', x: 20, y: 5 });
    expect(wallAt(h, 20, 5)).toBe(WallShape.None);
    expect(validateCourse(m).filter((i) => i.level === 'error')).toEqual([]);
    expect(validateCourse(h).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('resets a hazard surface under the new object to grass', () => {
    const wet = setSurface(frozen(), 10, 10, Surface.Water);
    const h = placeObject(wet, { type: 'hole', x: 10, y: 10 });
    expect(surfAt(h, 10, 10)).toBe(Surface.Grass);
    const tarred = setSurface(frozen(), 10, 10, Surface.Tar);
    expect(surfAt(placeObject(tarred, { type: 'mine', x: 10, y: 10 }), 10, 10)).toBe(Surface.Tar); // tar is fine for a mine
    expect(surfAt(placeObject(tarred, { type: 'start', x: 10, y: 10 }), 10, 10)).toBe(Surface.Grass);
    const icy = setSurface(frozen(), 10, 10, Surface.Ice);
    expect(surfAt(placeObject(icy, { type: 'hole', x: 10, y: 10 }), 10, 10)).toBe(Surface.Ice);
  });

  it('replaces whatever object is on the tile and keeps start a singleton', () => {
    const c = placeObject(frozen(), { type: 'mine', x: 45, y: 12 });
    expect(c.objects.filter((o) => o.x === 45 && o.y === 12)).toEqual([{ type: 'mine', x: 45, y: 12 }]);
    const moved = placeObject(frozen(), { type: 'start', x: 10, y: 10 });
    expect(moved.objects.filter((o) => o.type === 'start')).toEqual([{ type: 'start', x: 10, y: 10 }]);
    expect(moved.objects.length).toBe(2);
    const onStart = placeObject(frozen(), { type: 'hole', x: 3, y: 12 });
    expect(onStart.objects.filter((o) => o.type === 'start')).toEqual([]);
  });

  it('does not keep a reference to the passed object', () => {
    const obj = { type: 'mine', x: 10, y: 10 } as const;
    const c = placeObject(frozen(), obj);
    expect(objectAt(c, 10, 10)).toEqual(obj);
    expect(objectAt(c, 10, 10)).not.toBe(obj);
  });
});

describe('removeObjectAt', () => {
  it('removes the object; removing a magnet leaves the Full wall in place', () => {
    const m = placeObject(frozen(), { type: 'magnet', x: 20, y: 5, polarity: 1, strength: 350, radius: 90 });
    const r = removeObjectAt(m, 20, 5);
    expect(objectAt(r, 20, 5)).toBeUndefined();
    expect(wallAt(r, 20, 5)).toBe(WallShape.Full);
    expect(removeObjectAt(frozen(), 45, 12).objects.map((o) => o.type)).toEqual(['start']);
  });
});

describe('fillRect', () => {
  it('fills the inclusive rectangle in any corner order and clips to the field', () => {
    const c = fillRect(frozen(), 'surface', 8, 8, 5, 5, Surface.Sand);
    for (let y = 5; y <= 8; y++) for (let x = 5; x <= 8; x++) expect(surfAt(c, x, y)).toBe(Surface.Sand);
    expect(surfAt(c, 4, 5)).toBe(Surface.Grass);
    expect(surfAt(c, 9, 8)).toBe(Surface.Grass);
    expect(surfAt(c, 5, 4)).toBe(Surface.Grass);
    const clipped = fillRect(frozen(), 'walls', -5, -5, 100, 100, WallShape.Full);
    expect(clipped.walls.every((r) => r === '#'.repeat(49))).toBe(true);
    expect(clipped.objects).toEqual([]); // objects under the wall are removed
  });

  it('outline strokes only the border of the rectangle', () => {
    const c = fillRect(frozen(), 'walls', 10, 10, 14, 13, WallShape.Full, true);
    expect(wallAt(c, 10, 10)).toBe(WallShape.Full);
    expect(wallAt(c, 14, 13)).toBe(WallShape.Full);
    expect(wallAt(c, 12, 10)).toBe(WallShape.Full);
    expect(wallAt(c, 10, 12)).toBe(WallShape.Full);
    expect(wallAt(c, 12, 11)).toBe(WallShape.None);
    expect(wallAt(c, 11, 12)).toBe(WallShape.None);
  });

  it('applies the object invariants per tile', () => {
    const c = fillRect(frozen(), 'surface', 40, 10, 47, 14, Surface.Water);
    expect(objectAt(c, 45, 12)).toBeUndefined();
    expect(objectAt(c, 3, 12)?.type).toBe('start');
    const m = placeObject(frozen(), { type: 'magnet', x: 20, y: 5, polarity: 1, strength: 350, radius: 90 });
    expect(objectAt(fillRect(m, 'walls', 18, 3, 22, 7, WallShape.Full), 20, 5)?.type).toBe('magnet');
    expect(objectAt(fillRect(m, 'walls', 18, 3, 22, 7, WallShape.None), 20, 5)).toBeUndefined();
  });
});

describe('floodFill', () => {
  it('fills the 4-connected region of equal value and stops at different values', () => {
    const base = fillRect(frozen(), 'walls', 10, 5, 10, 19, WallShape.Full); // vertical bar inside the border
    const c = floodFill(base, 'walls', 5, 12, WallShape.Breakable1);
    expect(wallAt(c, 5, 12)).toBe(WallShape.Breakable1);
    expect(wallAt(c, 9, 5)).toBe(WallShape.Breakable1);
    expect(wallAt(c, 20, 12)).toBe(WallShape.Breakable1); // connected around the bar's ends
    expect(wallAt(c, 10, 12)).toBe(WallShape.Full);
    expect(wallAt(c, 0, 12)).toBe(WallShape.Full); // border untouched
  });

  it('works per layer: a wall ring does not bound a surface fill, and the fill never crosses diagonally', () => {
    const ringed = fillRect(frozen(), 'walls', 20, 8, 26, 14, WallShape.Full, true);
    const c = floodFill(ringed, 'surface', 23, 11, Surface.Ice);
    expect(surfAt(c, 20, 8)).toBe(Surface.Ice);
    expect(surfAt(c, 1, 1)).toBe(Surface.Ice);
    // Diagonal-only connection: a sand "X" of two tiles touching at a corner is not connected.
    let diag = fillRect(frozen(), 'surface', 10, 10, 10, 10, Surface.Sand);
    diag = fillRect(diag, 'surface', 11, 11, 11, 11, Surface.Sand);
    const d = floodFill(diag, 'surface', 10, 10, Surface.Ice);
    expect(surfAt(d, 10, 10)).toBe(Surface.Ice);
    expect(surfAt(d, 11, 11)).toBe(Surface.Sand);
  });

  it('respects a surface boundary and the field edge; same-value fill is a no-op', () => {
    const ring = fillRect(frozen(), 'surface', 20, 8, 26, 14, Surface.Sand, true);
    const c = floodFill(ring, 'surface', 23, 11, Surface.Ice);
    for (let y = 9; y <= 13; y++) for (let x = 21; x <= 25; x++) expect(surfAt(c, x, y)).toBe(Surface.Ice);
    expect(surfAt(c, 20, 11)).toBe(Surface.Sand);
    expect(surfAt(c, 19, 11)).toBe(Surface.Grass);
    expect(surfAt(c, 0, 0)).toBe(Surface.Grass);
    const whole = floodFill(frozen(), 'surface', 1, 1, Surface.Sand);
    expect(whole.surface.every((r) => r === 's'.repeat(49))).toBe(true);
    const f = frozen();
    expect(floodFill(f, 'surface', 1, 1, Surface.Grass)).toBe(f);
    expect(floodFill(f, 'surface', 60, 1, Surface.Sand)).toBe(f);
  });
});

describe('line', () => {
  it('paints both endpoints and a connected Bresenham path', () => {
    const c = line(frozen(), 'walls', 5, 5, 20, 9, WallShape.Full);
    expect(wallAt(c, 5, 5)).toBe(WallShape.Full);
    expect(wallAt(c, 20, 9)).toBe(WallShape.Full);
    let count = 0;
    for (let y = 1; y < 24; y++) for (let x = 1; x < 48; x++) if (wallAt(c, x, y) === WallShape.Full) count++;
    expect(count).toBe(16); // one tile per column for a shallow line
    const rev = line(frozen(), 'walls', 20, 9, 5, 5, WallShape.Full);
    expect(rev.walls).toEqual(c.walls);
  });

  it('handles vertical, horizontal, steep and single-point lines, skipping off-field cells', () => {
    const v = line(frozen(), 'surface', 10, 2, 10, 22, Surface.Sand);
    for (let y = 2; y <= 22; y++) expect(surfAt(v, 10, y)).toBe(Surface.Sand);
    expect(surfAt(v, 10, 1)).toBe(Surface.Grass);
    const h = line(frozen(), 'surface', 2, 7, 46, 7, Surface.Ice);
    for (let x = 2; x <= 46; x++) expect(surfAt(h, x, 7)).toBe(Surface.Ice);
    const steep = line(frozen(), 'surface', 4, 2, 8, 22, Surface.Tar);
    expect(surfAt(steep, 4, 2)).toBe(Surface.Tar);
    expect(surfAt(steep, 8, 22)).toBe(Surface.Tar);
    const point = line(frozen(), 'surface', 6, 6, 6, 6, Surface.Acid);
    expect(surfAt(point, 6, 6)).toBe(Surface.Acid);
    const off = line(frozen(), 'surface', -3, 12, 5, 12, Surface.Sand);
    expect(surfAt(off, 0, 12)).toBe(Surface.Sand);
    expect(surfAt(off, 5, 12)).toBe(Surface.Sand);
    expect(objectAt(line(frozen(), 'surface', 40, 12, 47, 12, Surface.Water), 45, 12)).toBeUndefined();
  });
});

describe('setMeta', () => {
  it('updates name/author/description and rules, clipping strings to their limits', () => {
    const c = setMeta(frozen(), { name: 'Nimi', author: 'Tekijä', description: 'Kuvaus', par: 4, maxStrokes: 12 });
    expect(c.name).toBe('Nimi');
    expect(c.author).toBe('Tekijä');
    expect(c.description).toBe('Kuvaus');
    expect(c.rules).toEqual({ maxStrokes: 12, par: 4 });
    const long = setMeta(frozen(), { name: 'x'.repeat(100), author: 'a'.repeat(100), description: 'd'.repeat(300) });
    expect(long.name.length).toBe(40);
    expect(long.author.length).toBe(40);
    expect(long.description.length).toBe(200);
    const partial = setMeta(frozen(), { par: 5 });
    expect(partial.name).toBe('Testirata');
    expect(partial.rules.maxStrokes).toBe(20);
  });
});

describe('fillRect / line: off-field geometry', () => {
  it('fillRect with no cell inside the field returns the input unchanged instead of painting the clamped corner', () => {
    const c = frozen();
    expect(fillRect(c, 'surface', -5, -5, -2, -2, Surface.Sand)).toBe(c);
    expect(fillRect(c, 'surface', 49, 3, 60, 10, Surface.Sand)).toBe(c);
    expect(fillRect(c, 'walls', 3, 25, 10, 40, WallShape.Full)).toBe(c);
    expect(fillRect(c, 'walls', 10, -9, 20, -1, WallShape.Full)).toBe(c);
    expect(fillRect(c, 'walls', Number.NaN, 0, 5, 5, WallShape.Full)).toBe(c);
    // A rectangle that merely touches the field still paints the overlapping cells.
    const edge = fillRect(c, 'surface', -5, -5, 0, 0, Surface.Sand);
    expect(surfAt(edge, 0, 0)).toBe(Surface.Sand);
    expect(surfAt(edge, 1, 0)).toBe(Surface.Grass);
    expect(surfAt(edge, 0, 1)).toBe(Surface.Grass);
  });

  it('line paints the on-field part when an endpoint (or both) is far outside the field', () => {
    const far = line(frozen(), 'surface', -100, 12, 5, 12, Surface.Sand);
    for (let x = 0; x <= 5; x++) expect(surfAt(far, x, 12)).toBe(Surface.Sand);
    expect(surfAt(far, 6, 12)).toBe(Surface.Grass);
    const both = line(frozen(), 'surface', -1000, 7, 1000, 7, Surface.Ice);
    expect(both.surface[7]).toBe('i'.repeat(49));
    const vert = line(frozen(), 'walls', 20, -500, 20, 500, WallShape.Full);
    for (let y = 0; y < 25; y++) expect(wallAt(vert, 20, y)).toBe(WallShape.Full);
    // Diagonal through the field from far away: connected, one cell per column, and both field-edge columns hit.
    const diag = line(frozen(), 'surface', -200, -100, 248, 124, Surface.Tar); // slope 0.5 through (0,0) and (48,24)
    let cells = 0;
    for (let x = 0; x < 49; x++) {
      let perColumn = 0;
      for (let y = 0; y < 25; y++) if (surfAt(diag, x, y) === Surface.Tar) perColumn++;
      expect(perColumn, `column ${x}`).toBe(1);
      cells += perColumn;
    }
    expect(cells).toBe(49);
  });

  it('line entirely outside the field (or with non-finite input) returns the input unchanged', () => {
    const c = frozen();
    expect(line(c, 'surface', -10, -10, -2, -3, Surface.Sand)).toBe(c);
    expect(line(c, 'surface', 60, 0, 60, 24, Surface.Sand)).toBe(c);
    expect(line(c, 'surface', Number.POSITIVE_INFINITY, 0, 5, 5, Surface.Sand)).toBe(c);
    expect(line(c, 'surface', 0, 0, 1e9, 1e9, Surface.Sand)).toBe(c); // beyond MAX_LINE_STEPS
  });

  it('line matches the incremental Bresenham error algorithm cell for cell', () => {
    // Reference: the classic two-axis error-accumulating Bresenham (what the editor used before the closed form).
    const reference = (x0: number, y0: number, x1: number, y1: number): string[] => {
      let ax = x0;
      let ay = y0;
      const dx = Math.abs(x1 - ax);
      const dy = -Math.abs(y1 - ay);
      const sx = ax < x1 ? 1 : -1;
      const sy = ay < y1 ? 1 : -1;
      let e = dx + dy;
      const out: string[] = [];
      for (;;) {
        if (ax >= 0 && ay >= 0 && ax < 49 && ay < 25) out.push(`${ax},${ay}`);
        if (ax === x1 && ay === y1) break;
        const e2 = 2 * e;
        if (e2 >= dy) { e += dy; ax += sx; }
        if (e2 <= dx) { e += dx; ay += sy; }
      }
      return out.sort();
    };
    const painted = (c: Course): string[] => {
      const out: string[] = [];
      for (let y = 0; y < 25; y++) for (let x = 0; x < 49; x++) if (surfAt(c, x, y) === Surface.Acid) out.push(`${x},${y}`);
      return out.sort();
    };
    // Deterministic pseudo-random segments, including ones that start or end outside the field.
    let seed = 12345;
    const rnd = (lo: number, hi: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return lo + (seed % (hi - lo + 1));
    };
    const base = frozen();
    for (let i = 0; i < 300; i++) {
      const [x0, y0, x1, y1] = [rnd(-30, 78), rnd(-20, 44), rnd(-30, 78), rnd(-20, 44)];
      expect(painted(line(base, 'surface', x0, y0, x1, y1, Surface.Acid)), `${x0},${y0} -> ${x1},${y1}`).toEqual(reference(x0, y0, x1, y1));
    }
  });
});
