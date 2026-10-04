import { describe, expect, it } from 'vitest';
import { deepFreeze, makeCourse, makePlayer } from './fixtures.test';
import { createLobbyState, DEFAULT_ROOM_SETTINGS } from './initial';
import { parPlayed, ranking, toPar, totalStrokes } from './scoring';
import type { GameState } from './types';

const courses = [makeCourse({ par: 3 }), makeCourse({ par: 4 }), makeCourse({ par: 2 })];

function state(strokes: Record<string, number[]>, left: string[] = []): GameState {
  const ids = Object.keys(strokes);
  const players = ids.map((id, i) => makePlayer(id, i + 1, { leftRound: left.includes(id) }));
  return deepFreeze({ ...createLobbyState(DEFAULT_ROOM_SETTINGS, courses), phase: 'roundSummary', players, strokes });
}

describe('totals', () => {
  it('sums played holes only and computes par played / to par', () => {
    const s = state({ a: [3, -1, 5], b: [-1, -1, -1] });
    expect(totalStrokes(s, 'a')).toBe(8);
    expect(parPlayed(s, 'a')).toBe(5);
    expect(toPar(s, 'a')).toBe(3);
    expect(totalStrokes(s, 'b')).toBe(0);
    expect(parPlayed(s, 'b')).toBe(0);
    expect(totalStrokes(s, 'missing')).toBe(0);
    expect(parPlayed(s, 'missing')).toBe(0);
  });
});

describe('ranking', () => {
  it('orders active players by total with shared ranks (1,1,3)', () => {
    const s = state({ a: [4, 4, 4], b: [2, 2, 2], c: [3, 3, 0], d: [1, 1, 1] });
    const r = ranking(s);
    expect(r).toEqual([
      { playerId: 'd', total: 3, rank: 1 },
      { playerId: 'b', total: 6, rank: 2 },
      { playerId: 'c', total: 6, rank: 2 },
      { playerId: 'a', total: 12, rank: 4 },
    ]);
    expect(r.map((e) => e.playerId)).toEqual(['d', 'b', 'c', 'a']);
    expect(r.map((e) => e.rank)).toEqual([1, 2, 2, 4]);
  });
  it('ties keep seat order and three-way ties skip the following ranks', () => {
    const s = state({ a: [3], b: [3], c: [3], d: [5] });
    expect(ranking(s)).toEqual([
      { playerId: 'a', total: 3, rank: 1 },
      { playerId: 'b', total: 3, rank: 1 },
      { playerId: 'c', total: 3, rank: 1 },
      { playerId: 'd', total: 5, rank: 4 },
    ]);
  });
  it('appends leftRound players with rank = active count + 1', () => {
    const s = state({ a: [9], b: [2], c: [4], d: [1] }, ['a', 'd']);
    expect(ranking(s)).toEqual([
      { playerId: 'b', total: 2, rank: 1 },
      { playerId: 'c', total: 4, rank: 2 },
      { playerId: 'd', total: 1, rank: 3 },
      { playerId: 'a', total: 9, rank: 3 },
    ]);
  });
  it('is empty without players and ranks everyone 1 when all left', () => {
    expect(ranking(state({}))).toEqual([]);
    expect(ranking(state({ a: [1], b: [2] }, ['a', 'b']))).toEqual([
      { playerId: 'a', total: 1, rank: 1 },
      { playerId: 'b', total: 2, rank: 1 },
    ]);
  });
});
