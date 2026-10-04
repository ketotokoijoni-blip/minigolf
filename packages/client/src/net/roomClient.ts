// RoomSession (DESIGN §12.5, §6.5): the multiplayer GameHost. Holds the GameState (gameStateFromJson on roomJoined /
// roomState, applyEvent on event, requestSnapshot on ReducerError), the member id and role (localPlayerId is '' for a
// spectator), the chat ring buffer (cleared on every roomJoined — the server resends the last 50 lines), and the
// lobby actions the lobby screen needs. The constructor resets the sim tuning (D14) and opens the socket; `hello`
// then `rejoin` after every reconnect is driven by the socket's ready event.
//
// GameHost.subscribe(HostListener) and ChatApi.subscribe(messagesListener) share a method name, so the ChatApi is
// exposed as the `chat` member object bound to this session instead of being implemented on the same object.
import { MAX_COURSES_PER_SET } from '@puttipeli/shared/constants';
import { findBuiltin } from '@puttipeli/shared/course/builtin';
import { isBuiltinId } from '@puttipeli/shared/course/canonical';
import type { Course, CourseRef, ValidationIssue } from '@puttipeli/shared/course/types';
import type { GameEvent } from '@puttipeli/shared/game/events';
import { createLobbyState, DEFAULT_ROOM_SETTINGS } from '@puttipeli/shared/game/initial';
import { applyEvent, ReducerError } from '@puttipeli/shared/game/reducer';
import { isMyTurn } from '@puttipeli/shared/game/selectors';
import { gameStateFromJson } from '@puttipeli/shared/game/serialize';
import { canStart } from '@puttipeli/shared/game/turns';
import type { GameState, PlayerColour, RoomSettings } from '@puttipeli/shared/game/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import { MAX_CHAT_CHARS } from '@puttipeli/shared/protocol/limits';
import type { ClientMessage, ServerMessage } from '@puttipeli/shared/protocol/messages';
import { normalizeRoomCode } from '@puttipeli/shared/protocol/roomCode';
import type { ShotInput } from '@puttipeli/shared/sim/types';
import { resetSimTuning } from '@puttipeli/shared/sim/tuning';
import type { ChatApi, ChatMessage, GameHost, HostListener } from '../game/gameHost';
import { t } from '../i18n/t';
// The multiplayer dictionaries self-register on import (D26); importing them here makes errorText() and the
// chat.* system lines available to every consumer of RoomSession, not only to the WP-H screens.
import '../i18n/fi.mp';
import '../i18n/en.mp';
import { getSessionStore, type SessionStore } from './session';
import { CLOSE_REPLACED, WsClient, type RoomSocket, type SocketStatus } from './socket';

export type MemberRole = 'player' | 'spectator';

export type JoinRequest =
  | { kind: 'create'; name: string; colour: PlayerColour; settings?: Partial<RoomSettings> }
  | { kind: 'join'; code: string; name: string; colour: PlayerColour; asSpectator?: boolean }
  | { kind: 'rejoin'; code: string; token: string; name: string; colour: PlayerColour };

/**
 * connecting: socket not ready yet · joining: create/join sent · joined: in the room · reconnecting: socket lost,
 * backing off · rejoining: `rejoin` sent after a reconnect · left: the session is over (we left, were removed, the
 * room closed, the session expired, the join failed or the socket closed for good).
 */
export type SessionStatus = 'connecting' | 'joining' | 'joined' | 'reconnecting' | 'rejoining' | 'left';

/**
 * left: our own leave() · removed/roomClosed: server roomLeft · sessionExpired: the seat is gone · joinFailed: the
 * create/join/rejoin request was rejected · connectionClosed: the socket closed for good (BAD_VERSION) · replaced:
 * another tab resumed the same session token (server close 4001); the token is kept, the seat lives on over there.
 */
export type LeftReason = 'left' | 'removed' | 'roomClosed' | 'sessionExpired' | 'joinFailed' | 'connectionClosed' | 'replaced';
export type LeftListener = (reason: LeftReason, code?: ErrorCode, message?: string) => void;
export type AnySessionLeftListener = (session: RoomSession, reason: LeftReason, code?: ErrorCode, message?: string) => void;
export type ErrorListener = (code: string, message: string, issues?: ValidationIssue[]) => void;
export interface JoinedInfo { code: string; playerId: string; role: MemberRole; rejoin: boolean }

export interface RoomSessionDeps {
  socket?: RoomSocket;
  sessions?: SessionStore;
  now?: () => number;
}

export const MAX_CHAT_MESSAGES = 200;
/** At most one requestSnapshot per second, so a burst of rejected events does not flood the server. */
export const SNAPSHOT_MIN_INTERVAL_MS = 1000;
/** A leave() issued while reconnecting waits this long for the rejoin before giving up on telling the server. */
export const DEFERRED_LEAVE_TIMEOUT_MS = 30_000;

// Module-level "any session ended" listeners (DESIGN §10.8, §12.1): the end-of-session dialogs must appear whatever
// screen is mounted (the play view does not know RoomSession), so the UX handler registers once here instead of on
// each session from a screen. Invoked after the session's own left listeners; never for destroy().
const anySessionLeftListeners = new Set<AnySessionLeftListener>();
export function onAnySessionLeft(listener: AnySessionLeftListener): () => void {
  anySessionLeftListeners.add(listener);
  return () => { anySessionLeftListeners.delete(listener); };
}

type RoomJoinedMsg = Extract<ServerMessage, { t: 'roomJoined' }>;
type RoomStateMsg = Extract<ServerMessage, { t: 'roomState' }>;
type ChatMsg = Extract<ServerMessage, { t: 'chat' }>;
type ErrorMsg = Extract<ServerMessage, { t: 'error' }>;
type RoomLeftMsg = Extract<ServerMessage, { t: 'roomLeft' }>;

function safe(fn: () => void, what: string): void {
  try { fn(); } catch (err) { console.error(`[mp] ${what} failed`, err); }
}

/** Server courses back to wire refs: built-ins by id (R13: ids are reserved), everything else as full data. */
export function coursesToRefs(courses: readonly Course[]): CourseRef[] {
  return courses.map((c): CourseRef => (isBuiltinId(c.id) && findBuiltin(c.id) ? { kind: 'builtin', id: c.id } : { kind: 'custom', course: c }));
}

/** Why "Aloita peli" is disabled (multiplayer needs 2 players), or null when the host may start. */
export function startBlockReason(state: GameState): ErrorCode | null {
  return canStart(state, 2);
}

/** Localized error text: t('error.' + code) with the server's English message as the fallback (§6.4). */
export function errorText(code: string, message?: string): string {
  const key = `error.${code}`;
  const s = t(key);
  return s === key ? (message || code) : s;
}

export class RoomSession implements GameHost {
  readonly kind = 'remote' as const;
  readonly chat: ChatApi;
  /** Room code: known at once for join/rejoin requests, after roomJoined for a created room. */
  code: string | null;

  private memberId = '';
  private role: MemberRole = 'spectator';
  private token: string | null = null;
  private profile: { name: string; colour: PlayerColour };
  private state: GameState;
  private _status: SessionStatus = 'connecting';
  private ended = false;
  private joinedOnce = false;
  private chatBuf: ChatMessage[] = [];
  private chatSeq = 0;
  private lastSnapshotRequestAt = Number.NEGATIVE_INFINITY;
  private lastErrorCode: ErrorCode | null = null;
  private lastErrorMessage: string | null = null;
  /** True while a leave() issued during a reconnect is still being delivered on the detached socket. */
  private leaveDeferred = false;

  private readonly socket: RoomSocket;
  private readonly sessions: SessionStore;
  private readonly now: () => number;
  private readonly offs: (() => void)[] = [];
  private readonly hostListeners = new Set<HostListener>();
  private readonly chatListeners = new Set<(messages: readonly ChatMessage[]) => void>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly statusListeners = new Set<(status: SessionStatus) => void>();
  private readonly joinedListeners = new Set<(info: JoinedInfo) => void>();
  private readonly leftListeners = new Set<LeftListener>();

  constructor(readonly request: JoinRequest, deps: RoomSessionDeps = {}) {
    resetSimTuning(); // §5.7: a multiplayer session always simulates with the default tuning
    this.socket = deps.socket ?? new WsClient();
    this.sessions = deps.sessions ?? getSessionStore();
    this.now = deps.now ?? (() => Date.now());
    this.state = createLobbyState(DEFAULT_ROOM_SETTINGS, []);
    this.code = request.kind === 'create' ? null : normalizeRoomCode(request.code);
    this.profile = { name: request.name, colour: request.colour };
    if (request.kind === 'rejoin') this.token = request.token;
    this.chat = {
      messages: () => this.chatBuf,
      send: (text) => this.sendChat(text),
      subscribe: (listener) => {
        this.chatListeners.add(listener);
        return () => { this.chatListeners.delete(listener); };
      },
    };
    this.offs.push(
      this.socket.onReady((reconnect) => this.onSocketReady(reconnect)),
      this.socket.onStatus((s) => this.onSocketStatus(s)),
      this.socket.on('roomJoined', (m) => this.onRoomJoined(m)),
      this.socket.on('roomState', (m) => this.onRoomState(m)),
      this.socket.on('event', (m) => this.onEvent(m.ev)),
      this.socket.on('chat', (m) => this.onChat(m)),
      this.socket.on('error', (m) => this.onServerError(m)),
      this.socket.on('roomLeft', (m) => this.onRoomLeft(m)),
    );
    this.socket.connect();
  }

  // ------------------------------------------------------------------------------------------------ identity

  /** Alias of `code` for consumers that look for a room code on a remote host (WP-G's play view). */
  get roomCode(): string | null { return this.code; }
  /** '' for a spectator (GameHost contract); the member id itself is private and used for chat/rejoin. */
  get localPlayerId(): string { return this.role === 'player' ? this.memberId : ''; }
  get isSpectator(): boolean { return this.role !== 'player'; }
  get isHost(): boolean { return this.memberId !== '' && this.state.hostId === this.memberId; }
  /** True for the local member id, player or spectator (list highlighting). */
  isMe(id: string): boolean { return this.memberId !== '' && id === this.memberId; }
  get status(): SessionStatus { return this._status; }
  get socketStatus(): SocketStatus { return this.socket.status; }
  /** True once a roomJoined has been received by this session object. */
  get hasJoined(): boolean { return this.joinedOnce; }
  /** Name and colour as the server last confirmed them (or as requested before the join). */
  get currentProfile(): { name: string; colour: PlayerColour } { return { ...this.profile }; }

  // ------------------------------------------------------------------------------------------------ GameHost

  getState(): GameState { return this.state; }

  subscribe(listener: HostListener): () => void {
    this.hostListeners.add(listener);
    safe(() => listener(this.state, null, null), 'host listener');
    return () => { this.hostListeners.delete(listener); };
  }

  /** No-op unless phase 'hole', it is my turn and no shot is in flight (the server re-validates anyway). */
  shoot(shot: ShotInput): void {
    const id = this.localPlayerId;
    const turn = this.state.turn;
    if (!id || !turn || this.state.phase !== 'hole' || !isMyTurn(this.state, id)) return;
    this.sendMsg({ t: 'shoot', holeIndex: this.state.holeIndex, turnSeq: turn.turnSeq, shot });
  }

  summaryReady(): void {
    const id = this.localPlayerId;
    const ph = this.state.phase;
    if (!id || (ph !== 'holeSummary' && ph !== 'roundSummary') || this.state.summaryReady[id]) return;
    this.sendMsg({ t: 'summaryReady' });
  }

  backToLobby(): void {
    if (this.state.phase !== 'roundSummary' || !this.isHost) return;
    this.sendMsg({ t: 'backToLobby' });
  }

  restart(): void { /* single player only ("Pelaa uudelleen"); the host returns to the lobby instead */ }

  requestSnapshot(): void {
    const now = this.now();
    if (now - this.lastSnapshotRequestAt < SNAPSHOT_MIN_INTERVAL_MS) return;
    this.lastSnapshotRequestAt = now;
    this.sendMsg({ t: 'requestSnapshot' });
  }

  nowAuthorityMs(): number { return this.now() + this.socket.clockOffsetMs; }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => { this.errorListeners.delete(listener); };
  }

  /**
   * Sends leaveRoom, clears the session token and stops reconnecting. Left listeners get 'left' at once. When the
   * socket is down (reconnecting/rejoining) the seat would otherwise stay occupied for the whole grace period, so the
   * leave is deferred: the socket is kept alive detached from this session until the rejoin succeeds, then leaveRoom
   * is sent and the socket closed (or it gives up when the rejoin fails, the socket dies or the timeout passes).
   */
  leave(): void {
    if (this.ended) return;
    const sent = this._status === 'joined' && this.sendMsg({ t: 'leaveRoom' });
    if (!sent && this.token && this.code && this.joinedOnce) this.deferLeave(this.code, this.token);
    this.endSession('left');
  }

  /** Releases the socket and every listener without leaving the room: the stored token still allows a rejoin. */
  destroy(): void {
    this.ended = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (!this.leaveDeferred) this.socket.close();
    this.hostListeners.clear();
    this.chatListeners.clear();
    this.errorListeners.clear();
    this.statusListeners.clear();
    this.joinedListeners.clear();
    this.leftListeners.clear();
    this._status = 'left';
  }

  // ------------------------------------------------------------------------------------------------ session events

  onStatus(listener: (status: SessionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  /** After every roomJoined (initial join and every successful rejoin). */
  onJoined(listener: (info: JoinedInfo) => void): () => void {
    this.joinedListeners.add(listener);
    return () => { this.joinedListeners.delete(listener); };
  }

  /** When the session ends for any reason (including our own leave()). */
  onLeft(listener: LeftListener): () => void {
    this.leftListeners.add(listener);
    return () => { this.leftListeners.delete(listener); };
  }

  // ------------------------------------------------------------------------------------------------ lobby actions

  setReady(ready: boolean): boolean {
    if (!this.localPlayerId) return false;
    return this.sendMsg({ t: 'setReady', ready });
  }

  setProfile(patch: { name?: string; colour?: PlayerColour }): boolean {
    if (!this.localPlayerId) return false;
    const msg: Extract<ClientMessage, { t: 'setProfile' }> = { t: 'setProfile' };
    if (patch.name !== undefined) msg.name = patch.name;
    if (patch.colour !== undefined) msg.colour = patch.colour;
    return this.sendMsg(msg);
  }

  setSettings(settings: Partial<RoomSettings>): boolean {
    return this.sendMsg({ t: 'setSettings', settings });
  }

  /** 1..MAX_COURSES_PER_SET refs; returns false (nothing sent) otherwise. */
  setCourses(courses: CourseRef[]): boolean {
    if (courses.length < 1 || courses.length > MAX_COURSES_PER_SET) return false;
    return this.sendMsg({ t: 'setCourses', courses });
  }

  startGame(): boolean { return this.sendMsg({ t: 'startGame' }); }

  becomePlayer(): boolean {
    if (this.role !== 'spectator') return false;
    return this.sendMsg({ t: 'becomePlayer' });
  }

  // ------------------------------------------------------------------------------------------------ internals

  private sendMsg(msg: ClientMessage): boolean {
    if (this.ended) return false;
    return this.socket.send(msg);
  }

  private sendChat(text: string): void {
    const trimmed = text.trim().slice(0, MAX_CHAT_CHARS);
    if (!trimmed || this._status !== 'joined') return;
    this.sendMsg({ t: 'chat', text: trimmed });
  }

  private onSocketReady(reconnect: boolean): void {
    if (this.ended) return;
    if (this.token && this.code) {
      this.setStatus('rejoining');
      this.sendMsg({ t: 'rejoin', code: this.code, sessionToken: this.token });
      return;
    }
    if (reconnect && this.joinedOnce) {
      // Joined before but no token to resume with: the seat cannot be reclaimed.
      this.endSession('sessionExpired');
      return;
    }
    const r = this.request;
    this.setStatus('joining');
    if (r.kind === 'create') {
      this.sendMsg(r.settings ? { t: 'createRoom', name: r.name, colour: r.colour, settings: r.settings } : { t: 'createRoom', name: r.name, colour: r.colour });
    } else if (r.kind === 'join') {
      this.sendMsg(r.asSpectator ? { t: 'joinRoom', code: this.code!, name: r.name, colour: r.colour, asSpectator: true } : { t: 'joinRoom', code: this.code!, name: r.name, colour: r.colour });
    }
  }

  private onSocketStatus(s: SocketStatus): void {
    if (this.ended) return;
    if (s === 'reconnecting') this.setStatus('reconnecting');
    else if (s === 'closed') {
      if (this.socket.closeCode === CLOSE_REPLACED) this.endSession('replaced');
      else this.endSession('connectionClosed', this.lastErrorCode ?? undefined, this.lastErrorMessage ?? undefined);
    }
  }

  /** Finishes a leave() on the socket after this session has ended (see leave()). */
  private deferLeave(code: string, token: string): void {
    const sock = this.socket;
    this.leaveDeferred = true;
    const offs: (() => void)[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const off of offs) off();
      this.leaveDeferred = false;
      sock.close();
    };
    const timer = setTimeout(finish, DEFERRED_LEAVE_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.(); // never keeps a Node process (tests, scripts) alive
    offs.push(
      sock.onReady(() => { sock.send({ t: 'rejoin', code, sessionToken: token }); }),
      sock.on('roomJoined', () => { sock.send({ t: 'leaveRoom' }); finish(); }),
      sock.on('error', () => finish()), // SESSION_EXPIRED / ROOM_NOT_FOUND / BAD_VERSION: nothing left to release
      sock.on('roomLeft', () => finish()),
      sock.onStatus((s) => { if (s === 'closed') finish(); }),
    );
  }

  private onRoomJoined(m: RoomJoinedMsg): void {
    if (this.ended) return;
    const rejoin = this.joinedOnce;
    const prev = this.state;
    this.code = m.code;
    this.memberId = m.playerId;
    this.role = m.role;
    this.token = m.sessionToken;
    this.state = gameStateFromJson(m.state);
    this.joinedOnce = true;
    this.refreshProfileFromState();
    this.persistSession();
    this.sessions.rememberRecent(m.code);
    this.clearChat();
    this.setStatus('joined');
    this.notify(null, prev);
    const info: JoinedInfo = { code: m.code, playerId: m.playerId, role: m.role, rejoin };
    for (const l of [...this.joinedListeners]) safe(() => l(info), 'joined listener');
  }

  private onRoomState(m: RoomStateMsg): void {
    if (this.ended || !this.joinedOnce) return;
    const prev = this.state;
    this.state = gameStateFromJson(m.state); // full replacement, no merging (§6.4)
    this.notify(null, prev);
  }

  private onEvent(ev: GameEvent): void {
    if (this.ended || this._status !== 'joined') return; // the snapshot that follows a (re)join already contains it
    const prev = this.state;
    let next: GameState;
    try {
      next = applyEvent(prev, ev);
    } catch (err) {
      if (err instanceof ReducerError) console.warn(`[mp] reducer rejected ${ev.type} (${err.message}); requesting a snapshot`);
      else console.error(`[mp] applying ${ev.type} failed; requesting a snapshot`, err);
      this.requestSnapshot();
      return;
    }
    this.state = next;
    this.trackSelf(ev);
    this.notify(ev, prev);
  }

  /** Role/profile changes that concern the local member (spectator -> player, name/colour confirmed by the server). */
  private trackSelf(ev: GameEvent): void {
    if (ev.type === 'playerJoined' && ev.player.id === this.memberId && this.role !== 'player') {
      this.role = 'player';
      this.profile = { name: ev.player.name, colour: ev.player.colour };
      this.persistSession();
    } else if (ev.type === 'profileChanged' && ev.playerId === this.memberId) {
      this.profile = { name: ev.name, colour: ev.colour };
      this.persistSession();
    }
  }

  private refreshProfileFromState(): void {
    const me = this.state.players.find((p) => p.id === this.memberId);
    if (me) { this.profile = { name: me.name, colour: me.colour }; return; }
    const sp = this.state.spectators.find((s) => s.id === this.memberId);
    if (sp) this.profile = { ...this.profile, name: sp.name };
  }

  private persistSession(): void {
    if (!this.code || !this.token) return;
    this.sessions.setSession({ code: this.code, token: this.token, playerId: this.memberId, role: this.role, name: this.profile.name, colour: this.profile.colour, savedAt: this.now() });
  }

  private onChat(m: ChatMsg): void {
    if (this.ended) return;
    const msg: ChatMessage = { seq: ++this.chatSeq, from: m.from, text: m.text, key: m.key, params: m.params, atMs: m.atMs };
    this.chatBuf.push(msg);
    if (this.chatBuf.length > MAX_CHAT_MESSAGES) this.chatBuf.splice(0, this.chatBuf.length - MAX_CHAT_MESSAGES);
    this.notifyChat();
  }

  private clearChat(): void {
    if (this.chatBuf.length === 0) return;
    this.chatBuf = [];
    this.notifyChat();
  }

  private onServerError(m: ErrorMsg): void {
    if (this.ended) return;
    const code = m.code;
    this.lastErrorCode = code;
    this.lastErrorMessage = m.message;
    for (const l of [...this.errorListeners]) safe(() => l(code, m.message, m.issues), 'error listener');
    if (code === ErrorCode.BAD_VERSION) return; // the socket closes with 4000 next -> 'connectionClosed'
    if (this._status === 'joining') {
      this.endSession('joinFailed', code, m.message);
      return;
    }
    if (this._status === 'rejoining') {
      if (code === ErrorCode.SESSION_EXPIRED) {
        this.token = null;
        if (this.code) this.sessions.clearSession(this.code);
        if (this.joinedOnce && this.role === 'spectator' && this.code) {
          // §10.6: a spectator seat is dropped at once on disconnect; re-join automatically as a spectator.
          this.setStatus('joining');
          this.sendMsg({ t: 'joinRoom', code: this.code, name: this.profile.name, colour: this.profile.colour, asSpectator: true });
          return;
        }
        this.endSession('sessionExpired', code, m.message);
        return;
      }
      this.endSession('joinFailed', code, m.message);
    }
    // While joined, errors such as NOT_HOST / INVALID_COURSE / NOT_YOUR_TURN are informational.
  }

  private onRoomLeft(m: RoomLeftMsg): void {
    if (this.ended) return;
    this.endSession(m.reason);
  }

  private endSession(reason: LeftReason, code?: ErrorCode, message?: string): void {
    if (this.ended) return;
    this.ended = true;
    // A fatal socket close (version mismatch) keeps the token: after the reload the seat may still be resumable.
    // 'replaced' keeps it too: the seat is alive in another tab and "Palaa huoneeseen" may take it back on purpose.
    const keepToken = reason === 'connectionClosed' || reason === 'replaced';
    if (!keepToken && this.code) this.sessions.clearSession(this.code);
    if (!keepToken) this.token = null;
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (!this.leaveDeferred) this.socket.close();
    this.setStatus('left');
    for (const l of [...this.leftListeners]) safe(() => l(reason, code, message), 'left listener');
    for (const l of [...anySessionLeftListeners]) safe(() => l(this, reason, code, message), 'session-left listener');
  }

  private notify(ev: GameEvent | null, prev: GameState | null): void {
    for (const l of [...this.hostListeners]) safe(() => l(this.state, ev, prev), 'host listener');
  }

  private notifyChat(): void {
    for (const l of [...this.chatListeners]) safe(() => l(this.chatBuf), 'chat listener');
  }

  private setStatus(s: SessionStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const l of [...this.statusListeners]) safe(() => l(s), 'status listener');
  }
}
