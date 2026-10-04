// Room: membership, sessions, chat ring buffer and message handling (DESIGN §11.3, §11.5, §11.6).
//
// *** PHASE 1 SKELETON *** — the membership layer below (members, tokens, rejoin, disconnect, broadcast, chat log,
// system lines) is final. Everything that concerns the game itself is a clearly marked PHASE 1 STUB that WP-F phase 2
// replaces with the shared `Authority` (game/authority.ts, WP-C):
//   - `state()` builds a lobby GameStateJson from the member list instead of `gameStateToJson(authority.state)`;
//   - join/leave/profile/ready/settings emit their events directly instead of through Authority;
//   - the lobby disconnect timer lives here instead of `Authority.connection()`;
//   - setCourses / startGame / backToLobby / shoot / summaryReady / becomePlayer answer with a stub error.
import { randomUUID } from 'node:crypto';
import { DEFAULT_TURN_TIMEOUT_SEC, HOLE_SUMMARY_SEC, LOBBY_DISCONNECT_REMOVE_SEC, MAX_SPECTATORS } from '@puttipeli/shared/constants';
import type { GameEvent } from '@puttipeli/shared/game/events';
import type { GameStateJson, Phase, PlayerColour, PlayerState, RoomSettings, SpectatorState } from '@puttipeli/shared/game/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import type { ChatFrom, ClientMessage, ServerMessage } from '@puttipeli/shared/protocol/messages';
import type { Clock, TimerHandle } from '../clock';
import type { Logger } from '../log';
import { CLOSE_REPLACED, type ClientSession, type MemberRole } from '../ws/connection';
import { generateSessionToken, namesEqual, pickColour, pickHost, sanitizeChatText, sanitizeName, tokensEqual } from './session';

export const CHAT_BACKLOG = 50;

export interface Member {
  id: string;
  session: ClientSession | null; // null while disconnected (grace)
  token: string;
  role: MemberRole;
  name: string;
  colour: PlayerColour;
  ready: boolean;
  connected: boolean;
  joinedSeq: number;
}

export type ChatLine = Extract<ServerMessage, { t: 'chat' }>;
export type RoomLeftReason = Extract<ServerMessage, { t: 'roomLeft' }>['reason'];

export interface RoomDeps {
  clock: Clock;
  log: Logger;
  /** Called whenever the member list changes (RoomManager removes a room with no members). */
  onMembersChanged?: (room: Room) => void;
}

const PLAYER_ONLY: ReadonlySet<ClientMessage['t']> = new Set(['setProfile', 'setReady', 'setCourses', 'setSettings', 'startGame', 'backToLobby', 'shoot', 'summaryReady']);

/**
 * PHASE 1 STUB of game/initial.ts `normalizeSettings` (WP-C): defaults + clamp maxPlayers to the current player count.
 * The parser has already restricted every field to its allowed literal values.
 */
export function normalizeSettingsLocal(partial: Partial<RoomSettings> | undefined, minPlayers: number, base?: RoomSettings): RoomSettings {
  const s: RoomSettings = {
    maxPlayers: base?.maxPlayers ?? 4,
    turnTimeoutSec: base?.turnTimeoutSec ?? (DEFAULT_TURN_TIMEOUT_SEC as RoomSettings['turnTimeoutSec']),
    holeSummarySec: base?.holeSummarySec ?? (HOLE_SUMMARY_SEC as RoomSettings['holeSummarySec']),
    ballCollision: false,
  };
  if (partial?.maxPlayers !== undefined) s.maxPlayers = partial.maxPlayers;
  if (partial?.turnTimeoutSec !== undefined) s.turnTimeoutSec = partial.turnTimeoutSec;
  if (partial?.holeSummarySec !== undefined) s.holeSummarySec = partial.holeSummarySec;
  const floor = Math.min(4, Math.max(2, minPlayers)) as RoomSettings['maxPlayers'];
  if (s.maxPlayers < floor) s.maxPlayers = floor;
  return s;
}

export class Room {
  readonly createdAt: number;
  lastActivity: number;
  /** Clock time since no member has had a live connection; null while anyone is connected. */
  emptySince: number | null;
  readonly members = new Map<string, Member>();
  settings: RoomSettings;
  hostId: string | null = null;
  private seq = 0;
  private lastJoinedSeq = 0;
  private readonly chatLog: ChatLine[] = [];
  private readonly disconnectTimers = new Map<string, TimerHandle>();
  private closed = false;

  constructor(
    readonly code: string,
    settings: Partial<RoomSettings> | undefined,
    private readonly deps: RoomDeps,
  ) {
    this.createdAt = deps.clock.now();
    this.lastActivity = this.createdAt;
    this.emptySince = this.createdAt;
    this.settings = normalizeSettingsLocal(settings, 2);
  }

  /** PHASE 1 STUB: always lobby (phase 2: authority.state.phase). */
  get phase(): Phase {
    return 'lobby';
  }

  players(): Member[] {
    return [...this.members.values()].filter((m) => m.role === 'player').sort((a, b) => a.joinedSeq - b.joinedSeq);
  }

  spectators(): Member[] {
    return [...this.members.values()].filter((m) => m.role === 'spectator').sort((a, b) => a.joinedSeq - b.joinedSeq);
  }

  connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.session) n++;
    return n;
  }

  hasFreeSeat(): boolean {
    return this.players().length < this.settings.maxPlayers;
  }

  memberOf(session: ClientSession): Member | null {
    const id = session.playerId;
    if (id === null || session.roomCode !== this.code) return null;
    const m = this.members.get(id);
    return m && m.session === session ? m : null;
  }

  // -------------------------------------------------------------------------------------------- joining

  addPlayer(session: ClientSession, rawName: string, colour: PlayerColour): ErrorCode | null {
    if (this.closed) return ErrorCode.ROOM_NOT_FOUND;
    if (this.phase !== 'lobby') return ErrorCode.GAME_IN_PROGRESS;
    if (!this.hasFreeSeat()) return ErrorCode.ROOM_FULL;
    const name = sanitizeName(rawName);
    if (this.nameTaken(name)) return ErrorCode.NAME_TAKEN;
    const member = this.createMember(session, 'player', name, pickColour(colour, this.players().map((p) => p.colour)));
    if (this.hostId === null || !this.members.has(this.hostId)) this.hostId = member.id; // reducer rule on playerJoined
    // PHASE 1 STUB: phase 2 calls authority.join(player) which emits this.
    this.emit({ type: 'playerJoined', player: this.playerState(member) }, member);
    session.send(this.roomJoinedFor(member));
    this.systemLine('chat.playerJoined', { name: member.name });
    this.touch();
    this.deps.onMembersChanged?.(this);
    return null;
  }

  addSpectator(session: ClientSession, rawName: string, colour: PlayerColour): ErrorCode | null {
    if (this.closed) return ErrorCode.ROOM_NOT_FOUND;
    if (this.spectators().length >= MAX_SPECTATORS) return ErrorCode.ROOM_FULL;
    const name = sanitizeName(rawName);
    const member = this.createMember(session, 'spectator', name, colour);
    // PHASE 1 STUB: phase 2 calls authority.spectatorJoin(s).
    this.emit({ type: 'spectatorJoined', spectator: { id: member.id, name: member.name } }, member);
    session.send(this.roomJoinedFor(member));
    this.systemLine('chat.spectatorJoined', { name: member.name });
    this.touch();
    this.deps.onMembersChanged?.(this);
    return null;
  }

  /** Swaps the connection of the member owning `token`; SESSION_EXPIRED when nobody does or the room is gone (§11.3, §11.5). */
  rejoin(session: ClientSession, token: string): ErrorCode | null {
    if (this.closed) return ErrorCode.SESSION_EXPIRED;
    let member: Member | null = null;
    for (const m of this.members.values()) if (tokensEqual(m.token, token)) member = m;
    if (!member) return ErrorCode.SESSION_EXPIRED;

    const old = member.session;
    if (old && old !== session) {
      old.clearRoom();
      old.close(CLOSE_REPLACED, 'session resumed elsewhere');
    }
    this.cancelDisconnectTimer(member.id);
    member.session = session;
    this.updateEmptySince(); // a connection is back: the room is no longer a sweep candidate
    const wasConnected = member.connected;
    member.connected = true;
    session.playerId = member.id;
    session.roomCode = this.code;
    session.role = member.role;

    session.send(this.roomJoinedFor(member));
    // PHASE 1 STUB: phase 2 calls authority.connection(id, true) which emits this (and may restart the turn, §10.6).
    if (member.role === 'player' && !wasConnected) this.emit({ type: 'playerConnection', playerId: member.id, connected: true });
    for (const line of this.chatLog) session.send(line);
    this.touch();
    this.deps.log.debug('rejoin', { room: this.code, member: member.id, conn: session.id });
    return null;
  }

  // -------------------------------------------------------------------------------------------- messages

  handle(session: ClientSession, msg: ClientMessage): void {
    const member = this.memberOf(session);
    if (!member) {
      session.error(ErrorCode.NOT_IN_ROOM, 'Not a member of this room');
      return;
    }
    this.touch();
    // PHASE 2: authority.activity(member.id) for players (clears afk).

    if (member.role === 'spectator' && PLAYER_ONLY.has(msg.t)) {
      session.error(ErrorCode.NOT_A_PLAYER, 'Spectators cannot do that');
      return;
    }

    switch (msg.t) {
      case 'chat': {
        if (!session.acceptChat()) return;
        const text = sanitizeChatText(msg.text);
        if (text.length === 0) return;
        const from: ChatFrom = { id: member.id, name: member.name, colour: member.colour };
        this.pushChat({ t: 'chat', from, text, atMs: this.deps.clock.now() });
        return;
      }
      case 'leaveRoom':
        this.removeMember(member.id, 'left');
        return;
      case 'requestSnapshot':
        session.send(this.snapshotFor(session));
        return;
      case 'ping': // normally answered by the Gateway; harmless here
        session.send({ t: 'pong', t0: msg.t0, serverTimeMs: this.deps.clock.now() });
        return;

      // PHASE 1 STUBS of lobby actions (phase 2: authority.setProfile / setReady / setSettings).
      case 'setProfile': {
        if (this.phase !== 'lobby') {
          session.error(ErrorCode.NOT_IN_LOBBY, 'Profile can be changed in the lobby only');
          return;
        }
        if (msg.name !== undefined) {
          const name = sanitizeName(msg.name);
          if (!namesEqual(name, member.name) && this.nameTaken(name)) {
            session.error(ErrorCode.NAME_TAKEN, 'Name already used in this room');
            return;
          }
          member.name = name;
        }
        if (msg.colour !== undefined) {
          const others = this.players().filter((p) => p.id !== member.id).map((p) => p.colour);
          if (!others.includes(msg.colour)) member.colour = msg.colour; // taken colour: ignored (§6.4)
        }
        this.emit({ type: 'profileChanged', playerId: member.id, name: member.name, colour: member.colour });
        return;
      }
      case 'setReady':
        if (this.phase !== 'lobby') {
          session.error(ErrorCode.NOT_IN_LOBBY, 'Ready state applies in the lobby only');
          return;
        }
        if (member.ready !== msg.ready) {
          member.ready = msg.ready;
          this.emit({ type: 'readyChanged', playerId: member.id, ready: member.ready });
        }
        return;
      case 'setSettings': {
        if (this.hostId !== member.id) {
          session.error(ErrorCode.NOT_HOST, 'Only the host can change settings');
          return;
        }
        if (this.phase !== 'lobby') {
          session.error(ErrorCode.NOT_IN_LOBBY, 'Settings can be changed in the lobby only');
          return;
        }
        this.settings = normalizeSettingsLocal(msg.settings, this.players().length, this.settings);
        this.emit({ type: 'settingsChanged', settings: this.settings });
        return;
      }

      case 'setCourses':
      case 'startGame':
      case 'backToLobby':
      case 'shoot':
      case 'summaryReady':
      case 'becomePlayer':
        // PHASE 1 STUB: these need Authority + courseStore (phase 2).
        this.deps.log.debug('phase 1 stub rejected message', { room: this.code, t: msg.t });
        session.error(ErrorCode.INVALID_MESSAGE, `${msg.t} is not available yet (server phase 1)`);
        return;

      case 'hello':
      case 'createRoom':
      case 'joinRoom':
      case 'rejoin':
        session.error(ErrorCode.ALREADY_IN_ROOM, 'Already in a room');
        return;
    }
  }

  /** Socket lost: spectators leave immediately, players enter the disconnect grace (§10.6). */
  disconnected(session: ClientSession): void {
    const member = this.memberOf(session);
    if (!member) return;
    member.session = null;
    session.clearRoom();
    if (member.role === 'spectator') {
      this.removeMember(member.id, 'removed');
      return;
    }
    member.connected = false;
    // PHASE 1 STUB: phase 2 calls authority.connection(id, false), which emits playerConnection and owns the
    // LOBBY_DISCONNECT_REMOVE_SEC / DISCONNECT_GRACE_SEC timers (its `leave()` emits playerLeft).
    this.emit({ type: 'playerConnection', playerId: member.id, connected: false });
    this.cancelDisconnectTimer(member.id);
    const handle = this.deps.clock.setTimeout(() => {
      this.disconnectTimers.delete(member.id);
      if (this.members.get(member.id)?.session === null) this.removeMember(member.id, 'removed');
    }, LOBBY_DISCONNECT_REMOVE_SEC * 1000);
    this.disconnectTimers.set(member.id, handle);
    this.updateEmptySince();
  }

  // -------------------------------------------------------------------------------------------- output

  broadcast(msg: ServerMessage, except?: Member): void {
    for (const m of this.members.values()) if (m.session && m !== except) m.session.send(msg);
  }

  snapshotFor(session: ClientSession): ServerMessage {
    void session; // same snapshot for every member in v1 (no per-viewer data)
    return { t: 'roomState', state: this.state(), serverTimeMs: this.deps.clock.now() };
  }

  /** Last CHAT_BACKLOG chat lines (players and system), oldest first. */
  chatBacklog(): readonly ChatLine[] {
    return this.chatLog;
  }

  /** Closes the room: every connected member gets roomLeft{reason}; timers cleared; members forgotten. */
  close(reason: RoomLeftReason = 'roomClosed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.disconnectTimers.values()) this.deps.clock.clearTimeout(h);
    this.disconnectTimers.clear();
    for (const m of this.members.values()) {
      if (m.session) {
        m.session.send({ t: 'roomLeft', reason });
        m.session.clearRoom();
        m.session = null;
      }
    }
    this.members.clear();
    this.deps.log.info('room closed', { room: this.code, reason });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // -------------------------------------------------------------------------------------------- state (STUB)

  /** PHASE 1 STUB: lobby snapshot from the member list. Phase 2: gameStateToJson(authority.state). */
  state(): GameStateJson {
    return {
      phase: this.phase,
      settings: this.settings,
      hostId: this.hostId,
      players: this.players().map((m) => this.playerState(m)),
      spectators: this.spectators().map((m): SpectatorState => ({ id: m.id, name: m.name })),
      courses: [],
      seatOrder: [],
      holeIndex: -1,
      order: [],
      balls: {},
      shotOrigins: {},
      strokes: {},
      holeDone: {},
      world: null,
      turn: null,
      lastShot: null,
      summaryReady: {},
      ranking: null,
      countdownEndsAtMs: null,
      seq: this.seq,
    };
  }

  // -------------------------------------------------------------------------------------------- internals

  private createMember(session: ClientSession, role: MemberRole, name: string, colour: PlayerColour): Member {
    const member: Member = {
      id: randomUUID(),
      session,
      token: generateSessionToken(),
      role,
      name,
      colour,
      ready: false,
      connected: true,
      joinedSeq: ++this.lastJoinedSeq,
    };
    this.members.set(member.id, member);
    session.playerId = member.id;
    session.roomCode = this.code;
    session.role = role;
    this.updateEmptySince();
    return member;
  }

  private playerState(m: Member): PlayerState {
    return { id: m.id, name: m.name, colour: m.colour, ready: m.ready, connected: m.connected, afk: false, consecutiveTimeouts: 0, joinedSeq: m.joinedSeq, leftRound: false };
  }

  private roomJoinedFor(member: Member): ServerMessage {
    return { t: 'roomJoined', code: this.code, playerId: member.id, sessionToken: member.token, role: member.role, state: this.state(), serverTimeMs: this.deps.clock.now() };
  }

  private nameTaken(name: string): boolean {
    for (const m of this.members.values()) if (namesEqual(m.name, name)) return true;
    return false;
  }

  /** Removes a member: roomLeft to them (if connected), playerLeft/spectatorLeft (+ hostChanged) to the rest. */
  private removeMember(id: string, reason: RoomLeftReason): void {
    const member = this.members.get(id);
    if (!member) return;
    this.cancelDisconnectTimer(id);
    this.members.delete(id);
    if (member.session) {
      member.session.send({ t: 'roomLeft', reason });
      member.session.clearRoom();
      member.session = null;
    }
    // PHASE 1 STUB: phase 2 calls authority.leave(id) / spectatorLeave(id), which emit these events.
    if (member.role === 'player') {
      this.emit({ type: 'playerLeft', playerId: id });
      this.systemLine('chat.playerLeft', { name: member.name });
      if (this.hostId === id) {
        const next = pickHost(this.players().map((p) => ({ id: p.id, joinedSeq: p.joinedSeq, connected: p.connected, leftRound: false })));
        this.hostId = next;
        if (next !== null) {
          this.emit({ type: 'hostChanged', hostId: next });
          this.systemLine('chat.hostChanged', { name: this.members.get(next)?.name ?? '' });
        }
      }
    } else {
      this.emit({ type: 'spectatorLeft', id });
    }
    this.updateEmptySince();
    this.touch();
    this.deps.onMembersChanged?.(this);
  }

  private emit(ev: GameEvent, except?: Member): void {
    this.seq++;
    this.broadcast({ t: 'event', ev }, except);
  }

  private systemLine(key: string, params: Record<string, string | number>): void {
    this.pushChat({ t: 'chat', from: null, key, params, atMs: this.deps.clock.now() });
  }

  private pushChat(line: ChatLine): void {
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_BACKLOG) this.chatLog.splice(0, this.chatLog.length - CHAT_BACKLOG);
    this.broadcast(line);
  }

  private cancelDisconnectTimer(id: string): void {
    const h = this.disconnectTimers.get(id);
    if (h !== undefined) {
      this.deps.clock.clearTimeout(h);
      this.disconnectTimers.delete(id);
    }
  }

  private updateEmptySince(): void {
    if (this.connectedCount() > 0) this.emptySince = null;
    else if (this.emptySince === null) this.emptySince = this.deps.clock.now();
  }

  private touch(): void {
    this.lastActivity = this.deps.clock.now();
  }
}
