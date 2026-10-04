// CourseRef -> validated Course[] plus the per-id decoded-layer cache used by Room's `deps.simulate` (DESIGN §11.6).
//
// Built-in refs resolve through findBuiltin (unknown id -> INVALID_COURSE). Custom courses go through WP-A's
// parseCourseFile (structure, version chain, validateCourse incl. TOO_LARGE); errors come back as INVALID_COURSE with
// the issues attached so the client can show them. Ids are recomputed server-side (R13: a custom course may never
// carry a built-in id unless it is byte-identical to that built-in, because layers are cached per course id).
import { MAX_COURSES_PER_SET } from '@puttipeli/shared/constants';
import { BUILTIN_COURSES, findBuiltin } from '@puttipeli/shared/course/builtin';
import { canonicalCourseJson, courseId, isBuiltinId } from '@puttipeli/shared/course/canonical';
import { parseCourseFile } from '@puttipeli/shared/course/migrate';
import { decodeLayers } from '@puttipeli/shared/course/parse';
import type { Course, CourseLayers, CourseRef, ValidationIssue } from '@puttipeli/shared/course/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';

export type ResolveResult =
  | { ok: true; courses: Course[] }
  | { ok: false; code: ErrorCode; message: string; issues?: ValidationIssue[] };

/** Decoded layers kept for custom courses (built-ins are always kept); oldest entry evicted beyond this. */
export const LAYER_CACHE_MAX_CUSTOM = 256;

/**
 * R13 locally enforced: a course whose id looks built-in but whose canonical JSON differs from that built-in (or
 * names no built-in) gets a content-hash id. A byte-identical copy resolves to the built-in object itself.
 */
export function withServerId(course: Course): Course {
  if (isBuiltinId(course.id)) {
    const builtin = findBuiltin(course.id);
    if (builtin !== undefined && canonicalCourseJson(builtin) === canonicalCourseJson(course)) return builtin;
    return { ...course, id: courseId({ ...course, id: '' }) };
  }
  const id = courseId(course);
  return id === course.id ? course : { ...course, id };
}

export class CourseStore {
  private readonly builtinLayers = new Map<string, CourseLayers>();
  private readonly customLayers = new Map<string, CourseLayers>();

  constructor(private readonly maxCustom: number = LAYER_CACHE_MAX_CUSTOM) {}

  /** Every built-in course in set order (the initial course set of a new room). */
  builtins(): Course[] {
    return BUILTIN_COURSES.slice();
  }

  resolve(refs: readonly CourseRef[]): ResolveResult {
    if (refs.length < 1 || refs.length > MAX_COURSES_PER_SET) {
      return { ok: false, code: ErrorCode.INVALID_COURSE, message: `Expected 1..${MAX_COURSES_PER_SET} courses` };
    }
    const courses: Course[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!;
      if (ref.kind === 'builtin') {
        const course = findBuiltin(ref.id);
        if (course === undefined) {
          return { ok: false, code: ErrorCode.INVALID_COURSE, message: `Unknown built-in course '${ref.id}' (entry ${i})` };
        }
        courses.push(course);
        continue;
      }
      const parsed = parseCourseFile(ref.course);
      if (!parsed.ok) {
        const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ ...issue, params: { ...issue.params, courseIndex: i } }));
        const first = issues[0];
        return {
          ok: false,
          code: ErrorCode.INVALID_COURSE,
          message: `Course ${i + 1} is invalid: ${first ? `${first.code} ${first.message}` : 'unknown error'}`,
          issues,
        };
      }
      courses.push(withServerId(parsed.course));
    }
    return { ok: true, courses };
  }

  /** decodeLayers(course) cached by course id (ids are content hashes or reserved built-in ids, R13). */
  layersFor(course: Course): CourseLayers {
    const builtin = this.builtinLayers.get(course.id);
    if (builtin !== undefined) return builtin;
    const custom = this.customLayers.get(course.id);
    if (custom !== undefined) return custom;
    const layers = decodeLayers(course);
    if (isBuiltinId(course.id)) {
      this.builtinLayers.set(course.id, layers);
    } else {
      this.customLayers.set(course.id, layers);
      while (this.customLayers.size > this.maxCustom) {
        const oldest = this.customLayers.keys().next().value;
        if (oldest === undefined) break;
        this.customLayers.delete(oldest);
      }
    }
    return layers;
  }

  cachedLayerCount(): number {
    return this.builtinLayers.size + this.customLayers.size;
  }
}
