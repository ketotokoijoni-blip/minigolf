// The built-in course set "Perusradat" (docs/COURSES.md). Each JSON file is run through parseCourseFile at module
// initialisation; any error throws so a bad course fails at startup instead of reaching players (DESIGN §7.7).
import c01 from './builtin/01-ensiputti.json';
import c02 from './builtin/02-kulmakivi.json';
import c03 from './builtin/03-jaatie.json';
import c04 from './builtin/04-lampi.json';
import c05 from './builtin/05-portaali.json';
import c06 from './builtin/06-magneettilaakso.json';
import c07 from './builtin/07-murtuva-muuri.json';
import c08 from './builtin/08-pomppulinna.json';
import c09 from './builtin/09-finaali.json';
import { parseCourseFile } from './migrate';
import type { Course } from './types';

export const BUILTIN_SET_NAME = 'Perusradat';

const RAW: readonly unknown[] = [c01, c02, c03, c04, c05, c06, c07, c08, c09];

function loadBuiltin(raw: unknown, index: number): Course {
  const result = parseCourseFile(raw);
  const expectedId = `b_${String(index + 1).padStart(2, '0')}`;
  if (!result.ok) {
    const detail = result.issues.map((i) => `${i.code}${i.x !== undefined ? ` (${i.x},${i.y})` : ''}: ${i.message}`).join('; ');
    throw new Error(`built-in course ${expectedId} is invalid: ${detail}`);
  }
  if (result.course.id !== expectedId) {
    throw new Error(`built-in course at position ${index} has id '${result.course.id}', expected '${expectedId}'`);
  }
  return result.course;
}

/** The 9 built-in courses in play order, ids b_01..b_09. */
export const BUILTIN_COURSES: Course[] = RAW.map(loadBuiltin);

export function findBuiltin(id: string): Course | undefined {
  return BUILTIN_COURSES.find((c) => c.id === id);
}
