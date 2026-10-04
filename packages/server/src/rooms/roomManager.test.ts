// Room lifecycle through the real Gateway + ClientSession over FakeTransport with a FakeClock (DESIGN §16.4).
import { describe, expect, it } from 'vitest';
import { LOBBY_DISCONNECT_REMOVE_SEC, MAX_SPECTATORS, SIM_VERSION } from '@puttipeli/shared/constants';
import { PROTOCOL_VERSION } from '@puttipeli/shared/protocol/version';
import type { GameEvent } from '@puttipeli/shared/game/events';
import type { ServerMessage } from '@puttipeli/shared/protocol/messages';
import { nullLogger } from '../log';
import { CLOSE_REPLACED } from '../ws/connection';
import { FakeClock, FakeConnection, FakeTransport } from '../ws/fakeTransport';
import { Gateway } from '../ws/gateway';
import { CHAT_BACKLOG } from './room';
import { RoomManager, SWEEP_INTERVAL_MS } from './roomManager';

const HELLO = { t: 'hello', protocolVersion: PROTOCOL_VERSION, simVersion: SIM_VERSION, clientBuild: 'test' };

function harness(opts: { maxRooms?: number; roomIdleTtlMin?: number; roomEmptyTtlSec?: number; codes?: string[] } = {}) {
  const clock = new FakeClock();
  const codes = opts.codes ? [...opts.codes] : null;
  const codeGen = codes ? () => codes.shift() ?? 'ZZZZZ' : undefined;
  const rooms = new RoomManager(clock, { maxRooms: opts.maxRooms ?? 200, roomIdleTtlMin: opts.roomIdleTtlMin ?? 90, roomEmptyTtlSec: opts.roomEmptyTtlSec ?? 120 }, nullLogger, codeGen);
  const gateway = new Gateway({ rooms, clock, log: nullLogger, build: 'b' });
  const transport = new FakeTransport();
  transport.start(gateway);

  const client = (): FakeConnection => {
    const c = transport.connect();
    c.receive(HELLO);
    c.clearSent();
    return c;
  };
  const events = (c: FakeConnection): GameEvent[] => c.sentOf('event').map((m) => m.ev);
  const types = (c: FakeConnection): string[] => c.sent.map((m) => (m.t === 'event' ? `event:${m.ev.type}` : m.t));
  // roomJoined is memoized per connection so tests may clearSent() and still read the join data.
  const joinedMemo = new WeakMap<FakeConnection, Extract<ServerMessage, { t: 'roomJoined' }>>();
  const joined = (c: FakeConnection) => {
    const memo = joinedMemo.get(c);
    if (memo) return memo;
    const m = c.sentOf('roomJoined')[0];
    if (!m) throw new Error('no roomJoined in ' + JSON.stringify(c.sent));
    joinedMemo.set(c, m);
    return m;
  };
  const remember = (c: FakeConnection): FakeConnection => {
    if (c.sentOf('roomJoined').length > 0) joined(c);
    return c;
  };
  /** Host creates a room, returns the host connection and the code. */
  const createRoom = (name = 'Host', colour: 0 | 1 | 2 | 3 = 0, settings?: object) => {
    const c = client();
    c.receive({ t: 'createRoom', name, colour, ...(settings ? { settings } : {}) });
    remember(c);
    return { c, code: joined(c).code, playerId: joined(c).playerId, token: joined(c).sessionToken };
  };
  const join = (code: string, name: string, colour: 0 | 1 | 2 | 3 = 1, asSpectator?: boolean) => {
    const c = client();
    c.receive({ t: 'joinRoom', code, name, colour, ...(asSpectator !== undefined ? { asSpectator } : {}) });
    return remember(c);
  };
  return { clock, rooms, gateway, transport, client, createRoom, join, joined, events, types };
}

describe('create and join', () => {
  it('createRoom answers roomJoined as player/host with a token and a lobby snapshot', () => {
    const h = harness();
    const { c, code } = h.createRoom('Matti', 2);
    const j = h.joined(c);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
    expect(j.role).toBe('player');
    expect(j.sessionToken).toMatch(/^[0-9a-f]{32}$/);
    expect(j.state.phase).toBe('lobby');
    expect(j.state.hostId).toBe(j.playerId);
    expect(j.state.players).toHaveLength(1);
    expect(j.state.players[0]).toMatchObject({ id: j.playerId, name: 'Matti', colour: 2, ready: false, connected: true, joinedSeq: 1 });
    expect(j.state.settings).toEqual({ maxPlayers: 4, turnTimeoutSec: 45, holeSummarySec: 6, ballCollision: false });
    expect(h.rooms.stats()).toEqual({ rooms: 1, players: 1, spectators: 0 });
    // the host also sees the system chat line for the join
    expect(c.sentOf('chat')[0]).toMatchObject({ from: null, key: 'chat.playerJoined', params: { name: 'Matti' } });
  });

  it('applies and clamps settings on create', () => {
    const h = harness();
    const { c } = h.createRoom('Host', 0, { maxPlayers: 2, turnTimeoutSec: 0, holeSummarySec: 0 });
    expect(h.joined(c).state.settings).toEqual({ maxPlayers: 2, turnTimeoutSec: 0, holeSummarySec: 0, ballCollision: false });
  });

  it('joinRoom: existing members see playerJoined first, the joiner gets roomJoined with everyone; colour conflict resolved', () => {
    const h = harness();
    const host = h.createRoom('Host', 0);
    host.c.clearSent();
    const p2 = h.join(host.code, 'Liisa', 0); // colour 0 taken -> lowest free = 1
    const j = h.joined(p2);
    expect(j.role).toBe('player');
    expect(j.state.players.map((p) => p.name)).toEqual(['Host', 'Liisa']);
    expect(j.state.players[1]?.colour).toBe(1);
    expect(j.state.hostId).toBe(host.playerId);
    expect(h.types(host.c)).toEqual(['event:playerJoined', 'chat']);
    expect(h.events(host.c)[0]).toMatchObject({ type: 'playerJoined', player: { name: 'Liisa', colour: 1, joinedSeq: 2 } });
    expect(p2.sentOf('event')).toHaveLength(0); // the joiner is not sent their own playerJoined (it is in the snapshot)
  });

  it('normalizes the code and rejects unknown or malformed codes with ROOM_NOT_FOUND', () => {
    const h = harness({ codes: ['K7PQ2'] });
    h.createRoom();
    const ok = h.join(' k7-pq2 ', 'Liisa');
    expect(ok.sentOf('roomJoined')).toHaveLength(1);
    const bad = h.join('K7PQ0', 'Liisa');
    expect(bad.sentOf('error')[0]?.code).toBe('ROOM_NOT_FOUND');
    const missing = h.join('ABCDE', 'Liisa');
    expect(missing.sentOf('error')[0]?.code).toBe('ROOM_NOT_FOUND');
  });

  it('NAME_TAKEN is case-insensitive and names are sanitized', () => {
    const h = harness();
    const host = h.createRoom('Matti');
    const dup = h.join(host.code, '  mATTI ');
    expect(dup.sentOf('error')[0]?.code).toBe('NAME_TAKEN');
    expect(dup.sentOf('roomJoined')).toHaveLength(0);
    const weird = h.join(host.code, ' Liisa' + String.fromCharCode(0) + '  V '); // 11 units: passes the parser, Room sanitizes
    expect(h.joined(weird).state.players[1]?.name).toBe('Liisa V');
  });

  it('a full lobby turns a join into a spectator join; asSpectator forces it; MAX_SPECTATORS -> ROOM_FULL', () => {
    const h = harness();
    const host = h.createRoom('Host', 0, { maxPlayers: 2 });
    h.join(host.code, 'P2');
    const spec = h.join(host.code, 'S1', 2);
    expect(h.joined(spec).role).toBe('spectator');
    expect(h.joined(spec).state.spectators).toEqual([{ id: h.joined(spec).playerId, name: 'S1' }]);
    expect(h.events(host.c).at(-1)).toMatchObject({ type: 'spectatorJoined', spectator: { name: 'S1' } });

    const h2 = harness();
    const host2 = h2.createRoom();
    const forced = h2.join(host2.code, 'Katsoja', 1, true);
    expect(h2.joined(forced).role).toBe('spectator');
    expect(h2.rooms.stats()).toEqual({ rooms: 1, players: 1, spectators: 1 });
    for (let i = 1; i < MAX_SPECTATORS; i++) h2.join(host2.code, `K${i}`, 1, true);
    const tooMany = h2.join(host2.code, 'Liikaa', 1, true);
    expect(tooMany.sentOf('error')[0]?.code).toBe('ROOM_FULL');
  });

  it('ROOM_FULL for players when every seat is taken and spectators are full too', () => {
    const h = harness();
    const host = h.createRoom('Host', 0, { maxPlayers: 2 });
    h.join(host.code, 'P2');
    for (let i = 0; i < MAX_SPECTATORS; i++) h.join(host.code, `K${i}`);
    const c = h.join(host.code, 'P3');
    expect(c.sentOf('error')[0]?.code).toBe('ROOM_FULL');
  });

  it('ALREADY_IN_ROOM for a second create/join from the same connection', () => {
    const h = harness();
    const host = h.createRoom();
    host.c.clearSent();
    host.c.receive({ t: 'createRoom', name: 'X', colour: 0 });
    expect(host.c.sentOf('error')[0]?.code).toBe('ALREADY_IN_ROOM');
    host.c.receive({ t: 'joinRoom', code: host.code, name: 'X', colour: 0 });
    expect(host.c.sentOf('error')[1]?.code).toBe('ALREADY_IN_ROOM');
    expect(h.rooms.stats().rooms).toBe(1);
  });

  it('SERVER_FULL at MAX_ROOMS and when codes collide forever', () => {
    const h = harness({ maxRooms: 1 });
    h.createRoom();
    const c = h.client();
    c.receive({ t: 'createRoom', name: 'Toinen', colour: 0 });
    expect(c.sentOf('error')[0]?.code).toBe('SERVER_FULL');
    expect(c.sentOf('roomJoined')).toHaveLength(0);

    const h2 = harness({ codes: ['AAAAA'] }); // the generator then returns 'ZZZZZ' forever
    h2.createRoom();
    h2.createRoom();
    const c3 = h2.client();
    c3.receive({ t: 'createRoom', name: 'X', colour: 0 });
    expect(c3.sentOf('error')[0]?.code).toBe('SERVER_FULL');
    expect(h2.rooms.stats().rooms).toBe(2);
  });
});

describe('in-room messages', () => {
  it('NOT_IN_ROOM for room messages before joining; ping is answered anywhere', () => {
    const h = harness();
    const c = h.client();
    c.receive({ t: 'setReady', ready: true });
    expect(c.sentOf('error')[0]?.code).toBe('NOT_IN_ROOM');
    c.receive({ t: 'ping', t0: 77 });
    expect(c.sentOf('pong')[0]).toEqual({ t: 'pong', t0: 77, serverTimeMs: h.clock.now() });
  });

  it('chat is sanitized, broadcast to everyone including the sender, and kept in the backlog', () => {
    const h = harness();
    const host = h.createRoom('Host');
    const p2 = h.join(host.code, 'Liisa');
    host.c.clearSent();
    p2.clearSent();
    h.clock.advance(5);
    p2.receive({ t: 'chat', text: '  Hei   kaikki!  ' + String.fromCharCode(0) });
    const expected: ServerMessage = { t: 'chat', from: { id: h.joined(p2).playerId, name: 'Liisa', colour: 1 }, text: 'Hei kaikki!', atMs: h.clock.now() };
    expect(host.c.sent).toEqual([expected]);
    expect(p2.sent).toEqual([expected]);
    p2.receive({ t: 'chat', text: '   ' });
    expect(p2.sent).toHaveLength(1); // empty after sanitation: dropped silently
    expect(h.rooms.get(host.code)?.chatBacklog().at(-1)).toEqual(expected);
  });

  it('chat throttle drops lines over CHAT_MSGS_PER_10S with RATE_LIMITED', () => {
    const h = harness();
    const host = h.createRoom();
    host.c.clearSent();
    for (let i = 0; i < 6; i++) host.c.receive({ t: 'chat', text: `rivi ${i}` });
    expect(host.c.sentOf('chat')).toHaveLength(5);
    expect(host.c.sentOf('error')).toEqual([{ t: 'error', code: 'RATE_LIMITED', message: 'Chat too fast' }]);
  });

  it('spectators may chat but player actions answer NOT_A_PLAYER', () => {
    const h = harness();
    const host = h.createRoom();
    const spec = h.join(host.code, 'Katsoja', 1, true);
    spec.clearSent();
    spec.receive({ t: 'setReady', ready: true });
    spec.receive({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: { dx: 1200, dy: 0 } });
    spec.receive({ t: 'startGame' });
    expect(spec.sentOf('error').map((e) => e.code)).toEqual(['NOT_A_PLAYER', 'NOT_A_PLAYER', 'NOT_A_PLAYER']);
    spec.receive({ t: 'chat', text: 'moi' });
    expect(spec.sentOf('chat')).toHaveLength(1);
  });

  it('setReady / setProfile broadcast events; setSettings is host-only', () => {
    const h = harness();
    const host = h.createRoom('Host', 0);
    const p2 = h.join(host.code, 'Liisa', 1);
    host.c.clearSent();
    p2.clearSent();
    p2.receive({ t: 'setReady', ready: true });
    expect(h.events(host.c)).toEqual([{ type: 'readyChanged', playerId: h.joined(p2).playerId, ready: true }]);
    p2.receive({ t: 'setReady', ready: true }); // no change -> no event
    expect(h.events(host.c)).toHaveLength(1);

    p2.receive({ t: 'setProfile', name: 'Liisa L', colour: 0 }); // colour 0 is the host's -> ignored
    expect(h.events(host.c).at(-1)).toEqual({ type: 'profileChanged', playerId: h.joined(p2).playerId, name: 'Liisa L', colour: 1 });
    p2.receive({ t: 'setProfile', name: 'host' });
    expect(p2.sentOf('error').at(-1)?.code).toBe('NAME_TAKEN');

    p2.receive({ t: 'setSettings', settings: { maxPlayers: 2 } });
    expect(p2.sentOf('error').at(-1)?.code).toBe('NOT_HOST');
    host.c.receive({ t: 'setSettings', settings: { maxPlayers: 2, turnTimeoutSec: 30 } });
    expect(h.events(p2).at(-1)).toEqual({ type: 'settingsChanged', settings: { maxPlayers: 2, turnTimeoutSec: 30, holeSummarySec: 6, ballCollision: false } });
    expect(h.rooms.get(host.code)?.hasFreeSeat()).toBe(false);
  });

  it('requestSnapshot returns a roomState equal to the join snapshot shape', () => {
    const h = harness();
    const host = h.createRoom();
    host.c.clearSent();
    host.c.receive({ t: 'requestSnapshot' });
    const snap = host.c.sentOf('roomState')[0];
    expect(snap?.state.players).toHaveLength(1);
    expect(snap?.state.phase).toBe('lobby');
    expect(snap?.serverTimeMs).toBe(h.clock.now());
  });

  it('game-flow messages reach the Authority: start gating and course selection answer with real codes', () => {
    const h = harness();
    const host = h.createRoom();
    host.c.clearSent();
    host.c.receive({ t: 'startGame' });
    expect(host.c.sentOf('error').map((e) => e.code)).toEqual(['NOT_ENOUGH_PLAYERS']);
    host.c.receive({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_01' }] });
    expect(h.events(host.c).at(-1)).toMatchObject({ type: 'coursesChanged', courses: [{ id: 'b_01' }] });
    expect(h.rooms.get(host.code)?.state.courses.map((c) => c.id)).toEqual(['b_01']);
  });
});

describe('leaving, disconnecting, rejoining', () => {
  it('leaveRoom: roomLeft{left} to the leaver, playerLeft (+hostChanged to lowest joinedSeq) to the rest', () => {
    const h = harness();
    const host = h.createRoom('Host');
    const p2 = h.join(host.code, 'P2');
    const p3 = h.join(host.code, 'P3');
    p2.clearSent();
    p3.clearSent();
    host.c.receive({ t: 'leaveRoom' });
    expect(host.c.sentOf('roomLeft')).toEqual([{ t: 'roomLeft', reason: 'left' }]);
    expect(h.types(p2)).toEqual(['event:playerLeft', 'chat', 'event:hostChanged', 'chat']);
    expect(h.events(p3)).toEqual([
      { type: 'playerLeft', playerId: host.playerId },
      { type: 'hostChanged', hostId: h.joined(p2).playerId },
    ]);
    expect(h.rooms.stats()).toEqual({ rooms: 1, players: 2, spectators: 0 });
    // the leaver's connection is free again
    host.c.clearSent();
    host.c.receive({ t: 'joinRoom', code: host.code, name: 'Host', colour: 0 });
    expect(host.c.sentOf('roomJoined')).toHaveLength(1);
  });

  it('removes the room immediately when the last member leaves', () => {
    const h = harness();
    const host = h.createRoom();
    host.c.receive({ t: 'leaveRoom' });
    expect(h.rooms.stats().rooms).toBe(0);
    expect(h.rooms.get(host.code)).toBeNull();
  });

  it('spectator disconnect removes them at once; player disconnect -> playerConnection false, removal after LOBBY_DISCONNECT_REMOVE_SEC', () => {
    const h = harness();
    const host = h.createRoom('Host');
    const p2 = h.join(host.code, 'P2');
    const spec = h.join(host.code, 'S', 1, true);
    host.c.clearSent();
    spec.disconnect();
    expect(h.events(host.c)).toEqual([{ type: 'spectatorLeft', id: h.joined(spec).playerId }]);
    host.c.clearSent();
    p2.disconnect();
    expect(h.events(host.c)).toEqual([{ type: 'playerConnection', playerId: h.joined(p2).playerId, connected: false }]);
    expect(h.rooms.stats().players).toBe(2); // seat held during grace
    h.clock.advance(LOBBY_DISCONNECT_REMOVE_SEC * 1000 - 1);
    expect(h.rooms.stats().players).toBe(2);
    h.clock.advance(1);
    expect(h.rooms.stats().players).toBe(1);
    expect(h.events(host.c).at(-1)).toEqual({ type: 'playerLeft', playerId: h.joined(p2).playerId });
  });

  it('rejoin with a valid token swaps the connection, replays the chat backlog and cancels removal', () => {
    const h = harness();
    const host = h.createRoom('Host');
    const p2 = h.join(host.code, 'P2');
    const p2Join = h.joined(p2);
    host.c.receive({ t: 'chat', text: 'ennen katkoa' });
    p2.disconnect();
    h.clock.advance(3000);
    host.c.clearSent();

    const p2b = h.client();
    p2b.receive({ t: 'rejoin', code: host.code, sessionToken: p2Join.sessionToken });
    const rj = h.joined(p2b);
    expect(rj.playerId).toBe(p2Join.playerId);
    expect(rj.role).toBe('player');
    expect(rj.state.players.find((p) => p.id === rj.playerId)?.connected).toBe(false); // R20: snapshot predates connection(true); the frame below completes it
    expect(h.rooms.get(host.code)?.state.players.find((p) => p.id === rj.playerId)?.connected).toBe(true);
    expect(h.events(host.c)).toEqual([{ type: 'playerConnection', playerId: p2Join.playerId, connected: true }]);
    // roomJoined, then the playerConnection broadcast (the member is connected again), then the chat backlog:
    // system lines for both joins + the chat line
    expect(p2b.sent[1]).toEqual({ t: 'event', ev: { type: 'playerConnection', playerId: p2Join.playerId, connected: true } });
    const backlog = p2b.sent.slice(2);
    expect(backlog.every((m) => m.t === 'chat')).toBe(true);
    expect(backlog.map((m) => (m.t === 'chat' ? (m.text ?? m.key) : ''))).toEqual(['chat.playerJoined', 'chat.playerJoined', 'ennen katkoa']);
    h.clock.advance(LOBBY_DISCONNECT_REMOVE_SEC * 1000 + 1);
    expect(h.rooms.stats().players).toBe(2); // removal cancelled
    // the resumed connection acts as the member
    p2b.receive({ t: 'setReady', ready: true });
    expect(h.events(host.c).at(-1)).toEqual({ type: 'readyChanged', playerId: p2Join.playerId, ready: true });
  });

  it('rejoin while the old socket is still open replaces it (close 4001)', () => {
    const h = harness();
    const host = h.createRoom('Host');
    const token = host.token;
    const again = h.client();
    again.receive({ t: 'rejoin', code: host.code, sessionToken: token });
    expect(h.joined(again).playerId).toBe(host.playerId);
    expect(host.c.closed?.code).toBe(CLOSE_REPLACED);
    expect(h.rooms.stats()).toEqual({ rooms: 1, players: 1, spectators: 0 });
    expect(h.rooms.get(host.code)?.connectedCount()).toBe(1);
  });

  it('rejoin: SESSION_EXPIRED for an unknown/removed token and for a dead room (§11.3, §11.5), ALREADY_IN_ROOM in a room', () => {
    const h = harness();
    const host = h.createRoom('Host');
    const p2 = h.join(host.code, 'P2');
    const token = h.joined(p2).sessionToken;
    const c = h.client();
    c.receive({ t: 'rejoin', code: host.code, sessionToken: 'f'.repeat(32) });
    expect(c.sentOf('error')[0]?.code).toBe('SESSION_EXPIRED');
    p2.receive({ t: 'leaveRoom' });
    c.receive({ t: 'rejoin', code: host.code, sessionToken: token });
    expect(c.sentOf('error')[1]?.code).toBe('SESSION_EXPIRED');
    c.receive({ t: 'rejoin', code: 'ABCDE', sessionToken: token });
    expect(c.sentOf('error')[2]?.code).toBe('SESSION_EXPIRED');
    host.c.clearSent();
    host.c.receive({ t: 'rejoin', code: host.code, sessionToken: host.token });
    expect(host.c.sentOf('error')[0]?.code).toBe('ALREADY_IN_ROOM');
  });

  it('a spectator token expires immediately on disconnect', () => {
    const h = harness();
    const host = h.createRoom();
    const spec = h.join(host.code, 'S', 1, true);
    const token = h.joined(spec).sessionToken;
    spec.disconnect();
    const c = h.client();
    c.receive({ t: 'rejoin', code: host.code, sessionToken: token });
    expect(c.sentOf('error')[0]?.code).toBe('SESSION_EXPIRED');
  });

  it('keeps at most CHAT_BACKLOG lines', () => {
    const h = harness();
    const host = h.createRoom();
    for (let i = 0; i < CHAT_BACKLOG + 20; i++) {
      h.clock.advance(2001); // stay under the chat throttle
      host.c.receive({ t: 'chat', text: `m${i}` });
    }
    const backlog = h.rooms.get(host.code)!.chatBacklog();
    expect(backlog).toHaveLength(CHAT_BACKLOG);
    expect(backlog.at(-1)).toMatchObject({ text: `m${CHAT_BACKLOG + 19}` });
  });
});

describe('sweep, stats and shutdown', () => {
  it('sweeps rooms empty for ROOM_EMPTY_TTL_SEC (seat still held) and idle for ROOM_IDLE_TTL_MIN', () => {
    const h = harness({ roomEmptyTtlSec: 120, roomIdleTtlMin: 90 });
    const a = h.createRoom('A');
    const b = h.createRoom('B');
    // room A: the only player disconnects; after the lobby timer they are removed -> memberless -> removed at once
    a.c.disconnect();
    expect(h.rooms.stats().rooms).toBe(2);
    h.clock.advance(LOBBY_DISCONNECT_REMOVE_SEC * 1000);
    expect(h.rooms.get(a.code)).toBeNull();
    // room B stays while active
    h.rooms.sweep();
    expect(h.rooms.get(b.code)).not.toBeNull();
    // idle: no message for 90 min
    h.clock.advance(90 * 60_000);
    h.rooms.sweep();
    expect(h.rooms.get(b.code)).toBeNull();
    expect(b.c.sentOf('roomLeft')).toEqual([{ t: 'roomLeft', reason: 'roomClosed' }]);
    expect(h.gateway.sessionOf(b.c)?.inRoom).toBe(false);
  });

  it('a rejoin after every member dropped clears emptySince so the sweeper keeps the room', () => {
    const h = harness({ roomEmptyTtlSec: 120 });
    const host = h.createRoom('Host');
    host.c.disconnect();
    const room = h.rooms.get(host.code)!;
    expect(room.emptySince).toBe(h.clock.now());
    h.clock.advance(2000);
    const back = h.client();
    back.receive({ t: 'rejoin', code: host.code, sessionToken: host.token });
    expect(h.joined(back).playerId).toBe(host.playerId);
    expect(room.connectedCount()).toBe(1);
    expect(room.emptySince).toBeNull();
    back.clearSent();
    h.clock.advance(130_000);
    h.rooms.sweep();
    expect(h.rooms.get(host.code)).toBe(room);
    expect(back.sentOf('roomLeft')).toHaveLength(0);
    expect(h.gateway.sessionOf(back)?.inRoom).toBe(true);
    // dropping again restarts the empty clock from now, not from the first drop
    back.disconnect();
    expect(room.emptySince).toBe(h.clock.now());
  });

  it('sweeps a room whose connections are all gone once the empty TTL passes', () => {
    const h = harness({ roomEmptyTtlSec: 60 });
    const host = h.createRoom();
    const room = h.rooms.get(host.code)!;
    expect(room.emptySince).toBeNull();
    // simulate a held seat without connection longer than the empty TTL (phase 2 grace can be 60 s)
    room.members.get(host.playerId)!.session = null;
    room.emptySince = h.clock.now();
    h.clock.advance(59_000);
    h.rooms.sweep();
    expect(h.rooms.get(host.code)).not.toBeNull();
    h.clock.advance(1000);
    h.rooms.sweep();
    expect(h.rooms.get(host.code)).toBeNull();
  });

  it('the sweeper runs on the clock every SWEEP_INTERVAL_MS until closeAll', () => {
    const h = harness({ roomIdleTtlMin: 1 });
    h.rooms.startSweeper();
    const host = h.createRoom();
    h.clock.advance(60_000 - SWEEP_INTERVAL_MS); // not idle yet at the first sweeps
    expect(h.rooms.get(host.code)).not.toBeNull();
    h.clock.advance(SWEEP_INTERVAL_MS * 2);
    expect(h.rooms.get(host.code)).toBeNull();
    h.rooms.closeAll();
    const pending = h.clock.pendingTimers();
    h.clock.advance(SWEEP_INTERVAL_MS * 3);
    expect(h.clock.pendingTimers()).toBeLessThanOrEqual(pending);
  });

  it('stats count players and spectators across rooms', () => {
    const h = harness();
    const a = h.createRoom('A');
    h.join(a.code, 'A2');
    h.join(a.code, 'S', 1, true);
    h.createRoom('B');
    expect(h.rooms.stats()).toEqual({ rooms: 2, players: 3, spectators: 1 });
  });

  it('closeAll sends roomLeft{roomClosed} to every connected member and clears the rooms', () => {
    const h = harness();
    const a = h.createRoom('A');
    const a2 = h.join(a.code, 'A2');
    const b = h.createRoom('B');
    h.rooms.closeAll();
    for (const c of [a.c, a2, b.c]) expect(c.sentOf('roomLeft')).toEqual([{ t: 'roomLeft', reason: 'roomClosed' }]);
    expect(h.rooms.stats()).toEqual({ rooms: 0, players: 0, spectators: 0 });
    const c = h.client();
    c.receive({ t: 'createRoom', name: 'X', colour: 0 });
    expect(c.sentOf('error')[0]?.code).toBe('SERVER_FULL');
  });

  it('gateway forgets the session on close and the transport stop closes everything with 1001', async () => {
    const h = harness();
    const host = h.createRoom();
    expect(h.gateway.sessions.size).toBe(1);
    await h.transport.stop();
    expect(host.c.closed?.code).toBe(1001);
    expect(h.gateway.sessions.size).toBe(0);
    expect(h.transport.connectionCount()).toBe(0);
  });
});
