// Room (DESIGN §11.3–§11.6): membership and session tokens, the chat ring buffer, and the mapping of every
// ClientMessage onto the shared Authority (game/authority.ts, WP-C), which owns the game state machine and all
// gameplay timers. The Room injects the clock, the physics wrapper (decodeLayers cached per course id + simulateShot)
// and the event sink (broadcast `event` frames, then membership side effects and system chat lines).
import { randomUUID } from 'node:crypto';
import { MAX_SPECTATORS } from '@puttipeli/shared/constants';
import type { Course, Vec2 } from '@puttipeli/shared/course/types';
import { Authority } from '@puttipeli/shared/game/authority';
import type { GameEvent } from '@puttipeli/shared/game/events';
import { createLobbyState, normalizeSettings } from '@puttipeli/shared/game/initial';
import { gameStateToJson } from '@puttipeli/shared/game/serialize';
import type { GameState, GameStateJson, Phase, PlayerColour, PlayerState, RoomSettings } from '@puttipeli/shared/game/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import type { ChatFrom, ClientMessage, ServerMessage } from '@puttipeli/shared/protocol/messages';
import { simulateShot, toShotSummary } from '@puttipeli/shared/sim/simulate';
import type { BallState, ShotInput, ShotSummary, WorldState } from '@puttipeli/shared/sim/types';
import type { Clock } from '../clock';
import type { Logger } from '../log';
import { CLOSE_REPLACED, type ClientSession, type MemberRole } from '../ws/connection';
import type { CourseStore } from './courseStore';
import { errorMessage, generateSessionToken, namesEqual, sanitizeChatText, sanitizeName, tokensEqual } from './session';

export const CHAT_BACKLOG = 50;

export interface Member {
  id: string;
  /** Live connection, or null while disconnected (players during grace). */
  session: ClientSession | null;
  token: string;
  role: MemberRole;
  /** Mirrors the Authority state (synced from playerJoined / profileChanged); for spectators the join name. */
  name: string;
  /** Players: the assigned colour; spectators: the requested one, used when they take a seat. */
  colour: PlayerColour;
  joinedAt: number;
}

export type ChatLine = Extract<ServerMessage, { t: 'chat' }>;
export type RoomLeftReason = Extract<ServerMessage, { t: 'roomLeft' }>['reason'];

export interface RoomDeps {
  clock: Clock;
  log: Logger;
  courseStore: CourseStore;
  /** Called whenever the member list changes (RoomManager removes a room with no members). */
  onMembersChanged?: (room: Room) => void;
}

const PLAYER_ONLY: ReadonlySet<ClientMessage['t']> = new Set(['setProfile', 'setReady', 'setCourses', 'setSettings', 'startGame', 'backToLobby', 'shoot', 'summaryReady']);

export class Room {
  readonly createdAt: number;
  lastActivity: number;
  /** Clock time since no member has had a live connection; null while anyone is connected. */
  emptySince: number | null;
  readonly members = new Map<string, Member>();
  readonly authority: Authority;
  private prevState: GameState;
  private readonly chatLog: ChatLine[] = [];
  /** Reason to send with roomLeft when the Authority confirms the removal of a member (default 'removed'). */
  private readonly leaveReasons = new Map<string, RoomLeftReason>();
  /** Spectator id currently moving to a seat: its spectatorLeft must not remove the member. */
  private promoting: string | null = null;
  private closed = false;

  constructor(
    readonly code: string,
    settings: Partial<RoomSettings> | undefined,
    private readonly deps: RoomDeps,
  ) {
    this.createdAt = deps.clock.now();
    this.lastActivity = this.createdAt;
    this.emptySince = this.createdAt;
    const initial = createLobbyState(normalizeSettings(settings), deps.courseStore.builtins());
    this.authority = new Authority(initial, {
      now: () => deps.clock.now(),
      setTimeout: (fn, ms) => deps.clock.setTimeout(this.guarded(fn), ms),
      clearTimeout: (id) => deps.clock.clearTimeout(id),
      simulate: (course, world, ball, shot, others) => this.simulate(course, world, ball, shot, others),
      emit: (ev) => this.onEvent(ev),
      minPlayers: 2,
    });
    this.prevState = this.authority.state;
  }

  get state(): GameState {
    return this.authority.state;
  }

  get phase(): Phase {
    return this.authority.state.phase;
  }

  get settings(): RoomSettings {
    return this.authority.state.settings;
  }

  get hostId(): string | null {
    return this.authority.state.hostId;
  }

  players(): Member[] {
    return [...this.members.values()].filter((m) => m.role === 'player').sort((a, b) => a.joinedAt - b.joinedAt);
  }

  spectators(): Member[] {
    return [...this.members.values()].filter((m) => m.role === 'spectator').sort((a, b) => a.joinedAt - b.joinedAt);
  }

  connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.session) n++;
    return n;
  }

  hasFreeSeat(): boolean {
    const s = this.authority.state;
    return s.players.length < s.settings.maxPlayers;
  }

  memberOf(session: ClientSession): Member | null {
    const id = session.playerId;
    if (id === null || session.roomCode !== this.code) return null;
    const m = this.members.get(id);
    return m && m.session === session ? m : null;
  }

  // -------------------------------------------------------------------------------------------- joining

  /** Lobby only (GAME_IN_PROGRESS), free seat (ROOM_FULL), unique name (NAME_TAKEN); the Authority assigns the colour. */
  addPlayer(session: ClientSession, rawName: string, colour: PlayerColour): ErrorCode | null {
    if (this.closed) return ErrorCode.ROOM_NOT_FOUND;
    const s = this.authority.state;
    if (s.phase !== 'lobby') return ErrorCode.GAME_IN_PROGRESS;
    if (!this.hasFreeSeat()) return ErrorCode.ROOM_FULL;
    const name = sanitizeName(rawName);
    if (this.nameTaken(name)) return ErrorCode.NAME_TAKEN;

    // The member exists (without a connection) while the Authority emits playerJoined, so the event reaches everyone
    // else and the joiner receives the state in roomJoined instead (§6.4).
    const member = this.createMember('player', name, colour);
    const player: PlayerState = { id: member.id, name, colour, ready: false, connected: true, afk: false, consecutiveTimeouts: 0, joinedSeq: 0, leftRound: false };
    const err = this.authority.join(player);
    if (err !== null) {
      this.members.delete(member.id);
      return err;
    }
    this.attach(member, session);
    session.send(this.roomJoinedFor(member));
    this.sendBacklog(session); // §6.4: the client cleared its chat on roomJoined; the backlog precedes its own join line
    this.systemLine('chat.playerJoined', { name: member.name });
    this.touch();
    this.deps.onMembersChanged?.(this);
    return null;
  }

  addSpectator(session: ClientSession, rawName: string, colour: PlayerColour): ErrorCode | null {
    if (this.closed) return ErrorCode.ROOM_NOT_FOUND;
    if (this.authority.state.spectators.length >= MAX_SPECTATORS) return ErrorCode.ROOM_FULL;
    const name = sanitizeName(rawName);
    const member = this.createMember('spectator', name, colour);
    const err = this.authority.spectatorJoin({ id: member.id, name });
    if (err !== null) {
      this.members.delete(member.id);
      return err;
    }
    this.attach(member, session);
    session.send(this.roomJoinedFor(member));
    this.sendBacklog(session);
    this.systemLine('chat.spectatorJoined', { name: member.name });
    this.touch();
    this.deps.onMembersChanged?.(this);
    return null;
  }

  /**
   * Swaps the connection of the member owning `token` (§11.5): roomJoined with the full snapshot, then the Authority's
   * playerConnection{true} (and, when they are on turn with the short disconnected deadline, a fresh turnStarted),
   * then the chat backlog. SESSION_EXPIRED when no member owns the token or the room is gone.
   */
  rejoin(session: ClientSession, token: string): ErrorCode | null {
    if (this.closed) return ErrorCode.SESSION_EXPIRED;
    let member: Member | null = null;
    for (const m of this.members.values()) if (tokensEqual(m.token, token)) member = m;
    if (!member) return ErrorCode.SESSION_EXPIRED;

    const old = member.session;
    if (old && old !== session) {
      old.clearRoom(); // so the close below is not treated as a disconnect of this member
      old.close(CLOSE_REPLACED, 'session resumed elsewhere');
    }
    // The snapshot is taken before the Authority applies connection(true) (R20): the rejoiner then receives the
    // playerConnection{true} (and a fresh turnStarted) frames through the normal broadcast, exactly like every other
    // member, so its reduced state (seq included) equals the server's instead of running one event ahead.
    this.attach(member, session);
    session.send(this.roomJoinedFor(member));
    if (member.role === 'player') this.authority.connection(member.id, true);
    this.sendBacklog(session);
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
    if (member.role === 'player') this.authority.activity(member.id); // any message clears afk (§10.6)

    if (member.role === 'spectator' && PLAYER_ONLY.has(msg.t)) {
      session.error(ErrorCode.NOT_A_PLAYER, errorMessage(ErrorCode.NOT_A_PLAYER));
      return;
    }
    try {
      this.dispatch(member, session, msg);
    } catch (err) {
      // A bug must not take the socket down (the transport would close it with 1011); answer and keep going.
      this.deps.log.error('room message handling failed', { room: this.code, t: msg.t, member: member.id, err });
      session.error(ErrorCode.INVALID_MESSAGE, `Internal error while handling ${msg.t}`);
    }
  }

  private dispatch(member: Member, session: ClientSession, msg: ClientMessage): void {
    const a = this.authority;
    const reply = (code: ErrorCode | null): void => {
      if (code !== null) session.error(code, errorMessage(code));
    };
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
        this.leaveReasons.set(member.id, 'left');
        a.leave(member.id); // playerLeft / spectatorLeft -> onEvent completes the removal
        if (this.members.has(member.id)) this.finishRemoval(member.id, null); // unknown to the Authority: drop anyway
        return;
      case 'requestSnapshot':
        session.send(this.snapshotFor(session));
        return;
      case 'ping': // normally answered by the Gateway; harmless here
        session.send({ t: 'pong', t0: msg.t0, serverTimeMs: this.deps.clock.now() });
        return;

      case 'setProfile': {
        let name: string | undefined;
        if (msg.name !== undefined) {
          name = sanitizeName(msg.name);
          if (!namesEqual(name, member.name) && this.nameTaken(name)) {
            reply(ErrorCode.NAME_TAKEN);
            return;
          }
        }
        reply(a.setProfile(member.id, name, msg.colour));
        return;
      }
      case 'setReady':
        reply(a.setReady(member.id, msg.ready));
        return;
      case 'setSettings':
        reply(a.setSettings(member.id, msg.settings));
        return;
      case 'setCourses': {
        const s = a.state;
        if (s.phase !== 'lobby') return reply(ErrorCode.NOT_IN_LOBBY);
        if (s.hostId !== member.id) return reply(ErrorCode.NOT_HOST);
        const res = this.deps.courseStore.resolve(msg.courses);
        if (!res.ok) {
          session.error(res.code, res.message, res.issues);
          return;
        }
        reply(a.setCourses(member.id, res.courses));
        return;
      }
      case 'startGame':
        reply(a.start(member.id));
        return;
      case 'backToLobby':
        reply(a.backToLobby(member.id));
        return;
      case 'shoot':
        reply(a.shoot(member.id, msg.holeIndex, msg.turnSeq, msg.shot));
        return;
      case 'summaryReady':
        a.summaryReady(member.id);
        return;
      case 'becomePlayer': {
        if (member.role === 'player') return reply(ErrorCode.ALREADY_IN_ROOM);
        this.promoting = member.id;
        let err: ErrorCode | null;
        try {
          err = a.becomePlayer(member.id, member.colour);
        } finally {
          this.promoting = null;
        }
        if (err !== null) return reply(err);
        session.role = 'player'; // member.role/name/colour were synced from the playerJoined event
        this.systemLine('chat.playerJoined', { name: member.name });
        return;
      }

      case 'hello':
      case 'createRoom':
      case 'joinRoom':
      case 'rejoin':
        reply(ErrorCode.ALREADY_IN_ROOM);
        return;
    }
  }

  /** Socket lost: spectators leave immediately, players enter the Authority's disconnect grace (§10.6). */
  disconnected(session: ClientSession): void {
    const member = this.memberOf(session);
    if (!member) return;
    member.session = null;
    session.clearRoom();
    this.updateEmptySince();
    if (member.role === 'spectator') {
      this.authority.spectatorLeave(member.id);
      if (this.members.has(member.id)) this.finishRemoval(member.id, null);
      return;
    }
    this.authority.connection(member.id, false);
  }

  // -------------------------------------------------------------------------------------------- output

  broadcast(msg: ServerMessage, exceptId?: string): void {
    for (const m of this.members.values()) {
      if (m.id === exceptId) continue;
      if (m.session) m.session.send(msg);
    }
  }

  snapshotFor(session: ClientSession): ServerMessage {
    void session; // same snapshot for every member in v1 (no per-viewer data)
    return { t: 'roomState', state: this.stateJson(), serverTimeMs: this.deps.clock.now() };
  }

  /** Last CHAT_BACKLOG chat lines (players and system), oldest first. */
  chatBacklog(): readonly ChatLine[] {
    return this.chatLog;
  }

  /** Closes the room: every connected member gets roomLeft{reason}; Authority timers cleared; members forgotten. */
  close(reason: RoomLeftReason = 'roomClosed'): void {
    if (this.closed) return;
    this.closed = true;
    this.authority.dispose();
    for (const m of this.members.values()) {
      if (m.session) {
        try {
          m.session.send({ t: 'roomLeft', reason });
        } catch (err) {
          // Closing must always complete (it is also the failure path of onTimerFailure); a dead socket is logged only.
          this.deps.log.warn('roomLeft not delivered', { room: this.code, member: m.id, err });
        }
        m.session.clearRoom();
        m.session = null;
      }
    }
    this.members.clear();
    this.leaveReasons.clear();
    this.deps.log.info('room closed', { room: this.code, reason });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  stateJson(): GameStateJson {
    return gameStateToJson(this.authority.state);
  }

  // -------------------------------------------------------------------------------------------- authority deps

  /**
   * Every Authority timer runs through this guard. handle() already keeps a throwing dispatch from reaching the
   * socket layer; without the guard an exception inside a timer-driven path (countdown end, hole intro, pacing
   * advance, deadline, summary, grace removal) would escape the Node timer into process 'uncaughtException' and
   * take every room down with it.
   */
  private guarded(fn: () => void): () => void {
    return () => {
      try {
        fn();
      } catch (err) {
        this.onTimerFailure(err);
      }
    };
  }

  /**
   * The Authority's timer chain is broken and its state can no longer be trusted (a ReducerError leaves the game
   * stuck with no timer armed), so the room is closed: members get roomLeft{roomClosed} (§11.5 client handling) and
   * the RoomManager drops the room through onMembersChanged. Other rooms are unaffected.
   */
  private onTimerFailure(err: unknown): void {
    this.deps.log.error('authority timer failed; closing room', { room: this.code, phase: this.phase, err });
    if (this.closed) return;
    this.close('roomClosed');
    this.deps.onMembersChanged?.(this);
  }

  private simulate(course: Course, world: WorldState, ball: BallState, shot: ShotInput, others: Vec2[]): ShotSummary {
    const layers = this.deps.courseStore.layersFor(course);
    return toShotSummary(simulateShot(layers, world, ball, shot, others));
  }

  /** Authority event sink: broadcast first, then membership bookkeeping and system chat lines (§11.3). */
  private onEvent(ev: GameEvent): void {
    const prev = this.prevState;
    const state = this.authority.state;
    this.prevState = state;
    const leaving = ev.type === 'playerLeft' ? ev.playerId : ev.type === 'spectatorLeft' && this.promoting !== ev.id ? ev.id : undefined;
    this.broadcast({ t: 'event', ev }, leaving);

    switch (ev.type) {
      case 'playerJoined': {
        const m = this.members.get(ev.player.id);
        if (m) {
          m.role = 'player';
          m.name = ev.player.name;
          m.colour = ev.player.colour;
        }
        return;
      }
      case 'profileChanged': {
        const m = this.members.get(ev.playerId);
        if (m) {
          m.name = ev.name;
          m.colour = ev.colour;
        }
        return;
      }
      case 'playerLeft':
        this.finishRemoval(ev.playerId, 'chat.playerLeft');
        return;
      case 'spectatorLeft':
        if (this.promoting !== ev.id) this.finishRemoval(ev.id, null);
        return;
      case 'hostChanged':
        this.systemLine('chat.hostChanged', { name: this.nameOf(ev.hostId) });
        return;
      case 'gameStarted':
        this.systemLine('chat.gameStarted', {});
        return;
      case 'turnTimedOut': {
        const name = this.nameOf(ev.playerId);
        this.systemLine('chat.timeout', { name });
        const wasAfk = prev.players.find((p) => p.id === ev.playerId)?.afk ?? false;
        const isAfk = state.players.find((p) => p.id === ev.playerId)?.afk ?? false;
        if (!wasAfk && isAfk) this.systemLine('chat.afk', { name });
        this.holeResultLine(prev, state, ev.playerId);
        return;
      }
      case 'shotTaken':
        this.holeResultLine(prev, state, ev.playerId);
        return;
      default:
        return;
    }
  }

  /** chat.holeResult{name, strokes} once a player's hole is done (holed or max strokes). */
  private holeResultLine(prev: GameState, state: GameState, playerId: string): void {
    if (prev.holeDone[playerId] || !state.holeDone[playerId]) return;
    const strokes = state.strokes[playerId]?.[state.holeIndex] ?? 0;
    this.systemLine('chat.holeResult', { name: this.nameOf(playerId), strokes });
  }

  // -------------------------------------------------------------------------------------------- internals

  private createMember(role: MemberRole, name: string, colour: PlayerColour): Member {
    const member: Member = { id: randomUUID(), session: null, token: generateSessionToken(), role, name, colour, joinedAt: this.deps.clock.now() };
    this.members.set(member.id, member);
    return member;
  }

  private attach(member: Member, session: ClientSession): void {
    member.session = session;
    session.playerId = member.id;
    session.roomCode = this.code;
    session.role = member.role;
    this.updateEmptySince();
  }

  private roomJoinedFor(member: Member): ServerMessage {
    return { t: 'roomJoined', code: this.code, playerId: member.id, sessionToken: member.token, role: member.role, state: this.stateJson(), serverTimeMs: this.deps.clock.now() };
  }

  /** The last CHAT_BACKLOG lines, oldest first, right after roomJoined on every initial join and rejoin (§6.4, §11.5). */
  private sendBacklog(session: ClientSession): void {
    for (const line of this.chatLog) session.send(line);
  }

  private nameOf(id: string): string {
    const m = this.members.get(id);
    if (m) return m.name;
    return this.authority.state.players.find((p) => p.id === id)?.name ?? '';
  }

  private nameTaken(name: string): boolean {
    for (const m of this.members.values()) if (namesEqual(m.name, name)) return true;
    return false;
  }

  /** Forgets a member the Authority has dropped: roomLeft to them (if connected), optional system line, sweep hook. */
  private finishRemoval(id: string, lineKey: string | null): void {
    const member = this.members.get(id);
    if (!member) return;
    this.members.delete(id);
    const reason = this.leaveReasons.get(id) ?? 'removed';
    this.leaveReasons.delete(id);
    if (member.session) {
      member.session.send({ t: 'roomLeft', reason });
      member.session.clearRoom();
      member.session = null;
    }
    if (lineKey !== null) this.systemLine(lineKey, { name: member.name });
    this.updateEmptySince();
    this.deps.onMembersChanged?.(this);
  }

  private systemLine(key: string, params: Record<string, string | number>): void {
    this.pushChat({ t: 'chat', from: null, key, params, atMs: this.deps.clock.now() });
  }

  private pushChat(line: ChatLine): void {
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_BACKLOG) this.chatLog.splice(0, this.chatLog.length - CHAT_BACKLOG);
    this.broadcast(line);
  }

  private updateEmptySince(): void {
    if (this.connectedCount() > 0) this.emptySince = null;
    else if (this.emptySince === null) this.emptySince = this.deps.clock.now();
  }

  private touch(): void {
    this.lastActivity = this.deps.clock.now();
  }
}
