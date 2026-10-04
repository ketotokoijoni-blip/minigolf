import { describe, expect, it } from 'vitest';
import { BUILTIN_COURSES } from './builtin';
import {
  COURSE_ID_BASIS_2, canonicalCourseJson, courseByteLength, courseId, customIdOfCanonical, isBuiltinId, isCustomId,
  isRegisteredBuiltin, registerBuiltinCanonical, registeredBuiltinCanonical, registeredBuiltinIds, utf8Length, withComputedId,
} from './canonical';
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
  it('recognises b_ + two digits and c_ + 16 hex; every other string is neither', () => {
    expect(isBuiltinId('b_01')).toBe(true);
    expect(isBuiltinId('b_1')).toBe(false);
    expect(isBuiltinId('b_foo')).toBe(false);
    expect(isBuiltinId('b_001')).toBe(false);
    expect(isBuiltinId(7)).toBe(false);
    expect(isCustomId('c_0123456789abcdef')).toBe(true);
    expect(isCustomId('c_0123456789ABCDEF')).toBe(false);
    expect(isCustomId('c_0123')).toBe(false);
    expect(isCustomId('b_01')).toBe(false);
  });
});

describe('reserved built-in ids (R13)', () => {
  it('a course that merely claims a built-in id is rehashed to a c_ id', () => {
    const a = testCourse();
    const plain = courseId({ ...a, id: '' });
    expect(plain).toMatch(/^c_[0-9a-f]{16}$/);
    for (const claimed of ['b_01', 'b_07', 'b_09', 'b_42', 'b_foo', 'b_x']) {
      expect(courseId({ ...a, id: claimed }), claimed).toBe(plain);
      expect(withComputedId({ ...a, id: claimed }).id, claimed).toBe(plain);
      expect(isRegisteredBuiltin({ ...a, id: claimed }), claimed).toBe(false);
    }
  });

  it('builtin.ts has registered all nine canonical forms and each built-in keeps its id', () => {
    expect(registeredBuiltinIds()).toEqual(BUILTIN_COURSES.map((c) => c.id));
    for (const c of BUILTIN_COURSES) {
      expect(registeredBuiltinCanonical(c.id)).toBe(canonicalCourseJson(c));
      expect(isRegisteredBuiltin(c)).toBe(true);
      expect(courseId(c)).toBe(c.id);
    }
    expect(registeredBuiltinCanonical('b_42')).toBeUndefined();
  });

  it('a byte-identical copy of a built-in keeps the b_ id, a one-tile change turns it into a c_ id', () => {
    const original = BUILTIN_COURSES[0]!;
    const copy: Course = JSON.parse(JSON.stringify(original)) as Course;
    expect(courseId(copy)).toBe('b_01');
    expect(withComputedId(copy).id).toBe('b_01');
    const surface = copy.surface.slice();
    surface[3] = surface[3]!.slice(0, 10) + 's' + surface[3]!.slice(11);
    const tampered: Course = { ...copy, surface };
    const id = courseId(tampered);
    expect(id).toMatch(/^c_[0-9a-f]{16}$/);
    expect(id).toBe(customIdOfCanonical(canonicalCourseJson(tampered)));
    expect(isRegisteredBuiltin(tampered)).toBe(false);
    // A metadata-only change (name, par) is a different course too.
    expect(courseId({ ...copy, name: 'Ensiputti 2' })).toMatch(/^c_/);
    expect(courseId({ ...copy, rules: { ...copy.rules, par: 3 } })).toMatch(/^c_/);
    // The same content under a different built-in id is not that built-in.
    expect(courseId({ ...copy, id: 'b_02' })).toMatch(/^c_/);
    // Without an id the content hash is used even though the content equals a built-in (only builtin.ts mints b_ ids).
    expect(courseId({ ...copy, id: '' })).toMatch(/^c_/);
  });

  it('registerBuiltinCanonical accepts only b_NN ids and the registration decides what courseId keeps', () => {
    const a = testCourse();
    expect(() => registerBuiltinCanonical('c_0123456789abcdef', '{}')).toThrow();
    expect(() => registerBuiltinCanonical('b_x', '{}')).toThrow();
    expect(courseId({ ...a, id: 'b_99' })).toMatch(/^c_/);
    registerBuiltinCanonical('b_99', canonicalCourseJson(a));
    expect(courseId({ ...a, id: 'b_99' })).toBe('b_99');
    expect(isRegisteredBuiltin({ ...a, id: 'b_99' })).toBe(true);
    expect(courseId({ ...a, id: 'b_99', name: 'Muokattu' })).toMatch(/^c_/);
    // Re-registration (dev-server hot reload) replaces the content instead of throwing.
    registerBuiltinCanonical('b_99', canonicalCourseJson({ ...a, name: 'Muokattu' }));
    expect(courseId({ ...a, id: 'b_99' })).toMatch(/^c_/);
    expect(courseId({ ...a, id: 'b_99', name: 'Muokattu' })).toBe('b_99');
  });
});
