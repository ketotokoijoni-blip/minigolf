// Canonical JSON and content-hash identity of a course (DESIGN §7.4, D15, ruling R13).
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

/** The shape of a shipped built-in id ('b_' + two digits, §5.2). */
export const BUILTIN_ID_PATTERN = /^b_[0-9]{2}$/;
/** The shape of a content-hash id ('c_' + 16 lowercase hex). */
export const CUSTOM_ID_PATTERN = /^c_[0-9a-f]{16}$/;
export const isBuiltinId = (id: unknown): boolean => typeof id === 'string' && BUILTIN_ID_PATTERN.test(id);
export const isCustomId = (id: unknown): boolean => typeof id === 'string' && CUSTOM_ID_PATTERN.test(id);

/**
 * Built-in ids are reserved (R13). Layers are cached per course id on the client and the server, so a custom course
 * claiming 'b_01' would be simulated with the wrong geometry. `course/builtin.ts` is the only producer of 'b_NN' ids:
 * at module initialisation it registers the canonical JSON of every shipped course here, and `courseId` keeps a
 * 'b_NN' id only when the course's canonical JSON equals the registered one. Everything else gets a 'c_' hash.
 * canonical.ts never imports builtin.ts (no import cycle); before builtin.ts has run, no 'b_' id survives.
 */
const builtinCanon = new Map<string, string>();

/** Registers (or re-registers, e.g. on dev-server hot reload) the canonical JSON of a shipped built-in course. */
export function registerBuiltinCanonical(id: string, canon: string): void {
  if (!isBuiltinId(id)) throw new Error(`'${id}' is not a built-in id (expected b_NN)`);
  builtinCanon.set(id, canon);
}

/** Canonical JSON registered for a built-in id, or undefined when builtin.ts has not registered it. */
export const registeredBuiltinCanonical = (id: string): string | undefined => builtinCanon.get(id);

/** Registered built-in ids in registration order (empty until course/builtin.ts has been imported). */
export const registeredBuiltinIds = (): string[] => [...builtinCanon.keys()];

/** True when the course carries a registered built-in id and its content is byte-identical to that built-in. */
export function isRegisteredBuiltin(course: Course): boolean {
  if (!isBuiltinId(course.id)) return false;
  const canon = builtinCanon.get(course.id);
  return canon !== undefined && canon === canonicalCourseJson(course);
}

/** 'c_' + hex8(fnv1a32(canon)) + hex8(fnv1a32(canon, COURSE_ID_BASIS_2)) of a canonical JSON string. */
export function customIdOfCanonical(canon: string): string {
  return 'c_' + hex8(fnv1a32(canon)) + hex8(fnv1a32(canon, COURSE_ID_BASIS_2));
}

/**
 * Content id of a course. A registered built-in whose canonical JSON matches keeps its 'b_NN' id; every other
 * course (including one that merely claims a built-in id, or claims one that is not registered) gets
 * 'c_' + hex8(fnv1a32(canon)) + hex8(fnv1a32(canon, COURSE_ID_BASIS_2)). The id field itself never affects the hash.
 */
export function courseId(course: Course): string {
  const canon = canonicalCourseJson(course);
  if (isBuiltinId(course.id) && builtinCanon.get(course.id) === canon) return course.id;
  return customIdOfCanonical(canon);
}

/** Copy with id = courseId(course): built-in ids survive only when the content matches the registered built-in (R13). */
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
