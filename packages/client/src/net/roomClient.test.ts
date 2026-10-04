import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import type { Course } from '@puttipeli/shared/course/types';
import type { GameEvent } from '@puttipeli/shared/game/events';
import { createLobbyState, DEFAULT_ROOM_SETTINGS } from '@puttipeli/shared/game/initial';
import { applyEvent } from '@puttipeli/shared/game/reducer';
import { gameStateToJson } from '@puttipeli/shared/game/serialize';
import type { GameState, GameStateJson, PlayerState } from '@puttipeli/shared/game/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import type { ClientMessage, ServerMessage, ServerMessageType } from '@puttipeli/shared/protocol/messages';
import { isSimTuningDefault, setSimTuning } from '@puttipeli/shared/sim/tuning';
import type { StorageLike } from '../storage/settings';
import { createSessionStore, type SessionStore } from './session';
import type { RoomSocket, SocketStatus } from './socket';
import { CLOSE_REPLACED } from './socket';
import { RoomSession, coursesToRefs, startBlockReason, errorText, onAnySessionLeft, MAX_CHAT_MESSAGES, type JoinRequest, type LeftReason } from './roomClient';

// ------------------------------------------------------------------------------------------------ fakes

class FakeSocket implements RoomSocket {
  status: SocketStatus = 'idle';
  isReady = false;
  clockOffsetMs = 0;
  closeCode: number | null = null;
  sent: ClientMessage[] = [];
  connectCalls = 0;
  closeCalls = 0;
  private readonly typeL = new Map<string, Set<(m: ServerMessage) => void>>();
  private readonly readyL = new Set<(r: boolean) => void>();
  private readonly statusL = new Set<(s: SocketStatus) => void>();

  connect(): void { this.connectCalls++; this.status = 'connecting'; }
  close(): void { this.closeCalls++; this.isReady = false; this.setStatus('closed'); }
  send(msg: ClientMessage): boolean { if (!this.isReady) return false; this.sent.push(msg); return true; }
  on<T extends ServerMessageType>(type: T, listener: (msg: Extract<ServerMessage, { t: T }>) => void): () => void {
    let set = this.typeL.get(type);
    if (!set) { set = new Set(); this.typeL.set(type, set); }
    const l = listener as (m: ServerMessage) => void;
    set.add(l);
    return () => { set.delete(l); };
  }
  onReady(l: (r: boolean) => void): () => void { this.readyL.add(l); return () => { this.readyL.delete(l); }; }
  onStatus(l: (s: SocketStatus) => void): () => void { this.statusL.add(l); return () => { this.statusL.delete(l); }; }
  // helpers
  ready(reconnect = false): void { this.isReady = true; this.setStatus('open'); for (const l of [...this.readyL]) l(reconnect); }
  drop(): void { this.isReady = false; this.setStatus('reconnecting'); }
  /** What WsClient does on a terminal server close (4000 / 4001). */
  terminate(code: number): void { this.isReady = false; this.closeCode = code; this.setStatus('closed'); }
  emit(msg: ServerMessage): void { for (const l of [...(this.typeL.get(msg.t) ?? [])]) l(msg); }
  last(): ClientMessage | undefined { return this.sent[this.sent.length - 1]; }
  ofType<T extends ClientMessage['t']>(t: T): Extract<ClientMessage, { t: T }>[] { return this.sent.filter((m): m is Extract<ClientMessage, { t: T }> => m.t === t); }
  private setStatus(s: SocketStatus): void { this.status = s; for (const l of [...this.statusL]) l(s); }
}

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
  removeItem(k: string): void { this.data.delete(k); }
}

// ------------------------------------------------------------------------------------------------ fixtures

const course: Course = BUILTIN_COURSES[0]!;
const player = (id: string, name: string, colour: 0 | 1 | 2 | 3, joinedSeq: number, ready = true): PlayerState =>
  ({ id, name, colour, ready, connected: true, afk: false, consecutiveTimeouts: 0, joinedSeq, leftRound: false });

function lobbyState(players: PlayerState[], courses: Course[] = [course]): GameState {
  let s = createLobbyState(DEFAULT_ROOM_SETTINGS, courses);
  for (const p of players) s = applyEvent(s, { type: 'playerJoined', player: p });
  return s;
}

function playingState(players: PlayerState[]): GameState {
  const ids = players.map((p) => p.id);
  const evs: GameEvent[] = [
    { type: 'countdownStarted', endsAtMs: 1000 },
    { type: 'gameStarted', seatOrder: ids },
    { type: 'holeStarted', holeIndex: 0, order: ids },
    { type: 'turnStarted', playerId: ids[0]!, turnSeq: 1, deadlineMs: 50_000 },
  ];
  return evs.reduce((s, ev) => applyEvent(s, ev), lobbyState(players));
}

const joined = (code: string, playerId: string, role: 'player' | 'spectator', state: GameState, token = 'tok-1'): ServerMessage =>
  ({ t: 'roomJoined', code, playerId, sessionToken: token, role, state: gameStateToJson(state), serverTimeMs: 123 });

interface Harness { session: RoomSession; socket: FakeSocket; store: SessionStore; left: { reason: LeftReason; code?: string }[]; errors: string[]; statuses: string[] }

function harness(request: JoinRequest, opts: { now?: () => number; store?: SessionStore } = {}): Harness {
  const socket = new FakeSocket();
  const store = opts.store ?? createSessionStore({ session: new MemoryStorage(), local: new MemoryStorage() });
  const session = new RoomSession(request, { socket, sessions: store, now: opts.now ?? (() => 10_000) });
  const left: { reason: LeftReason; code?: string }[] = [];
  const errors: string[] = [];
  const statuses: string[] = [];
  session.onLeft((reason, code) => left.push({ reason, code }));
  session.onError((code) => errors.push(code));
  session.onStatus((s) => statuses.push(s));
  return { session, socket, store, left, errors, statuses };
}

const me = player('me', 'Maija', 2, 1);
const other = player('other', 'Ville', 0, 2);

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });

// ------------------------------------------------------------------------------------------------ tests

describe('join flow', () => {
  it('create: connects, sends createRoom after welcome, adopts the snapshot and stores the session', () => {
    const h = harness({ kind: 'create', name: 'Maija', colour: 2 });
    const { session, socket } = h;
    expect(socket.connectCalls).toBe(1);
    expect(session.status).toBe('connecting');
    expect(session.code).toBeNull();
    expect(session.getState().phase).toBe('lobby'); // placeholder state before the join
    expect(session.localPlayerId).toBe('');
    const seen: { ev: GameEvent | null; prev: GameState | null; players: number }[] = [];
    session.subscribe((s, ev, prev) => seen.push({ ev, prev, players: s.players.length }));
    expect(seen).toEqual([{ ev: null, prev: null, players: 0 }]); // immediate call
    const joinedInfos: unknown[] = [];
    session.onJoined((i) => joinedInfos.push(i));

    socket.ready();
    expect(session.status).toBe('joining');
    expect(socket.sent).toEqual([{ t: 'createRoom', name: 'Maija', colour: 2 }]);

    socket.emit(joined('K7PQ2', 'me', 'player', lobbyState([me])));
    expect(session.status).toBe('joined');
    expect(session.code).toBe('K7PQ2');
    expect(session.localPlayerId).toBe('me');
    expect(session.isSpectator).toBe(false);
    expect(session.isHost).toBe(true);
    expect(session.isMe('me')).toBe(true);
    expect(session.getState().players.map((p) => p.id)).toEqual(['me']);
    expect(session.getState().courses[0]?.id).toBe('b_01');
    expect(seen[1]).toMatchObject({ ev: null, players: 1 });
    expect(seen[1]!.prev?.players).toHaveLength(0);
    expect(joinedInfos).toEqual([{ code: 'K7PQ2', playerId: 'me', role: 'player', rejoin: false }]);
    expect(h.store.getSession('K7PQ2')).toMatchObject({ token: 'tok-1', playerId: 'me', role: 'player', name: 'Maija', colour: 2 });
    expect(h.store.listRecent().map((r) => r.code)).toEqual(['K7PQ2']);
    expect(h.statuses).toEqual(['joining', 'joined']);
  });

  it('join sends joinRoom with the normalized code and the spectator flag only when set', () => {
    const a = harness({ kind: 'join', code: ' k7-pq2 ', name: 'Ville', colour: 0 });
    expect(a.session.code).toBe('K7PQ2');
    a.socket.ready();
    expect(a.socket.sent).toEqual([{ t: 'joinRoom', code: 'K7PQ2', name: 'Ville', colour: 0 }]);
    const b = harness({ kind: 'join', code: 'K7PQ2', name: 'Ville', colour: 0, asSpectator: true });
    b.socket.ready();
    expect(b.socket.sent).toEqual([{ t: 'joinRoom', code: 'K7PQ2', name: 'Ville', colour: 0, asSpectator: true }]);
  });

  it('spectator: localPlayerId is empty, player actions are no-ops, chat still works', () => {
    const h = harness({ kind: 'join', code: 'K7PQ2', name: 'Katsoja', colour: 1, asSpectator: true });
    h.socket.ready();
    const state = applyEvent(lobbyState([me]), { type: 'spectatorJoined', spectator: { id: 'spec', name: 'Katsoja' } });
    h.socket.emit(joined('K7PQ2', 'spec', 'spectator', state));
    expect(h.session.localPlayerId).toBe('');
    expect(h.session.isSpectator).toBe(true);
    expect(h.session.isMe('spec')).toBe(true);
    expect(h.session.isHost).toBe(false);
    const before = h.socket.sent.length;
    h.session.shoot({ dx: 100, dy: 0 });
    h.session.summaryReady();
    h.session.backToLobby();
    expect(h.session.setReady(true)).toBe(false);
    expect(h.session.setProfile({ name: 'X' })).toBe(false);
    expect(h.socket.sent.length).toBe(before);
    h.session.chat!.send('  moi  ');
    expect(h.socket.last()).toEqual({ t: 'chat', text: 'moi' });
    expect(h.session.becomePlayer()).toBe(true);
    expect(h.socket.last()).toEqual({ t: 'becomePlayer' });
    // becomePlayer confirmed by the authority: the role flips and the stored session follows
    h.socket.emit({ t: 'event', ev: { type: 'playerJoined', player: player('spec', 'Katsoja', 1, 3, false) } });
    expect(h.session.localPlayerId).toBe('spec');
    expect(h.session.isSpectator).toBe(false);
    expect(h.store.getSession('K7PQ2')?.role).toBe('player');
  });

  it('a failed join ends the session: error listener, left(joinFailed), socket closed', () => {
    const h = harness({ kind: 'join', code: 'K7PQ2', name: 'Ville', colour: 0 });
    h.socket.ready();
    h.socket.emit({ t: 'error', code: 'ROOM_NOT_FOUND', message: 'No room with that code' });
    expect(h.errors).toEqual(['ROOM_NOT_FOUND']);
    expect(h.left).toEqual([{ reason: 'joinFailed', code: 'ROOM_NOT_FOUND' }]);
    expect(h.session.status).toBe('left');
    expect(h.socket.closeCalls).toBe(1);
    expect(h.session.hasJoined).toBe(false);
    // nothing else reaches a dead session
    h.socket.ready();
    expect(h.socket.ofType('joinRoom')).toHaveLength(1);
  });

  it('an initial rejoin request sends rejoin and gives up with sessionExpired when the token is stale', () => {
    const store = createSessionStore({ session: new MemoryStorage(), local: new MemoryStorage() });
    store.setSession({ code: 'K7PQ2', token: 'old', playerId: 'me', role: 'player', name: 'Maija', colour: 2, savedAt: 1 });
    const h = harness({ kind: 'rejoin', code: 'K7PQ2', token: 'old', name: 'Maija', colour: 2 }, { store });
    h.socket.ready();
    expect(h.session.status).toBe('rejoining');
    expect(h.socket.sent).toEqual([{ t: 'rejoin', code: 'K7PQ2', sessionToken: 'old' }]);
    h.socket.emit({ t: 'error', code: 'SESSION_EXPIRED', message: 'gone' });
    expect(h.left).toEqual([{ reason: 'sessionExpired', code: 'SESSION_EXPIRED' }]);
    expect(store.getSession('K7PQ2')).toBeNull();
    expect(h.session.status).toBe('left');
  });

  it('resets the sim tuning in the constructor (D14)', () => {
    setSimTuning({ FRICTION_GRASS: 999 });
    expect(isSimTuningDefault()).toBe(false);
    harness({ kind: 'create', name: 'Maija', colour: 2 });
    expect(isSimTuningDefault()).toBe(true);
  });
});

function joinedHarness(role: 'player' | 'spectator' = 'player', state: GameState = lobbyState([me, other])): Harness {
  const h = harness({ kind: 'join', code: 'K7PQ2', name: 'Maija', colour: 2 });
  h.socket.ready();
  h.socket.emit(joined('K7PQ2', 'me', role, state));
  return h;
}

describe('events and snapshots', () => {
  it('applies events through the shared reducer and reports (state, event, prev)', () => {
    const h = joinedHarness('player', lobbyState([me]));
    const calls: { type: string | null; now: number; prev: number }[] = [];
    h.session.subscribe((s, ev, prev) => calls.push({ type: ev?.type ?? null, now: s.players.length, prev: prev?.players.length ?? -1 }));
    h.socket.emit({ t: 'event', ev: { type: 'playerJoined', player: other } });
    h.socket.emit({ t: 'event', ev: { type: 'readyChanged', playerId: 'other', ready: false } });
    expect(calls).toEqual([
      { type: null, now: 1, prev: -1 },
      { type: 'playerJoined', now: 2, prev: 1 },
      { type: 'readyChanged', now: 2, prev: 2 },
    ]);
    expect(h.session.getState().players.find((p) => p.id === 'other')?.ready).toBe(false);
    expect(h.session.getState().seq).toBe(3);
  });

  it('a ReducerError leaves the state untouched and requests one snapshot per second', () => {
    let now = 10_000;
    const h = harness({ kind: 'join', code: 'K7PQ2', name: 'Maija', colour: 2 }, { now: () => now });
    h.socket.ready();
    h.socket.emit(joined('K7PQ2', 'me', 'player', lobbyState([me, other])));
    const before = h.session.getState();
    const calls: unknown[] = [];
    h.session.subscribe(() => calls.push(1));
    // turnStarted in the lobby is an impossible transition
    h.socket.emit({ t: 'event', ev: { type: 'turnStarted', playerId: 'me', turnSeq: 1, deadlineMs: null } });
    expect(h.session.getState()).toBe(before);
    expect(h.socket.ofType('requestSnapshot')).toHaveLength(1);
    expect(calls).toHaveLength(1); // only the immediate subscribe call
    h.socket.emit({ t: 'event', ev: { type: 'shotTaken', playerId: 'me', turnSeq: 1, shot: { dx: 1, dy: 0 }, outcome: { ticks: 1, result: 'stopped', penalty: 0, holeIndex: -1, ball: before.balls['me']!, worldDelta: { tiles: [], minesDisarmed: [] }, checksum: 0 }, atMs: 0 } });
    expect(h.socket.ofType('requestSnapshot')).toHaveLength(1); // debounced
    now += 1000;
    h.session.requestSnapshot(); // controller-detected desync after the interval
    expect(h.socket.ofType('requestSnapshot')).toHaveLength(2);
    // the snapshot replaces the whole state
    const fresh = playingState([me, other]);
    h.socket.emit({ t: 'roomState', state: gameStateToJson(fresh), serverTimeMs: 1 });
    expect(h.session.getState().phase).toBe('hole');
    expect(h.session.getState().world).not.toBeNull();
    expect(h.session.getState().world!.walls).toBeInstanceOf(Uint8Array);
    expect(calls).toHaveLength(2);
  });

  it('events are ignored before the first roomJoined', () => {
    const h = harness({ kind: 'join', code: 'K7PQ2', name: 'Maija', colour: 2 });
    h.socket.ready();
    h.socket.emit({ t: 'event', ev: { type: 'playerJoined', player: other } });
    expect(h.session.getState().players).toHaveLength(0);
    expect(h.socket.ofType('requestSnapshot')).toHaveLength(0);
  });
});

describe('play actions', () => {
  it('shoot sends holeIndex + turnSeq only on my turn with no shot in flight', () => {
    const h = joinedHarness('player', playingState([me, other]));
    h.session.shoot({ dx: 1200, dy: -300 });
    expect(h.socket.last()).toEqual({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: { dx: 1200, dy: -300 } });
    const n = h.socket.sent.length;
    // shot in flight -> no-op
    const st = h.session.getState();
    h.socket.emit({ t: 'event', ev: { type: 'shotTaken', playerId: 'me', turnSeq: 1, shot: { dx: 1200, dy: -300 }, outcome: { ticks: 10, result: 'stopped', penalty: 0, holeIndex: -1, ball: { ...st.balls['me']!, x: 100 }, worldDelta: { tiles: [], minesDisarmed: [] }, checksum: 1 }, atMs: 5 } });
    expect(h.session.getState().turn?.shotInFlight).toBe(true);
    expect(h.socket.ofType('requestSnapshot')).toHaveLength(0);
    h.session.shoot({ dx: 100, dy: 0 });
    expect(h.socket.sent.length).toBe(n);
    // other player's turn -> no-op
    h.socket.emit({ t: 'event', ev: { type: 'turnStarted', playerId: 'other', turnSeq: 2, deadlineMs: null } });
    h.session.shoot({ dx: 100, dy: 0 });
    expect(h.socket.sent.length).toBe(n);
  });

  it('summaryReady and backToLobby respect phase, role and host', () => {
    let s = playingState([me, other]);
    s = applyEvent(s, { type: 'holeEnded', holeIndex: 0 });
    const h = joinedHarness('player', s);
    h.session.backToLobby(); // not roundSummary
    expect(h.socket.ofType('backToLobby')).toHaveLength(0);
    h.session.summaryReady();
    expect(h.socket.last()).toEqual({ t: 'summaryReady' });
    h.socket.emit({ t: 'event', ev: { type: 'summaryReady', playerId: 'me' } });
    const n = h.socket.sent.length;
    h.session.summaryReady(); // already ready
    expect(h.socket.sent.length).toBe(n);
    h.socket.emit({ t: 'event', ev: { type: 'roundEnded', ranking: [{ playerId: 'me', total: 3, rank: 1 }, { playerId: 'other', total: 3, rank: 1 }] } });
    h.session.backToLobby(); // me is the host (first joiner)
    expect(h.socket.last()).toEqual({ t: 'backToLobby' });
    h.session.restart(); // no-op for remote
    expect(h.socket.last()).toEqual({ t: 'backToLobby' });
  });

  it('nowAuthorityMs adds the measured socket offset', () => {
    const h = joinedHarness();
    h.socket.clockOffsetMs = 2500;
    expect(h.session.nowAuthorityMs()).toBe(12_500);
  });

  it('lobby actions map to protocol messages', () => {
    const h = joinedHarness();
    expect(h.session.setReady(true)).toBe(true);
    expect(h.socket.last()).toEqual({ t: 'setReady', ready: true });
    h.session.setProfile({ colour: 3 });
    expect(h.socket.last()).toEqual({ t: 'setProfile', colour: 3 });
    h.session.setProfile({ name: 'Maija2', colour: 1 });
    expect(h.socket.last()).toEqual({ t: 'setProfile', name: 'Maija2', colour: 1 });
    h.session.setSettings({ turnTimeoutSec: 30 });
    expect(h.socket.last()).toEqual({ t: 'setSettings', settings: { turnTimeoutSec: 30 } });
    expect(h.session.setCourses([])).toBe(false);
    expect(h.session.setCourses(new Array(19).fill({ kind: 'builtin', id: 'b_01' }))).toBe(false);
    expect(h.session.setCourses([{ kind: 'builtin', id: 'b_02' }])).toBe(true);
    expect(h.socket.last()).toEqual({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_02' }] });
    h.session.startGame();
    expect(h.socket.last()).toEqual({ t: 'startGame' });
    expect(h.session.becomePlayer()).toBe(false); // already a player
  });

  it('profileChanged for me updates the stored profile', () => {
    const h = joinedHarness();
    h.socket.emit({ t: 'event', ev: { type: 'profileChanged', playerId: 'me', name: 'Maikki', colour: 3 } });
    expect(h.session.currentProfile).toEqual({ name: 'Maikki', colour: 3 });
    expect(h.store.getSession('K7PQ2')).toMatchObject({ name: 'Maikki', colour: 3 });
  });
});

describe('chat', () => {
  it('buffers messages with increasing seq, caps the ring and notifies subscribers', () => {
    const h = joinedHarness();
    const seen: number[] = [];
    const off = h.session.chat!.subscribe((m) => seen.push(m.length));
    h.socket.emit({ t: 'chat', from: { id: 'other', name: 'Ville', colour: 0 }, text: 'moi', atMs: 1 });
    h.socket.emit({ t: 'chat', from: null, key: 'chat.playerJoined', params: { name: 'Ville' }, atMs: 2 });
    const msgs = h.session.chat!.messages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ seq: 1, text: 'moi', from: { name: 'Ville' } });
    expect(msgs[1]).toMatchObject({ seq: 2, from: null, key: 'chat.playerJoined', params: { name: 'Ville' } });
    expect(seen).toEqual([1, 2]);
    for (let i = 0; i < MAX_CHAT_MESSAGES + 10; i++) h.socket.emit({ t: 'chat', from: null, text: String(i), atMs: i });
    expect(h.session.chat!.messages()).toHaveLength(MAX_CHAT_MESSAGES);
    expect(h.session.chat!.messages()[MAX_CHAT_MESSAGES - 1]!.seq).toBe(MAX_CHAT_MESSAGES + 12);
    off();
    h.socket.emit({ t: 'chat', from: null, text: 'x', atMs: 0 });
    expect(seen).toHaveLength(MAX_CHAT_MESSAGES + 12);
  });

  it('send trims, caps and ignores empty text', () => {
    const h = joinedHarness();
    const n = h.socket.sent.length;
    h.session.chat!.send('   ');
    expect(h.socket.sent.length).toBe(n);
    h.session.chat!.send(' ' + 'a'.repeat(300));
    const last = h.socket.last() as { t: 'chat'; text: string };
    expect(last.t).toBe('chat');
    expect(last.text).toHaveLength(200);
  });

  it('is cleared on every roomJoined (the server resends the backlog)', () => {
    const h = joinedHarness();
    h.socket.emit({ t: 'chat', from: null, text: 'old', atMs: 1 });
    expect(h.session.chat!.messages()).toHaveLength(1);
    h.socket.drop();
    h.socket.ready(true);
    h.socket.emit(joined('K7PQ2', 'me', 'player', lobbyState([me, other])));
    expect(h.session.chat!.messages()).toHaveLength(0);
    h.socket.emit({ t: 'chat', from: null, text: 'old', atMs: 1 });
    expect(h.session.chat!.messages()[0]!.seq).toBe(2); // seq keeps increasing so the panel re-renders
  });
});

describe('reconnection', () => {
  it('rejoins with code + token after the socket comes back, adopts the snapshot, reports rejoin=true', () => {
    const h = joinedHarness();
    const joinedInfos: { rejoin: boolean }[] = [];
    h.session.onJoined((i) => joinedInfos.push({ rejoin: i.rejoin }));
    h.socket.drop();
    expect(h.session.status).toBe('reconnecting');
    expect(h.session.setReady(true)).toBe(false); // nothing is sent while offline
    h.socket.ready(true);
    expect(h.session.status).toBe('rejoining');
    expect(h.socket.last()).toEqual({ t: 'rejoin', code: 'K7PQ2', sessionToken: 'tok-1' });
    // an event that arrives before the snapshot is ignored (the snapshot includes it)
    h.socket.emit({ t: 'event', ev: { type: 'readyChanged', playerId: 'other', ready: false } });
    expect(h.session.getState().players.find((p) => p.id === 'other')?.ready).toBe(true);
    const fresh = playingState([me, other]);
    h.socket.emit(joined('K7PQ2', 'me', 'player', fresh, 'tok-2'));
    expect(h.session.status).toBe('joined');
    expect(h.session.getState().phase).toBe('hole');
    expect(joinedInfos).toEqual([{ rejoin: true }]);
    expect(h.store.getSession('K7PQ2')?.token).toBe('tok-2');
    expect(h.statuses).toEqual(['joining', 'joined', 'reconnecting', 'rejoining', 'joined']);
  });

  it('SESSION_EXPIRED on rejoin as a player ends the session and clears the token', () => {
    const h = joinedHarness();
    h.socket.drop();
    h.socket.ready(true);
    h.socket.emit({ t: 'error', code: 'SESSION_EXPIRED', message: 'gone' });
    expect(h.left).toEqual([{ reason: 'sessionExpired', code: 'SESSION_EXPIRED' }]);
    expect(h.store.getSession('K7PQ2')).toBeNull();
    expect(h.session.status).toBe('left');
    expect(h.socket.closeCalls).toBe(1);
  });

  it('SESSION_EXPIRED on rejoin as a spectator re-joins automatically as a spectator (§10.6)', () => {
    const state = applyEvent(lobbyState([me]), { type: 'spectatorJoined', spectator: { id: 'spec', name: 'Katsoja' } });
    const h = harness({ kind: 'join', code: 'K7PQ2', name: 'Katsoja', colour: 1, asSpectator: true });
    h.socket.ready();
    h.socket.emit(joined('K7PQ2', 'spec', 'spectator', state));
    h.socket.drop();
    h.socket.ready(true);
    h.socket.emit({ t: 'error', code: 'SESSION_EXPIRED', message: 'gone' });
    expect(h.left).toEqual([]);
    expect(h.session.status).toBe('joining');
    expect(h.socket.last()).toEqual({ t: 'joinRoom', code: 'K7PQ2', name: 'Katsoja', colour: 1, asSpectator: true });
    h.socket.emit(joined('K7PQ2', 'spec2', 'spectator', state, 'tok-3'));
    expect(h.session.status).toBe('joined');
    expect(h.session.isMe('spec2')).toBe(true);
  });

  it('roomLeft reasons end the session and clear the token', () => {
    for (const reason of ['removed', 'roomClosed', 'sessionExpired'] as const) {
      const h = joinedHarness();
      h.socket.emit({ t: 'roomLeft', reason });
      expect(h.left).toEqual([{ reason, code: undefined }]);
      expect(h.store.getSession('K7PQ2')).toBeNull();
      expect(h.session.status).toBe('left');
      expect(h.socket.closeCalls).toBe(1);
    }
  });

  it('BAD_VERSION: error is reported, the fatal socket close ends the session but keeps the token for after the reload', () => {
    const h = joinedHarness();
    h.socket.emit({ t: 'error', code: 'BAD_VERSION', message: 'mismatch' });
    expect(h.errors).toEqual(['BAD_VERSION']);
    expect(h.session.status).toBe('joined');
    h.socket.close(); // what WsClient does on close code 4000
    expect(h.left).toEqual([{ reason: 'connectionClosed', code: 'BAD_VERSION' }]);
    expect(h.store.getSession('K7PQ2')?.token).toBe('tok-1');
  });

  it('close 4001 (session resumed in another tab) ends the session with "replaced" and keeps the token', () => {
    const h = joinedHarness();
    const anyLeft: { code: string | null; reason: LeftReason }[] = [];
    const off = onAnySessionLeft((s, reason) => anyLeft.push({ code: s.code, reason }));
    h.socket.terminate(CLOSE_REPLACED);
    off();
    expect(h.left).toEqual([{ reason: 'replaced', code: undefined }]);
    expect(h.session.status).toBe('left');
    expect(h.store.getSession('K7PQ2')?.token).toBe('tok-1');
    expect(h.socket.ofType('rejoin')).toHaveLength(0); // no rejoin ping-pong
    expect(h.socket.closeCalls).toBe(1);
    expect(anyLeft).toEqual([{ code: 'K7PQ2', reason: 'replaced' }]);
  });

  it('errors while joined are informational and keep the session alive', () => {
    const h = joinedHarness();
    h.socket.emit({ t: 'error', code: 'NOT_HOST', message: 'nope' });
    h.socket.emit({ t: 'error', code: 'INVALID_COURSE', message: 'bad', issues: [{ level: 'error', code: 'NO_HOLE', message: 'no hole' }] });
    expect(h.errors).toEqual(['NOT_HOST', 'INVALID_COURSE']);
    expect(h.session.status).toBe('joined');
    expect(h.left).toEqual([]);
  });
});

describe('leave and destroy', () => {
  it('leave sends leaveRoom, clears the token, closes the socket and notifies left("left")', () => {
    const h = joinedHarness();
    h.session.leave();
    expect(h.socket.last()).toEqual({ t: 'leaveRoom' });
    expect(h.store.getSession('K7PQ2')).toBeNull();
    expect(h.socket.closeCalls).toBe(1);
    expect(h.session.status).toBe('left');
    expect(h.left).toEqual([{ reason: 'left', code: undefined }]);
    h.session.leave(); // idempotent
    expect(h.socket.ofType('leaveRoom')).toHaveLength(1);
    // a late server message changes nothing
    h.socket.emit({ t: 'roomLeft', reason: 'left' });
    expect(h.left).toHaveLength(1);
  });

  it('leave while reconnecting ends the session at once but delivers leaveRoom after the rejoin', () => {
    const h = joinedHarness();
    h.socket.drop();
    expect(h.session.status).toBe('reconnecting');
    h.session.leave();
    expect(h.session.status).toBe('left');
    expect(h.left).toEqual([{ reason: 'left', code: undefined }]);
    expect(h.store.getSession('K7PQ2')).toBeNull();
    expect(h.socket.closeCalls).toBe(0); // the socket stays alive for the deferred leave
    h.session.destroy(); // what setActiveHost(null) does right after leave(): must not kill the deferred leave
    expect(h.socket.closeCalls).toBe(0);
    h.socket.ready(true);
    expect(h.socket.last()).toEqual({ t: 'rejoin', code: 'K7PQ2', sessionToken: 'tok-1' });
    h.socket.emit(joined('K7PQ2', 'me', 'player', lobbyState([me, other]), 'tok-9'));
    expect(h.socket.last()).toEqual({ t: 'leaveRoom' });
    expect(h.socket.closeCalls).toBe(1);
    expect(h.store.getSession('K7PQ2')).toBeNull(); // the fresh token of the detached rejoin is not stored
    expect(h.left).toHaveLength(1);
  });

  it('leave while rejoining (rejoin already sent) sends leaveRoom on the roomJoined that follows', () => {
    const h = joinedHarness();
    h.socket.drop();
    h.socket.ready(true);
    expect(h.session.status).toBe('rejoining');
    h.session.leave();
    expect(h.socket.ofType('rejoin')).toHaveLength(1);
    h.socket.emit(joined('K7PQ2', 'me', 'player', lobbyState([me, other])));
    expect(h.socket.ofType('leaveRoom')).toHaveLength(1);
    expect(h.socket.closeCalls).toBe(1);
  });

  it('a deferred leave gives up when the rejoin is rejected', () => {
    const h = joinedHarness();
    h.socket.drop();
    h.session.leave();
    h.socket.ready(true);
    h.socket.emit({ t: 'error', code: 'SESSION_EXPIRED', message: 'gone' });
    expect(h.socket.ofType('leaveRoom')).toHaveLength(0);
    expect(h.socket.closeCalls).toBe(1);
    expect(h.left).toEqual([{ reason: 'left', code: undefined }]);
    expect(h.errors).toEqual([]); // the ended session no longer reports anything
  });

  it('leave before joining just closes the socket without leaveRoom', () => {
    const h = harness({ kind: 'create', name: 'Maija', colour: 2 });
    h.session.leave();
    expect(h.socket.ofType('leaveRoom')).toHaveLength(0);
    expect(h.socket.closeCalls).toBe(1);
    expect(h.session.status).toBe('left');
  });

  it('destroy closes the socket, drops listeners and keeps the stored token (a reload can rejoin)', () => {
    const h = joinedHarness();
    h.session.destroy();
    expect(h.socket.closeCalls).toBe(1);
    expect(h.store.getSession('K7PQ2')?.token).toBe('tok-1');
    expect(h.left).toEqual([]);
    expect(h.session.status).toBe('left');
    h.socket.emit({ t: 'chat', from: null, text: 'x', atMs: 0 });
    expect(h.session.chat!.messages()).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('coursesToRefs keeps built-ins as ids and ships custom courses in full', () => {
    const custom: Course = { ...course, id: 'c_0123456789abcdef', name: 'Oma' };
    const fakeBuiltin: Course = { ...course, id: 'b_42' }; // reserved shape but not a shipped built-in
    const refs = coursesToRefs([course, custom, fakeBuiltin]);
    expect(refs[0]).toEqual({ kind: 'builtin', id: 'b_01' });
    expect(refs[1]).toEqual({ kind: 'custom', course: custom });
    expect(refs[2]).toEqual({ kind: 'custom', course: fakeBuiltin });
  });

  it('startBlockReason mirrors canStart with two players required', () => {
    expect(startBlockReason(lobbyState([me]))).toBe(ErrorCode.NOT_ENOUGH_PLAYERS);
    expect(startBlockReason(lobbyState([me, player('other', 'Ville', 0, 2, false)]))).toBe(ErrorCode.PLAYERS_NOT_READY);
    expect(startBlockReason(lobbyState([me, other]))).toBeNull();
    expect(startBlockReason(playingState([me, other]))).toBe(ErrorCode.NOT_IN_LOBBY);
  });

  it('errorText localizes known codes and falls back to the server message', () => {
    expect(errorText('ROOM_FULL')).toBe('Huone on täynnä.');
    expect(errorText('SOMETHING_NEW', 'dev text')).toBe('dev text');
    expect(errorText('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('GameStateJson round trip through the session keeps typed arrays', () => {
    const json: GameStateJson = gameStateToJson(playingState([me, other]));
    const h = joinedHarness('player', playingState([me, other]));
    expect(h.session.getState().world!.walls.length).toBe(json.world!.walls.length);
  });
});
