// parseCourseFile(unknown): structural check + version chain + defaults, then validateCourse (DESIGN §7.3).
import { COURSE_H, COURSE_W, DEFAULT_MAX_STROKES, DEFAULT_PAR, MAGNET_DEFAULT_RADIUS, MAGNET_DEFAULT_STRENGTH } from '../constants';
import { courseId } from './canonical';
import type { Course, CourseObject, CourseRules, TeleportGroup, ValidationIssue } from './types';
import { validateCourse } from './validate';

export type ParseResult =
  | { ok: true; course: Course; warnings: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

export const COURSE_FORMAT = 'puttipeli-course';
export const CURRENT_FORMAT_VERSION = 1;
/** Accepted id shapes: built-in 'b_NN' or content hash 'c_' + 16 hex. Anything else is recomputed. */
const ID_PATTERN = /^(b_[0-9]{2}|c_[0-9a-f]{16})$/;

const OBJECT_TYPES = new Set<string>(['start', 'hole', 'teleport', 'magnet', 'mine']);

const fail = (code: string, message: string): ParseResult => ({ ok: false, issues: [{ level: 'error', code, message }] });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asNumber = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

function normalizeRules(raw: unknown): CourseRules {
  const r = isRecord(raw) ? raw : {};
  return {
    maxStrokes: r.maxStrokes === undefined ? DEFAULT_MAX_STROKES : asNumber(r.maxStrokes),
    par: r.par === undefined ? DEFAULT_PAR : asNumber(r.par),
  };
}

/** Shape check of one object entry; field values are left for validateCourse, only the discriminator is enforced here. */
function normalizeObject(raw: unknown, index: number): CourseObject | ValidationIssue {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !OBJECT_TYPES.has(raw.type)) {
    return { level: 'error', code: 'BAD_STRUCTURE', message: `objects[${index}] is not a known course object`, objectIndex: index };
  }
  const x = asNumber(raw.x);
  const y = asNumber(raw.y);
  switch (raw.type) {
    case 'start':
      return { type: 'start', x, y };
    case 'hole':
      return { type: 'hole', x, y };
    case 'mine':
      return { type: 'mine', x, y };
    case 'teleport':
      return { type: 'teleport', x, y, group: asNumber(raw.group) as TeleportGroup };
    default:
      return {
        type: 'magnet', x, y,
        polarity: asNumber(raw.polarity) as 1 | -1,
        strength: raw.strength === undefined ? MAGNET_DEFAULT_STRENGTH : asNumber(raw.strength),
        radius: raw.radius === undefined ? MAGNET_DEFAULT_RADIUS : asNumber(raw.radius),
      };
  }
}

/** v1 -> v1 identity migration; the chain exists so a v2 can add sizes later. */
function migrateToCurrent(raw: Record<string, unknown>, version: number): Record<string, unknown> {
  // version 1 is the only one so far; `version` is kept for the future chain (if (version < 2) raw = v1to2(raw) ...).
  void version;
  return raw;
}

/**
 * Structural check (format discriminator, version chain, defaults for optional fields), then validateCourse.
 * Never throws; unusable input comes back as issues. Missing author/description default to '', missing rules to
 * the defaults, id is recomputed when missing or not matching the c_/b_ pattern.
 */
export function parseCourseFile(input: unknown): ParseResult {
  if (!isRecord(input)) return fail('FORMAT_UNKNOWN', 'course file is not a JSON object');
  if (input.format !== COURSE_FORMAT) return fail('FORMAT_UNKNOWN', `format '${String(input.format)}' is not '${COURSE_FORMAT}'`);
  const version = input.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return fail('BAD_STRUCTURE', 'formatVersion must be a positive integer');
  }
  if (version > CURRENT_FORMAT_VERSION) return fail('VERSION_TOO_NEW', `formatVersion ${version} is newer than ${CURRENT_FORMAT_VERSION}`);
  const raw = migrateToCurrent(input, version);

  const issues: ValidationIssue[] = [];
  for (const layer of ['surface', 'walls'] as const) {
    const rows = raw[layer];
    if (!Array.isArray(rows) || !rows.every((r) => typeof r === 'string')) {
      issues.push({ level: 'error', code: 'BAD_STRUCTURE', message: `${layer} must be an array of strings` });
    }
  }
  if (raw.objects !== undefined && !Array.isArray(raw.objects)) {
    issues.push({ level: 'error', code: 'BAD_STRUCTURE', message: 'objects must be an array' });
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') issues.push({ level: 'error', code: 'BAD_NAME', message: 'name must be a string' });
  if (raw.author !== undefined && typeof raw.author !== 'string') issues.push({ level: 'error', code: 'BAD_AUTHOR', message: 'author must be a string' });
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    issues.push({ level: 'error', code: 'BAD_DESCRIPTION', message: 'description must be a string' });
  }
  if (issues.length > 0) return { ok: false, issues };

  const objects: CourseObject[] = [];
  const rawObjects = Array.isArray(raw.objects) ? raw.objects : [];
  rawObjects.forEach((o, i) => {
    const n = normalizeObject(o, i);
    if ('level' in n) issues.push(n);
    else objects.push(n);
  });
  if (issues.length > 0) return { ok: false, issues };

  const course: Course = {
    format: COURSE_FORMAT,
    formatVersion: 1,
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    author: typeof raw.author === 'string' ? raw.author : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    width: (raw.width === undefined ? COURSE_W : asNumber(raw.width)) as 49,
    height: (raw.height === undefined ? COURSE_H : asNumber(raw.height)) as 25,
    rules: normalizeRules(raw.rules),
    surface: (raw.surface as string[]).slice(),
    walls: (raw.walls as string[]).slice(),
    objects,
  };

  const all = validateCourse(course);
  const errors = all.filter((i) => i.level === 'error');
  if (errors.length > 0) return { ok: false, issues: all };
  if (!ID_PATTERN.test(course.id)) course.id = courseId({ ...course, id: '' });
  return { ok: true, course, warnings: all };
}
