import { describe, expect, it } from 'vitest';
import { SURFACE_CHARS, WALL_CHARS } from './chars';
import { validateCourse } from './validate';
// Shared fixtures and helpers for the WP-A course tests (a .test.ts file so it stays inside WP-A's ownership and out of tsc -b).
import type { Course, CourseObject } from './types';
import { createBlankCourse } from './blank';

/** Blank course with the given objects (default start (3,12) + hole (45,12)). */
export function testCourse(objects?: CourseObject[], patch: Partial<Course> = {}): Course {
  const base = createBlankCourse({ name: 'Testirata' });
  return { ...base, ...patch, objects: objects ?? base.objects };
}

/** Returns a copy of `rows` with `ch` written at (x, y). */
export function putChar(rows: readonly string[], x: number, y: number, ch: string): string[] {
  const out = rows.slice();
  out[y] = out[y]!.slice(0, x) + ch + out[y]!.slice(x + 1);
  return out;
}

/** Writes `ch` on every tile of the inclusive rectangle. */
export function putRect(rows: readonly string[], x0: number, y0: number, x1: number, y1: number, ch: string): string[] {
  let out = rows.slice();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out = putChar(out, x, y, ch);
  return out;
}

export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const key of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[key]);
  }
  return v;
}

/** Row fixture using every surface and wall character at least once (49 x 25, border ring). */
export function everyCharCourse(): Course {
  const base = createBlankCourse({ name: 'Kaikki merkit' });
  let surface = base.surface;
  let walls = base.walls;
  const surfChars = 'sitwa8624';
  const wallChars = '7931xyzMO^>v<';
  for (let i = 0; i < surfChars.length; i++) surface = putChar(surface, 10 + i, 20, surfChars[i]!);
  for (let i = 0; i < wallChars.length; i++) walls = putChar(walls, 10 + i, 5, wallChars[i]!);
  walls = putChar(walls, 30, 8, '#');
  return {
    ...base,
    surface,
    walls,
    objects: [
      { type: 'start', x: 3, y: 12 },
      { type: 'hole', x: 45, y: 12 },
      { type: 'hole', x: 40, y: 3 },
      { type: 'teleport', x: 8, y: 2, group: 2 },
      { type: 'teleport', x: 36, y: 20, group: 2 },
      { type: 'magnet', x: 30, y: 8, polarity: -1, strength: 400, radius: 100 },
      { type: 'mine', x: 25, y: 12 },
      { type: 'mine', x: 25, y: 14 },
    ],
  };
}

describe('fixtures', () => {
  it('everyCharCourse uses every surface and wall character and is a valid course', () => {
    const c = everyCharCourse();
    const surf = new Set(c.surface.join(''));
    const walls = new Set(c.walls.join(''));
    for (const ch of SURFACE_CHARS) expect(surf.has(ch), `surface ${ch}`).toBe(true);
    for (const ch of WALL_CHARS) expect(walls.has(ch), `wall ${ch}`).toBe(true);
    expect(validateCourse(c).filter((i) => i.level === 'error')).toEqual([]);
  });
});
