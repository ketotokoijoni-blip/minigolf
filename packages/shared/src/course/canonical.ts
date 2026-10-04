// Canonical JSON and content-hash identity of a course (DESIGN §7.4, D15).
import { fnv1a32, hex8 } from '../math/hash';
import type { Course, CourseObject } from './types';

/** Second FNV offset basis so the id carries two independent 32-bit hashes (no BigInt). */
export const COURSE_ID_BASIS_2 = 0x01000193 ^ 0x811c9dc5;

const str = (s: string): string => JSON.stringify(s);
const num = (n: number): string => JSON.stringify(n);

function canonicalObject(o: CourseObject): string {
  let s = `{"type":${str(o.type)},"x":${num(o.x)},"y":${num(o.y)}`;
  if (o.type === 'teleport') s += `,"group":${num(o.group)}`;
  else if (o.type === 'magnet') s += `,"polarity":${num(o.polarity)},"strength":${num(o.strength)},"radius":${num(o.radius)}`;
  return s + '}';
}

/**
 * Key order: format, formatVersion, name, author, description, width, height, rules{maxStrokes,par}, surface, walls,
 * objects (each: type, x, y, then group | polarity, strength, radius). `id` is excluded. No whitespace.
 */
export function canonicalCourseJson(course: Course): string {
  return (
    `{"format":${str(course.format)},"formatVersion":${num(course.formatVersion)}` +
    `,"name":${str(course.name)},"author":${str(course.author)},"description":${str(course.description)}` +
    `,"width":${num(course.width)},"height":${num(course.height)}` +
    `,"rules":{"maxStrokes":${num(course.rules.maxStrokes)},"par":${num(course.rules.par)}}` +
    `,"surface":[${course.surface.map(str).join(',')}]` +
    `,"walls":[${course.walls.map(str).join(',')}]` +
    `,"objects":[${course.objects.map(canonicalObject).join(',')}]}`
  );
}

/**
 * The shape of a shipped built-in id ('b_' + two digits, §5.2). Only an exact match is preserved by courseId; any
 * other 'b_…' string is treated as a custom course and rehashed. NOTE (reported to the lead): a custom course that
 * claims 'b_01' still keeps that id per the §7.3/§7.4 wording; see the WP-A report for the proposed ruling.
 */
export const BUILTIN_ID_PATTERN = /^b_[0-9]{2}$/;
export const isBuiltinId = (id: unknown): boolean => typeof id === 'string' && BUILTIN_ID_PATTERN.test(id);

/** 'c_' + hex8(fnv1a32(canon)) + hex8(fnv1a32(canon, COURSE_ID_BASIS_2)); built-ins keep their 'b_NN' ids. */
export function courseId(course: Course): string {
  if (isBuiltinId(course.id)) return course.id;
  const canon = canonicalCourseJson(course);
  return 'c_' + hex8(fnv1a32(canon)) + hex8(fnv1a32(canon, COURSE_ID_BASIS_2));
}

/** Copy with id = courseId(course) unless the id starts with 'b_'. */
export function withComputedId(course: Course): Course {
  return { ...course, id: courseId(course) };
}

/** UTF-8 byte length of a string without TextEncoder (shared stays lib-free). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** UTF-8 length of canonicalCourseJson(course). */
export function courseByteLength(course: Course): number {
  return utf8Length(canonicalCourseJson(course));
}
