import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_STROKES, DEFAULT_PAR, MAGNET_DEFAULT_RADIUS, MAGNET_DEFAULT_STRENGTH } from '../constants';
import { courseId } from './canonical';
import { parseCourseFile } from './migrate';
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

  it('recomputes ids that do not match the b_/c_ pattern and keeps matching ones', () => {
    const bad = parseCourseFile({ ...testCourse(), id: 'my-course' });
    expect(bad.ok && bad.course.id).toMatch(/^c_[0-9a-f]{16}$/);
    const builtin = parseCourseFile({ ...testCourse(), id: 'b_42' });
    expect(builtin.ok && builtin.course.id).toBe('b_42');
    const custom = parseCourseFile({ ...testCourse(), id: 'c_0123456789abcdef' });
    expect(custom.ok && custom.course.id).toBe('c_0123456789abcdef');
  });

  it('reports structural problems as issues instead of throwing', () => {
    expect(codes(parseCourseFile({ ...testCourse(), surface: 'nope' }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), walls: [1, 2, 3] }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), objects: {} }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), objects: [{ type: 'dragon', x: 1, y: 1 }] }))).toEqual(['BAD_STRUCTURE']);
    expect(codes(parseCourseFile({ ...testCourse(), objects: ['start'] }))).toEqual(['BAD_STRUCTURE']);
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
