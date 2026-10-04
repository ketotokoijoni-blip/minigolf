// Scorecard view model from a fixture GameState built with WP-C initial.ts + the reducer (DESIGN §15 WP-E
// acceptance; D24: pure logic, no DOM). Totals, to-par and ranking come from WP-C scoring.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Course } from '@puttipeli/shared/course/types';
import type { GameState, PlayerState } from '@puttipeli/shared/game/types';
import type { ShotResult } from '@puttipeli/shared/sim/types';
import { applyEvent } from '@puttipeli/shared/game/reducer';
import { createLobbyState, createSinglePlayerState, DEFAULT_ROOM_SETTINGS } from '@puttipeli/shared/game/initial';
import { ranking } from '@puttipeli/shared/game/scoring';
import { formatToPar, orderedPlayers, scorecardModel } from './scorecard';
import { setLanguage } from '../i18n/t';
import '../i18n/fi';
import '../i18n/en';

const row = (c: string): string => c.repeat(49);
const border = (y: number): string => (y === 0 || y === 24 ? row('#') : '#' + row('.').slice(2) + '#');
const course = (name: string, par: number, maxStrokes = 20): Course => ({
  format: 'puttipeli-course', formatVersion: 1, id: `c_${name}`, name, author: '', description: '', width: 49, height: 25,
  rules: { maxStrokes, par },
  surface: Array.from({ length: 25 }, () => row('.')),
  walls: Array.from({ length: 25 }, (_, y) => border(y)),
  objects: [{ type: 'start', x: 2, y: 12 }, { type: 'hole', x: 46, y: 12 }],
});
const player = (id: string, name: string, colour: 0 | 1 | 2 | 3, joinedSeq: number): PlayerState =>
  ({ id, name, colour, ready: true, connected: true, afk: false, consecutiveTimeouts: 0, joinedSeq, leftRound: false });

function shot(s: GameState, pid: string, turnSeq: number, result: ShotResult): GameState {
  s = applyEvent(s, { type: 'turnStarted', playerId: pid, turnSeq, deadlineMs: null });
  const ball = s.balls[pid]!;
  return applyEvent(s, {
    type: 'shotTaken', playerId: pid, turnSeq, shot: { dx: 1000, dy: 0 }, atMs: 1000 * turnSeq,
    outcome: {
      ticks: 120, result, penalty: result === 'water' || result === 'acid' || result === 'mine' ? 1 : 0,
      holeIndex: result === 'holed' ? 0 : -1,
      ball: { ...ball, x: ball.x + 30, moving: false },
      worldDelta: { tiles: [], minesDisarmed: [] },
      checksum: 0,
    },
  });
}

/** Three players joined out of seat order; hole 1 done (Aino 3, Bertta 2, Cecilia 4 = max), hole 2 in progress. */
function threePlayerRound(): GameState {
  let s = createLobbyState(DEFAULT_ROOM_SETTINGS, [course('Ensiputti', 3, 4), course('Mutka', 4), course('Finaali', 5)]);
  s = applyEvent(s, { type: 'playerJoined', player: player('a', 'Aino', 0, 1) });
  s = applyEvent(s, { type: 'playerJoined', player: player('b', 'Bertta', 1, 2) });
  s = applyEvent(s, { type: 'playerJoined', player: player('c', 'Cecilia', 2, 3) });
  s = applyEvent(s, { type: 'countdownStarted', endsAtMs: 3000 });
  s = applyEvent(s, { type: 'gameStarted', seatOrder: ['a', 'b', 'c'] });
  s = applyEvent(s, { type: 'holeStarted', holeIndex: 0, order: ['a', 'b', 'c'] });
  s = shot(s, 'a', 1, 'stopped');
  s = shot(s, 'b', 2, 'stopped');
  s = shot(s, 'c', 3, 'stopped');
  s = shot(s, 'a', 4, 'stopped');
  s = shot(s, 'b', 5, 'holed');
  s = shot(s, 'c', 6, 'water');     // c: 3
  s = shot(s, 'a', 7, 'holed');     // a: 3
  s = shot(s, 'c', 8, 'stopped');   // c: 4 = max strokes => done
  s = applyEvent(s, { type: 'holeEnded', holeIndex: 0 });
  s = applyEvent(s, { type: 'holeStarted', holeIndex: 1, order: ['b', 'c', 'a'] });
  s = shot(s, 'b', 1, 'stopped');
  s = shot(s, 'c', 2, 'stopped');
  s = applyEvent(s, { type: 'turnStarted', playerId: 'a', turnSeq: 3, deadlineMs: null });
  return s;
}

beforeAll(() => setLanguage('fi'));

describe('scorecardModel from a reducer-built three-player round', () => {
  const state = threePlayerRound();

  it('fixture sanity', () => {
    expect(state.strokes).toEqual({ a: [3, -1, -1], b: [2, 1, -1], c: [4, 1, -1] });
    expect(state.holeDone).toEqual({});
  });

  it('lists holes with par, the current hole and the par total', () => {
    const m = scorecardModel(state, 'a');
    expect(m.holes.map((h) => h.name)).toEqual(['Ensiputti', 'Mutka', 'Finaali']);
    expect(m.holes.map((h) => h.par)).toEqual([3, 4, 5]);
    expect(m.holes.map((h) => h.current)).toEqual([false, true, false]);
    expect(m.parTotal).toBe(12);
  });

  it('rows follow seat order and show scores, score classes, totals and to-par from scoring.ts', () => {
    const m = scorecardModel(state, 'b');
    expect(m.rows.map((r) => r.playerId)).toEqual(['a', 'b', 'c']);
    const [a, b, c] = m.rows as [typeof m.rows[0], typeof m.rows[0], typeof m.rows[0]];
    expect(a.cells.map((x) => x.text)).toEqual(['3', '–', '–']);
    expect(a.cells.map((x) => x.cls)).toEqual(['', '', '']);
    expect(a.cells.map((x) => x.current)).toEqual([false, true, false]);
    expect(a.total).toBe(3);
    expect(a.toPar).toBe('E');
    expect(a.toParCls).toBe('');
    expect(b.cells.map((x) => x.text)).toEqual(['2', '1', '–']);
    expect(b.cells.map((x) => x.cls)).toEqual(['under', 'under', '']);
    expect(b.total).toBe(3);
    expect(b.toPar).toBe('-4');
    expect(b.toParCls).toBe('under');
    expect(b.isMe).toBe(true);
    expect(c.cells.map((x) => x.cls)).toEqual(['max', 'under', '']);
    expect(c.total).toBe(5);
    expect(c.toPar).toBe('-2');
    expect(c.colour).toBe(2);
  });

  it('shows live standings during a multi-player round (ties share a rank)', () => {
    const m = scorecardModel(state, 'a');
    expect(m.showRank).toBe(true);
    expect(m.final).toBe(false);
    expect(m.rows.map((r) => r.rank)).toEqual(['1.', '1.', '3.']);
    expect(ranking(state).map((r) => r.rank)).toEqual([1, 1, 3]);
  });

  it('uses the authoritative ranking after roundEnded and marks left players', () => {
    let s = applyEvent(state, { type: 'playerLeft', playerId: 'c' });
    s = applyEvent(s, { type: 'roundEnded', ranking: ranking(s) });
    const m = scorecardModel(s, 'a');
    expect(m.final).toBe(true);
    expect(m.rows.map((r) => r.rank)).toEqual(['1.', '1.', '3.']);
    expect(m.rows[2]!.left).toBe(true);
  });

  it('renders unplayed to-par as the not-played marker in the lobby and hides ranks there', () => {
    let s = createLobbyState(DEFAULT_ROOM_SETTINGS, [course('Yksi', 3)]);
    s = applyEvent(s, { type: 'playerJoined', player: player('a', 'Aino', 0, 1) });
    s = applyEvent(s, { type: 'playerJoined', player: player('b', 'Bertta', 1, 2) });
    const m = scorecardModel(s, 'a');
    expect(m.showRank).toBe(false);
    expect(m.rows.map((r) => r.toPar)).toEqual(['–', '–']);
    expect(m.rows.map((r) => r.total)).toEqual([0, 0]);
    expect(m.rows.map((r) => r.rank)).toEqual(['', '']);
  });

  it('hides the live rank column during the countdown (everyone would be tied) and shows it once the hole starts', () => {
    let s = createLobbyState(DEFAULT_ROOM_SETTINGS, [course('Yksi', 3)]);
    s = applyEvent(s, { type: 'playerJoined', player: player('a', 'Aino', 0, 1) });
    s = applyEvent(s, { type: 'playerJoined', player: player('b', 'Bertta', 1, 2) });
    s = applyEvent(s, { type: 'countdownStarted', endsAtMs: 3000 });
    expect(s.phase).toBe('countdown');
    const during = scorecardModel(s, 'a');
    expect(during.showRank).toBe(false);
    expect(during.rows.map((r) => r.rank)).toEqual(['', '']);
    s = applyEvent(s, { type: 'gameStarted', seatOrder: ['a', 'b'] });
    s = applyEvent(s, { type: 'holeStarted', holeIndex: 0, order: ['a', 'b'] });
    const live = scorecardModel(s, 'a');
    expect(live.showRank).toBe(true);
    expect(live.rows.map((r) => r.rank)).toEqual(['1.', '1.']);
  });

  it('orders players by seatOrder with late joiners appended', () => {
    const s: GameState = { ...state, seatOrder: ['c', 'a'] };
    expect(orderedPlayers(s).map((p) => p.id)).toEqual(['c', 'a', 'b']);
    expect(orderedPlayers({ ...s, seatOrder: [] }).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('scorecardModel in single player', () => {
  it('has no rank column and tracks the single row', () => {
    let s = createSinglePlayerState([course('Eka', 3), course('Toka', 4)], player('me', 'Minä', 3, 1));
    s = applyEvent(s, { type: 'countdownStarted', endsAtMs: 0 });
    s = applyEvent(s, { type: 'gameStarted', seatOrder: ['me'] });
    s = applyEvent(s, { type: 'holeStarted', holeIndex: 0, order: ['me'] });
    s = shot(s, 'me', 1, 'stopped');
    s = shot(s, 'me', 2, 'stopped');
    s = shot(s, 'me', 3, 'stopped');
    s = shot(s, 'me', 4, 'holed');
    const m = scorecardModel(s, 'me');
    expect(m.showRank).toBe(false);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]!.cells.map((c) => c.text)).toEqual(['4', '–']);
    expect(m.rows[0]!.cells[0]!.cls).toBe('over');
    expect(m.rows[0]!.toPar).toBe('+1');
    expect(m.rows[0]!.toParCls).toBe('over');
  });
});

describe('formatToPar', () => {
  it('formats even, over and under par in both languages', () => {
    expect(formatToPar(0)).toBe('E');
    expect(formatToPar(2)).toBe('+2');
    expect(formatToPar(-1)).toBe('-1');
    setLanguage('en');
    try {
      expect(formatToPar(0)).toBe('E');
    } finally {
      setLanguage('fi');
    }
  });
});
