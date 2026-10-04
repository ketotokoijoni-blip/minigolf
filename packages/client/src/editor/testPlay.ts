// Test play (DESIGN §13.4): hands the current course to the play view as a pending local game and navigates to
// #/game. The editor session itself stays in memory (module state in editor.screen.ts) and is restored when the
// play view navigates back to returnTo. Same simulateShot everywhere, so what works here works online.
import { DEFAULT_PLAYER_NAME, MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import type { Course, ValidationIssue } from '@puttipeli/shared/course/types';
import { hasValidationErrors } from '@puttipeli/shared/course/validate';
import type { PlayerColour } from '@puttipeli/shared/game/types';
import { setPendingLocalGame, type PendingLocalGame } from '../app/activeHost';

export const EDITOR_ROUTE = '#/editor';
export const GAME_ROUTE = '#/game';

export interface TestPlayer { name: string; colour: PlayerColour }

/** Errors block test play (§7.5: a course with errors never reaches an authority); warnings do not. */
export const canTestPlay = (issues: readonly ValidationIssue[]): boolean => !hasValidationErrors(issues);

export function buildTestPlayRequest(course: Course, player: TestPlayer): PendingLocalGame {
  const name = player.name.trim().slice(0, MAX_NAME_CHARS);
  return {
    courses: [course],
    playerName: name || DEFAULT_PLAYER_NAME,
    colour: player.colour,
    returnTo: EDITOR_ROUTE,
    testPlay: true,
  };
}

/** Returns false (and does nothing) when the course has validation errors. */
export function startTestPlay(course: Course, issues: readonly ValidationIssue[], player: TestPlayer, navigate: (hash: string) => void): boolean {
  if (!canTestPlay(issues)) return false;
  setPendingLocalGame(buildTestPlayRequest(course, player));
  navigate(GAME_ROUTE);
  return true;
}
