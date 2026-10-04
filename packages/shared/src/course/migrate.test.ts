import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_STROKES, DEFAULT_PAR, MAGNET_DEFAULT_RADIUS, MAGNET_DEFAULT_STRENGTH } from '../constants';
import { courseId } from './canonical';
import { PARSE_ERROR_CODES, parseCourseFile } from './migrate';
import { putChar, testCourse } from './fixtures.test';

const codes = (r: ReturnType<typeof parseCourseFile>): string[] => (r.ok ? [] : r.issues.map((i) => i.code));

describe('parseCourseFile', () => {
  it('accepts a valid course and returns it with warnings', () => {
    const r = parseCourseFile(JSON.parse(JSON.stringify(testCourse())));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.course.name).toBe('Testirata');
      expect(r.warnings).toEqual([]);
    }
  });

  it('rejects non-objects and unknown formats with FORMAT_UNKNOWN', () => {
    expect(codes(parseCourseFile(null))).toEqual(['FORMAT_UNKNOWN']);
    expect(codes(parseCourseFile('text'))).toEqual(['FORMAT_UNKNOWN']);
    expect(codes(parseCourseFile([]))).toEqual(['FORMAT_UNKNOWN']);
    expect(codes(parseCourseFile({ ...testCourse(), format: 'other-game' }))).toEqual(['FORMAT_UNKNOWN']);
    expect(codes(parseCourseFile({ ...testCourse(), format: undefined }))).toEqual(['FORMAT_UNKNOWN']);
  });

  it('rejects a too-new version with VERSION_TOO_NEW and a missing version as structure error', () => {
    expect(codes(parseCourseFile({ ...testCourse(), formatVersion: 2 }))).toEqual(['VERSION_TOO_NEW']);
    expect(codes(parseCourseFile({ ...testCourse(), formatVersion: '1' }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), formatVersion: 0 }))).toEqual(['BAD_STRUCTURE']);
  });

  it('fills defaults for author, description, rules, id and magnet fields', () => {
    const raw = testCourse() as unknown as Record<string, unknown>;
    delete raw.author;
    delete raw.description;
    delete raw.rules;
    delete raw.id;
    raw.walls = putChar(raw.walls as string[], 20, 5, '#');
    raw.objects = [...(raw.objects as unknown[]), { type: 'magnet', x: 20, y: 5, polarity: -1 }];
    const r = parseCourseFile(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.course.author).toBe('');
    expect(r.course.description).toBe('');
    expect(r.course.rules).toEqual({ maxStrokes: DEFAULT_MAX_STROKES, par: DEFAULT_PAR });
    expect(r.course.id).toBe(courseId({ ...r.course, id: '' }));
    const magnet = r.course.objects.find((o) => o.type === 'magnet');
    expect(magnet).toMatchObject({ strength: MAGNET_DEFAULT_STRENGTH, radius: MAGNET_DEFAULT_RADIUS, polarity: -1 });
  });

  it('fills a missing par but keeps a given maxStrokes', () => {
    const r = parseCourseFile({ ...testCourse(), rules: { maxStrokes: 7 } });
    expect(r.ok && r.course.rules).toEqual({ maxStrokes: 7, par: DEFAULT_PAR });
  });

  it('always recomputes the id from the content (R13): a correct c_ id is idempotent, anything else is replaced', () => {
    const expected = courseId({ ...testCourse(), id: '' });
    const bad = parseCourseFile({ ...testCourse(), id: 'my-course' });
    expect(bad.ok && bad.course.id).toBe(expected);
    const unregisteredBuiltin = parseCourseFile({ ...testCourse(), id: 'b_42' });
    expect(unregisteredBuiltin.ok && unregisteredBuiltin.course.id).toBe(expected);
    const staleCustom = parseCourseFile({ ...testCourse(), id: 'c_0123456789abcdef' });
    expect(staleCustom.ok && staleCustom.course.id).toBe(expected);
    const correct = parseCourseFile({ ...testCourse(), id: expected });
    expect(correct.ok && correct.course.id).toBe(expected);
    const missing = parseCourseFile({ ...testCourse(), id: undefined });
    expect(missing.ok && missing.course.id).toBe(expected);
  });

  it('reports structural problems as issues instead of throwing', () => {
    expect(codes(parseCourseFile({ ...testCourse(), surface: 'nope' }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), walls: [1, 2, 3] }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), objects: {} }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), objects: ['start'] }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), objects: [null] }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), name: 5 }))).toEqual(['BAD_NAME']);
  });

  it('passes validation errors through (invalid course is not ok)', () => {
    const r = parseCourseFile({ ...testCourse(), objects: [{ type: 'hole', x: 45, y: 12 }] });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('NO_START');
    const r2 = parseCourseFile({ ...testCourse(), objects: [{ type: 'start', x: 'a', y: 12 }, { type: 'hole', x: 45, y: 12 }] });
    expect(codes(r2)).toContain('OBJECT_OUT_OF_BOUNDS');
  });

  it('does not mutate the input', () => {
    const raw = JSON.parse(JSON.stringify(testCourse())) as Record<string, unknown>;
    delete raw.id;
    const snapshot = JSON.stringify(raw);
    parseCourseFile(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});

describe('parseCourseFile: BAD_OBJECT_TYPE (R14)', () => {
  it('reports an unknown object type with params {x, y} and the entry index', () => {
    const r = parseCourseFile({ ...testCourse(), objects: [...testCourse().objects, { type: 'dragon', x: 7, y: 9 }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(['BAD_OBJECT_TYPE']);
    expect(r.issues[0]).toMatchObject({ level: 'error', objectIndex: 2, x: 7, y: 9, params: { x: 7, y: 9 } });
  });

  it('a missing or non-string type is an unknown type; non-numeric coordinates are reported as "?"', () => {
    const noType = parseCourseFile({ ...testCourse(), objects: [{ x: 1, y: 2 }] });
    expect(noType.ok).toBe(false);
    if (!noType.ok) expect(noType.issues[0]).toMatchObject({ code: 'BAD_OBJECT_TYPE', objectIndex: 0, params: { x: 1, y: 2 } });
    const numType = parseCourseFile({ ...testCourse(), objects: [{ type: 3, x: 'a' }] });
    expect(numType.ok).toBe(false);
    if (!numType.ok) {
      expect(numType.issues[0]).toMatchObject({ code: 'BAD_OBJECT_TYPE', params: { x: '?', y: '?' } });
      expect(numType.issues[0]!.x).toBeUndefined();
    }
  });

  it('every known type passes the shape check (positive case) and every bad entry is reported, not just the first', () => {
    const ok = parseCourseFile({ ...testCourse(), objects: [{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 45, y: 12 }, { type: 'mine', x: 20, y: 12 }] });
    expect(ok.ok).toBe(true);
    const two = parseCourseFile({ ...testCourse(), objects: [{ type: 'a', x: 1, y: 1 }, { type: 'start', x: 3, y: 12 }, { type: 'b', x: 2, y: 2 }] });
    expect(codes(two)).toEqual(['BAD_OBJECT_TYPE', 'BAD_OBJECT_TYPE']);
    if (!two.ok) expect(two.issues.map((i) => i.objectIndex)).toEqual([0, 2]);
  });

  it('lists its own error codes so the client can provide validation.<code> strings', () => {
    expect(PARSE_ERROR_CODES).toEqual(['FORMAT_UNKNOWN', 'VERSION_TOO_NEW', 'BAD_STRUCTURE', 'BAD_OBJECT_TYPE']);
    const seen = new Set<string>();
    for (const r of [
      parseCourseFile(null),
      parseCourseFile({ ...testCourse(), formatVersion: 2 }),
      parseCourseFile({ ...testCourse(), surface: 'nope' }),
      parseCourseFile({ ...testCourse(), objects: [{ type: 'dragon', x: 1, y: 1 }] }),
    ]) {
      for (const code of codes(r)) seen.add(code);
    }
    expect([...seen].sort()).toEqual([...PARSE_ERROR_CODES].sort());
  });
});
