// Pure-logic checks of the HUD/scorecard score helpers against a fixture GameState (DESIGN D24: no DOM in client tests).
import { describe, expect, it } from 'vitest';
import type { Course } from '@puttipeli/shared/course/types';
import type { GameState, PlayerState } from '@puttipeli/shared/game/types';
import { parPlayedOf, formatToPar } from './scorecard';
import { totalStrokesOf, strokesThisHoleOf } from './hud';
import { setLanguage } from '../i18n/t';
import '../i18n/fi';

const row = (c: string): string => c.repeat(49);
const course = (name: string, par: number): Course => ({
  format: 'puttipeli-course', formatVersion: 1, id: '', name, author: '', description: '', width: 49, height: 25,
  rules: { maxStrokes: 20, par },
  surface: Array.from({ length: 25 }, () => row('.')),
  walls: Array.from({ length: 25 }, () => row('.')),
  objects: [{ type: 'start', x: 1, y: 1 }, { type: 'hole', x: 40, y: 20 }],
});
const player = (id: string, name: string, colour: 0 | 1 | 2 | 3, joinedSeq: number): PlayerState =>
  ({ id, name, colour, ready: true, connected: true, afk: false, consecutiveTimeouts: 0, joinedSeq, leftRound: false });

const fixture: GameState = {
  phase: 'hole',
  settings: { maxPlayers: 4, turnTimeoutSec: 45, holeSummarySec: 6, ballCollision: false },
  hostId: 'a',
  players: [player('a', 'Aino', 0, 1), player('b', 'Bertta', 1, 2)],
  spectators: [],
  courses: [course('Ensiputti', 3), course('Mutka', 4), course('Finaali', 5)],
  seatOrder: ['a', 'b'],
  holeIndex: 2,
  order: ['a', 'b'],
  balls: {},
  shotOrigins: {},
  strokes: { a: [3, 5, 2], b: [2, 4, -1] },
  holeDone: { a: false, b: false },
  world: null,
  turn: { playerId: 'b', turnSeq: 7, deadlineMs: null, shotInFlight: false },
  lastShot: null,
  summaryReady: {},
  ranking: null,
  countdownEndsAtMs: null,
  seq: 42,
};

describe('score helpers from a fixture GameState', () => {
  it('totals ignore unplayed holes', () => {
    expect(totalStrokesOf(fixture, 'a')).toBe(10);
    expect(totalStrokesOf(fixture, 'b')).toBe(6);
    expect(totalStrokesOf(fixture, 'zzz')).toBe(0);
  });
  it('strokes this hole', () => {
    expect(strokesThisHoleOf(fixture, 'a')).toBe(2);
    expect(strokesThisHoleOf(fixture, 'b')).toBe(0);
    expect(strokesThisHoleOf({ ...fixture, holeIndex: -1 }, 'a')).toBe(0);
  });
  it('par played follows the holes with a score', () => {
    expect(parPlayedOf(fixture, 'a')).toBe(12);
    expect(parPlayedOf(fixture, 'b')).toBe(7);
  });
  it('formats to-par', () => {
    setLanguage('fi');
    expect(formatToPar(0)).toBe('E');
    expect(formatToPar(2)).toBe('+2');
    expect(formatToPar(-1)).toBe('-1');
  });
});
