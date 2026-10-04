import { describe, expect, it } from 'vitest';
import { MAX_COURSE_BYTES } from '../protocol/limits';
import { VALIDATION_ERROR_CODES, VALIDATION_WARNING_CODES, hasValidationErrors, validateCourse } from './validate';
import type { Course, CourseObject, ValidationIssue } from './types';
import { putChar, putRect, testCourse } from './fixtures.test';

const errors = (c: Course): string[] => validateCourse(c).filter((i) => i.level === 'error').map((i) => i.code);
const warnings = (c: Course): string[] => validateCourse(c).filter((i) => i.level === 'warning').map((i) => i.code);
const find = (c: Course, code: string): ValidationIssue | undefined => validateCourse(c).find((i) => i.code === code);
const SH: CourseObject[] = [{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 45, y: 12 }];

describe('validateCourse: a valid course', () => {
  it('has no issues at all', () => {
    expect(validateCourse(testCourse())).toEqual([]);
    expect(hasValidationErrors([])).toBe(false);
  });
});

describe('validateCourse errors', () => {
  it('BAD_DIMENSIONS: width/height, row count, row length', () => {
    expect(errors({ ...testCourse(), width: 48 as 49 })).toContain('BAD_DIMENSIONS');
    expect(errors({ ...testCourse(), height: 26 as 25 })).toContain('BAD_DIMENSIONS');
    const c = testCourse();
    expect(errors({ ...c, surface: c.surface.slice(0, 24) })).toContain('BAD_DIMENSIONS');
    const short = c.walls.slice();
    short[7] = short[7]!.slice(0, 48);
    const issue = find({ ...c, walls: short }, 'BAD_DIMENSIONS');
    expect(issue).toMatchObject({ level: 'error', y: 7, x: 48 });
    expect(errors(testCourse())).not.toContain('BAD_DIMENSIONS');
  });

  it('BAD_CHAR with position and params', () => {
    const c = testCourse();
    const bad = { ...c, surface: putChar(c.surface, 10, 4, 'Z') };
    expect(find(bad, 'BAD_CHAR')).toMatchObject({ x: 10, y: 4, params: { char: 'Z', layer: 'surface' } });
    const badWall = { ...c, walls: putChar(c.walls, 11, 5, '*') };
    expect(find(badWall, 'BAD_CHAR')).toMatchObject({ x: 11, y: 5, params: { char: '*', layer: 'walls' } });
    // Wall chars are not surface chars and vice versa.
    expect(errors({ ...c, surface: putChar(c.surface, 10, 4, '#') })).toContain('BAD_CHAR');
    expect(errors({ ...c, walls: putChar(c.walls, 10, 4, 's') })).toContain('BAD_CHAR');
    expect(errors({ ...c, surface: putChar(c.surface, 10, 4, 'w') })).not.toContain('BAD_CHAR');
  });

  it('NO_START / MULTIPLE_STARTS', () => {
    expect(errors(testCourse([{ type: 'hole', x: 45, y: 12 }]))).toContain('NO_START');
    expect(errors(testCourse([...SH, { type: 'start', x: 5, y: 5 }]))).toContain('MULTIPLE_STARTS');
    expect(errors(testCourse(SH))).not.toContain('NO_START');
    expect(errors(testCourse(SH))).not.toContain('MULTIPLE_STARTS');
  });

  it('NO_HOLE', () => {
    expect(errors(testCourse([{ type: 'start', x: 3, y: 12 }]))).toContain('NO_HOLE');
    expect(errors(testCourse([...SH, { type: 'hole', x: 40, y: 3 }]))).not.toContain('NO_HOLE');
  });

  it('OBJECT_OUT_OF_BOUNDS: non-integers and out-of-range coordinates', () => {
    expect(find(testCourse([...SH, { type: 'mine', x: 49, y: 3 }]), 'OBJECT_OUT_OF_BOUNDS')).toMatchObject({ objectIndex: 2, x: 49, y: 3 });
    expect(errors(testCourse([...SH, { type: 'mine', x: 3, y: -1 }]))).toContain('OBJECT_OUT_OF_BOUNDS');
    expect(errors(testCourse([...SH, { type: 'mine', x: 3.5, y: 3 }]))).toContain('OBJECT_OUT_OF_BOUNDS');
    expect(errors(testCourse([...SH, { type: 'mine', x: Number.NaN, y: 3 }]))).toContain('OBJECT_OUT_OF_BOUNDS');
    expect(errors(testCourse([...SH, { type: 'mine', x: 1, y: 1 }]))).not.toContain('OBJECT_OUT_OF_BOUNDS');
  });

  it('object issues carry x/y only as finite numbers; raw coordinates (or ?) go to params', () => {
    // A tampered Course (not via parseCourseFile) may have a string or NaN coordinate on a known object type.
    const nan = find(testCourse([...SH, { type: 'mine', x: Number.NaN, y: 3 }]), 'OBJECT_OUT_OF_BOUNDS');
    expect(nan).toMatchObject({ objectIndex: 2, y: 3, params: { x: '?', y: 3 } });
    expect(nan).not.toHaveProperty('x');
    const str = find(testCourse([...SH, { type: 'mine', x: 'a' as unknown as number, y: 'b' as unknown as number }]), 'OBJECT_OUT_OF_BOUNDS');
    expect(str).toMatchObject({ objectIndex: 2, params: { x: '?', y: '?' } });
    expect(str).not.toHaveProperty('x');
    expect(str).not.toHaveProperty('y');
    const inf = find(testCourse([...SH, { type: 'mine', x: Number.POSITIVE_INFINITY, y: 2 }]), 'OBJECT_OUT_OF_BOUNDS');
    expect(inf).toMatchObject({ y: 2, params: { x: '?', y: 2 } });
    expect(inf).not.toHaveProperty('x');
    // Every object issue, including the in-bounds ones, satisfies the number-typed contract and carries params.
    const okCoords = validateCourse(testCourse([...SH, { type: 'mine', x: 45, y: 12 }, { type: 'mine', x: 3.5, y: 3 }]));
    for (const issue of okCoords.filter((i) => i.objectIndex !== undefined)) {
      if (issue.x !== undefined) expect(Number.isFinite(issue.x)).toBe(true);
      if (issue.y !== undefined) expect(Number.isFinite(issue.y)).toBe(true);
    }
    expect(find(testCourse([...SH, { type: 'mine', x: 45, y: 12 }]), 'OBJECT_OVERLAP')).toMatchObject({ x: 45, y: 12, params: { x: 45, y: 12 } });
    expect(find(testCourse([...SH, { type: 'mine', x: 3.5, y: 3 }]), 'OBJECT_OUT_OF_BOUNDS')).toMatchObject({ x: 3.5, y: 3, params: { x: 3.5, y: 3 } });
  });

  it('OBJECT_OVERLAP', () => {
    expect(find(testCourse([...SH, { type: 'mine', x: 45, y: 12 }]), 'OBJECT_OVERLAP')).toMatchObject({ objectIndex: 2 });
    expect(errors(testCourse([...SH, { type: 'mine', x: 44, y: 12 }]))).not.toContain('OBJECT_OVERLAP');
  });

  it('OBJECT_ON_WALL for start/hole/teleport/mine on any wall shape', () => {
    const c = testCourse();
    for (const ch of ['#', '7', 'x', 'M', 'O', '^']) {
      const walls = putChar(c.walls, 45, 12, ch);
      expect(errors({ ...c, walls }), `hole on ${ch}`).toContain('OBJECT_ON_WALL');
    }
    const wallsStart = putChar(c.walls, 3, 12, '#');
    expect(errors({ ...c, walls: wallsStart })).toContain('OBJECT_ON_WALL');
    const tele = testCourse([...SH, { type: 'teleport', x: 10, y: 10, group: 0 }, { type: 'teleport', x: 20, y: 10, group: 0 }]);
    expect(errors({ ...tele, walls: putChar(tele.walls, 10, 10, '>') })).toContain('OBJECT_ON_WALL');
    const mine = testCourse([...SH, { type: 'mine', x: 10, y: 10 }]);
    expect(errors({ ...mine, walls: putChar(mine.walls, 10, 10, 'z') })).toContain('OBJECT_ON_WALL');
    expect(errors(mine)).not.toContain('OBJECT_ON_WALL');
  });

  it('MAGNET_NOT_ON_FULL', () => {
    const c = testCourse([...SH, { type: 'magnet', x: 20, y: 5, polarity: 1, strength: 350, radius: 90 }]);
    expect(errors(c)).toContain('MAGNET_NOT_ON_FULL');
    expect(errors({ ...c, walls: putChar(c.walls, 20, 5, 'x') })).toContain('MAGNET_NOT_ON_FULL');
    expect(errors({ ...c, walls: putChar(c.walls, 20, 5, '#') })).toEqual([]);
  });

  it('OBJECT_ON_HAZARD: start/hole/teleport refuse water, acid and tar; mines refuse only water and acid', () => {
    const c = testCourse();
    for (const ch of ['w', 'a', 't']) {
      expect(errors({ ...c, surface: putChar(c.surface, 45, 12, ch) }), `hole on ${ch}`).toContain('OBJECT_ON_HAZARD');
      expect(errors({ ...c, surface: putChar(c.surface, 3, 12, ch) }), `start on ${ch}`).toContain('OBJECT_ON_HAZARD');
    }
    const tele = testCourse([...SH, { type: 'teleport', x: 10, y: 10, group: 0 }, { type: 'teleport', x: 20, y: 10, group: 0 }]);
    expect(errors({ ...tele, surface: putChar(tele.surface, 20, 10, 't') })).toContain('OBJECT_ON_HAZARD');
    const mine = testCourse([...SH, { type: 'mine', x: 10, y: 10 }]);
    expect(errors({ ...mine, surface: putChar(mine.surface, 10, 10, 'w') })).toContain('OBJECT_ON_HAZARD');
    expect(errors({ ...mine, surface: putChar(mine.surface, 10, 10, 'a') })).toContain('OBJECT_ON_HAZARD');
    expect(errors({ ...mine, surface: putChar(mine.surface, 10, 10, 't') })).toEqual([]);
    expect(errors({ ...c, surface: putChar(c.surface, 45, 12, 'i') })).toEqual([]);
  });

  it('TELEPORT_GROUP_SIZE with params', () => {
    const one = testCourse([...SH, { type: 'teleport', x: 10, y: 10, group: 4 }]);
    expect(find(one, 'TELEPORT_GROUP_SIZE')).toMatchObject({ params: { group: 4, count: 1 } });
    const three = testCourse([...SH,
      { type: 'teleport', x: 10, y: 10, group: 4 }, { type: 'teleport', x: 11, y: 10, group: 4 }, { type: 'teleport', x: 12, y: 10, group: 4 }]);
    expect(find(three, 'TELEPORT_GROUP_SIZE')).toMatchObject({ params: { group: 4, count: 3 } });
    const two = testCourse([...SH, { type: 'teleport', x: 10, y: 10, group: 4 }, { type: 'teleport', x: 11, y: 10, group: 4 }]);
    expect(errors(two)).toEqual([]);
  });

  it('BAD_TELEPORT_GROUP', () => {
    const bad = testCourse([...SH, { type: 'teleport', x: 10, y: 10, group: 8 as 0 }, { type: 'teleport', x: 11, y: 10, group: 8 as 0 }]);
    expect(errors(bad)).toContain('BAD_TELEPORT_GROUP');
    expect(errors(bad)).not.toContain('TELEPORT_GROUP_SIZE');
    const neg = testCourse([...SH, { type: 'teleport', x: 10, y: 10, group: -1 as 0 }, { type: 'teleport', x: 11, y: 10, group: 7 }]);
    expect(errors(neg)).toContain('BAD_TELEPORT_GROUP');
    const ok = testCourse([...SH, { type: 'teleport', x: 10, y: 10, group: 7 }, { type: 'teleport', x: 11, y: 10, group: 7 }]);
    expect(errors(ok)).not.toContain('BAD_TELEPORT_GROUP');
  });

  it('BAD_MAGNET: polarity, strength, radius', () => {
    const base = testCourse();
    const walls = putChar(base.walls, 20, 5, '#');
    const mk = (polarity: number, strength: number, radius: number): Course =>
      ({ ...base, walls, objects: [...SH, { type: 'magnet', x: 20, y: 5, polarity: polarity as 1, strength, radius }] });
    expect(errors(mk(0, 350, 90))).toContain('BAD_MAGNET');
    expect(errors(mk(2, 350, 90))).toContain('BAD_MAGNET');
    expect(errors(mk(1, Number.NaN, 90))).toContain('BAD_MAGNET');
    expect(errors(mk(1, 350, Number.POSITIVE_INFINITY))).toContain('BAD_MAGNET');
    expect(errors(mk(-1, 350, 90))).toEqual([]);
    expect(errors(mk(1, 5, 5))).toEqual([]); // out-of-range values are clamped by decodeLayers, not rejected
  });

  it('BAD_RULES', () => {
    const c = testCourse();
    expect(errors({ ...c, rules: { maxStrokes: 0, par: 3 } })).toContain('BAD_RULES');
    expect(errors({ ...c, rules: { maxStrokes: 51, par: 3 } })).toContain('BAD_RULES');
    expect(errors({ ...c, rules: { maxStrokes: 20, par: 0 } })).toContain('BAD_RULES');
    expect(errors({ ...c, rules: { maxStrokes: 20, par: 21 } })).toContain('BAD_RULES');
    expect(errors({ ...c, rules: { maxStrokes: 20, par: 2.5 } })).toContain('BAD_RULES');
    expect(errors({ ...c, rules: { maxStrokes: 1, par: 1 } })).toEqual([]);
    expect(errors({ ...c, rules: { maxStrokes: 50, par: 20 } })).toEqual([]);
  });

  it('BAD_NAME / BAD_AUTHOR / BAD_DESCRIPTION', () => {
    const c = testCourse();
    expect(errors({ ...c, name: '' })).toContain('BAD_NAME');
    expect(errors({ ...c, name: '   ' })).toContain('BAD_NAME');
    expect(errors({ ...c, name: 'x'.repeat(41) })).toContain('BAD_NAME');
    expect(errors({ ...c, name: 'x'.repeat(40) })).toEqual([]);
    expect(errors({ ...c, author: 'a'.repeat(41) })).toContain('BAD_AUTHOR');
    expect(errors({ ...c, author: '' })).toEqual([]);
    expect(errors({ ...c, author: 'a'.repeat(40) })).toEqual([]);
    expect(errors({ ...c, description: 'd'.repeat(201) })).toContain('BAD_DESCRIPTION');
    expect(errors({ ...c, description: 'd'.repeat(200) })).toEqual([]);
  });

  it('TOO_LARGE when the canonical JSON exceeds MAX_COURSE_BYTES', () => {
    const c = testCourse();
    const many: CourseObject[] = [...SH];
    for (let y = 1; y < 24; y++) for (let x = 1; x < 48; x++) if (!(x === 3 && y === 12) && !(x === 45 && y === 12)) many.push({ type: 'mine', x, y });
    const big = { ...c, objects: many };
    expect(errors(big)).toContain('TOO_LARGE');
    const small = { ...c, objects: many.slice(0, 200) };
    expect(errors(small)).not.toContain('TOO_LARGE');
    expect(MAX_COURSE_BYTES).toBeGreaterThan(3000);
  });
});

describe('validateCourse warnings', () => {
  it('UNREACHABLE_HOLE is a warning only and is skipped when there are errors', () => {
    const c = testCourse();
    const blocked = { ...c, walls: putRect(c.walls, 24, 1, 24, 23, '#') };
    expect(warnings(blocked)).toContain('UNREACHABLE_HOLE');
    expect(errors(blocked)).toEqual([]);
    expect(hasValidationErrors(validateCourse(blocked))).toBe(false);
    expect(warnings({ ...blocked, name: '' })).not.toContain('UNREACHABLE_HOLE');
    expect(warnings(c)).not.toContain('UNREACHABLE_HOLE');
  });

  it('HOLE_NEXT_TO_START (Chebyshev distance <= 1)', () => {
    expect(warnings(testCourse([{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 4, y: 13 }]))).toContain('HOLE_NEXT_TO_START');
    expect(warnings(testCourse([{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 5, y: 12 }]))).not.toContain('HOLE_NEXT_TO_START');
  });

  it('OPEN_BORDER', () => {
    const c = testCourse();
    expect(find({ ...c, walls: putChar(c.walls, 0, 10, '.') }, 'OPEN_BORDER')).toMatchObject({ level: 'warning', x: 0, y: 10 });
    expect(warnings({ ...c, walls: putChar(c.walls, 48, 24, 'O') })).not.toContain('OPEN_BORDER');
    expect(warnings(c)).not.toContain('OPEN_BORDER');
  });

  it('PAR_HIGH above 8', () => {
    const c = testCourse();
    expect(warnings({ ...c, rules: { maxStrokes: 20, par: 9 } })).toContain('PAR_HIGH');
    expect(warnings({ ...c, rules: { maxStrokes: 20, par: 8 } })).not.toContain('PAR_HIGH');
  });

  it('errors are listed before warnings', () => {
    const c = testCourse([{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 4, y: 12 }]);
    const issues = validateCourse({ ...c, rules: { maxStrokes: 20, par: 9 }, name: '' });
    expect(issues.map((i) => i.level)).toEqual(['error', 'warning', 'warning']); // BAD_NAME, then PAR_HIGH + HOLE_NEXT_TO_START
  });
});

describe('validateCourse structure of direct Course objects (not via parseCourseFile)', () => {
  it('BAD_OBJECT_TYPE (params x, y) for an unknown object type; BAD_STRUCTURE for a non-object entry (R14)', () => {
    const c = testCourse();
    const unknown = { ...c, objects: [...c.objects, { type: 'portal', x: 10, y: 10 } as unknown as CourseObject] };
    expect(errors(unknown)).toContain('BAD_OBJECT_TYPE');
    expect(errors(unknown)).not.toContain('BAD_STRUCTURE');
    expect(find(unknown, 'BAD_OBJECT_TYPE')).toMatchObject({ level: 'error', objectIndex: 2, x: 10, y: 10, params: { x: 10, y: 10 } });
    // A missing type or a non-string type is still an unknown type; non-numeric coordinates become '?' in params.
    const noType = { ...c, objects: [...c.objects, { x: 4, y: 'five' } as unknown as CourseObject] };
    expect(find(noType, 'BAD_OBJECT_TYPE')).toMatchObject({ objectIndex: 2, x: 4, params: { x: 4, y: '?' } });
    expect(find(noType, 'BAD_OBJECT_TYPE')?.y).toBeUndefined();
    const nul = { ...c, objects: [...c.objects, null as unknown as CourseObject] };
    expect(find(nul, 'BAD_STRUCTURE')).toMatchObject({ level: 'error', objectIndex: 2 });
    expect(errors(nul)).not.toContain('BAD_OBJECT_TYPE');
    // The valid objects around the bad entry are still checked (positive case: no other spurious errors).
    expect(errors(unknown)).toEqual(['BAD_OBJECT_TYPE']);
    expect(errors(c)).not.toContain('BAD_OBJECT_TYPE');
    expect(errors(c)).not.toContain('BAD_STRUCTURE');
    // decodeLayers never sees it: the validated-course precondition holds because the issue is an error.
    expect(hasValidationErrors(validateCourse(unknown))).toBe(true);
  });
});

describe('validation code lists', () => {
  it('cover the §7.5 table plus BAD_OBJECT_TYPE and BAD_STRUCTURE, with no duplicates', () => {
    const table = [
      'BAD_DIMENSIONS', 'BAD_CHAR', 'NO_START', 'MULTIPLE_STARTS', 'NO_HOLE', 'OBJECT_OUT_OF_BOUNDS', 'OBJECT_OVERLAP',
      'OBJECT_ON_WALL', 'MAGNET_NOT_ON_FULL', 'OBJECT_ON_HAZARD', 'TELEPORT_GROUP_SIZE', 'BAD_TELEPORT_GROUP', 'BAD_MAGNET',
      'BAD_RULES', 'BAD_NAME', 'BAD_AUTHOR', 'BAD_DESCRIPTION', 'TOO_LARGE',
    ];
    expect([...VALIDATION_ERROR_CODES].sort()).toEqual([...table, 'BAD_OBJECT_TYPE', 'BAD_STRUCTURE'].sort());
    expect(new Set(VALIDATION_ERROR_CODES).size).toBe(VALIDATION_ERROR_CODES.length);
    expect([...VALIDATION_WARNING_CODES].sort()).toEqual(['HOLE_NEXT_TO_START', 'OPEN_BORDER', 'PAR_HIGH', 'UNREACHABLE_HOLE']);
  });

  it('every code the validator emits for a battery of broken courses is in the lists, and the battery reaches every code', () => {
    const c = testCourse();
    const all = new Set<string>([...VALIDATION_ERROR_CODES, ...VALIDATION_WARNING_CODES]);
    const sealed = c.walls.map((row, y) => (y >= 1 && y <= 23 ? row.slice(0, 40) + '#' + row.slice(41) : row));
    const broken: Course[] = [
      { ...c, width: 48 as 49 },
      { ...c, surface: putChar(c.surface, 5, 5, 'Q') },
      testCourse([{ type: 'hole', x: 45, y: 12 }]),
      testCourse([...SH, { type: 'start', x: 5, y: 5 }]),
      testCourse([{ type: 'start', x: 3, y: 12 }]),
      testCourse([...SH, { type: 'mine', x: 49, y: 0 }]),
      testCourse([...SH, { type: 'mine', x: 45, y: 12 }]),
      testCourse([...SH, { type: 'mine', x: 0, y: 0 }]),
      testCourse([...SH, { type: 'magnet', x: 10, y: 10, polarity: 1, strength: 300, radius: 60 }]),
      { ...testCourse([...SH, { type: 'mine', x: 10, y: 10 }]), surface: putChar(c.surface, 10, 10, 'w') },
      testCourse([...SH, { type: 'teleport', x: 10, y: 10, group: 0 }]),
      testCourse([...SH, { type: 'teleport', x: 10, y: 10, group: 9 as 0 }, { type: 'teleport', x: 11, y: 10, group: 9 as 0 }]),
      { ...testCourse([...SH, { type: 'magnet', x: 10, y: 10, polarity: 2 as 1, strength: 300, radius: 60 }]), walls: putChar(c.walls, 10, 10, '#') },
      { ...c, rules: { maxStrokes: 0, par: 3 } },
      { ...c, rules: { maxStrokes: 20, par: 9 } },
      { ...c, name: '' },
      { ...c, author: 'a'.repeat(41) },
      { ...c, description: 'a'.repeat(201) },
      { ...c, objects: [...c.objects, { type: 'portal', x: 1, y: 1 } as unknown as CourseObject] },
      { ...c, objects: [...c.objects, null as unknown as CourseObject] },
      { ...c, walls: putChar(c.walls, 0, 5, '.') },
      { ...c, walls: sealed },
      testCourse([{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 4, y: 12 }]),
    ];
    const seen = new Set<string>();
    for (const b of broken) for (const i of validateCourse(b)) seen.add(i.code);
    for (const code of seen) expect(all.has(code), code).toBe(true);
    const missing = [...all].filter((code) => !seen.has(code));
    expect(missing).toEqual([]);
  });
});
