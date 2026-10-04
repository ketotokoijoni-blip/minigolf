import { describe, expect, it } from 'vitest';
import {
  AFK_TURN_TIMEOUT_SEC,
  ANIMATION_GRACE_MS,
  COUNTDOWN_SEC,
  DISCONNECTED_TURN_WAIT_SEC,
  DISCONNECT_GRACE_SEC,
  HOLE_INTRO_MS,
  HOLE_SUMMARY_SEC,
  LOBBY_DISCONNECT_REMOVE_SEC,
  MAX_SPECTATORS,
  ROUND_SUMMARY_AUTO_LOBBY_SEC,
} from '../constants';
import { ErrorCode } from '../protocol/codes';
import { Authority } from './authority';
import type { GameEvent } from './events';
import { createHarness, makeCourse, makePlayer, seatPlayers, SHOT, shootAndWait, startRound, START_CENTRE } from './fixtures.test';
import { createSinglePlayerState } from './initial';

const last = <T extends GameEvent['type']>(events: GameEvent[], type: T): Extract<GameEvent, { type: T }> => {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === type) return events[i] as Extract<GameEvent, { type: T }>;
  throw new Error(`no ${type} event`);
};

describe('Authority lobby', () => {
  it('join: seats players in order, assigns colours, makes the first joiner host', () => {
    const h = createHarness();
    expect(h.auth.join(makePlayer('p1', 0, { colour: 2, ready: true, afk: true }))).toBeNull();
    expect(h.auth.join(makePlayer('p2', 0, { colour: 2 }))).toBeNull();
    expect(h.auth.join(makePlayer('p3', 0, { colour: 0 }))).toBeNull();
    const s = h.state();
    expect(s.hostId).toBe('p1');
    expect(s.players.map((p) => [p.id, p.colour, p.joinedSeq])).toEqual([['p1', 2, 1], ['p2', 0, 2], ['p3', 1, 3]]);
    expect(s.players[0]).toMatchObject({ ready: false, afk: false, connected: true, leftRound: false });
    expect(h.take()).toEqual(['playerJoined', 'playerJoined', 'playerJoined']);
    expect(h.auth.join(makePlayer('p1', 0))).toBeNull(); // idempotent
    expect(h.take()).toEqual([]);
  });

  it('join: ROOM_FULL at maxPlayers and GAME_IN_PROGRESS outside the lobby', () => {
    const h = createHarness({ settings: { maxPlayers: 2 } });
    seatPlayers(h, 2);
    expect(h.auth.join(makePlayer('p3', 0))).toBe(ErrorCode.ROOM_FULL);
    expect(h.auth.start('p1')).toBeNull();
    expect(h.auth.join(makePlayer('p9', 0))).toBe(ErrorCode.GAME_IN_PROGRESS);
  });

  it('leave in the lobby removes the player and migrates the host to the lowest joinedSeq connected player', () => {
    const h = createHarness();
    seatPlayers(h, 3);
    h.auth.connection('p2', false);
    h.take();
    h.auth.leave('p1');
    expect(h.take()).toEqual(['playerLeft', 'hostChanged']);
    expect(h.state().hostId).toBe('p3');
    h.auth.leave('p3');
    expect(h.state().hostId).toBe('p2'); // only a disconnected player is left: any remaining player
    h.auth.leave('p2');
    expect(h.state().players).toEqual([]);
    expect(h.state().hostId).toBe('p2'); // absent host: the next joiner takes the role via the reducer rule
    h.auth.join(makePlayer('p7', 0));
    expect(h.state().hostId).toBe('p7');
    expect(h.clock.pending()).toBe(0);
  });

  it('setReady / setProfile / setSettings / setCourses gate by phase, role and seat', () => {
    const h = createHarness();
    seatPlayers(h, 2);
    h.take();
    expect(h.auth.setReady('zz', true)).toBe(ErrorCode.NOT_A_PLAYER);
    expect(h.auth.setReady('p2', true)).toBeNull(); // already ready -> no event
    expect(h.auth.setReady('p2', false)).toBeNull();
    expect(h.take()).toEqual(['readyChanged']);

    expect(h.auth.setProfile('p2', '  Maija  ', 0)).toBeNull(); // colour 0 taken by p1 -> ignored, name applies
    expect(last(h.events, 'profileChanged')).toMatchObject({ playerId: 'p2', name: 'Maija', colour: 1 });
    expect(h.auth.setProfile('p2', '   ', 3)).toBeNull();
    expect(last(h.events, 'profileChanged')).toMatchObject({ playerId: 'p2', name: 'Maija', colour: 3 });
    expect(h.auth.setProfile('p2', 'Maija', 3)).toBeNull(); // no change -> no event
    expect(h.auth.setProfile('zz', 'x', 0)).toBe(ErrorCode.NOT_A_PLAYER);
    expect(h.auth.setProfile('p2', 'A'.repeat(40), undefined)).toBeNull();
    expect(h.state().players[1]!.name).toHaveLength(16);

    expect(h.auth.setSettings('p2', { turnTimeoutSec: 30 })).toBe(ErrorCode.NOT_HOST);
    expect(h.auth.setSettings('p1', { turnTimeoutSec: 30, maxPlayers: 2, ballCollision: true as unknown as false })).toBeNull();
    expect(h.state().settings).toEqual({ maxPlayers: 2, turnTimeoutSec: 30, holeSummarySec: 6, ballCollision: false });
    h.auth.setSettings('p1', { maxPlayers: 4 });
    seatPlayers(h, 3);
    expect(h.auth.setSettings('p1', { maxPlayers: 2 })).toBeNull();
    expect(h.state().settings.maxPlayers).toBe(3); // clamped up to the current player count

    expect(h.auth.setCourses('p2', [makeCourse()])).toBe(ErrorCode.NOT_HOST);
    expect(h.auth.setCourses('p1', [])).toBe(ErrorCode.INVALID_COURSE);
    expect(h.auth.setCourses('p1', Array.from({ length: 19 }, () => makeCourse()))).toBe(ErrorCode.INVALID_COURSE);
    expect(h.auth.setCourses('p1', [makeCourse({ id: 'c_x' })])).toBeNull();
    expect(h.state().courses.map((c) => c.id)).toEqual(['c_x']);

    expect(h.auth.start('p2')).toBe(ErrorCode.NOT_HOST);
    expect(h.auth.start('p1')).toBeNull();
    expect(h.auth.setReady('p2', true)).toBe(ErrorCode.NOT_IN_LOBBY);
    expect(h.auth.setProfile('p2', 'x', 0)).toBe(ErrorCode.NOT_IN_LOBBY);
    expect(h.auth.setSettings('p1', {})).toBe(ErrorCode.NOT_IN_LOBBY);
    expect(h.auth.setCourses('p1', [makeCourse()])).toBe(ErrorCode.NOT_IN_LOBBY);
    expect(h.auth.start('p1')).toBe(ErrorCode.NOT_IN_LOBBY);
  });

  it('start is gated by canStart codes', () => {
    const h = createHarness();
    h.auth.join(makePlayer('p1', 0));
    expect(h.auth.start('p1')).toBe(ErrorCode.NOT_ENOUGH_PLAYERS);
    h.auth.join(makePlayer('p2', 0));
    expect(h.auth.start('p1')).toBe(ErrorCode.PLAYERS_NOT_READY);
    h.auth.setReady('p2', true);
    expect(h.auth.start('p1')).toBeNull();
    expect(h.state().phase).toBe('countdown');
  });

  it('spectators: join/leave, ROOM_FULL at MAX_SPECTATORS, leave() delegates for spectator ids', () => {
    const h = createHarness();
    for (let i = 0; i < MAX_SPECTATORS; i++) expect(h.auth.spectatorJoin({ id: `s${i}`, name: 'K' })).toBeNull();
    expect(h.auth.spectatorJoin({ id: 's0', name: 'K' })).toBeNull(); // idempotent
    expect(h.auth.spectatorJoin({ id: 'extra', name: 'K' })).toBe(ErrorCode.ROOM_FULL);
    h.take();
    h.auth.leave('s3');
    expect(h.take()).toEqual(['spectatorLeft']);
    h.auth.spectatorLeave('s3');
    h.auth.leave('nobody');
    expect(h.take()).toEqual([]);
    expect(h.state().spectators).toHaveLength(MAX_SPECTATORS - 1);
  });

  it('becomePlayer: spectator -> player in the lobby only, with a free seat, unique name and free colour', () => {
    const h = createHarness({ settings: { maxPlayers: 3 } });
    seatPlayers(h, 2);
    h.auth.spectatorJoin({ id: 's1', name: 'p1' });
    h.auth.spectatorJoin({ id: 's2', name: 'Katsoja' });
    h.take();
    expect(h.auth.becomePlayer('nobody')).toBe(ErrorCode.NOT_IN_ROOM);
    expect(h.auth.becomePlayer('p1')).toBe(ErrorCode.ALREADY_IN_ROOM);
    expect(h.auth.becomePlayer('s1', 0)).toBeNull();
    expect(h.take()).toEqual(['spectatorLeft', 'playerJoined']);
    const joined = last(h.events, 'playerJoined').player;
    expect(joined).toMatchObject({ id: 's1', name: 'p12', colour: 2, joinedSeq: 3, ready: false });
    expect(h.state().spectators.map((s) => s.id)).toEqual(['s2']);
    expect(h.auth.becomePlayer('s2')).toBe(ErrorCode.ROOM_FULL);
    h.auth.setReady('s1', true);
    h.auth.start('p1');
    h.auth.spectatorJoin({ id: 's3', name: 'K' });
    expect(h.auth.becomePlayer('s3')).toBe(ErrorCode.NOT_IN_LOBBY);
  });
});

describe('Authority countdown', () => {
  it('runs COUNTDOWN_SEC, then gameStarted/holeStarted and the first turn after HOLE_INTRO_MS', () => {
    const h = createHarness();
    seatPlayers(h, 3);
    h.take();
    const t0 = h.clock.now();
    expect(h.auth.start('p1')).toBeNull();
    expect(last(h.events, 'countdownStarted').endsAtMs).toBe(t0 + COUNTDOWN_SEC * 1000);
    h.clock.advance(COUNTDOWN_SEC * 1000 - 1);
    expect(h.take()).toEqual(['countdownStarted']);
    h.clock.advance(1);
    expect(h.take()).toEqual(['gameStarted', 'holeStarted']);
    expect(last(h.events, 'gameStarted').seatOrder).toEqual(['p1', 'p2', 'p3']);
    expect(last(h.events, 'holeStarted')).toMatchObject({ holeIndex: 0, order: ['p1', 'p2', 'p3'] });
    h.clock.advance(HOLE_INTRO_MS - 1);
    expect(h.take()).toEqual([]);
    h.clock.advance(1);
    expect(h.take()).toEqual(['turnStarted']);
    expect(last(h.events, 'turnStarted')).toEqual({ type: 'turnStarted', playerId: 'p1', turnSeq: 1, deadlineMs: h.clock.now() + 45_000 });
  });

  it('a player who leaves during the countdown is leftRound and absent from the hole order', () => {
    const h = createHarness();
    seatPlayers(h, 3);
    h.auth.start('p1');
    h.take();
    h.auth.leave('p2');
    expect(h.take()).toEqual(['playerLeft']);
    expect(h.state().players.find((p) => p.id === 'p2')).toMatchObject({ leftRound: true, connected: false });
    h.clock.advance(COUNTDOWN_SEC * 1000);
    expect(last(h.events, 'gameStarted').seatOrder).toEqual(['p1', 'p2', 'p3']);
    expect(last(h.events, 'holeStarted').order).toEqual(['p1', 'p3']);
    expect(Object.keys(h.state().balls)).toEqual(['p1', 'p3']);
  });

  it('aborts when nobody remains at the end of the countdown', () => {
    const h = createHarness();
    seatPlayers(h, 2);
    h.auth.spectatorJoin({ id: 's1', name: 'K' });
    h.auth.start('p1');
    h.take();
    h.auth.leave('p1');
    h.auth.leave('p2');
    expect(h.take()).toEqual(['playerLeft', 'hostChanged', 'playerLeft']);
    expect(h.state().phase).toBe('countdown');
    h.clock.advance(COUNTDOWN_SEC * 1000);
    expect(h.take()).toEqual(['gameStarted', 'roundEnded', 'backToLobby']);
    expect(last(h.events, 'roundEnded').ranking).toEqual([]);
    expect(h.state().phase).toBe('lobby');
    expect(h.state().players).toEqual([]);
    expect(h.state().spectators).toHaveLength(1);
    expect(h.clock.pending()).toBe(0);
  });
});

describe('Authority round flow', () => {
  it('plays a 3-player 2-hole round with rotation, then returns to the lobby automatically', () => {
    const h = createHarness({ settings: { holeSummarySec: 6 } });
    startRound(h, 3);
    const turns: string[] = [];
    const record = () => turns.push(h.state().turn!.playerId);
    record();
    expect(h.state().turn!.turnSeq).toBe(1);
    // hole 0: everyone holes out on the second shot
    for (let i = 0; i < 3; i++) {
      shootAndWait(h);
      record();
    }
    expect(turns).toEqual(['p1', 'p2', 'p3', 'p1']);
    for (let i = 0; i < 3; i++) shootAndWait(h, { result: 'holed', holeIndex: 0 });
    expect(h.state().phase).toBe('holeSummary');
    expect(h.state().strokes).toEqual({ p1: [2, -1], p2: [2, -1], p3: [2, -1] });
    expect(h.state().holeDone).toEqual({ p1: true, p2: true, p3: true });
    h.take();
    h.clock.advance(6000);
    expect(h.take()).toEqual(['holeStarted']);
    expect(last(h.events, 'holeStarted')).toMatchObject({ holeIndex: 1, order: ['p2', 'p3', 'p1'] });
    h.clock.advance(HOLE_INTRO_MS);
    expect(h.state().turn).toMatchObject({ playerId: 'p2', turnSeq: 7 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 }); // p2: 1
    shootAndWait(h); // p3
    shootAndWait(h); // p1
    shootAndWait(h, { result: 'holed', holeIndex: 0 }); // p3: 2
    shootAndWait(h); // p1
    shootAndWait(h, { result: 'holed', holeIndex: 0 }); // p1: 3
    expect(h.state().phase).toBe('holeSummary');
    h.take();
    h.auth.summaryReady('p1');
    h.auth.summaryReady('p2');
    h.auth.summaryReady('p2'); // duplicate ignored
    h.auth.summaryReady('ghost'); // unknown ignored
    expect(h.take()).toEqual(['summaryReady', 'summaryReady']);
    h.auth.summaryReady('p3');
    expect(h.take()).toEqual(['summaryReady', 'roundEnded']);
    expect(h.state().phase).toBe('roundSummary');
    expect(h.state().ranking).toEqual([
      { playerId: 'p2', total: 3, rank: 1 },
      { playerId: 'p3', total: 4, rank: 2 },
      { playerId: 'p1', total: 5, rank: 3 },
    ]);
    expect(h.state().summaryReady).toEqual({});
    h.clock.advance(ROUND_SUMMARY_AUTO_LOBBY_SEC * 1000 - 1);
    expect(h.take()).toEqual([]);
    h.clock.advance(1);
    expect(h.take()).toEqual(['backToLobby']);
    expect(h.state().phase).toBe('lobby');
    expect(h.state().players.map((p) => p.ready)).toEqual([false, false, false]);
    expect(h.clock.pending()).toBe(0);
  });

  it('skips a holed player for the rest of the hole and ends the hole when everyone is done', () => {
    const h = createHarness();
    startRound(h, 3);
    shootAndWait(h, { result: 'holed', holeIndex: 0 }); // p1 holed
    expect(h.state().turn!.playerId).toBe('p2');
    shootAndWait(h);
    expect(h.state().turn!.playerId).toBe('p3');
    shootAndWait(h);
    expect(h.state().turn!.playerId).toBe('p2'); // p1 skipped
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    expect(h.state().turn!.playerId).toBe('p3');
    h.take();
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    expect(h.take()).toEqual(['shotTaken', 'holeEnded']);
  });

  it('caps strokes at maxStrokes and marks the player done', () => {
    const h = createHarness({ courses: [makeCourse({ maxStrokes: 2 })] });
    startRound(h, 2);
    shootAndWait(h); // p1: 1
    shootAndWait(h); // p2: 1
    shootAndWait(h); // p1: 2 -> done
    expect(h.state().strokes['p1']).toEqual([2]);
    expect(h.state().holeDone['p1']).toBe(true);
    expect(h.state().turn!.playerId).toBe('p2');
    h.take();
    shootAndWait(h, { result: 'water', penalty: 1 }); // p2: 1 + 1 + 1 = 3 -> capped to 2
    expect(h.state().strokes['p2']).toEqual([2]);
    expect(h.take()).toEqual(['shotTaken', 'holeEnded']);
  });

  it('paces the next turn by ticks/TICK_HZ + ANIMATION_GRACE_MS and passes the sim the other resting balls', () => {
    const h = createHarness();
    startRound(h, 2);
    h.sim.queue({ ticks: 600 });
    expect(h.auth.shoot('p1', 0, 1, SHOT)).toBeNull();
    expect(h.sim.calls[0]!.others).toEqual([START_CENTRE]);
    expect(last(h.events, 'shotTaken')).toMatchObject({ playerId: 'p1', turnSeq: 1, shot: SHOT, atMs: h.clock.now() });
    h.take();
    h.clock.advance(5000 + ANIMATION_GRACE_MS - 1);
    expect(h.take()).toEqual([]);
    h.clock.advance(1);
    expect(h.take()).toEqual(['turnStarted']);
    expect(h.state().turn).toMatchObject({ playerId: 'p2', turnSeq: 2 });
    // p2's shot sees p1's moved ball
    expect(h.auth.shoot('p2', 0, 2, SHOT)).toBeNull();
    expect(h.sim.calls[1]!.others).toEqual([{ x: START_CENTRE.x + 30, y: START_CENTRE.y }]);
  });

  it('shoot() returns the codes in the specified order', () => {
    const h = createHarness();
    seatPlayers(h, 2);
    expect(h.auth.shoot('p1', 0, 1, SHOT)).toBe(ErrorCode.NOT_YOUR_TURN);
    startRound(h, 2);
    expect(h.auth.shoot('p2', 0, 1, SHOT)).toBe(ErrorCode.NOT_YOUR_TURN);
    expect(h.auth.shoot('p1', 1, 1, SHOT)).toBe(ErrorCode.STALE_TURN);
    expect(h.auth.shoot('p1', 0, 2, SHOT)).toBe(ErrorCode.STALE_TURN);
    expect(h.auth.shoot('p1', 0, 1, { dx: 1, dy: 1 })).toBe(ErrorCode.INVALID_SHOT);
    expect(h.auth.shoot('p1', 0, 1, { dx: 1.5, dy: 3000 })).toBe(ErrorCode.INVALID_SHOT);
    expect(h.auth.shoot('p1', 0, 1, SHOT)).toBeNull();
    expect(h.auth.shoot('p1', 0, 1, SHOT)).toBe(ErrorCode.SHOT_IN_FLIGHT);
    expect(h.sim.calls).toHaveLength(1);
  });

  it('ranking ties share a rank in roundEnded', () => {
    const h = createHarness({ courses: [makeCourse()], settings: { holeSummarySec: 3 } });
    startRound(h, 3);
    for (let i = 0; i < 3; i++) shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.clock.advance(3000);
    expect(h.state().phase).toBe('roundSummary');
    expect(h.state().ranking).toEqual([
      { playerId: 'p1', total: 1, rank: 1 },
      { playerId: 'p2', total: 1, rank: 1 },
      { playerId: 'p3', total: 1, rank: 1 },
    ]);
  });
});

describe('Authority timeouts and AFK', () => {
  it('a turn timeout adds a stroke, leaves the ball, and passes the turn; two in a row set afk with 5 s deadlines', () => {
    const h = createHarness({ courses: [makeCourse({ maxStrokes: 20 })] });
    startRound(h, 2);
    h.take();
    h.clock.advance(45_000 - 1);
    expect(h.take()).toEqual([]);
    h.clock.advance(1);
    expect(h.take()).toEqual(['turnTimedOut', 'turnStarted']);
    expect(h.state().strokes['p1']).toEqual([1]);
    expect(h.state().balls['p1']).toMatchObject(START_CENTRE);
    expect(h.state().turn!.playerId).toBe('p2');
    expect(h.sim.calls).toHaveLength(0);
    shootAndWait(h); // p2 shoots; back to p1 with a normal deadline (1 timeout so far)
    expect(h.state().turn).toMatchObject({ playerId: 'p1', deadlineMs: h.clock.now() + 45_000 });
    h.clock.advance(45_000);
    expect(h.state().players[0]).toMatchObject({ consecutiveTimeouts: 2, afk: true });
    shootAndWait(h); // p2
    expect(h.state().turn).toMatchObject({ playerId: 'p1', deadlineMs: h.clock.now() + AFK_TURN_TIMEOUT_SEC * 1000 });
    h.take();
    h.auth.activity('p1');
    h.auth.activity('p1');
    h.auth.activity('p2'); // not afk -> nothing
    expect(h.take()).toEqual(['playerAfk']);
    expect(h.state().players[0]).toMatchObject({ afk: false, consecutiveTimeouts: 0 });
    // the current short deadline stands; the next turn is normal again
    h.clock.advance(AFK_TURN_TIMEOUT_SEC * 1000);
    expect(h.take()).toEqual(['turnTimedOut', 'turnStarted']);
    shootAndWait(h);
    expect(h.state().turn!.deadlineMs).toBe(h.clock.now() + 45_000);
    // a shot clears afk/timeouts too
    h.clock.advance(45_000); // p1 times out again (2nd in a row -> afk), p2 on turn
    h.clock.advance(45_000); // p2 times out, p1 on turn with the 5 s deadline
    expect(h.state().players[0]!.afk).toBe(true);
    expect(h.state().turn).toMatchObject({ playerId: 'p1', deadlineMs: h.clock.now() + AFK_TURN_TIMEOUT_SEC * 1000 });
    expect(h.auth.shoot('p1', 0, h.state().turn!.turnSeq, SHOT)).toBeNull();
    expect(h.state().players[0]).toMatchObject({ afk: false, consecutiveTimeouts: 0 });
  });

  it('turnTimeoutSec 0 means no deadline', () => {
    const h = createHarness({ settings: { turnTimeoutSec: 0 } });
    startRound(h, 2);
    expect(h.state().turn!.deadlineMs).toBeNull();
    h.clock.advance(10 * 60_000);
    expect(h.state().turn).toMatchObject({ playerId: 'p1', turnSeq: 1, shotInFlight: false });
  });
});

describe('Authority disconnects', () => {
  it('a disconnected player is skipped without a stroke after 10 s and removed after the grace', () => {
    const h = createHarness({ settings: { turnTimeoutSec: 0 } });
    startRound(h, 3);
    h.take();
    const tDisc = h.clock.now();
    h.auth.connection('p2', false);
    expect(h.take()).toEqual(['playerConnection']);
    shootAndWait(h); // p1 -> p2's turn
    expect(h.state().turn).toMatchObject({ playerId: 'p2', deadlineMs: h.clock.now() + DISCONNECTED_TURN_WAIT_SEC * 1000 });
    h.take();
    h.clock.advance(DISCONNECTED_TURN_WAIT_SEC * 1000);
    expect(h.take()).toEqual(['turnSkipped', 'turnStarted']);
    expect(h.state().strokes['p2']).toEqual([-1, -1]);
    expect(h.state().turn!.playerId).toBe('p3');
    h.clock.advance(tDisc + DISCONNECT_GRACE_SEC * 1000 - h.clock.now() - 1);
    expect(h.state().players[1]!.leftRound).toBe(false);
    h.clock.advance(1);
    expect(h.take()).toEqual(['playerLeft']);
    expect(h.state().players[1]).toMatchObject({ leftRound: true, connected: false });
    expect(h.state().order).toEqual(['p1', 'p3']);
  });

  it('disconnecting on turn shortens an open deadline with a fresh turn; reconnecting restores a full turn', () => {
    const h = createHarness({ settings: { turnTimeoutSec: 0 } });
    startRound(h, 2);
    h.take();
    h.auth.connection('p1', false);
    expect(h.take()).toEqual(['playerConnection', 'turnStarted']);
    expect(h.state().turn).toMatchObject({ playerId: 'p1', turnSeq: 2, deadlineMs: h.clock.now() + DISCONNECTED_TURN_WAIT_SEC * 1000 });
    h.clock.advance(4000);
    h.auth.connection('p1', true);
    expect(h.take()).toEqual(['playerConnection', 'turnStarted']);
    expect(h.state().turn).toMatchObject({ playerId: 'p1', turnSeq: 3, deadlineMs: null });
    h.clock.advance(60_000);
    expect(h.state().turn!.turnSeq).toBe(3); // no skip, no removal
    expect(h.state().players[0]!.connected).toBe(true);
  });

  it('a deadline shorter than the disconnected wait is kept; reconnecting then does not restart the turn', () => {
    const h = createHarness({ settings: { turnTimeoutSec: 30 } });
    startRound(h, 2);
    h.clock.advance(25_000);
    h.take();
    const deadline = h.state().turn!.deadlineMs;
    h.auth.connection('p1', false);
    expect(h.take()).toEqual(['playerConnection']);
    expect(h.state().turn!.deadlineMs).toBe(deadline);
    h.auth.connection('p1', true);
    expect(h.take()).toEqual(['playerConnection']);
    h.clock.advance(5000);
    expect(h.take()).toEqual(['turnTimedOut', 'turnStarted']); // connected again -> timeout, not skip
  });

  it('a long deadline is shortened on disconnect, and expiry while offline is a skip', () => {
    const h = createHarness({ settings: { turnTimeoutSec: 60 } });
    startRound(h, 2);
    h.take();
    h.auth.connection('p1', false);
    expect(h.take()).toEqual(['playerConnection', 'turnStarted']);
    h.clock.advance(DISCONNECTED_TURN_WAIT_SEC * 1000);
    expect(h.take()).toEqual(['turnSkipped', 'turnStarted']);
    expect(h.state().strokes['p1']).toEqual([-1, -1]);
  });

  it('lobby disconnect removes the player after LOBBY_DISCONNECT_REMOVE_SEC; reconnecting cancels it', () => {
    const h = createHarness();
    seatPlayers(h, 3);
    h.take();
    h.auth.connection('p2', false);
    h.auth.connection('p2', false); // unchanged -> ignored
    expect(h.take()).toEqual(['playerConnection']);
    h.clock.advance(LOBBY_DISCONNECT_REMOVE_SEC * 1000 - 1);
    h.auth.connection('p2', true);
    h.clock.advance(60_000);
    expect(h.state().players).toHaveLength(3);
    h.auth.connection('p3', false);
    h.clock.advance(LOBBY_DISCONNECT_REMOVE_SEC * 1000);
    expect(h.state().players.map((p) => p.id)).toEqual(['p1', 'p2']);
    h.auth.connection('ghost', false);
    expect(h.clock.pending()).toBe(0);
  });

  it('host disconnect in the lobby: role kept during grace, hostChanged on removal', () => {
    const h = createHarness();
    seatPlayers(h, 2);
    h.take();
    h.auth.connection('p1', false);
    expect(h.state().hostId).toBe('p1');
    h.clock.advance(LOBBY_DISCONNECT_REMOVE_SEC * 1000);
    expect(h.take()).toEqual(['playerConnection', 'playerLeft', 'hostChanged']);
    expect(h.state().hostId).toBe('p2');
  });

  it('host disconnect during a hole: keeps the role, turns are skipped, removal migrates the host and the hole goes on', () => {
    const h = createHarness({ settings: { turnTimeoutSec: 0 } });
    startRound(h, 3);
    h.auth.connection('p1', false); // on turn -> fresh 10 s turn
    h.clock.advance(DISCONNECTED_TURN_WAIT_SEC * 1000);
    expect(h.state().turn!.playerId).toBe('p2');
    expect(h.state().hostId).toBe('p1');
    h.take();
    h.clock.advance(DISCONNECT_GRACE_SEC * 1000);
    expect(h.take()).toEqual(['playerLeft', 'hostChanged']);
    expect(h.state().hostId).toBe('p2');
    expect(h.state().phase).toBe('hole');
    expect(h.state().turn!.playerId).toBe('p2');
  });

  it('host disconnect in holeSummary / roundSummary: the automatic rules keep the room moving', () => {
    const h = createHarness({ courses: [makeCourse(), makeCourse()], settings: { holeSummarySec: 0 } });
    startRound(h, 2);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    expect(h.state().phase).toBe('holeSummary');
    h.take();
    h.auth.summaryReady('p2');
    h.auth.connection('p1', false); // p2 is the only connected active player and is ready -> next hole
    expect(h.take()).toEqual(['summaryReady', 'playerConnection', 'holeStarted']);
    h.auth.connection('p1', true);
    h.clock.advance(HOLE_INTRO_MS);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    expect(h.state().phase).toBe('holeSummary');
    h.auth.summaryReady('p1');
    h.auth.summaryReady('p2');
    expect(h.state().phase).toBe('roundSummary');
    h.take();
    h.auth.connection('p1', false);
    h.auth.summaryReady('p2');
    expect(h.take()).toEqual(['playerConnection', 'summaryReady', 'backToLobby']);
    expect(h.state().phase).toBe('lobby');
    expect(h.state().hostId).toBe('p1'); // still host, still disconnected; the lobby rule now applies (§10.6)
    expect(h.state().players[0]!.connected).toBe(false);
    h.clock.advance(LOBBY_DISCONNECT_REMOVE_SEC * 1000 - 1);
    expect(h.state().hostId).toBe('p1');
    h.clock.advance(1);
    expect(h.take()).toEqual(['playerLeft', 'hostChanged']);
    expect(h.state().hostId).toBe('p2');
    expect(h.state().players.map((p) => p.id)).toEqual(['p2']);
    expect(h.clock.pending()).toBe(0);
  });

  it('backToLobby shortens a round grace timer to the lobby rule but never extends a shorter remainder', () => {
    const h = createHarness({ courses: [makeCourse()], settings: { turnTimeoutSec: 0 } });
    startRound(h, 3);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.clock.advance(6000);
    expect(h.state().phase).toBe('roundSummary');
    h.auth.connection('p2', false); // 60 s grace
    h.clock.advance(DISCONNECT_GRACE_SEC * 1000 - 4000); // 4 s of grace left
    h.auth.connection('p3', false); // fresh 60 s grace
    h.take();
    expect(h.auth.backToLobby('p1')).toBeNull();
    expect(h.take()).toEqual(['backToLobby']);
    h.clock.advance(3999);
    expect(h.state().players.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    h.clock.advance(1); // p2: the 4 s remainder is kept (shorter than the lobby rule)
    expect(h.state().players.map((p) => p.id)).toEqual(['p1', 'p3']);
    h.clock.advance(LOBBY_DISCONNECT_REMOVE_SEC * 1000 - 4000 - 1);
    expect(h.state().players.map((p) => p.id)).toEqual(['p1', 'p3']);
    h.clock.advance(1); // p3: removed LOBBY_DISCONNECT_REMOVE_SEC after backToLobby, not after the remaining grace
    expect(h.state().players.map((p) => p.id)).toEqual(['p1']);
    expect(h.clock.pending()).toBe(0);
  });

  it('holeSummary with everyone disconnected ends after HOLE_SUMMARY_SEC regardless of the setting', () => {
    const h = createHarness({ settings: { holeSummarySec: 0 } });
    startRound(h, 2);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.auth.connection('p1', false);
    h.auth.connection('p2', false);
    h.take();
    h.clock.advance(HOLE_SUMMARY_SEC * 1000 - 1);
    expect(h.take()).toEqual([]);
    h.clock.advance(1);
    expect(h.take()).toEqual(['holeStarted']);
  });

  it('holeSummary with everyone disconnected: a longer holeSummarySec timer is shortened, a shorter remainder is kept', () => {
    const h = createHarness({ settings: { holeSummarySec: 10 } });
    startRound(h, 2);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.auth.connection('p1', false);
    h.auth.connection('p2', false);
    h.take();
    h.clock.advance(HOLE_SUMMARY_SEC * 1000 - 1);
    expect(h.state().phase).toBe('holeSummary');
    h.clock.advance(1);
    expect(h.take()).toEqual(['holeStarted']); // 6 s, not 10 s
    h.auth.connection('p1', true);
    h.auth.connection('p2', true);
    h.clock.advance(HOLE_INTRO_MS);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.clock.advance(7000); // 3 s of the 10 s timer left
    h.auth.connection('p1', false);
    h.auth.leave('p2'); // the connected active set is now empty via leave(), not only via connection()
    h.take();
    h.clock.advance(2999);
    expect(h.state().phase).toBe('holeSummary');
    h.clock.advance(1);
    expect(h.take()).toEqual(['roundEnded']); // the 3 s remainder was kept (not extended to 6 s)
  });

  it('holeSummary (no timer) where the last connected player leaves and the rest are offline ends after HOLE_SUMMARY_SEC', () => {
    const h = createHarness({ settings: { holeSummarySec: 0 } });
    startRound(h, 2);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.auth.connection('p1', false);
    h.auth.leave('p2');
    h.take();
    h.clock.advance(HOLE_SUMMARY_SEC * 1000 - 1);
    expect(h.state().phase).toBe('holeSummary');
    h.clock.advance(1);
    expect(h.take()).toEqual(['holeStarted']);
  });

  it('the only player (host) disconnecting mid-round: grace, then roundEnded and backToLobby; room left empty', () => {
    const h = createHarness({ settings: { turnTimeoutSec: 0 } });
    startRound(h, 2);
    h.auth.leave('p2');
    expect(h.state().players.filter((p) => !p.leftRound).map((p) => p.id)).toEqual(['p1']);
    h.take();
    h.auth.connection('p1', false);
    h.clock.advance(DISCONNECTED_TURN_WAIT_SEC * 1000); // skipped, and p1 is still the only player -> next turn is p1 again
    expect(h.state().turn!.playerId).toBe('p1');
    h.clock.advance(DISCONNECT_GRACE_SEC * 1000);
    expect(h.take().slice(-3)).toEqual(['playerLeft', 'roundEnded', 'backToLobby']);
    expect(h.state().phase).toBe('lobby');
    expect(h.state().players).toEqual([]);
    expect(h.clock.pending()).toBe(0);
  });

  it('the only remaining player disconnecting in roundSummary: the grace fires before the auto-lobby timer without a second roundEnded', () => {
    const h = createHarness({ courses: [makeCourse()], settings: { holeSummarySec: 0 } });
    startRound(h, 2);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.auth.summaryReady('p1');
    h.auth.summaryReady('p2');
    expect(h.state().phase).toBe('roundSummary');
    h.auth.leave('p2');
    h.take();
    h.auth.connection('p1', false);
    expect(h.take()).toEqual(['playerConnection']);
    expect(DISCONNECT_GRACE_SEC).toBeLessThan(ROUND_SUMMARY_AUTO_LOBBY_SEC);
    expect(() => h.clock.advance(DISCONNECT_GRACE_SEC * 1000)).not.toThrow();
    expect(h.take()).toEqual(['playerLeft', 'backToLobby']);
    expect(h.state()).toMatchObject({ phase: 'lobby', players: [] });
    expect(h.clock.pending()).toBe(0);
  });
});

describe('Authority leaving mid-round', () => {
  it('leaving on turn advances immediately and migrates the host', () => {
    const h = createHarness();
    startRound(h, 3);
    h.take();
    h.auth.leave('p1');
    expect(h.take()).toEqual(['playerLeft', 'hostChanged', 'turnStarted']);
    expect(h.state().hostId).toBe('p2');
    expect(h.state().turn).toMatchObject({ playerId: 'p2', turnSeq: 2 });
    expect(h.state().order).toEqual(['p2', 'p3']);
    h.clock.advance(45_000); // old deadline timer was cleared: only p2's own timeout fires now
    expect(h.take()).toEqual(['turnTimedOut', 'turnStarted']);
    expect(h.state().turn!.playerId).toBe('p3');
  });

  it('leaving with a shot in flight lets the pacing timer advance as scheduled', () => {
    const h = createHarness();
    startRound(h, 3);
    expect(h.auth.shoot('p1', 0, 1, SHOT)).toBeNull();
    h.take();
    h.auth.leave('p1');
    expect(h.take()).toEqual(['playerLeft', 'hostChanged']);
    expect(h.state().turn!.playerId).toBe('p1');
    h.clock.advance(1250);
    expect(h.take()).toEqual(['turnStarted']);
    expect(h.state().turn!.playerId).toBe('p2');
  });

  it('a non-turn leaver keeps the turn; the leaver who was the last unfinished player on a later turn is skipped', () => {
    const h = createHarness();
    startRound(h, 3);
    h.take();
    h.auth.leave('p3');
    expect(h.take()).toEqual(['playerLeft']);
    expect(h.state().turn!.playerId).toBe('p1');
    shootAndWait(h);
    expect(h.state().turn!.playerId).toBe('p2');
    shootAndWait(h);
    expect(h.state().turn!.playerId).toBe('p1');
  });

  it('one remaining active player plays the rest of the round alone', () => {
    const h = createHarness({ courses: [makeCourse(), makeCourse()], settings: { holeSummarySec: 3 } });
    startRound(h, 3);
    h.auth.leave('p2');
    h.auth.leave('p3');
    expect(h.state().phase).toBe('hole');
    shootAndWait(h);
    expect(h.state().turn!.playerId).toBe('p1');
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    expect(h.state().phase).toBe('holeSummary');
    h.clock.advance(3000);
    expect(last(h.events, 'holeStarted')).toMatchObject({ holeIndex: 1, order: ['p1'] });
    h.clock.advance(HOLE_INTRO_MS);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.clock.advance(3000);
    expect(h.state().phase).toBe('roundSummary');
    expect(h.state().ranking).toEqual([
      { playerId: 'p1', total: 3, rank: 1 },
      { playerId: 'p2', total: 0, rank: 2 },
      { playerId: 'p3', total: 0, rank: 2 },
    ]);
    h.auth.summaryReady('p1');
    expect(h.state().phase).toBe('lobby');
    expect(h.state().players.map((p) => p.id)).toEqual(['p1']);
  });

  it('the last active player leaving mid-round ends the round and returns to the lobby', () => {
    const h = createHarness();
    startRound(h, 2);
    h.auth.spectatorJoin({ id: 's1', name: 'K' });
    shootAndWait(h);
    h.take();
    h.auth.leave('p2'); // p2 was on turn: the turn passes to p1 (the last active player plays alone)
    expect(h.take()).toEqual(['playerLeft', 'turnStarted']);
    expect(h.state().turn!.playerId).toBe('p1');
    h.auth.leave('p1');
    expect(h.take()).toEqual(['playerLeft', 'roundEnded', 'backToLobby']);
    // §10.5: roundEnded(ranking) — the leavers are listed, all with rank 1 (no active player outranks them)
    expect(last(h.events, 'roundEnded').ranking).toEqual([
      { playerId: 'p2', total: 0, rank: 1 },
      { playerId: 'p1', total: 1, rank: 1 },
    ]);
    expect(h.state()).toMatchObject({ phase: 'lobby', players: [], spectators: [{ id: 's1', name: 'K' }], hostId: 'p1' });
    expect(h.clock.pending()).toBe(0);
    expect(h.auth.becomePlayer('s1')).toBeNull();
    expect(h.state().hostId).toBe('s1');
  });

  it('the last active player leaving in roundSummary goes straight back to the lobby (no second roundEnded)', () => {
    const h = createHarness({ courses: [makeCourse()], settings: { holeSummarySec: 0 } });
    startRound(h, 2);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.auth.summaryReady('p1');
    h.auth.summaryReady('p2');
    expect(h.state().phase).toBe('roundSummary');
    h.take();
    h.auth.leave('p1');
    expect(h.take()).toEqual(['playerLeft', 'hostChanged']);
    expect(h.state().phase).toBe('roundSummary');
    expect(() => h.auth.leave('p2')).not.toThrow();
    expect(h.take()).toEqual(['playerLeft', 'backToLobby']);
    expect(h.state()).toMatchObject({ phase: 'lobby', players: [] });
    expect(h.clock.pending()).toBe(0); // the ROUND_SUMMARY_AUTO_LOBBY_SEC timer is gone too
  });

  it('leaving in holeSummary completes the summary when the rest are ready', () => {
    const h = createHarness({ settings: { holeSummarySec: 0 } });
    startRound(h, 3);
    for (let i = 0; i < 3; i++) shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.auth.summaryReady('p1');
    h.auth.summaryReady('p2');
    h.take();
    h.auth.leave('p3');
    expect(h.take()).toEqual(['playerLeft', 'holeStarted']);
  });
});

describe('Authority summaries and backToLobby', () => {
  it('holeSummarySec 0 waits for every connected active player', () => {
    const h = createHarness({ settings: { holeSummarySec: 0 } });
    startRound(h, 2);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.take();
    h.clock.advance(10 * 60_000);
    expect(h.take()).toEqual([]);
    h.auth.summaryReady('p1');
    expect(h.state().phase).toBe('holeSummary');
    h.auth.summaryReady('p2');
    expect(h.state().phase).toBe('hole');
  });

  it('summaryReady is ignored outside the summaries and for spectators / left players', () => {
    const h = createHarness();
    startRound(h, 2);
    h.auth.spectatorJoin({ id: 's1', name: 'K' });
    h.take();
    h.auth.summaryReady('p1');
    expect(h.take()).toEqual([]);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.auth.leave('p2');
    expect(h.state().phase).toBe('holeSummary');
    h.take();
    h.auth.summaryReady('s1');
    h.auth.summaryReady('p2');
    expect(h.take()).toEqual([]);
  });

  it('backToLobby: host in roundSummary, NOT_HOST for others, GAME_IN_PROGRESS mid-round, no-op in the lobby', () => {
    const h = createHarness({ courses: [makeCourse()] });
    expect(h.auth.backToLobby('p1')).toBeNull();
    expect(h.auth.backToLobby(null)).toBeNull();
    startRound(h, 2);
    expect(h.auth.backToLobby('p1')).toBe(ErrorCode.GAME_IN_PROGRESS);
    expect(h.auth.backToLobby('p2')).toBe(ErrorCode.NOT_HOST);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.clock.advance(6000);
    expect(h.state().phase).toBe('roundSummary');
    expect(h.auth.backToLobby('p2')).toBe(ErrorCode.NOT_HOST);
    h.take();
    expect(h.auth.backToLobby('p1')).toBeNull();
    expect(h.take()).toEqual(['backToLobby']);
    expect(h.state().phase).toBe('lobby');
    expect(h.clock.pending()).toBe(0);
    expect(h.auth.backToLobby('p1')).toBeNull();
    expect(h.take()).toEqual([]);
  });

  it('automatic backToLobby mid-round clears the round timers', () => {
    const h = createHarness();
    startRound(h, 2);
    expect(h.auth.shoot('p1', 0, 1, SHOT)).toBeNull();
    expect(h.auth.backToLobby(null)).toBeNull();
    expect(h.state().phase).toBe('lobby');
    expect(h.clock.pending()).toBe(0);
    h.clock.advance(100_000);
    expect(h.state().phase).toBe('lobby');
  });

  it('dispose clears every timer and silences the instance', () => {
    const h = createHarness();
    startRound(h, 2);
    h.auth.connection('p2', false);
    expect(h.clock.pending()).toBeGreaterThan(0);
    h.auth.dispose();
    expect(h.clock.pending()).toBe(0);
    h.take();
    h.clock.advance(10 * 60_000);
    expect(h.take()).toEqual([]);
  });
});

describe('Authority single player (minPlayers 1)', () => {
  it('runs the §10.7 flow: join no-op, 0 ms countdown, no deadlines, summaries wait, restart', () => {
    const courses = [makeCourse({ id: 'c_1', par: 2 }), makeCourse({ id: 'c_2', par: 3 })];
    const player = makePlayer('p1', 0, { name: 'Yksin', colour: 2 });
    const h = createHarness({ minPlayers: 1, initial: createSinglePlayerState(courses, player) });
    expect(h.state().players[0]).toMatchObject({ id: 'p1', ready: true, joinedSeq: 1 });
    expect(h.auth.join(player)).toBeNull();
    expect(h.take()).toEqual([]);
    expect(h.auth.start('p1')).toBeNull();
    expect(last(h.events, 'countdownStarted').endsAtMs).toBe(h.clock.now());
    expect(h.take()).toEqual(['countdownStarted']);
    h.clock.advance(0);
    expect(h.take()).toEqual(['gameStarted', 'holeStarted']);
    h.clock.advance(HOLE_INTRO_MS);
    expect(h.take()).toEqual(['turnStarted']);
    expect(h.state().turn).toEqual({ playerId: 'p1', turnSeq: 1, deadlineMs: null, shotInFlight: false });
    expect(h.auth.shoot('p1', 0, 1, SHOT)).toBeNull();
    h.clock.advance(1250);
    expect(h.state().turn).toMatchObject({ playerId: 'p1', turnSeq: 2 });
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    expect(h.state().phase).toBe('holeSummary');
    h.clock.advance(60 * 60_000);
    expect(h.state().phase).toBe('holeSummary');
    h.auth.summaryReady('p1');
    expect(h.state().phase).toBe('hole');
    expect(h.state().holeIndex).toBe(1);
    h.clock.advance(HOLE_INTRO_MS);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.auth.summaryReady('p1');
    expect(h.state().phase).toBe('roundSummary');
    expect(h.state().ranking).toEqual([{ playerId: 'p1', total: 3, rank: 1 }]);
    expect(h.clock.pending()).toBe(0); // no auto-lobby timer in single player
    // "Pelaa uudelleen"
    expect(h.auth.backToLobby('p1')).toBeNull();
    expect(h.auth.start('p1')).toBeNull();
    h.clock.advance(HOLE_INTRO_MS);
    expect(h.state()).toMatchObject({ phase: 'hole', holeIndex: 0 });
    expect(h.state().turn).toMatchObject({ playerId: 'p1', turnSeq: 1 });
    expect(h.state().strokes).toEqual({ p1: [-1, -1] });
    // "Lopeta": leave aborts the round
    h.take();
    h.auth.leave('p1');
    expect(h.take()).toEqual(['playerLeft', 'roundEnded', 'backToLobby']);
    expect(last(h.events, 'roundEnded').ranking).toEqual([{ playerId: 'p1', total: 0, rank: 1 }]);
    expect(h.clock.pending()).toBe(0);
  });

  it('"Valikkoon": leave() in roundSummary returns to the lobby without throwing or a second roundEnded', () => {
    const player = makePlayer('p1', 0, { name: 'Yksin' });
    const h = createHarness({ minPlayers: 1, initial: createSinglePlayerState([makeCourse()], player) });
    expect(h.auth.start('p1')).toBeNull();
    h.clock.advance(HOLE_INTRO_MS);
    shootAndWait(h, { result: 'holed', holeIndex: 0 });
    h.auth.summaryReady('p1');
    expect(h.state().phase).toBe('roundSummary');
    h.take();
    expect(() => h.auth.leave('p1')).not.toThrow();
    expect(h.take()).toEqual(['playerLeft', 'backToLobby']);
    expect(h.state()).toMatchObject({ phase: 'lobby', players: [] });
    expect(h.clock.pending()).toBe(0);
  });

  it('constructor picks up joinedSeq and turnSeq from a non-empty initial state', () => {
    const h = createHarness({ minPlayers: 1, initial: createSinglePlayerState([makeCourse()], makePlayer('p1', 5)) });
    expect(h.auth.join(makePlayer('p2', 0))).toBeNull();
    expect(h.state().players[1]!.joinedSeq).toBe(6);
    const a = new Authority(
      { ...h.state(), phase: 'hole', holeIndex: 0, order: ['p1'], seatOrder: ['p1'], turn: { playerId: 'p1', turnSeq: 9, deadlineMs: null, shotInFlight: false } },
      { now: () => 0, setTimeout: () => 1, clearTimeout: () => undefined, simulate: h.sim.fn, emit: () => undefined, minPlayers: 1 },
    );
    expect(a.state.turn!.turnSeq).toBe(9);
    a.dispose();
  });
});
