import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../protocol/codes';
import { deepFreeze, makeCourse, makePlayer } from './fixtures.test';
import { createLobbyState, DEFAULT_ROOM_SETTINGS } from './initial';
import { activePlayers, canStart, holeOrder, isHoleComplete, nextTurnPlayer } from './turns';
import type { GameState } from './types';

const players = [makePlayer('a', 1), makePlayer('b', 2), makePlayer('c', 3)];

function holeState(over: Partial<GameState>): GameState {
  const base = createLobbyState(DEFAULT_ROOM_SETTINGS, [makeCourse()]);
  return deepFreeze({ ...base, phase: 'hole', players, seatOrder: ['a', 'b', 'c'], order: ['a', 'b', 'c'], holeIndex: 0, ...over });
}

describe('holeOrder', () => {
  it('rotates left by holeIndex % n', () => {
    expect(holeOrder(['a', 'b', 'c'], 0, players)).toEqual(['a', 'b', 'c']);
    expect(holeOrder(['a', 'b', 'c'], 1, players)).toEqual(['b', 'c', 'a']);
    expect(holeOrder(['a', 'b', 'c'], 2, players)).toEqual(['c', 'a', 'b']);
    expect(holeOrder(['a', 'b', 'c'], 3, players)).toEqual(['a', 'b', 'c']);
  });
  it('drops leftRound players and unknown ids, handles empty', () => {
    const withLeft = [players[0]!, { ...players[1]!, leftRound: true }, players[2]!];
    expect(holeOrder(['a', 'b', 'c'], 1, withLeft)).toEqual(['c', 'a']);
    expect(holeOrder(['a', 'zz', 'c'], 0, players)).toEqual(['a', 'c']);
    expect(holeOrder([], 5, players)).toEqual([]);
  });
});

describe('nextTurnPlayer', () => {
  it('starts from index 0 when after is null and walks cyclically', () => {
    const s = holeState({});
    expect(nextTurnPlayer(s, null)).toBe('a');
    expect(nextTurnPlayer(s, 'a')).toBe('b');
    expect(nextTurnPlayer(s, 'c')).toBe('a');
  });
  it('skips holeDone and leftRound players and returns null when nobody is left', () => {
    const s = holeState({ holeDone: { b: true } });
    expect(nextTurnPlayer(s, 'a')).toBe('c');
    const s2 = holeState({ players: [players[0]!, players[1]!, { ...players[2]!, leftRound: true }], holeDone: { b: true } });
    expect(nextTurnPlayer(s2, 'a')).toBe('a');
    const s3 = holeState({ holeDone: { a: true, b: true, c: true } });
    expect(nextTurnPlayer(s3, 'b')).toBeNull();
    expect(nextTurnPlayer(holeState({ order: [] }), null)).toBeNull();
  });
  it('keeps the rotation when `after` was removed from order (left on turn)', () => {
    const s = holeState({ order: ['a', 'c'], players: [players[0]!, { ...players[1]!, leftRound: true }, players[2]!] });
    expect(nextTurnPlayer(s, 'b')).toBe('c');
    const s2 = holeState({ order: ['a', 'b'], players: [players[0]!, players[1]!, { ...players[2]!, leftRound: true }] });
    expect(nextTurnPlayer(s2, 'c')).toBe('a');
    expect(nextTurnPlayer(holeState({}), 'nobody')).toBe('a');
  });
});

describe('isHoleComplete / activePlayers', () => {
  it('reports completion and active players', () => {
    expect(isHoleComplete(holeState({}))).toBe(false);
    expect(isHoleComplete(holeState({ holeDone: { a: true, b: true, c: true } }))).toBe(true);
    expect(isHoleComplete(holeState({ order: [] }))).toBe(true);
    const s = holeState({ players: [players[0]!, { ...players[1]!, leftRound: true }, players[2]!] });
    expect(activePlayers(s).map((p) => p.id)).toEqual(['a', 'c']);
  });
});

describe('canStart', () => {
  const lobby = (over: Partial<GameState>): GameState =>
    deepFreeze({ ...createLobbyState(DEFAULT_ROOM_SETTINGS, [makeCourse()]), hostId: 'a', players, ...over });
  it('gates on phase, player count and readiness', () => {
    expect(canStart(lobby({ phase: 'hole' }), 2)).toBe(ErrorCode.NOT_IN_LOBBY);
    expect(canStart(lobby({ players: [players[0]!] }), 2)).toBe(ErrorCode.NOT_ENOUGH_PLAYERS);
    expect(canStart(lobby({ players: [players[0]!] }), 1)).toBeNull();
    expect(canStart(lobby({}), 2)).toBe(ErrorCode.PLAYERS_NOT_READY);
    const ready = players.map((p) => ({ ...p, ready: p.id !== 'a' }));
    expect(canStart(lobby({ players: ready }), 2)).toBeNull();
  });
  it('ignores disconnected lobby players and rejects an empty course set', () => {
    const mixed = [players[0]!, { ...players[1]!, ready: true }, { ...players[2]!, connected: false, ready: false }];
    expect(canStart(lobby({ players: mixed }), 2)).toBeNull();
    const disconnected = players.map((p) => ({ ...p, connected: false }));
    expect(canStart(lobby({ players: disconnected }), 2)).toBe(ErrorCode.NOT_ENOUGH_PLAYERS);
    expect(canStart(lobby({ courses: [] }), 2)).toBe(ErrorCode.INVALID_COURSE);
  });
});
