// Phase 2 room scenarios (DESIGN §15 WP-F acceptance, §16.4): the Authority-backed Room driven through the real
// Gateway + ClientSession over FakeTransport with a FakeClock. No sockets; the physics is the real simulateShot.
import { describe, expect, it } from 'vitest';
import {
  AFK_TURN_TIMEOUT_SEC,
  ANIMATION_GRACE_MS,
  COUNTDOWN_SEC,
  DEFAULT_TURN_TIMEOUT_SEC,
  DISCONNECTED_TURN_WAIT_SEC,
  DISCONNECT_GRACE_SEC,
  HOLE_INTRO_MS,
  SIM_VERSION,
  TICK_HZ,
} from '@puttipeli/shared/constants';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import { decodeLayers } from '@puttipeli/shared/course/parse';
import type { Course } from '@puttipeli/shared/course/types';
import type { GameEvent } from '@puttipeli/shared/game/events';
import type { PlayerColour } from '@puttipeli/shared/game/types';
import { CHAT_MSGS_PER_10S, RATE_BURST } from '@puttipeli/shared/protocol/limits';
import type { ClientMessage, ServerMessage } from '@puttipeli/shared/protocol/messages';
import { parseClientMessage } from '@puttipeli/shared/protocol/validate';
import { PROTOCOL_VERSION } from '@puttipeli/shared/protocol/version';
import { simulateShot } from '@puttipeli/shared/sim/simulate';
import { createBallAt, createWorldFromCourse, startCentre } from '@puttipeli/shared/sim/worldState';
import { type Logger, nullLogger } from '../log';
import { CLOSE_POLICY } from '../ws/connection';
import { FakeClock, FakeConnection, FakeTransport } from '../ws/fakeTransport';
import { Gateway } from '../ws/gateway';
import { CHAT_BACKLOG } from './room';
import { RoomManager } from './roomManager';

const HELLO = { t: 'hello', protocolVersion: PROTOCOL_VERSION, simVersion: SIM_VERSION, clientBuild: 'test' };
/** Straight east on b_01 (Ensiputti): holes out from the start in 216 ticks (probed with the real sim). */
const HOLING_SHOT = { dx: 11000, dy: 0 };
const SHORT_SHOT = { dx: 3000, dy: 0 };
const b01 = BUILTIN_COURSES[0]!;
type Joined = Extract<ServerMessage, { t: 'roomJoined' }>;

/** Lets unvalidated `shoot` payloads through so the Authority's own INVALID_SHOT check is exercised. */
const permissiveParse = (raw: string): ClientMessage | null => {
  const v = JSON.parse(raw) as { t?: string };
  return v.t === 'shoot' ? (v as ClientMessage) : parseClientMessage(raw);
};

function harness(opts: { roomEmptyTtlSec?: number; permissiveShots?: boolean; log?: Logger } = {}) {
  const clock = new FakeClock();
  const log = opts.log ?? nullLogger;
  const rooms = new RoomManager(clock, { maxRooms: 50, roomIdleTtlMin: 90, roomEmptyTtlSec: opts.roomEmptyTtlSec ?? 120 }, log);
  const gateway = new Gateway({ rooms, clock, log, build: 'b', parse: opts.permissiveShots ? permissiveParse : undefined });
  const transport = new FakeTransport();
  transport.start(gateway);

  const client = (): FakeConnection => {
    const c = transport.connect();
    c.receive(HELLO);
    c.clearSent();
    return c;
  };
  const joinedMemo = new WeakMap<FakeConnection, Joined>();
  const joined = (c: FakeConnection): Joined => {
    const memo = joinedMemo.get(c);
    if (memo) return memo;
    const m = c.sentOf('roomJoined')[0];
    if (!m) throw new Error('no roomJoined in ' + JSON.stringify(c.sent));
    joinedMemo.set(c, m);
    return m;
  };
  const events = (c: FakeConnection): GameEvent[] => c.sentOf('event').map((m) => m.ev);
  const eventTypes = (c: FakeConnection): string[] => events(c).map((e) => e.type);
  const types = (c: FakeConnection): string[] => c.sent.map((m) => (m.t === 'event' ? `event:${m.ev.type}` : m.t === 'chat' ? `chat:${m.key ?? 'text'}` : m.t));
  const errors = (c: FakeConnection): string[] => c.sentOf('error').map((e) => e.code);
  const lastEvent = <T extends GameEvent['type']>(c: FakeConnection, type: T): Extract<GameEvent, { type: T }> | undefined =>
    events(c).filter((e): e is Extract<GameEvent, { type: T }> => e.type === type).at(-1);
  const clearAll = (...cs: FakeConnection[]): void => cs.forEach((c) => c.clearSent());

  const createRoom = (name = 'Host', colour: PlayerColour = 0, settings?: object) => {
    const c = client();
    c.receive({ t: 'createRoom', name, colour, ...(settings ? { settings } : {}) });
    const j = joined(c);
    return { c, code: j.code, id: j.playerId, token: j.sessionToken };
  };
  const join = (code: string, name: string, colour: PlayerColour = 1, asSpectator?: boolean) => {
    const c = client();
    c.receive({ t: 'joinRoom', code, name, colour, ...(asSpectator !== undefined ? { asSpectator } : {}) });
    const j = joined(c);
    return { c, id: j.playerId, token: j.sessionToken, role: j.role };
  };
  const room = (code: string) => {
    const r = rooms.get(code);
    if (!r) throw new Error('room gone');
    return r;
  };
  /** Host + one player in a lobby playing only b_01 (plus an optional spectator). */
  const twoPlayers = (settings?: object, withSpectator = false) => {
    const host = createRoom('Host', 0, settings);
    const p2 = join(host.code, 'P2', 1);
    const spec = withSpectator ? join(host.code, 'Katsoja', 2, true) : null;
    host.c.receive({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_01' }] });
    return { host, p2, spec, code: host.code };
  };
  /** Ready-up, start, run the countdown and the hole intro: the host is on turn (turnSeq 1). */
  const begin = (host: FakeConnection, ...others: FakeConnection[]): void => {
    for (const o of others) o.receive({ t: 'setReady', ready: true });
    host.receive({ t: 'startGame' });
    clock.advance(COUNTDOWN_SEC * 1000);
    clock.advance(HOLE_INTRO_MS);
  };
  const shoot = (c: FakeConnection, code: string, shot = SHORT_SHOT): void => {
    const s = room(code).state;
    c.receive({ t: 'shoot', holeIndex: s.holeIndex, turnSeq: s.turn?.turnSeq ?? 0, shot });
  };
  const pacingMs = (ticks: number): number => (ticks / TICK_HZ) * 1000 + ANIMATION_GRACE_MS;

  return { clock, rooms, gateway, transport, client, joined, events, eventTypes, types, errors, lastEvent, clearAll, createRoom, join, room, twoPlayers, begin, shoot, pacingMs };
}

describe('start gating and countdown', () => {
  it('startGame: NOT_ENOUGH_PLAYERS, PLAYERS_NOT_READY, NOT_HOST; then countdown -> gameStarted -> holeStarted -> turnStarted for everyone', () => {
    const h = harness();
    const { host, p2, spec, code } = h.twoPlayers(undefined, true);
    h.clearAll(host.c, p2.c, spec!.c);
    const solo = h.createRoom('Yksin');
    solo.c.receive({ t: 'startGame' });
    expect(h.errors(solo.c)).toEqual(['NOT_ENOUGH_PLAYERS']);

    host.c.receive({ t: 'startGame' });
    expect(h.errors(host.c)).toEqual(['PLAYERS_NOT_READY']);
    p2.c.receive({ t: 'setReady', ready: true });
    p2.c.receive({ t: 'startGame' });
    expect(h.errors(p2.c)).toEqual(['NOT_HOST']);
    h.clearAll(host.c, p2.c, spec!.c);

    const t0 = h.clock.now();
    host.c.receive({ t: 'startGame' });
    expect(h.room(code).phase).toBe('countdown');
    for (const c of [host.c, p2.c, spec!.c]) expect(h.events(c)).toEqual([{ type: 'countdownStarted', endsAtMs: t0 + COUNTDOWN_SEC * 1000 }]);
    p2.c.receive({ t: 'setReady', ready: false });
    expect(h.errors(p2.c)).toEqual(['NOT_IN_LOBBY']);
    const late = h.join(code, 'Myohassa', 3); // a running game turns a join into a spectator join
    expect(late.role).toBe('spectator');

    h.clock.advance(COUNTDOWN_SEC * 1000 - 1);
    expect(h.room(code).phase).toBe('countdown');
    h.clock.advance(1);
    expect(h.room(code).phase).toBe('hole');
    expect(h.lastEvent(spec!.c, 'gameStarted')).toEqual({ type: 'gameStarted', seatOrder: [host.id, p2.id] });
    expect(h.lastEvent(spec!.c, 'holeStarted')).toEqual({ type: 'holeStarted', holeIndex: 0, order: [host.id, p2.id] });
    expect(h.eventTypes(spec!.c)).toEqual(['countdownStarted', 'spectatorJoined', 'gameStarted', 'holeStarted']);
    expect(spec!.c.sentOf('chat').map((m) => m.key)).toEqual(['chat.spectatorJoined', 'chat.gameStarted']);
    h.clock.advance(HOLE_INTRO_MS);
    const turn = { type: 'turnStarted', playerId: host.id, turnSeq: 1, deadlineMs: h.clock.now() + DEFAULT_TURN_TIMEOUT_SEC * 1000 };
    for (const c of [host.c, p2.c, spec!.c]) expect(h.lastEvent(c, 'turnStarted')).toEqual(turn);
    expect(h.room(code).state.turn).toEqual({ ...turn, type: undefined, shotInFlight: false });
    const snap = h.joined(late.c).state;
    expect(snap.phase).toBe('countdown'); // joined mid-countdown: the snapshot is from then, the events followed
    expect(h.eventTypes(late.c)).toEqual(['gameStarted', 'holeStarted', 'turnStarted']);
  });
});

describe('shooting', () => {
  it('authority errors: NOT_YOUR_TURN, STALE_TURN (turnSeq and holeIndex), SHOT_IN_FLIGHT, INVALID_SHOT', () => {
    const h = harness({ permissiveShots: true });
    const { host, p2, code } = h.twoPlayers();
    h.begin(host.c, p2.c);
    h.clearAll(host.c, p2.c);

    p2.c.receive({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: SHORT_SHOT });
    host.c.receive({ t: 'shoot', holeIndex: 0, turnSeq: 2, shot: SHORT_SHOT });
    host.c.receive({ t: 'shoot', holeIndex: 1, turnSeq: 1, shot: SHORT_SHOT });
    host.c.receive({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: { dx: 99_999, dy: 0 } }); // over MAX_PULL_PX
    host.c.receive({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: { dx: 1.5, dy: 0 } });    // not an integer
    expect(h.errors(p2.c)).toEqual(['NOT_YOUR_TURN']);
    expect(h.errors(host.c)).toEqual(['STALE_TURN', 'STALE_TURN', 'INVALID_SHOT', 'INVALID_SHOT']);
    expect(h.events(host.c)).toHaveLength(0);

    host.c.receive({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: SHORT_SHOT });
    expect(h.eventTypes(host.c)).toEqual(['shotTaken']);
    host.c.receive({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: SHORT_SHOT });
    expect(h.errors(host.c).at(-1)).toBe('SHOT_IN_FLIGHT');
    p2.c.receive({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: SHORT_SHOT });
    expect(h.errors(p2.c).at(-1)).toBe('NOT_YOUR_TURN');
    expect(h.room(code).state.turn?.shotInFlight).toBe(true);
  });

  it('shotTaken is broadcast to every member in the same order and the next turn starts after the pacing timer', () => {
    const h = harness();
    const { host, p2, spec, code } = h.twoPlayers(undefined, true);
    h.begin(host.c, p2.c);
    h.clearAll(host.c, p2.c, spec!.c);

    const t0 = h.clock.now();
    h.shoot(host.c, code, SHORT_SHOT);
    const shot = h.lastEvent(spec!.c, 'shotTaken')!;
    expect(shot).toMatchObject({ playerId: host.id, turnSeq: 1, shot: SHORT_SHOT, atMs: t0 });
    expect(shot.outcome.result).toBe('stopped');
    // the server simulated exactly what any client re-simulates from the same inputs (D1 determinism)
    const local = simulateShot(decodeLayers(b01), createWorldFromCourse(b01), createBallAt(startCentre(b01)), SHORT_SHOT, []);
    expect(shot.outcome.checksum).toBe(local.checksum);
    expect(shot.outcome.ticks).toBe(local.ticks);
    expect(shot.outcome.ball).toEqual(local.ball);
    for (const c of [host.c, p2.c, spec!.c]) expect(c.sent).toEqual(spec!.c.sent);

    const wait = h.pacingMs(shot.outcome.ticks);
    h.clock.advance(wait - 1);
    expect(h.eventTypes(spec!.c)).toEqual(['shotTaken']);
    h.clock.advance(1);
    expect(h.eventTypes(spec!.c)).toEqual(['shotTaken', 'turnStarted']);
    expect(h.lastEvent(spec!.c, 'turnStarted')).toEqual({ type: 'turnStarted', playerId: p2.id, turnSeq: 2, deadlineMs: h.clock.now() + DEFAULT_TURN_TIMEOUT_SEC * 1000 });
    const s = h.room(code).state;
    expect(s.balls[host.id]).toEqual(local.ball);
    expect(s.strokes[host.id]?.[0]).toBe(1);
    expect(s.turn).toMatchObject({ playerId: p2.id, turnSeq: 2, shotInFlight: false });
  });

  it('two players hole out b_01 with the real sim: holeEnded, summaries by ready, roundEnded ranking, host backToLobby', () => {
    const h = harness();
    const { host, p2, spec, code } = h.twoPlayers(undefined, true);
    h.begin(host.c, p2.c);
    h.clearAll(host.c, p2.c, spec!.c);

    h.shoot(host.c, code, HOLING_SHOT);
    const first = h.lastEvent(spec!.c, 'shotTaken')!;
    expect(first.outcome.result).toBe('holed');
    expect(first.outcome.holeIndex).toBe(0);
    expect(spec!.c.sentOf('chat').at(-1)).toMatchObject({ from: null, key: 'chat.holeResult', params: { name: 'Host', strokes: 1 } });
    h.clock.advance(h.pacingMs(first.outcome.ticks));
    expect(h.lastEvent(spec!.c, 'turnStarted')).toMatchObject({ playerId: p2.id, turnSeq: 2 });
    h.clearAll(host.c, p2.c, spec!.c);

    h.shoot(p2.c, code, HOLING_SHOT);
    const second = h.lastEvent(spec!.c, 'shotTaken')!;
    expect(second.outcome.result).toBe('holed');
    expect(second.outcome.checksum).toBe(first.outcome.checksum); // same course, same shot, same resting state
    h.clock.advance(h.pacingMs(second.outcome.ticks));
    expect(h.eventTypes(spec!.c)).toEqual(['shotTaken', 'holeEnded']);
    expect(h.room(code).phase).toBe('holeSummary');
    expect(h.room(code).state.holeDone).toEqual({ [host.id]: true, [p2.id]: true });

    spec!.c.receive({ t: 'summaryReady' }); // spectators are not asked
    expect(h.errors(spec!.c)).toEqual(['NOT_A_PLAYER']);
    host.c.receive({ t: 'summaryReady' });
    expect(h.room(code).phase).toBe('holeSummary');
    p2.c.receive({ t: 'summaryReady' });
    expect(h.room(code).phase).toBe('roundSummary');
    const ended = h.lastEvent(spec!.c, 'roundEnded')!;
    expect(ended.ranking).toEqual([
      { playerId: host.id, total: 1, rank: 1 },
      { playerId: p2.id, total: 1, rank: 1 },
    ]);
    expect(h.eventTypes(spec!.c)).toEqual(['shotTaken', 'holeEnded', 'summaryReady', 'summaryReady', 'roundEnded']);

    p2.c.receive({ t: 'backToLobby' });
    expect(h.errors(p2.c)).toEqual(['NOT_HOST']);
    host.c.receive({ t: 'backToLobby' });
    expect(h.lastEvent(spec!.c, 'backToLobby')).toEqual({ type: 'backToLobby' });
    const lobby = h.room(code).state;
    expect(lobby.phase).toBe('lobby');
    expect(lobby.players.map((p) => p.ready)).toEqual([false, false]);
    expect(lobby.strokes).toEqual({ [host.id]: [], [p2.id]: [] });
    expect(lobby.courses.map((c) => c.id)).toEqual(['b_01']);
    expect(h.clock.pendingTimers()).toBe(0); // nothing left running after the round
  });

  it('turn timeout adds a stroke and passes the turn; two in a row make the player afk (5 s deadlines) until any message', () => {
    const h = harness();
    const { host, p2, code } = h.twoPlayers({ turnTimeoutSec: 30 });
    h.begin(host.c, p2.c);
    h.clearAll(host.c, p2.c);

    h.clock.advance(30_000);
    expect(h.eventTypes(p2.c)).toEqual(['turnTimedOut', 'turnStarted']);
    expect(h.lastEvent(p2.c, 'turnTimedOut')).toEqual({ type: 'turnTimedOut', playerId: host.id, turnSeq: 1 });
    expect(p2.c.sentOf('chat').map((m) => m.key)).toEqual(['chat.timeout']);
    expect(h.room(code).state.strokes[host.id]?.[0]).toBe(1);
    expect(h.lastEvent(p2.c, 'turnStarted')).toMatchObject({ playerId: p2.id, turnSeq: 2, deadlineMs: h.clock.now() + 30_000 });

    h.clock.advance(30_000); // p2 times out -> host turn 3
    h.clock.advance(30_000); // host times out again -> afk
    const hostState = h.room(code).state.players.find((p) => p.id === host.id)!;
    expect(hostState.afk).toBe(true);
    expect(hostState.consecutiveTimeouts).toBe(2);
    expect(p2.c.sentOf('chat').map((m) => m.key)).toEqual(['chat.timeout', 'chat.timeout', 'chat.timeout', 'chat.afk']);
    expect(p2.c.sentOf('chat').at(-1)?.params).toEqual({ name: 'Host' });
    h.clock.advance(30_000); // p2 times out -> host turn 5 with the afk deadline
    expect(h.lastEvent(p2.c, 'turnStarted')).toEqual({ type: 'turnStarted', playerId: host.id, turnSeq: 5, deadlineMs: h.clock.now() + AFK_TURN_TIMEOUT_SEC * 1000 });
    h.clearAll(host.c, p2.c);
    host.c.receive({ t: 'chat', text: 'tässä ollaan' });
    expect(h.events(p2.c)).toEqual([{ type: 'playerAfk', playerId: host.id, afk: false }]);
    expect(h.room(code).state.players.find((p) => p.id === host.id)?.afk).toBe(false);
  });
});

describe('disconnects, rejoin and removal during a round', () => {
  it('a disconnected player\'s turn waits DISCONNECTED_TURN_WAIT_SEC and is skipped without a stroke', () => {
    const h = harness();
    const { host, p2, code } = h.twoPlayers();
    h.begin(host.c, p2.c);
    h.clearAll(host.c);
    p2.c.disconnect();
    expect(h.events(host.c)).toEqual([{ type: 'playerConnection', playerId: p2.id, connected: false }]);
    h.shoot(host.c, code, SHORT_SHOT);
    h.clock.advance(h.pacingMs(h.lastEvent(host.c, 'shotTaken')!.outcome.ticks));
    expect(h.lastEvent(host.c, 'turnStarted')).toEqual({ type: 'turnStarted', playerId: p2.id, turnSeq: 2, deadlineMs: h.clock.now() + DISCONNECTED_TURN_WAIT_SEC * 1000 });
    const before = h.room(code).state.strokes[p2.id]?.[0];
    h.clock.advance(DISCONNECTED_TURN_WAIT_SEC * 1000);
    expect(h.lastEvent(host.c, 'turnSkipped')).toEqual({ type: 'turnSkipped', playerId: p2.id, turnSeq: 2 });
    expect(h.room(code).state.strokes[p2.id]?.[0]).toBe(before);
    expect(h.lastEvent(host.c, 'turnStarted')).toMatchObject({ playerId: host.id, turnSeq: 3 });
  });

  it('rejoin with a valid token on turn: snapshot, playerConnection, fresh normal turn, chat backlog; invalid token: SESSION_EXPIRED', () => {
    const h = harness();
    const { host, p2, code } = h.twoPlayers();
    h.begin(host.c, p2.c);
    h.shoot(host.c, code, SHORT_SHOT);
    h.clock.advance(h.pacingMs(h.lastEvent(host.c, 'shotTaken')!.outcome.ticks));
    expect(h.room(code).state.turn?.playerId).toBe(p2.id);
    h.clearAll(host.c);

    p2.c.disconnect(); // on turn with the normal 45 s deadline -> shortened to the disconnected wait with a fresh turn
    expect(h.eventTypes(host.c)).toEqual(['playerConnection', 'turnStarted']);
    expect(h.lastEvent(host.c, 'turnStarted')).toEqual({ type: 'turnStarted', playerId: p2.id, turnSeq: 3, deadlineMs: h.clock.now() + DISCONNECTED_TURN_WAIT_SEC * 1000 });
    expect(h.room(code).hostId).toBe(host.id);
    h.clock.advance(4000);
    h.clearAll(host.c);

    const bad = h.client();
    bad.receive({ t: 'rejoin', code, sessionToken: 'f'.repeat(32) });
    expect(h.errors(bad)).toEqual(['SESSION_EXPIRED']);

    const back = h.client();
    back.receive({ t: 'rejoin', code, sessionToken: p2.token });
    const j = h.joined(back);
    expect(j.playerId).toBe(p2.id);
    expect(j.role).toBe('player');
    expect(j.state.players.find((p) => p.id === p2.id)?.connected).toBe(true);
    expect(j.state.phase).toBe('hole');
    expect(j.state.balls[host.id]).toBeDefined();
    const fresh = { type: 'turnStarted', playerId: p2.id, turnSeq: 4, deadlineMs: h.clock.now() + DEFAULT_TURN_TIMEOUT_SEC * 1000 };
    expect(j.state.turn).toEqual({ playerId: p2.id, turnSeq: 4, deadlineMs: fresh.deadlineMs, shotInFlight: false });
    expect(h.types(back).slice(0, 3)).toEqual(['roomJoined', 'event:playerConnection', 'event:turnStarted']);
    expect(h.lastEvent(back, 'turnStarted')).toEqual(fresh);
    expect(back.sent.slice(3).every((m) => m.t === 'chat')).toBe(true);
    expect(back.sent.slice(3).map((m) => (m.t === 'chat' ? m.key : ''))).toEqual(['chat.playerJoined', 'chat.playerJoined', 'chat.gameStarted']);
    expect(h.events(host.c)).toEqual([{ type: 'playerConnection', playerId: p2.id, connected: true }, fresh]);

    back.receive({ t: 'shoot', holeIndex: 0, turnSeq: 3, shot: SHORT_SHOT });
    expect(h.errors(back)).toEqual(['STALE_TURN']);
    back.receive({ t: 'shoot', holeIndex: 0, turnSeq: 4, shot: SHORT_SHOT });
    expect(h.lastEvent(host.c, 'shotTaken')).toMatchObject({ playerId: p2.id, turnSeq: 4 });
    // the grace timer was cancelled: nothing removes the player later
    h.clock.advance(DISCONNECT_GRACE_SEC * 1000);
    expect(h.room(code).players()).toHaveLength(2);
  });

  it('grace removal: after DISCONNECT_GRACE_SEC the player leaves the round, the token expires and the other plays on alone', () => {
    const h = harness();
    const { host, p2, code } = h.twoPlayers();
    h.begin(host.c, p2.c);
    h.clearAll(host.c);
    p2.c.disconnect();
    h.clock.advance(DISCONNECT_GRACE_SEC * 1000 - 1);
    expect(h.room(code).players()).toHaveLength(2);
    h.clock.advance(1);
    expect(h.lastEvent(host.c, 'playerLeft')).toEqual({ type: 'playerLeft', playerId: p2.id });
    expect(host.c.sentOf('chat').at(-1)).toMatchObject({ key: 'chat.playerLeft', params: { name: 'P2' } });
    expect(h.room(code).players().map((m) => m.id)).toEqual([host.id]);
    const s = h.room(code).state;
    expect(s.phase).toBe('hole');
    expect(s.players.find((p) => p.id === p2.id)).toMatchObject({ leftRound: true, connected: false });
    expect(s.turn?.playerId).toBe(host.id);
    expect(h.rooms.stats()).toEqual({ rooms: 1, players: 1, spectators: 0 });

    const back = h.client();
    back.receive({ t: 'rejoin', code, sessionToken: p2.token });
    expect(h.errors(back)).toEqual(['SESSION_EXPIRED']);
    const asSpectator = h.join(code, 'P2', 1);
    expect(asSpectator.role).toBe('spectator');

    h.shoot(host.c, code, HOLING_SHOT);
    h.clock.advance(h.pacingMs(h.lastEvent(host.c, 'shotTaken')!.outcome.ticks));
    expect(h.room(code).phase).toBe('holeSummary'); // the lone player finished the hole
    expect(h.eventTypes(host.c)).not.toContain('roundEnded');
  });

  it('host disconnect keeps the host role during grace; removal migrates the host to the connected player with the lowest joinedSeq', () => {
    const h = harness();
    const host = h.createRoom('Host', 0);
    const p2 = h.join(host.code, 'P2', 1);
    const p3 = h.join(host.code, 'P3', 2);
    host.c.receive({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_01' }] });
    h.begin(host.c, p2.c, p3.c);
    h.clearAll(p2.c, p3.c);
    host.c.disconnect();
    expect(h.room(host.code).hostId).toBe(host.id);
    expect(h.lastEvent(p3.c, 'turnStarted')).toMatchObject({ playerId: host.id, turnSeq: 2, deadlineMs: h.clock.now() + DISCONNECTED_TURN_WAIT_SEC * 1000 });
    h.clock.advance(DISCONNECTED_TURN_WAIT_SEC * 1000);
    expect(h.lastEvent(p3.c, 'turnSkipped')).toMatchObject({ playerId: host.id });
    expect(h.lastEvent(p3.c, 'turnStarted')).toMatchObject({ playerId: p2.id });
    h.clearAll(p2.c, p3.c);
    h.clock.advance(DISCONNECT_GRACE_SEC * 1000 - DISCONNECTED_TURN_WAIT_SEC * 1000);
    const seq = h.eventTypes(p3.c);
    const leftAt = seq.indexOf('playerLeft');
    expect(leftAt).toBeGreaterThanOrEqual(0);
    expect(seq[leftAt + 1]).toBe('hostChanged'); // migration follows the removal immediately
    expect(h.lastEvent(p3.c, 'hostChanged')).toEqual({ type: 'hostChanged', hostId: p2.id });
    expect(p3.c.sentOf('chat').filter((m) => m.key !== 'chat.timeout').map((m) => [m.key, m.params?.name])).toEqual([['chat.playerLeft', 'Host'], ['chat.hostChanged', 'P2']]);
    expect(h.room(host.code).hostId).toBe(p2.id);
    expect(h.types(p2.c)).toEqual(h.types(p3.c));
  });

  it('leaving on turn advances the turn at once; when the last active player leaves the round ends and the room returns to the lobby', () => {
    const h = harness();
    const { host, p2, spec, code } = h.twoPlayers(undefined, true);
    h.begin(host.c, p2.c);
    h.clearAll(host.c, p2.c, spec!.c);

    host.c.receive({ t: 'leaveRoom' }); // on turn
    expect(host.c.sent).toEqual([{ t: 'roomLeft', reason: 'left' }]);
    expect(h.eventTypes(spec!.c)).toEqual(['playerLeft', 'hostChanged', 'turnStarted']);
    expect(h.lastEvent(spec!.c, 'turnStarted')).toMatchObject({ playerId: p2.id, turnSeq: 2 });
    expect(h.room(code).hostId).toBe(p2.id);
    h.clearAll(p2.c, spec!.c);

    p2.c.receive({ t: 'leaveRoom' });
    expect(p2.c.sent).toEqual([{ t: 'roomLeft', reason: 'left' }]);
    expect(h.eventTypes(spec!.c)).toEqual(['playerLeft', 'roundEnded', 'backToLobby']);
    expect(h.lastEvent(spec!.c, 'roundEnded')?.ranking).toEqual([
      { playerId: host.id, total: 0, rank: 1 },
      { playerId: p2.id, total: 0, rank: 1 },
    ]); // the leavers, all rank 1 (§10.5)
    expect(h.room(code).state).toMatchObject({ phase: 'lobby', players: [], hostId: p2.id }); // stale hostId: the next joiner takes it
    expect(h.rooms.stats()).toEqual({ rooms: 1, players: 0, spectators: 1 });
    expect(h.clock.pendingTimers()).toBe(0);

    spec!.c.receive({ t: 'becomePlayer' });
    expect(h.room(code).state.hostId).toBe(spec!.id);
    expect(h.room(code).players()).toHaveLength(1);
  });
});

describe('course selection', () => {
  it('setCourses: NOT_HOST, unknown built-in and invalid custom -> INVALID_COURSE with issues; valid custom re-broadcast with full data and a server id', () => {
    const h = harness();
    const { host, p2, spec, code } = h.twoPlayers(undefined, true);
    h.clearAll(host.c, p2.c, spec!.c);

    p2.c.receive({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_02' }] });
    expect(h.errors(p2.c)).toEqual(['NOT_HOST']);
    host.c.receive({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_77' }] });
    expect(host.c.sentOf('error').at(-1)).toMatchObject({ code: 'INVALID_COURSE', message: expect.stringContaining('b_77') });

    const noHole: Course = { ...b01, id: '', name: 'Reiätön', objects: b01.objects.filter((o) => o.type !== 'hole') };
    host.c.receive({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_01' }, { kind: 'custom', course: noHole }] });
    const err = host.c.sentOf('error').at(-1)!;
    expect(err.code).toBe('INVALID_COURSE');
    expect(err.issues?.map((i) => i.code)).toContain('NO_HOLE');
    expect(h.events(spec!.c)).toHaveLength(0);
    expect(h.room(code).state.courses.map((c) => c.id)).toEqual(['b_01']);

    const custom: Course = { ...b01, id: 'b_01', name: 'Oma kopio', author: 'Minä' }; // claims a reserved id (R13)
    host.c.receive({ t: 'setCourses', courses: [{ kind: 'custom', course: custom }, { kind: 'builtin', id: 'b_02' }] });
    const changed = h.lastEvent(spec!.c, 'coursesChanged')!;
    expect(changed.courses).toHaveLength(2);
    expect(changed.courses[0]!.id).toMatch(/^c_[0-9a-f]{16}$/);
    expect(changed.courses[0]).toMatchObject({ name: 'Oma kopio', author: 'Minä', surface: b01.surface, walls: b01.walls, objects: b01.objects });
    expect(changed.courses[1]!.id).toBe('b_02');
    for (const c of [host.c, p2.c]) expect(h.lastEvent(c, 'coursesChanged')).toEqual(changed);

    const late = h.join(code, 'Uusi', 3, true);
    expect(h.joined(late.c).state.courses).toEqual(changed.courses); // byte-identical data for late joiners

    h.begin(host.c, p2.c);
    host.c.receive({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_01' }] });
    expect(h.errors(host.c).at(-1)).toBe('NOT_IN_LOBBY');
    h.clearAll(host.c);
    h.shoot(host.c, code, HOLING_SHOT); // the custom course is simulated with its own decoded layers
    expect(h.lastEvent(host.c, 'shotTaken')?.outcome.result).toBe('holed');
    expect(h.rooms.courseStore.cachedLayerCount()).toBe(1);
  });
});

describe('becomePlayer', () => {
  it('a spectator takes a free seat in the lobby (unique name, events to all), players get ALREADY_IN_ROOM, full lobby ROOM_FULL, round NOT_IN_LOBBY', () => {
    const h = harness();
    const host = h.createRoom('Host', 0, { maxPlayers: 2 });
    const spec = h.join(host.code, 'host', 3, true);
    const spec2 = h.join(host.code, 'Toinen', 1, true);
    h.clearAll(host.c, spec.c, spec2.c);

    host.c.receive({ t: 'becomePlayer' });
    expect(h.errors(host.c)).toEqual(['ALREADY_IN_ROOM']);
    host.c.clearSent();

    spec.c.receive({ t: 'becomePlayer' });
    expect(h.errors(spec.c)).toEqual([]);
    expect(h.eventTypes(spec.c)).toEqual(['spectatorLeft', 'playerJoined']);
    expect(h.lastEvent(host.c, 'playerJoined')?.player).toMatchObject({ id: spec.id, name: 'host2', colour: 3, joinedSeq: 2 });
    expect(spec.c.sentOf('chat').at(-1)).toMatchObject({ key: 'chat.playerJoined', params: { name: 'host2' } });
    expect(h.types(host.c)).toEqual(h.types(spec2.c));
    expect(h.gateway.sessionOf(spec.c)?.role).toBe('player');
    expect(h.rooms.stats()).toEqual({ rooms: 1, players: 2, spectators: 1 });
    spec.c.receive({ t: 'setReady', ready: true });
    expect(h.lastEvent(host.c, 'readyChanged')).toEqual({ type: 'readyChanged', playerId: spec.id, ready: true });
    spec.c.receive({ t: 'chat', text: 'moi' });
    expect(host.c.sentOf('chat').at(-1)).toMatchObject({ from: { id: spec.id, name: 'host2', colour: 3 }, text: 'moi' });

    spec2.c.receive({ t: 'becomePlayer' });
    expect(h.errors(spec2.c)).toEqual(['ROOM_FULL']);
    host.c.receive({ t: 'startGame' });
    h.clock.advance(COUNTDOWN_SEC * 1000);
    spec2.c.receive({ t: 'becomePlayer' });
    expect(h.errors(spec2.c)).toEqual(['ROOM_FULL', 'NOT_IN_LOBBY']);
  });
});

describe('abuse limits and sweep', () => {
  it('rate limiting: RATE_LIMITED past the burst, close 1008 after three strikes, then the room sees a disconnect', () => {
    const h = harness();
    const { host, p2 } = h.twoPlayers();
    h.clearAll(host.c, p2.c);
    h.clock.advance(1000); // hello + joinRoom cost tokens; let the bucket refill to RATE_BURST
    for (let i = 0; i < RATE_BURST + 3; i++) {
      if (p2.c.closed) break;
      p2.c.receive({ t: 'setReady', ready: i % 2 === 0 });
    }
    expect(h.errors(p2.c)).toEqual(['RATE_LIMITED', 'RATE_LIMITED', 'RATE_LIMITED']);
    expect(p2.c.closed?.code).toBe(CLOSE_POLICY);
    expect(h.events(host.c).filter((e) => e.type === 'readyChanged')).toHaveLength(RATE_BURST);
    expect(h.lastEvent(host.c, 'playerConnection')).toEqual({ type: 'playerConnection', playerId: p2.id, connected: false });
  });

  it('sweep removes a room whose players all dropped mid-round once the empty TTL passes and disposes the Authority timers', () => {
    const h = harness({ roomEmptyTtlSec: 30 });
    const { host, p2, code } = h.twoPlayers();
    h.begin(host.c, p2.c);
    host.c.disconnect();
    p2.c.disconnect();
    const room = h.room(code);
    expect(room.emptySince).toBe(h.clock.now());
    expect(h.clock.pendingTimers()).toBeGreaterThan(0);
    h.clock.advance(29_000);
    h.rooms.sweep();
    expect(h.rooms.get(code)).toBe(room);
    h.clock.advance(1000);
    h.rooms.sweep();
    expect(h.rooms.get(code)).toBeNull();
    expect(room.isClosed).toBe(true);
    expect(h.clock.pendingTimers()).toBe(0);
    h.clock.advance(DISCONNECT_GRACE_SEC * 1000); // nothing fires on the disposed Authority
    expect(room.state.phase).toBe('hole');
    const back = h.client();
    back.receive({ t: 'rejoin', code, sessionToken: host.token });
    expect(h.errors(back)).toEqual(['SESSION_EXPIRED']);
  });
});

describe('chat backlog on initial join (§6.4)', () => {
  it('a late spectator receives the lobby chat lines in order followed by its own spectatorJoined line; a joining player likewise', () => {
    const h = harness();
    const host = h.createRoom('Host');
    const p2 = h.join(host.code, 'P2', 1);
    host.c.receive({ t: 'chat', text: 'moi kaikki' });
    p2.c.receive({ t: 'chat', text: 'terve' });
    const before = [...h.room(host.code).chatBacklog()];
    expect(before.map((l) => l.key ?? l.text)).toEqual(['chat.playerJoined', 'chat.playerJoined', 'moi kaikki', 'terve']);
    h.clearAll(host.c, p2.c);

    const spec = h.join(host.code, 'Katsoja', 2, true);
    expect(spec.role).toBe('spectator');
    expect(h.types(spec.c)).toEqual(['roomJoined', 'chat:chat.playerJoined', 'chat:chat.playerJoined', 'chat:text', 'chat:text', 'chat:chat.spectatorJoined']);
    expect(spec.c.sentOf('chat').slice(0, before.length)).toEqual(before);
    expect(spec.c.sentOf('chat').at(-1)).toMatchObject({ from: null, key: 'chat.spectatorJoined', params: { name: 'Katsoja' } });

    const p3 = h.join(host.code, 'P3', 3);
    expect(p3.role).toBe('player');
    expect(h.types(p3.c)).toEqual(['roomJoined', ...before.map((l) => 'chat:' + (l.key ?? 'text')), 'chat:chat.spectatorJoined', 'chat:chat.playerJoined']);
    expect(p3.c.sentOf('chat').at(-1)).toMatchObject({ key: 'chat.playerJoined', params: { name: 'P3' } });
    // members already present only see the new join lines, never a replay
    expect(host.c.sentOf('chat').map((m) => m.key)).toEqual(['chat.spectatorJoined', 'chat.playerJoined']);
    expect(p2.c.sentOf('chat').map((m) => m.key)).toEqual(['chat.spectatorJoined', 'chat.playerJoined']);
  });

  it('the backlog is capped at CHAT_BACKLOG lines and a mid-round joiner (turned spectator) gets exactly the most recent ones', () => {
    const h = harness();
    const { host, p2, code } = h.twoPlayers();
    for (let batch = 0; batch < 6; batch++) {
      for (let i = 0; i < CHAT_MSGS_PER_10S; i++) {
        host.c.receive({ t: 'chat', text: `h${batch}-${i}` });
        p2.c.receive({ t: 'chat', text: `p${batch}-${i}` });
      }
      h.clock.advance(10_000); // stay under the chat throttle
    }
    expect(h.errors(host.c)).toEqual([]);
    expect(h.errors(p2.c)).toEqual([]);
    expect(h.room(code).chatBacklog()).toHaveLength(CHAT_BACKLOG);
    h.begin(host.c, p2.c);
    const before = [...h.room(code).chatBacklog()];
    expect(before).toHaveLength(CHAT_BACKLOG);
    expect(before[0]?.text).toBeDefined(); // the two join lines were pushed out
    expect(before.at(-1)?.key).toBe('chat.gameStarted');

    const late = h.join(code, 'Myohassa', 3);
    expect(late.role).toBe('spectator');
    const lines = late.c.sentOf('chat');
    expect(lines).toHaveLength(CHAT_BACKLOG + 1);
    expect(lines.slice(0, CHAT_BACKLOG)).toEqual(before);
    expect(lines.at(-1)).toMatchObject({ key: 'chat.spectatorJoined', params: { name: 'Myohassa' } });
    expect(h.types(late.c)[0]).toBe('roomJoined');
  });
});

describe('authority timer failure isolation', () => {
  it('an exception inside a timer-driven path is logged and closes only that room (roomLeft{roomClosed}); other rooms keep running', () => {
    const logged: { level: string; msg: string }[] = [];
    const log: Logger = {
      ...nullLogger,
      warn: (msg) => logged.push({ level: 'warn', msg }),
      error: (msg) => logged.push({ level: 'error', msg }),
    };
    const h = harness({ log });
    const a = h.twoPlayers();
    const b = h.twoPlayers();
    for (const r of [a, b]) {
      r.p2.c.receive({ t: 'setReady', ready: true });
      r.host.c.receive({ t: 'startGame' });
      expect(h.room(r.code).phase).toBe('countdown');
    }
    const roomA = h.room(a.code);
    h.clearAll(a.host.c, a.p2.c, b.host.c, b.p2.c);
    // Room A: a member whose transport throws on send makes the countdown-end broadcast throw inside the timer.
    a.p2.c.send = () => {
      throw new Error('socket exploded');
    };

    expect(() => h.clock.advance(COUNTDOWN_SEC * 1000)).not.toThrow();
    expect(logged).toEqual([
      { level: 'error', msg: 'authority timer failed; closing room' },
      { level: 'warn', msg: 'roomLeft not delivered' },
    ]);
    expect(roomA.isClosed).toBe(true);
    expect(roomA.members.size).toBe(0);
    expect(h.rooms.get(a.code)).toBeNull();
    expect(a.host.c.sentOf('roomLeft')).toEqual([{ t: 'roomLeft', reason: 'roomClosed' }]);
    expect(a.host.c.last()).toEqual({ t: 'roomLeft', reason: 'roomClosed' });
    a.host.c.receive({ t: 'setReady', ready: true });
    expect(h.errors(a.host.c)).toEqual(['NOT_IN_ROOM']);
    const back = h.client();
    back.receive({ t: 'rejoin', code: a.code, sessionToken: a.host.token });
    expect(h.errors(back)).toEqual(['SESSION_EXPIRED']);

    // Room B went through the same clock tick untouched and keeps advancing on its own timers.
    expect(h.room(b.code).phase).toBe('hole');
    expect(h.eventTypes(b.host.c)).toEqual(['gameStarted', 'holeStarted']);
    h.clock.advance(HOLE_INTRO_MS);
    expect(h.lastEvent(b.p2.c, 'turnStarted')).toMatchObject({ playerId: b.host.id, turnSeq: 1 });
    h.shoot(b.host.c, b.code, SHORT_SHOT);
    expect(h.lastEvent(b.p2.c, 'shotTaken')).toMatchObject({ playerId: b.host.id, turnSeq: 1 });
    expect(h.rooms.stats()).toEqual({ rooms: 1, players: 2, spectators: 0 });
    expect(b.host.c.sentOf('roomLeft')).toEqual([]);
  });
});
