// CourseRef -> validated Course[] (DESIGN §11.6).
//
// *** PHASE 1 SKELETON *** — WP-F phase 2 (after WP-A) implements `resolve()` with findBuiltin / BUILTIN_COURSES,
// parseCourseFile, validateCourse, withComputedId, the MAX_COURSE_BYTES check and the per-id decoded-layer cache
// used by Room's `deps.simulate`. In phase 1 every request is rejected with INVALID_COURSE so a lobby can never
// hold unvalidated courses.
import { MAX_COURSES_PER_SET } from '@puttipeli/shared/constants';
import type { Course, CourseRef, ValidationIssue } from '@puttipeli/shared/course/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';

export type ResolveResult =
  | { ok: true; courses: Course[] }
  | { ok: false; code: ErrorCode; message: string; issues?: ValidationIssue[] };

export class CourseStore {
  resolve(refs: readonly CourseRef[]): ResolveResult {
    if (refs.length < 1 || refs.length > MAX_COURSES_PER_SET) {
      return { ok: false, code: ErrorCode.INVALID_COURSE, message: `Expected 1..${MAX_COURSES_PER_SET} courses` };
    }
    // PHASE 1 STUB: course resolution needs WP-A (course/builtin, course/migrate, course/validate, course/canonical).
    return { ok: false, code: ErrorCode.INVALID_COURSE, message: 'Course selection is not available yet (server phase 1)' };
  }
}
