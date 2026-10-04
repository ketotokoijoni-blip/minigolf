// createBlankCourse(meta): grass everywhere, full-wall border ring, start (3,12), hole (45,12), default rules, id computed.
import { COURSE_H, COURSE_W, DEFAULT_MAX_STROKES, DEFAULT_PAR } from '../constants';
import { withComputedId } from './canonical';
import type { Course, CourseRules } from './types';

export type BlankCourseMeta = Partial<Pick<Course, 'name' | 'author' | 'description'>> & Partial<CourseRules>;

export const BLANK_COURSE_NAME = 'Uusi rata';

export function createBlankCourse(meta: BlankCourseMeta = {}): Course {
  const grass = '.'.repeat(COURSE_W);
  const border = '#'.repeat(COURSE_W);
  const inner = '#' + '.'.repeat(COURSE_W - 2) + '#';
  const surface: string[] = [];
  const walls: string[] = [];
  for (let y = 0; y < COURSE_H; y++) {
    surface.push(grass);
    walls.push(y === 0 || y === COURSE_H - 1 ? border : inner);
  }
  return withComputedId({
    format: 'puttipeli-course',
    formatVersion: 1,
    id: '',
    name: meta.name ?? BLANK_COURSE_NAME,
    author: meta.author ?? '',
    description: meta.description ?? '',
    width: 49,
    height: 25,
    rules: { maxStrokes: meta.maxStrokes ?? DEFAULT_MAX_STROKES, par: meta.par ?? DEFAULT_PAR },
    surface,
    walls,
    objects: [
      { type: 'start', x: 3, y: 12 },
      { type: 'hole', x: 45, y: 12 },
    ],
  });
}
