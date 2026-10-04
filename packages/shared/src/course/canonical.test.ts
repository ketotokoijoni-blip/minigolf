import { describe, expect, it } from 'vitest';
import { BUILTIN_COURSES } from './builtin';
import { COURSE_ID_BASIS_2, canonicalCourseJson, courseByteLength, courseId, isBuiltinId, utf8Length, withComputedId } from './canonical';
import type { Course } from './types';
import { testCourse } from './fixtures.test';

describe('canonicalCourseJson', () => {
  it('has a fixed key order, excludes id and contains no whitespace', () => {
    const c = testCourse();
    const canon = canonicalCourseJson(c);
    expect(canon.startsWith('{"format":"puttipeli-course","formatVersion":1,"name":"Testirata","author":"","description":"","width":49,"height":25,"rules":{"maxStrokes":20,"par":3},"surface":[')).toBe(true);
    expect(canon).not.toContain('"id"');
    expect(canon).not.toMatch(/\s/);
    const parsed = JSON.parse(canon) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['format', 'formatVersion', 'name', 'author', 'description', 'width', 'height', 'rules', 'surface', 'walls', 'objects']);
    const objects = parsed.objects as Record<string, unknown>[];
    expect(Object.keys(objects[0]!)).toEqual(['type', 'x', 'y']);
  });

  it('orders object fields type, x, y, then group | polarity, strength, radius', () => {
    const c: Course = {
      ...testCourse(),
      objects: [
        { radius: 90, strength: 350, polarity: 1, y: 4, x: 10, type: 'magnet' } as never,
        { group: 2, y: 5, x: 11, type: 'teleport' } as never,
      ],
    };
    const objects = (JSON.parse(canonicalCourseJson(c)) as { objects: Record<string, unknown>[] }).objects;
    expect(Object.keys(objects[0]!)).toEqual(['type', 'x', 'y', 'polarity', 'strength', 'radius']);
    expect(Object.keys(objects[1]!)).toEqual(['type', 'x', 'y', 'group']);
  });

  it('is independent of source key order and whitespace', () => {
    const a = testCourse();
    const reordered = JSON.parse(JSON.stringify({
      objects: a.objects, walls: a.walls, surface: a.surface, rules: { par: a.rules.par, maxStrokes: a.rules.maxStrokes },
      height: 25, width: 49, description: a.description, author: a.author, name: a.name, id: 'c_whatever', formatVersion: 1, format: a.format,
    }, null, 2)) as Course;
    expect(canonicalCourseJson(reordered)).toBe(canonicalCourseJson(a));
  });
});

describe('courseId', () => {
  it('is c_ + 16 lowercase hex chars and stable across key reordering', () => {
    const a = testCourse();
    const id = courseId(a);
    expect(id).toMatch(/^c_[0-9a-f]{16}$/);
    const copy = { ...a, id: 'c_0000000000000000', name: a.name };
    expect(courseId(copy)).toBe(id);
    expect(courseId({ ...a, surface: a.surface.map((r) => r) })).toBe(id);
  });

  it('differs between two different courses and uses two independent hashes', () => {
    const a = testCourse();
    const b = { ...a, name: 'Toinen' };
    const ia = courseId(a);
    const ib = courseId(b);
    expect(ia).not.toBe(ib);
    expect(ia.slice(2, 10)).not.toBe(ia.slice(10));
    expect(COURSE_ID_BASIS_2).toBe(0x01000193 ^ 0x811c9dc5);
  });

  it('keeps built-in ids', () => {
    for (const c of BUILTIN_COURSES) {
      expect(courseId(c)).toBe(c.id);
      expect(withComputedId(c).id).toBe(c.id);
    }
  });

  it('withComputedId returns a copy with the computed id and leaves the input untouched', () => {
    const a = { ...testCourse(), id: '' };
    const b = withComputedId(a);
    expect(b).not.toBe(a);
    expect(a.id).toBe('');
    expect(b.id).toBe(courseId(a));
  });
});

describe('courseByteLength', () => {
  it('counts UTF-8 bytes (multi-byte Finnish letters and astral characters)', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('äö')).toBe(4);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    const plain = testCourse();
    const umlaut = { ...plain, name: 'Hämärä' };
    expect(courseByteLength(umlaut) - courseByteLength(plain)).toBe(utf8Length('Hämärä') - utf8Length('Testirata'));
    expect(courseByteLength(plain)).toBe(canonicalCourseJson(plain).length);
  });
});

describe('built-in id shape', () => {
  it('preserves only b_ + two digits; any other b_… string is rehashed like a custom course', () => {
    const a = testCourse();
    expect(isBuiltinId('b_01')).toBe(true);
    expect(isBuiltinId('b_1')).toBe(false);
    expect(isBuiltinId('b_foo')).toBe(false);
    expect(isBuiltinId('b_001')).toBe(false);
    expect(courseId({ ...a, id: 'b_07' })).toBe('b_07');
    expect(courseId({ ...a, id: 'b_foo' })).toBe(courseId({ ...a, id: '' }));
    expect(withComputedId({ ...a, id: 'b_x' }).id).toMatch(/^c_[0-9a-f]{16}$/);
  });
});
