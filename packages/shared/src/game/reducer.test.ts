import { describe, expect, it } from 'vitest';
import { TILE } from '../constants';
import type { ShotSummary } from '../sim/types';
import type { GameEvent } from './events';
import { deepFreeze, makeCourse, makePlayer, SHOT, START_CENTRE } from './fixtures.test';
import { createLobbyState, DEFAULT_ROOM_SETTINGS } from './initial';
import { applyEvent, ReducerError } from './reducer';
import type { GameState } from './types';

const courseA = makeCourse({ id: 'c_a', name: 'A', par: 3, maxStrokes: 3, objects: [{ type: 'mine', x: 20, y: 8 }] });
const courseB = makeCourse({ id: 'c_b', name: 'B', par: 4, start: { x: 5, y: 5 } });
const COURSES = [courseA, courseB];

/** Freezes both inputs, applies, and checks the generic invariants (new object, seq + 1). */
function apply(state: GameState, ev: GameEvent): GameState {
  deepFreeze(state);
  deepFreeze(ev);
  const before = JSON.stringify(state, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as Uint8Array) : v));
  const next = applyEvent(state, ev);
  expect(next).not.toBe(state);
  expect(next.seq).toBe(state.seq + 1);
  expect(JSON.stringify(state, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as Uint8Array) : v))).toBe(before);
  return next;
}

function applyAll(state: GameState, evs: GameEvent[]): GameState {
  return evs.reduce((s, ev) => apply(s, ev), state);
}

const lobby = (): GameState => createLobbyState(DEFAULT_ROOM_SETTINGS, COURSES);
const joined = (): GameState =>
  applyAll(lobby(), [
    { type: 'playerJoined', player: makePlayer('a', 1) },
    { type: 'playerJoined', player: makePlayer('b', 2) },
    { type: 'playerJoined', player: makePlayer('c', 3) },
  ]);
const inHole = (): GameState =>
  applyAll(joined(), [
    { type: 'countdownStarted', endsAtMs: 5000 },
    { type: 'gameStarted', seatOrder: ['a', 'b', 'c'] },
    { type: 'holeStarted', holeIndex: 0, order: ['a', 'b', 'c'] },
    { type: 'turnStarted', playerId: 'a', turnSeq: 1, deadlineMs: 9000 },
  ]);

function summary(over: Partial<ShotSummary> = {}): ShotSummary {
  return {
    ticks: 240,
    result: 'stopped',
    penalty: 0,
    holeIndex: -1,
    ball: { x: 300, y: 187.5, vx: 0, vy: 0, moving: false, lastTile: 0, teleportCooldownTile: -1, insideOneWay: -1, slowTicks: 0 },
    worldDelta: { tiles: [], minesDisarmed: [] },
    checksum: 7,
    ...over,
  };
}

const expectReducerError = (state: GameState, ev: GameEvent, re?: RegExp): void => {
  deepFreeze(state);
  expect(() => applyEvent(state, ev)).toThrowError(ReducerError);
  if (re) expect(() => applyEvent(state, ev)).toThrowError(re);
};

describe('lobby events', () => {
  it('playerJoined keeps joinedSeq order, allocates strokes and picks the host', () => {
    let s = apply(lobby(), { type: 'playerJoined', player: makePlayer('b', 2) });
    expect(s.hostId).toBe('b');
    s = apply(s, { type: 'playerJoined', player: makePlayer('a', 1) });
    expect(s.players.map((p) => p.id)).toEqual(['a', 'b']);
    expect(s.hostId).toBe('b');
    expect(s.strokes).toEqual({ a: [], b: [] });
    expectReducerError(s, { type: 'playerJoined', player: makePlayer('a', 9) }, /already present/);
    expectReducerError({ ...s, phase: 'hole' }, { type: 'playerJoined', player: makePlayer('z', 9) }, /phase/);
  });

  it('playerJoined takes over the host role when the host is absent or left', () => {
    const s = apply({ ...lobby(), hostId: 'ghost' }, { type: 'playerJoined', player: makePlayer('a', 1) });
    expect(s.hostId).toBe('a');
    const left = { ...joined(), players: joined().players.map((p) => (p.id === 'a' ? { ...p, leftRound: true } : p)) };
    expect(apply(left, { type: 'playerJoined', player: makePlayer('d', 4) }).hostId).toBe('d');
  });

  it('playerLeft in the lobby removes the player and the strokes row', () => {
    const s = apply(joined(), { type: 'playerLeft', playerId: 'b' });
    expect(s.players.map((p) => p.id)).toEqual(['a', 'c']);
    expect(Object.keys(s.strokes)).toEqual(['a', 'c']);
    expect(s.hostId).toBe('a'); // hostChanged is a separate event
    expectReducerError(s, { type: 'playerLeft', playerId: 'b' }, /unknown player/);
  });

  it('spectator list maintenance', () => {
    let s = apply(lobby(), { type: 'spectatorJoined', spectator: { id: 's1', name: 'Katsoja' } });
    expect(s.spectators).toEqual([{ id: 's1', name: 'Katsoja' }]);
    expectReducerError(s, { type: 'spectatorJoined', spectator: { id: 's1', name: 'X' } });
    s = apply(s, { type: 'spectatorLeft', id: 's1' });
    expect(s.spectators).toEqual([]);
    expectReducerError(s, { type: 'spectatorLeft', id: 's1' });
  });

  it('playerConnection / playerAfk / hostChanged', () => {
    let s = apply(joined(), { type: 'playerConnection', playerId: 'b', connected: false });
    expect(s.players[1]!.connected).toBe(false);
    s = { ...s, players: s.players.map((p) => (p.id === 'b' ? { ...p, consecutiveTimeouts: 2 } : p)) };
    s = apply(s, { type: 'playerAfk', playerId: 'b', afk: true });
    expect(s.players[1]!.afk).toBe(true);
    expect(s.players[1]!.consecutiveTimeouts).toBe(2);
    s = apply(s, { type: 'playerAfk', playerId: 'b', afk: false });
    expect(s.players[1]!.afk).toBe(false);
    expect(s.players[1]!.consecutiveTimeouts).toBe(0);
    s = apply(s, { type: 'hostChanged', hostId: 'c' });
    expect(s.hostId).toBe('c');
    expectReducerError(s, { type: 'playerConnection', playerId: 'zz', connected: true });
    expectReducerError(s, { type: 'playerAfk', playerId: 'zz', afk: true });
    expectReducerError(s, { type: 'hostChanged', hostId: 'zz' });
  });

  it('profile / ready / settings / courses are lobby-only field updates', () => {
    let s = apply(joined(), { type: 'profileChanged', playerId: 'a', name: 'Aino', colour: 3 });
    expect(s.players[0]).toMatchObject({ name: 'Aino', colour: 3 });
    s = apply(s, { type: 'readyChanged', playerId: 'a', ready: true });
    expect(s.players[0]!.ready).toBe(true);
    const settings = { maxPlayers: 3 as const, turnTimeoutSec: 30 as const, holeSummarySec: 0 as const, ballCollision: false as const };
    s = apply(s, { type: 'settingsChanged', settings });
    expect(s.settings).toEqual(settings);
    expect(s.settings).not.toBe(settings);
    s = apply(s, { type: 'coursesChanged', courses: [courseB] });
    expect(s.courses).toEqual([courseB]);
    const hole = inHole();
    expectReducerError(hole, { type: 'profileChanged', playerId: 'a', name: 'X', colour: 0 }, /phase/);
    expectReducerError(hole, { type: 'readyChanged', playerId: 'a', ready: true }, /phase/);
    expectReducerError(hole, { type: 'settingsChanged', settings }, /phase/);
    expectReducerError(hole, { type: 'coursesChanged', courses: [courseB] }, /phase/);
    expectReducerError(s, { type: 'profileChanged', playerId: 'zz', name: 'X', colour: 0 }, /unknown/);
    expectReducerError(s, { type: 'readyChanged', playerId: 'zz', ready: true }, /unknown/);
  });
});

describe('round start', () => {
  it('countdownStarted -> gameStarted -> holeStarted set up the round', () => {
    const ready = { ...joined(), players: joined().players.map((p) => ({ ...p, ready: true, afk: true, consecutiveTimeouts: 1 })) };
    let s = apply(ready, { type: 'countdownStarted', endsAtMs: 5000 });
    expect(s.phase).toBe('countdown');
    expect(s.countdownEndsAtMs).toBe(5000);
    expectReducerError(s, { type: 'countdownStarted', endsAtMs: 1 }, /phase/);
    expectReducerError(joined(), { type: 'gameStarted', seatOrder: ['a'] }, /phase/);

    s = apply(s, { type: 'gameStarted', seatOrder: ['a', 'b', 'c'] });
    expect(s.phase).toBe('countdown');
    expect(s.seatOrder).toEqual(['a', 'b', 'c']);
    expect(s.strokes).toEqual({ a: [-1, -1], b: [-1, -1], c: [-1, -1] });
    for (const p of s.players) expect(p).toMatchObject({ ready: false, afk: false, consecutiveTimeouts: 0 });
    expect(s.ranking).toBeNull();
    expect(s.holeIndex).toBe(-1);

    expectReducerError(s, { type: 'holeStarted', holeIndex: 5, order: [] }, /no course/);
    s = apply(s, { type: 'holeStarted', holeIndex: 0, order: ['a', 'b', 'c'] });
    expect(s.phase).toBe('hole');
    expect(s.holeIndex).toBe(0);
    expect(s.order).toEqual(['a', 'b', 'c']);
    expect(s.world).not.toBeNull();
    expect(s.world!.minesArmed).toEqual(new Uint8Array([1]));
    expect(s.balls['a']).toMatchObject({ x: START_CENTRE.x, y: START_CENTRE.y, moving: false });
    expect(s.shotOrigins).toEqual({ a: START_CENTRE, b: START_CENTRE, c: START_CENTRE });
    expect(s.holeDone).toEqual({});
    expect(s.turn).toBeNull();
    expect(s.lastShot).toBeNull();
    expectReducerError(s, { type: 'holeStarted', holeIndex: 1, order: ['a'] }, /phase/);
  });

  it('holeStarted marks left players done and gives them no ball', () => {
    const base = applyAll(joined(), [
      { type: 'countdownStarted', endsAtMs: 5000 },
      { type: 'playerLeft', playerId: 'b' },
      { type: 'gameStarted', seatOrder: ['a', 'b', 'c'] },
    ]);
    expect(base.players[1]).toMatchObject({ leftRound: true, connected: false });
    expect(base.strokes['b']).toEqual([-1, -1]);
    const s = apply(base, { type: 'holeStarted', holeIndex: 0, order: ['a', 'c'] });
    expect(s.holeDone).toEqual({ b: true });
    expect(Object.keys(s.balls)).toEqual(['a', 'c']);
  });

  it('turnStarted requires phase hole, a player in the order who is not done', () => {
    const s = apply(inHole(), { type: 'turnStarted', playerId: 'b', turnSeq: 2, deadlineMs: null });
    expect(s.turn).toEqual({ playerId: 'b', turnSeq: 2, deadlineMs: null, shotInFlight: false });
    expectReducerError({ ...s, holeDone: { c: true } }, { type: 'turnStarted', playerId: 'c', turnSeq: 3, deadlineMs: null }, /finished/);
    expectReducerError({ ...s, order: ['a', 'b'] }, { type: 'turnStarted', playerId: 'c', turnSeq: 3, deadlineMs: null }, /turn order/);
    expectReducerError(s, { type: 'turnStarted', playerId: 'zz', turnSeq: 3, deadlineMs: null }, /unknown/);
    expectReducerError({ ...s, phase: 'holeSummary' }, { type: 'turnStarted', playerId: 'a', turnSeq: 3, deadlineMs: null }, /phase/);
  });
});

describe('shotTaken', () => {
  it('moves the ball, applies the world delta, counts strokes and records lastShot', () => {
    const s0 = inHole();
    const out = summary({ worldDelta: { tiles: [{ i: 100, wall: 0, hits: 1 }], minesDisarmed: [0] } });
    const s = apply(s0, { type: 'shotTaken', playerId: 'a', turnSeq: 1, shot: SHOT, outcome: out, atMs: 777 });
    expect(s.shotOrigins['a']).toEqual(START_CENTRE);
    expect(s.balls['a']).toEqual(out.ball);
    expect(s.balls['a']).not.toBe(out.ball);
    expect(s.world!.walls[100]).toBe(0);
    expect(s.world!.breakHits[100]).toBe(1);
    expect(s.world!.minesArmed[0]).toBe(0);
    expect(s0.world!.breakHits[100]).toBe(0); // input untouched
    expect(s.strokes['a']).toEqual([1, -1]);
    expect(s.holeDone['a']).toBeUndefined();
    expect(s.lastShot).toEqual({ playerId: 'a', turnSeq: 1, shot: SHOT, ticks: 240, atMs: 777 });
    expect(s.turn).toEqual({ playerId: 'a', turnSeq: 1, deadlineMs: 9000, shotInFlight: true });
  });

  it('adds the penalty, resets afk/timeouts, handles holed and the max-stroke cap', () => {
    const s0 = { ...inHole(), players: inHole().players.map((p) => (p.id === 'a' ? { ...p, afk: true, consecutiveTimeouts: 2 } : p)) };
    let s = apply(s0, { type: 'shotTaken', playerId: 'a', turnSeq: 1, shot: SHOT, outcome: summary({ result: 'water', penalty: 1 }), atMs: 1 });
    expect(s.strokes['a']).toEqual([2, -1]);
    expect(s.players[0]).toMatchObject({ afk: false, consecutiveTimeouts: 0 });
    // second shot reaches maxStrokes 3 -> capped, holeDone, ball left where it stopped
    s = apply(s, { type: 'turnStarted', playerId: 'a', turnSeq: 2, deadlineMs: null });
    s = apply(s, { type: 'shotTaken', playerId: 'a', turnSeq: 2, shot: SHOT, outcome: summary({ result: 'timeout', penalty: 1, ball: { ...summary().ball, x: 50 } }), atMs: 2 });
    expect(s.strokes['a']).toEqual([3, -1]);
    expect(s.holeDone['a']).toBe(true);
    expect(s.balls['a']!.x).toBe(50);
    // holed on the first shot
    let h = apply(inHole(), { type: 'turnStarted', playerId: 'b', turnSeq: 2, deadlineMs: null });
    h = apply(h, { type: 'shotTaken', playerId: 'b', turnSeq: 2, shot: SHOT, outcome: summary({ result: 'holed', holeIndex: 0 }), atMs: 3 });
    expect(h.strokes['b']).toEqual([1, -1]);
    expect(h.holeDone['b']).toBe(true);
  });

  it('rejects impossible shots with ReducerError', () => {
    const s = inHole();
    expectReducerError(s, { type: 'shotTaken', playerId: 'b', turnSeq: 1, shot: SHOT, outcome: summary(), atMs: 0 }, /not on turn/);
    expectReducerError(s, { type: 'shotTaken', playerId: 'a', turnSeq: 2, shot: SHOT, outcome: summary(), atMs: 0 }, /turnSeq/);
    const flying = apply(s, { type: 'shotTaken', playerId: 'a', turnSeq: 1, shot: SHOT, outcome: summary(), atMs: 0 });
    expectReducerError(flying, { type: 'shotTaken', playerId: 'a', turnSeq: 1, shot: SHOT, outcome: summary(), atMs: 0 }, /in flight/);
    expectReducerError({ ...s, turn: null }, { type: 'shotTaken', playerId: 'a', turnSeq: 1, shot: SHOT, outcome: summary(), atMs: 0 }, /no turn/);
    expectReducerError({ ...s, phase: 'holeSummary' }, { type: 'shotTaken', playerId: 'a', turnSeq: 1, shot: SHOT, outcome: summary(), atMs: 0 }, /phase/);
  });
});

describe('turnTimedOut / turnSkipped', () => {
  it('timeout adds a stroke without moving the ball; two in a row set afk', () => {
    let s = apply(inHole(), { type: 'turnTimedOut', playerId: 'a', turnSeq: 1 });
    expect(s.strokes['a']).toEqual([1, -1]);
    expect(s.balls['a']).toEqual(inHole().balls['a']);
    expect(s.players[0]).toMatchObject({ consecutiveTimeouts: 1, afk: false });
    expect(s.turn!.shotInFlight).toBe(true);
    s = apply(s, { type: 'turnStarted', playerId: 'a', turnSeq: 2, deadlineMs: null });
    s = apply(s, { type: 'turnTimedOut', playerId: 'a', turnSeq: 2 });
    expect(s.players[0]).toMatchObject({ consecutiveTimeouts: 2, afk: true });
    expect(s.strokes['a']).toEqual([2, -1]);
    // third timeout reaches maxStrokes 3 -> done
    s = apply(s, { type: 'turnStarted', playerId: 'a', turnSeq: 3, deadlineMs: null });
    s = apply(s, { type: 'turnTimedOut', playerId: 'a', turnSeq: 3 });
    expect(s.strokes['a']).toEqual([3, -1]);
    expect(s.holeDone['a']).toBe(true);
    expectReducerError(s, { type: 'turnTimedOut', playerId: 'a', turnSeq: 3 }, /in flight/);
    expectReducerError(inHole(), { type: 'turnTimedOut', playerId: 'b', turnSeq: 1 }, /not on turn/);
  });

  it('skip consumes the turn without a stroke', () => {
    const s = apply(inHole(), { type: 'turnSkipped', playerId: 'a', turnSeq: 1 });
    expect(s.strokes['a']).toEqual([-1, -1]);
    expect(s.turn!.shotInFlight).toBe(true);
    expectReducerError(inHole(), { type: 'turnSkipped', playerId: 'a', turnSeq: 7 }, /turnSeq/);
  });
});

describe('leaving during a round', () => {
  it('playerLeft marks leftRound, disconnected, done and drops the player from order', () => {
    const s = apply(inHole(), { type: 'playerLeft', playerId: 'b' });
    expect(s.players.find((p) => p.id === 'b')).toMatchObject({ leftRound: true, connected: false });
    expect(s.holeDone['b']).toBe(true);
    expect(s.order).toEqual(['a', 'c']);
    expect(s.strokes['b']).toEqual([-1, -1]);
    expect(s.hostId).toBe('a');
  });
});

describe('summaries and lobby return', () => {
  const afterHole = (): GameState =>
    applyAll(inHole(), [
      { type: 'shotTaken', playerId: 'a', turnSeq: 1, shot: SHOT, outcome: summary({ result: 'holed', holeIndex: 0 }), atMs: 1 },
      { type: 'turnStarted', playerId: 'b', turnSeq: 2, deadlineMs: null },
      { type: 'shotTaken', playerId: 'b', turnSeq: 2, shot: SHOT, outcome: summary({ result: 'holed', holeIndex: 0 }), atMs: 2 },
      { type: 'turnStarted', playerId: 'c', turnSeq: 3, deadlineMs: null },
      { type: 'shotTaken', playerId: 'c', turnSeq: 3, shot: SHOT, outcome: summary({ result: 'holed', holeIndex: 0 }), atMs: 3 },
      { type: 'holeEnded', holeIndex: 0 },
    ]);

  it('holeEnded / summaryReady / holeStarted(next)', () => {
    let s = afterHole();
    expect(s.phase).toBe('holeSummary');
    expect(s.turn).toBeNull();
    expect(s.summaryReady).toEqual({});
    expectReducerError(inHole(), { type: 'holeEnded', holeIndex: 1 }, /not current/);
    expectReducerError(s, { type: 'holeEnded', holeIndex: 0 }, /phase/);
    s = apply(s, { type: 'summaryReady', playerId: 'a' });
    expect(s.summaryReady).toEqual({ a: true });
    expectReducerError(s, { type: 'summaryReady', playerId: 'zz' }, /unknown/);
    expectReducerError(inHole(), { type: 'summaryReady', playerId: 'a' }, /phase/);
    s = apply(s, { type: 'holeStarted', holeIndex: 1, order: ['b', 'c', 'a'] });
    expect(s.phase).toBe('hole');
    expect(s.holeIndex).toBe(1);
    expect(s.summaryReady).toEqual({});
    expect(s.balls['a']).toMatchObject({ x: 5.5 * TILE, y: 5.5 * TILE });
    expect(s.holeDone).toEqual({});
    expect(s.strokes['a']).toEqual([1, -1]);
  });

  it('roundEnded sets the ranking and clears summaryReady; backToLobby resets everything', () => {
    let s = apply(afterHole(), { type: 'summaryReady', playerId: 'a' });
    const rankingList = [{ playerId: 'a', total: 1, rank: 1 }];
    s = apply(s, { type: 'roundEnded', ranking: rankingList });
    expect(s.phase).toBe('roundSummary');
    expect(s.ranking).toEqual(rankingList);
    expect(s.ranking).not.toBe(rankingList);
    expect(s.turn).toBeNull();
    expect(s.summaryReady).toEqual({});
    expectReducerError(s, { type: 'roundEnded', ranking: [] }, /phase/);
    expectReducerError(joined(), { type: 'roundEnded', ranking: [] }, /phase/);
    // a left player is dropped by backToLobby
    s = apply(s, { type: 'playerLeft', playerId: 'c' });
    s = apply(s, { type: 'backToLobby' });
    expect(s.phase).toBe('lobby');
    expect(s.players.map((p) => p.id)).toEqual(['a', 'b']);
    for (const p of s.players) expect(p).toMatchObject({ ready: false, afk: false, consecutiveTimeouts: 0, leftRound: false });
    expect(s.strokes).toEqual({ a: [], b: [] });
    expect(s).toMatchObject({
      holeIndex: -1, seatOrder: [], order: [], balls: {}, shotOrigins: {}, holeDone: {}, world: null, turn: null,
      lastShot: null, ranking: null, summaryReady: {}, countdownEndsAtMs: null,
    });
    expectReducerError(s, { type: 'backToLobby' }, /phase/);
  });

  it('backToLobby is the abort transition from countdown and hole too', () => {
    const cd = apply(joined(), { type: 'countdownStarted', endsAtMs: 1 });
    expect(apply(cd, { type: 'backToLobby' }).phase).toBe('lobby');
    expect(apply(inHole(), { type: 'backToLobby' }).phase).toBe('lobby');
    expect(apply(apply(cd, { type: 'roundEnded', ranking: [] }), { type: 'backToLobby' }).phase).toBe('lobby');
  });
});

describe('ReducerError', () => {
  it('carries the event type and a readable name', () => {
    try {
      applyEvent(deepFreeze(lobby()), { type: 'backToLobby' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ReducerError);
      expect((e as ReducerError).eventType).toBe('backToLobby');
      expect((e as Error).name).toBe('ReducerError');
      expect((e as Error).message).toMatch(/^backToLobby:/);
    }
  });
});
