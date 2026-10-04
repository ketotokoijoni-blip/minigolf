// The built-in course set "Perusradat" (docs/COURSES.md). Each JSON file is run through parseCourseFile at module
// initialisation; any error throws so a bad course fails at startup instead of reaching players (DESIGN §7.7).
//
// Ruling R13: this module is the only producer of 'b_NN' ids. parseCourseFile hands back a content-hash 'c_' id for
// every input; here the shipped id is stamped on the typed course and its canonical JSON is registered in
// course/canonical.ts, after which courseId/withComputedId/parseCourseFile keep 'b_NN' for byte-identical copies only.
import c01 from './builtin/01-ensiputti.json';
import c02 from './builtin/02-kulmakivi.json';
import c03 from './builtin/03-jaatie.json';
import c04 from './builtin/04-lampi.json';
import c05 from './builtin/05-portaali.json';
import c06 from './builtin/06-magneettilaakso.json';
import c07 from './builtin/07-murtuva-muuri.json';
import c08 from './builtin/08-pomppulinna.json';
import c09 from './builtin/09-finaali.json';
import { canonicalCourseJson, registerBuiltinCanonical } from './canonical';
import { parseCourseFile } from './migrate';
import type { Course } from './types';

export const BUILTIN_SET_NAME = 'Perusradat';

const RAW: readonly unknown[] = [c01, c02, c03, c04, c05, c06, c07, c08, c09];

/** Id of the built-in at a 0-based play-order position: 'b_01' … 'b_09'. */
export const builtinIdAt = (index: number): string => `b_${String(index + 1).padStart(2, '0')}`;

function loadBuiltin(raw: unknown, index: number): Course {
  const expectedId = builtinIdAt(index);
  const declaredId = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
  if (declaredId !== expectedId) {
    throw new Error(`built-in course file at position ${index} declares id '${String(declaredId)}', expected '${expectedId}'`);
  }
  const result = parseCourseFile(raw);
  if (!result.ok) {
    const detail = result.issues.map((i) => `${i.code}${i.x !== undefined ? ` (${i.x},${i.y})` : ''}: ${i.message}`).join('; ');
    throw new Error(`built-in course ${expectedId} is invalid: ${detail}`);
  }
  const course: Course = { ...result.course, id: expectedId };
  registerBuiltinCanonical(expectedId, canonicalCourseJson(course));
  return course;
}

/** The 9 built-in courses in play order, ids b_01..b_09. */
export const BUILTIN_COURSES: Course[] = RAW.map(loadBuiltin);

export function findBuiltin(id: string): Course | undefined {
  return BUILTIN_COURSES.find((c) => c.id === id);
}
