// Pure import/export helpers: slug/file names, JSON text round trips through parseCourseFile, BAD_JSON reporting.
import { describe, expect, it } from 'vitest';
import { createBlankCourse } from '@puttipeli/shared/course/blank';
import { canonicalCourseJson } from '@puttipeli/shared/course/canonical';
import { placeObject, setWall } from '@puttipeli/shared/course/edit';
import { WallShape } from '@puttipeli/shared/course/types';
import { EXPORT_SUFFIX, courseToJsonText, courseToShareCode, exportFileName, parseCourseText, slugify } from './importExport';

describe('slugify / exportFileName', () => {
  it('transliterates Finnish letters and keeps only ascii word characters', () => {
    expect(slugify('Mäen Kulma')).toBe('maen-kulma');
    expect(slugify('  Jäätie – kierros 2!  ')).toBe('jaatie-kierros-2');
    expect(slugify('Ööö Ååå')).toBe('ooo-aaa');
  });
  it('falls back for empty or symbol-only names and caps the length', () => {
    expect(slugify('')).toBe('rata');
    expect(slugify('***')).toBe('rata');
    expect(slugify('a'.repeat(80)).length).toBeLessThanOrEqual(40);
  });
  it('builds the export file name', () => {
    expect(exportFileName(createBlankCourse({ name: 'Uusi rata' }))).toBe('uusi-rata' + EXPORT_SUFFIX);
  });
});

describe('parseCourseText', () => {
  const course = placeObject(setWall(createBlankCourse({ name: 'Vienti', author: 'Testaaja' }), 10, 10, WallShape.Full),
    { type: 'magnet', x: 10, y: 10, polarity: -1, strength: 200, radius: 60 });

  it('round-trips the pretty JSON export', () => {
    const r = parseCourseText(courseToJsonText(course));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.course.id).toBe(course.id);
    expect(canonicalCourseJson(r.course)).toBe(canonicalCourseJson(course));
    expect(r.course.objects).toContainEqual({ type: 'magnet', x: 10, y: 10, polarity: -1, strength: 200, radius: 60 });
  });

  it('round-trips the share code and tolerates a BOM', () => {
    const r = parseCourseText('\uFEFF' + courseToShareCode(course));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.course.id).toBe(course.id);
  });

  it('reports invalid JSON as a BAD_JSON issue instead of throwing', () => {
    const r = parseCourseText('{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]!.code).toBe('BAD_JSON');
      expect(r.issues[0]!.level).toBe('error');
    }
  });

  it('passes structural problems through parseCourseFile issues', () => {
    const r = parseCourseText(JSON.stringify({ format: 'other' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('FORMAT_UNKNOWN');
    const r2 = parseCourseText(JSON.stringify({ ...course, objects: [] }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['NO_START', 'NO_HOLE']));
  });
});
