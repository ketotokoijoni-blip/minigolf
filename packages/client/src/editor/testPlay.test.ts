// Test play hand-off (DESIGN §13.4): pending local game shape, error gating.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYER_NAME, MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import { createBlankCourse } from '@puttipeli/shared/course/blank';
import { removeObjectAt } from '@puttipeli/shared/course/edit';
import { validateCourse } from '@puttipeli/shared/course/validate';
import { takePendingLocalGame } from '../app/activeHost';
import { EDITOR_ROUTE, GAME_ROUTE, buildTestPlayRequest, canTestPlay, startTestPlay } from './testPlay';

const course = createBlankCourse({ name: 'Testirata' });

describe('buildTestPlayRequest', () => {
  it('wraps the single course as an editor test play returning to #/editor', () => {
    const req = buildTestPlayRequest(course, { name: '  Pelaaja Yksi  ', colour: 2 });
    expect(req).toEqual({ courses: [course], playerName: 'Pelaaja Yksi', colour: 2, returnTo: EDITOR_ROUTE, testPlay: true });
  });
  it('defaults an empty name and clips a long one', () => {
    expect(buildTestPlayRequest(course, { name: '   ', colour: 0 }).playerName).toBe(DEFAULT_PLAYER_NAME);
    expect(buildTestPlayRequest(course, { name: 'x'.repeat(50), colour: 0 }).playerName).toHaveLength(MAX_NAME_CHARS);
  });
});

describe('startTestPlay', () => {
  it('sets the pending game and navigates when the course has no errors (warnings are fine)', () => {
    const issues = validateCourse(course);
    expect(issues.every((i) => i.level !== 'error')).toBe(true);
    const visited: string[] = [];
    expect(canTestPlay(issues)).toBe(true);
    expect(startTestPlay(course, issues, { name: 'A', colour: 1 }, (h) => visited.push(h))).toBe(true);
    expect(visited).toEqual([GAME_ROUTE]);
    const pending = takePendingLocalGame();
    expect(pending?.courses[0]).toBe(course);
    expect(pending?.testPlay).toBe(true);
    expect(pending?.returnTo).toBe(EDITOR_ROUTE);
    expect(takePendingLocalGame()).toBeNull();
  });

  it('refuses a course with validation errors and leaves no pending game', () => {
    const broken = removeObjectAt(course, 45, 12); // no hole
    const issues = validateCourse(broken);
    expect(canTestPlay(issues)).toBe(false);
    const visited: string[] = [];
    expect(startTestPlay(broken, issues, { name: 'A', colour: 1 }, (h) => visited.push(h))).toBe(false);
    expect(visited).toEqual([]);
    expect(takePendingLocalGame()).toBeNull();
  });
});
