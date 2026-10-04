import { describe, expect, it } from 'vitest';
import { createBallAt } from '../sim/worldState';
import { deepFreeze, makeCourse, makePlayer, START_CENTRE } from './fixtures.test';
import { createLobbyState, DEFAULT_ROOM_SETTINGS } from './initial';
import { ballOf, currentCourse, currentPlayerId, isMyTurn, otherBallCentres, playerOf, strokesThisHole } from './selectors';
import type { GameState } from './types';

const courses = [makeCourse({ id: 'c_a' }), makeCourse({ id: 'c_b' })];
const players = [makePlayer('a', 1), makePlayer('b', 2), makePlayer('c', 3), makePlayer('d', 4, { leftRound: true })];

function hole(over: Partial<GameState> = {}): GameState {
  return deepFreeze({
    ...createLobbyState(DEFAULT_ROOM_SETTINGS, courses),
    phase: 'hole',
    players,
    holeIndex: 1,
    order: ['a', 'b', 'c'],
    balls: {
      a: createBallAt(START_CENTRE),
      b: { ...createBallAt({ x: 100, y: 100 }), moving: true },
      c: createBallAt({ x: 200, y: 50 }),
      d: createBallAt({ x: 300, y: 60 }),
    },
    strokes: { a: [2, 3], b: [1, -1], c: [-1, -1] },
    turn: { playerId: 'a', turnSeq: 4, deadlineMs: null, shotInFlight: false },
    ...over,
  });
}

describe('selectors', () => {
  it('currentCourse / currentPlayerId / playerOf / ballOf', () => {
    const s = hole();
    expect(currentCourse(s)?.id).toBe('c_b');
    expect(currentCourse({ ...s, holeIndex: -1 })).toBeNull();
    expect(currentCourse({ ...s, holeIndex: 7 })).toBeNull();
    expect(currentPlayerId(s)).toBe('a');
    expect(currentPlayerId({ ...s, turn: null })).toBeNull();
    expect(playerOf(s, 'b')?.name).toBe('B');
    expect(playerOf(s, 'zz')).toBeNull();
    expect(ballOf(s, 'c')?.x).toBe(200);
    expect(ballOf(s, 'zz')).toBeNull();
  });
  it('strokesThisHole treats unplayed as 0', () => {
    const s = hole();
    expect(strokesThisHole(s, 'a')).toBe(3);
    expect(strokesThisHole(s, 'b')).toBe(0);
    expect(strokesThisHole(s, 'zz')).toBe(0);
    expect(strokesThisHole({ ...s, holeIndex: -1 }, 'a')).toBe(0);
  });
  it('isMyTurn requires phase hole, matching player and no shot in flight', () => {
    const s = hole();
    expect(isMyTurn(s, 'a')).toBe(true);
    expect(isMyTurn(s, 'b')).toBe(false);
    expect(isMyTurn({ ...s, turn: { ...s.turn!, shotInFlight: true } }, 'a')).toBe(false);
    expect(isMyTurn({ ...s, phase: 'holeSummary' }, 'a')).toBe(false);
    expect(isMyTurn({ ...s, turn: null }, 'a')).toBe(false);
  });
  it('otherBallCentres lists resting balls of other active, unfinished players', () => {
    const s = hole();
    expect(otherBallCentres(s, 'a')).toEqual([{ x: 200, y: 50 }]); // b is moving, d left
    expect(otherBallCentres({ ...s, holeDone: { c: true } }, 'a')).toEqual([]);
    expect(otherBallCentres(s, 'c')).toEqual([{ x: START_CENTRE.x, y: START_CENTRE.y }]);
  });
});
