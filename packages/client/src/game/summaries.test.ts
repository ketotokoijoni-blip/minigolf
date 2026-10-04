// Pure helpers of the play-view overlays: hole result classification and labels, par formatting, ranking lines,
// and the self-registered game.* strings (both languages, same keys, same placeholders).
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import { createSinglePlayerState } from '@puttipeli/shared/game/initial';
import type { GameState, PlayerState } from '@puttipeli/shared/game/types';
import { setLanguage, t } from '../i18n/t';
import { formatDiff, holeResult, holeResultLabel, localHoleResult, rankingLines, strokesLabel } from './summaries';

const player = (id: string, name: string, colour: 0 | 1 | 2 | 3, joinedSeq: number, leftRound = false): PlayerState =>
  ({ id, name, colour, ready: true, connected: true, afk: false, consecutiveTimeouts: 0, joinedSeq, leftRound });

afterEach(() => setLanguage('fi'));

describe('holeResult', () => {
  it('classifies strokes against par, with hole-in-one and the stroke limit first', () => {
    expect(holeResult(1, 3, 20, true).kind).toBe('holeInOne');
    expect(holeResult(1, 1, 20, true).kind).toBe('holeInOne');
    expect(holeResult(2, 5, 20, true).kind).toBe('albatross');
    expect(holeResult(1, 3, 20, false).kind).toBe('eagle'); // not holed (impossible in practice) is never a hole-in-one
    expect(holeResult(2, 4, 20, true).kind).toBe('eagle');
    expect(holeResult(2, 3, 20, true).kind).toBe('birdie');
    expect(holeResult(3, 3, 20, true).kind).toBe('par');
    expect(holeResult(4, 3, 20, true).kind).toBe('bogey');
    expect(holeResult(5, 3, 20, true).kind).toBe('doubleBogey');
    expect(holeResult(7, 3, 20, true)).toEqual({ kind: 'over', strokes: 7, diff: 4 });
    expect(holeResult(20, 3, 20, false).kind).toBe('maxStrokes');
    expect(holeResult(20, 3, 20, true).kind).toBe('over'); // holed with the last allowed stroke counts as a score
    expect(holeResult(-1, 3, 20, false)).toEqual({ kind: 'notPlayed', strokes: 0, diff: 0 });
  });

  it('labels are localized in both languages', () => {
    expect(holeResultLabel(holeResult(2, 3, 20, true))).toBe('Birdie');
    expect(holeResultLabel(holeResult(5, 3, 20, true))).toBe('Tupla-bogey');
    expect(holeResultLabel(holeResult(8, 3, 20, true))).toBe('+5');
    expect(holeResultLabel(holeResult(20, 3, 20, false))).toBe('Lyöntiraja täyttyi');
    setLanguage('en');
    expect(holeResultLabel(holeResult(5, 3, 20, true))).toBe('Double bogey');
    expect(holeResultLabel(holeResult(20, 3, 20, false))).toBe('Stroke limit reached');
    expect(strokesLabel(1)).toBe('1 stroke');
    expect(strokesLabel(4)).toBe('4 strokes');
  });

  it('formatDiff uses E and a typographic minus', () => {
    expect(formatDiff(0)).toBe('E');
    expect(formatDiff(3)).toBe('+3');
    expect(formatDiff(-2)).toBe('−2');
  });
});

describe('localHoleResult / rankingLines on a GameState', () => {
  const courses = BUILTIN_COURSES.slice(0, 3);
  const base = (): GameState => createSinglePlayerState(courses, player('p1', 'Aino', 0, 1));

  it('reads the local player\'s result for the current hole', () => {
    const s: GameState = { ...base(), phase: 'holeSummary', holeIndex: 1, strokes: { p1: [3, 2, -1] }, holeDone: { p1: true } };
    expect(localHoleResult(s, 'p1')).toEqual({ kind: 'par', strokes: 2, diff: 0 }); // b_02 par 2
    const maxed: GameState = { ...s, strokes: { p1: [3, courses[1]!.rules.maxStrokes, -1] } };
    expect(localHoleResult(maxed, 'p1')!.kind).toBe('maxStrokes'); // unknown shot result: inferred from the limit
    expect(localHoleResult(maxed, 'p1', false)!.kind).toBe('maxStrokes');
    expect(localHoleResult(maxed, 'p1', true)!.kind).toBe('over'); // holed with the very last allowed stroke
    expect(localHoleResult(maxed, 'p1', true)!.diff).toBe(courses[1]!.rules.maxStrokes - courses[1]!.rules.par);
    expect(localHoleResult(s, 'p1', true)).toEqual({ kind: 'par', strokes: 2, diff: 0 });
    expect(localHoleResult(s, '')).toBeNull(); // spectator
    expect(localHoleResult({ ...s, holeIndex: -1 }, 'p1')).toBeNull();
    expect(localHoleResult({ ...s, holeIndex: 2 }, 'p1')!.kind).toBe('notPlayed');
  });

  it('ranking lines follow state.ranking with totals vs the par played, left players flagged', () => {
    const s: GameState = {
      ...base(),
      phase: 'roundSummary',
      players: [player('p1', 'Aino', 0, 1), player('p2', 'Bo', 1, 2), player('p3', 'Cia', 2, 3, true)],
      strokes: { p1: [2, 2, 3], p2: [3, 2, 2], p3: [5, -1, -1] },
      ranking: [{ playerId: 'p1', total: 7, rank: 1 }, { playerId: 'p2', total: 7, rank: 1 }, { playerId: 'p3', total: 5, rank: 3 }],
    };
    const lines = rankingLines(s);
    expect(lines.map((l) => [l.rank, l.name, l.total, l.diff, l.left])).toEqual([
      [1, 'Aino', 7, 0, false],   // par 2+2+3 = 7
      [1, 'Bo', 7, 0, false],
      [3, 'Cia', 5, 3, true],     // played only hole 1 (par 2)
    ]);
    // Without state.ranking the lines are computed from the scores.
    const computed = rankingLines({ ...s, ranking: null, strokes: { p1: [2, 2, 2], p2: [3, 2, 2], p3: [5, -1, -1] } });
    expect(computed.map((l) => [l.rank, l.playerId])).toEqual([[1, 'p1'], [2, 'p2'], [3, 'p3']]);
  });
});

describe('game.* strings', () => {
  it('exist in both languages with matching placeholders', () => {
    const keys = [
      'game.testPlay', 'game.hole', 'game.par', 'game.toMenu', 'game.toEditor', 'game.toLobby', 'game.scorecard', 'game.pause',
      'game.resume', 'game.quit', 'game.quit.confirm', 'game.leaveRoom.confirm', 'game.continue', 'game.continue.hint',
      'game.waitingOthers', 'game.ready', 'game.holeSummary.title', 'game.strokes', 'game.result.holeInOne', 'game.result.over',
      'game.roundSummary.title', 'game.roundSummary.testPlay', 'game.roundSummary.total', 'game.roundSummary.winner',
      'game.playAgain', 'game.aborted', 'game.timedOut', 'game.desync', 'game.noCourses', 'game.error', 'game.close',
    ];
    const params = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const k of keys) {
      setLanguage('fi');
      const fi = t(k);
      setLanguage('en');
      const en = t(k);
      expect(fi, k).not.toBe(k);
      expect(en, k).not.toBe(k);
      expect(params(en), k).toEqual(params(fi));
    }
    setLanguage('fi');
    expect(t('game.hole', { n: 3, total: 9 })).toBe('Rata 3/9');
    expect(t('game.roundSummary.total', { total: 31, par: 27 })).toBe('Yhteensä 31 lyöntiä · Par 27');
  });
});
