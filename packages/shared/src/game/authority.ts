// The shared flow driver (DESIGN §10.4–§10.6). The same class runs inside the server Room (WP-F) and inside the
// client localHost (WP-G), so single player, editor test play and multiplayer share one state machine.
// Dependencies (clock, timers, the physics wrapper, the event sink) are injected; this module imports WP0 modules only.
import {
  AFK_TURN_TIMEOUT_SEC,
  ANIMATION_GRACE_MS,
  COUNTDOWN_SEC,
  DISCONNECTED_TURN_WAIT_SEC,
  DISCONNECT_GRACE_SEC,
  HOLE_INTRO_MS,
  HOLE_SUMMARY_SEC,
  LOBBY_DISCONNECT_REMOVE_SEC,
  MAX_COURSES_PER_SET,
  MAX_NAME_CHARS,
  MAX_SPECTATORS,
  ROUND_SUMMARY_AUTO_LOBBY_SEC,
  TICK_HZ,
} from '../constants';
import type { Course, Vec2 } from '../course/types';
import { ErrorCode } from '../protocol/codes';
import { validateShot } from '../sim/shot';
import type { BallState, ShotInput, ShotSummary, WorldState } from '../sim/types';
import type { GameEvent } from './events';
import { applyEvent } from './reducer';
import { normalizeSettings } from './initial';
import { ranking } from './scoring';
import { currentCourse, otherBallCentres } from './selectors';
import { activePlayers, canStart, holeOrder, isHoleComplete, nextTurnPlayer } from './turns';
import type { GameState, PlayerColour, PlayerState, RankingEntry, RoomSettings, SpectatorState } from './types';

export interface AuthorityDeps {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** Wraps decodeLayers + simulateShot + summary conversion. Provided by server (WP-F) and localHost (WP-G). */
  simulate(course: Course, world: WorldState, ball: BallState, shot: ShotInput, otherBalls: Vec2[]): ShotSummary;
  /** Called after the authority has applied `ev` to its own state (so listeners may read `state`). */
  emit(ev: GameEvent): void;
  minPlayers: 1 | 2; // 1 for single player / test play
}

/** Which rule produced the current turn's deadline; drives the reconnect "fresh turn" rule (§10.6). */
type DeadlineKind = 'none' | 'normal' | 'afk' | 'disconnected';

const COLOURS: readonly PlayerColour[] = [0, 1, 2, 3];

export class Authority {
  private _state: GameState;
  private readonly deps: AuthorityDeps;
  private lastJoinedSeq = 0;
  private turnSeqCounter = 0;
  private deadlineKind: DeadlineKind = 'none';
  private disposed = false;

  // Timer handles (null = not scheduled).
  private countdownTimer: number | null = null;
  private introTimer: number | null = null;
  private deadlineTimer: number | null = null;
  private advanceTimer: number | null = null;
  private summaryTimer: number | null = null;
  private summaryDueMs = 0; // when summaryTimer fires (valid while summaryTimer !== null)
  private readonly disconnectTimers = new Map<string, { handle: number; dueMs: number }>();

  constructor(initial: GameState, deps: AuthorityDeps) {
    this._state = initial;
    this.deps = deps;
    for (const p of initial.players) if (p.joinedSeq > this.lastJoinedSeq) this.lastJoinedSeq = p.joinedSeq;
    if (initial.turn !== null) this.turnSeqCounter = initial.turn.turnSeq;
  }

  get state(): GameState {
    return this._state;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Lobby

  /** ROOM_FULL when players.length >= settings.maxPlayers, GAME_IN_PROGRESS unless lobby. A player already seated is a no-op. */
  join(player: PlayerState): ErrorCode | null {
    const s = this._state;
    if (s.players.some((p) => p.id === player.id)) return null;
    if (s.phase !== 'lobby') return ErrorCode.GAME_IN_PROGRESS;
    if (s.players.length >= s.settings.maxPlayers) return ErrorCode.ROOM_FULL;
    const seated: PlayerState = {
      id: player.id,
      name: player.name,
      colour: this.assignColour(player.colour),
      ready: false,
      connected: true,
      afk: false,
      consecutiveTimeouts: 0,
      joinedSeq: ++this.lastJoinedSeq,
      leftRound: false,
    };
    this.apply({ type: 'playerJoined', player: seated });
    return null;
  }

  /** Emits playerLeft (+ hostChanged if needed, + roundEnded/backToLobby if no active player remains during a round). */
  leave(playerId: string): void {
    const s = this._state;
    const player = s.players.find((p) => p.id === playerId);
    if (player === undefined) {
      this.spectatorLeave(playerId);
      return;
    }
    this.clearDisconnectTimer(playerId);
    const wasHost = s.hostId === playerId;
    const wasOnTurn = s.phase === 'hole' && s.turn !== null && s.turn.playerId === playerId;
    const shotInFlight = wasOnTurn && s.turn!.shotInFlight;

    this.apply({ type: 'playerLeft', playerId });
    if (wasHost) this.migrateHost();

    if (this._state.phase === 'lobby') return;
    if (activePlayers(this._state).length === 0) {
      if (this._state.phase === 'countdown') return; // the countdown runs out and aborts the round (§10.5)
      this.abortRound(ranking(this._state)); // the leavers, all rank 1 (§10.5 "roundEnded(ranking)")
      return;
    }
    if (wasOnTurn) {
      if (!shotInFlight) {
        this.clearDeadline();
        this.advance(playerId);
      }
      return;
    }
    if (this._state.phase === 'holeSummary' || this._state.phase === 'roundSummary') {
      this.checkSummaryComplete();
      this.ensureSummaryProgress();
    }
  }

  /** ROOM_FULL when spectators.length >= MAX_SPECTATORS. An id that is already a spectator is a no-op. */
  spectatorJoin(spectator: SpectatorState): ErrorCode | null {
    const s = this._state;
    if (s.spectators.some((q) => q.id === spectator.id)) return null;
    if (s.spectators.length >= MAX_SPECTATORS) return ErrorCode.ROOM_FULL;
    this.apply({ type: 'spectatorJoined', spectator: { id: spectator.id, name: spectator.name } });
    return null;
  }

  spectatorLeave(id: string): void {
    if (!this._state.spectators.some((q) => q.id === id)) return;
    this.apply({ type: 'spectatorLeft', id });
  }

  /**
   * Lobby only; needs a free seat; moves spectator -> player. The colour is the requested one when free, else the
   * lowest free colour; a case-insensitive duplicate name gets the smallest free digit suffix (§6.4).
   */
  becomePlayer(id: string, colour: PlayerColour = 0): ErrorCode | null {
    const s = this._state;
    if (s.phase !== 'lobby') return ErrorCode.NOT_IN_LOBBY;
    if (s.players.some((p) => p.id === id)) return ErrorCode.ALREADY_IN_ROOM;
    const spectator = s.spectators.find((q) => q.id === id);
    if (spectator === undefined) return ErrorCode.NOT_IN_ROOM;
    if (s.players.length >= s.settings.maxPlayers) return ErrorCode.ROOM_FULL;
    this.apply({ type: 'spectatorLeft', id });
    const seated: PlayerState = {
      id,
      name: this.uniqueName(spectator.name),
      colour: this.assignColour(colour),
      ready: false,
      connected: true,
      afk: false,
      consecutiveTimeouts: 0,
      joinedSeq: ++this.lastJoinedSeq,
      leftRound: false,
    };
    this.apply({ type: 'playerJoined', player: seated });
    return null;
  }

  /** Lobby only. A taken colour is ignored for the colour part (the name still applies); an empty name keeps the old one. */
  setProfile(id: string, name: string | undefined, colour: PlayerColour | undefined): ErrorCode | null {
    const s = this._state;
    if (s.phase !== 'lobby') return ErrorCode.NOT_IN_LOBBY;
    const p = s.players.find((q) => q.id === id);
    if (p === undefined) return ErrorCode.NOT_A_PLAYER;
    let nextName = p.name;
    if (typeof name === 'string') {
      const trimmed = name.trim().slice(0, MAX_NAME_CHARS);
      if (trimmed.length > 0) nextName = trimmed;
    }
    let nextColour = p.colour;
    if (colour !== undefined && COLOURS.includes(colour) && !s.players.some((q) => q.id !== id && q.colour === colour)) {
      nextColour = colour;
    }
    if (nextName === p.name && nextColour === p.colour) return null;
    this.apply({ type: 'profileChanged', playerId: id, name: nextName, colour: nextColour });
    return null;
  }

  setReady(id: string, ready: boolean): ErrorCode | null {
    const s = this._state;
    if (s.phase !== 'lobby') return ErrorCode.NOT_IN_LOBBY;
    const p = s.players.find((q) => q.id === id);
    if (p === undefined) return ErrorCode.NOT_A_PLAYER;
    if (p.ready === ready) return null;
    this.apply({ type: 'readyChanged', playerId: id, ready });
    return null;
  }

  /** Host, lobby only. Invalid values fall back to the current settings; maxPlayers is clamped up to the player count. */
  setSettings(id: string, partial: Partial<RoomSettings> | undefined): ErrorCode | null {
    const s = this._state;
    if (s.phase !== 'lobby') return ErrorCode.NOT_IN_LOBBY;
    if (s.hostId !== id) return ErrorCode.NOT_HOST;
    const settings = normalizeSettings(partial, s.settings, s.players.length);
    this.apply({ type: 'settingsChanged', settings });
    return null;
  }

  /** Host, lobby only. Receives already-validated courses; rejects an empty or oversized set with INVALID_COURSE. */
  setCourses(id: string, courses: Course[]): ErrorCode | null {
    const s = this._state;
    if (s.phase !== 'lobby') return ErrorCode.NOT_IN_LOBBY;
    if (s.hostId !== id) return ErrorCode.NOT_HOST;
    if (!Array.isArray(courses) || courses.length < 1 || courses.length > MAX_COURSES_PER_SET) return ErrorCode.INVALID_COURSE;
    this.apply({ type: 'coursesChanged', courses: courses.slice() });
    return null;
  }

  /** Emits playerConnection and manages the removal timers of §10.6. Unknown ids are ignored. */
  connection(playerId: string, connected: boolean): void {
    const s = this._state;
    const p = s.players.find((q) => q.id === playerId);
    if (p === undefined) return;
    if (p.connected === connected) return;
    this.apply({ type: 'playerConnection', playerId, connected });

    if (!connected) {
      const graceSec = this._state.phase === 'lobby' ? LOBBY_DISCONNECT_REMOVE_SEC : DISCONNECT_GRACE_SEC;
      this.armDisconnectTimer(playerId, graceSec * 1000);
      const st = this._state;
      if (st.phase === 'hole' && st.turn !== null && st.turn.playerId === playerId && !st.turn.shotInFlight) {
        // Their turn waits at most DISCONNECTED_TURN_WAIT_SEC (even with turnTimeoutSec 0): shorten an absent or
        // longer deadline with a fresh turnStarted so every client sees the real remaining time.
        const waitUntil = this.deps.now() + DISCONNECTED_TURN_WAIT_SEC * 1000;
        if (st.turn.deadlineMs === null || st.turn.deadlineMs > waitUntil) {
          this.clearDeadline();
          this.startTurn(playerId);
        }
      } else if (st.phase === 'holeSummary' || st.phase === 'roundSummary') {
        this.checkSummaryComplete();
        this.ensureSummaryProgress();
      }
      return;
    }

    this.clearDisconnectTimer(playerId);
    const st = this._state;
    if (
      st.phase === 'hole' &&
      st.turn !== null &&
      st.turn.playerId === playerId &&
      !st.turn.shotInFlight &&
      this.deadlineKind === 'disconnected'
    ) {
      this.clearDeadline();
      this.startTurn(playerId); // fresh turn: new turnSeq, normal deadline (§10.6)
    }
  }

  /** Any message from an afk player clears the flag (playerAfk{afk:false}). */
  activity(playerId: string): void {
    const p = this._state.players.find((q) => q.id === playerId);
    if (p === undefined || !p.afk) return;
    this.apply({ type: 'playerAfk', playerId, afk: false });
  }

  /** canStart -> countdownStarted (COUNTDOWN_SEC with minPlayers 2, 0 ms with minPlayers 1). */
  start(hostId: string): ErrorCode | null {
    const s = this._state;
    if (s.phase !== 'lobby') return ErrorCode.NOT_IN_LOBBY;
    if (s.hostId !== hostId) return ErrorCode.NOT_HOST;
    const gate = canStart(s, this.deps.minPlayers);
    if (gate !== null) return gate;
    const ms = this.deps.minPlayers === 2 ? COUNTDOWN_SEC * 1000 : 0;
    this.apply({ type: 'countdownStarted', endsAtMs: this.deps.now() + ms });
    this.countdownTimer = this.deps.setTimeout(() => {
      this.countdownTimer = null;
      if (this.disposed) return;
      this.onCountdownEnd();
    }, ms);
    return null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Play

  /** Validation order and codes per §10.5; then simulate, emit shotTaken and schedule advance(). */
  shoot(playerId: string, holeIndex: number, turnSeq: number, shot: ShotInput): ErrorCode | null {
    const s = this._state;
    if (s.phase !== 'hole' || s.turn === null) return ErrorCode.NOT_YOUR_TURN;
    if (s.turn.playerId !== playerId) return ErrorCode.NOT_YOUR_TURN;
    if (holeIndex !== s.holeIndex || turnSeq !== s.turn.turnSeq) return ErrorCode.STALE_TURN;
    if (s.turn.shotInFlight) return ErrorCode.SHOT_IN_FLIGHT;
    if (!validateShot(shot)) return ErrorCode.INVALID_SHOT;
    const course = currentCourse(s);
    const ball = s.balls[playerId];
    if (course === null || s.world === null || ball === undefined) return ErrorCode.NOT_YOUR_TURN;
    const clean: ShotInput = { dx: shot.dx, dy: shot.dy };
    const summary = this.deps.simulate(course, s.world, ball, clean, otherBallCentres(s, playerId));
    this.clearDeadline();
    this.apply({ type: 'shotTaken', playerId, turnSeq, shot: clean, outcome: summary, atMs: this.deps.now() });
    const delay = (summary.ticks / TICK_HZ) * 1000 + ANIMATION_GRACE_MS;
    this.advanceTimer = this.deps.setTimeout(() => {
      this.advanceTimer = null;
      if (this.disposed) return;
      this.advance(playerId);
    }, delay);
    return null;
  }

  /** Ignored unless the phase is holeSummary/roundSummary and the id is an active player. */
  summaryReady(playerId: string): void {
    const s = this._state;
    if (s.phase !== 'holeSummary' && s.phase !== 'roundSummary') return;
    const p = s.players.find((q) => q.id === playerId);
    if (p === undefined || p.leftRound) return;
    if (s.summaryReady[playerId]) return;
    this.apply({ type: 'summaryReady', playerId });
    this.checkSummaryComplete();
  }

  /**
   * null = automatic (timer / no players left), accepted from any non-lobby phase. A player request is accepted from
   * the host in roundSummary only (NOT_HOST otherwise; GAME_IN_PROGRESS while a round is still being played).
   * In the lobby it simply returns null and does nothing.
   */
  backToLobby(requesterId: string | null): ErrorCode | null {
    const s = this._state;
    if (s.phase === 'lobby') return null;
    if (requesterId !== null) {
      if (s.hostId !== requesterId) return ErrorCode.NOT_HOST;
      if (s.phase !== 'roundSummary') return ErrorCode.GAME_IN_PROGRESS;
    }
    this.toLobby();
    return null;
  }

  /** Clears every timer; the instance emits nothing afterwards. */
  dispose(): void {
    this.disposed = true;
    this.clearRoundTimers();
    for (const t of this.disconnectTimers.values()) this.deps.clearTimeout(t.handle);
    this.disconnectTimers.clear();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals

  private apply(ev: GameEvent): void {
    this._state = applyEvent(this._state, ev);
    this.deps.emit(ev);
  }

  private assignColour(requested: PlayerColour): PlayerColour {
    const taken = new Set(this._state.players.map((p) => p.colour));
    if (COLOURS.includes(requested) && !taken.has(requested)) return requested;
    for (const c of COLOURS) if (!taken.has(c)) return c;
    return requested;
  }

  private uniqueName(name: string): string {
    const base = name.trim().slice(0, MAX_NAME_CHARS) || 'Pelaaja';
    const taken = new Set(this._state.players.map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = String(n);
      const candidate = base.slice(0, MAX_NAME_CHARS - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return base;
  }

  private connectedActive(): PlayerState[] {
    return this._state.players.filter((p) => !p.leftRound && p.connected);
  }

  /** hostChanged to the connected non-left player with the lowest joinedSeq, else any non-left player; nothing if none remain. */
  private migrateHost(): void {
    const candidates = activePlayers(this._state);
    if (candidates.length === 0) return;
    const connected = candidates.filter((p) => p.connected);
    const pool = connected.length > 0 ? connected : candidates;
    let best = pool[0]!;
    for (const p of pool) if (p.joinedSeq < best.joinedSeq) best = p;
    if (this._state.hostId !== best.id) this.apply({ type: 'hostChanged', hostId: best.id });
  }

  private onCountdownEnd(): void {
    const s = this._state;
    if (s.phase !== 'countdown') return;
    const seatOrder = s.players
      .slice()
      .sort((a, b) => a.joinedSeq - b.joinedSeq)
      .map((p) => p.id);
    this.turnSeqCounter = 0;
    this.apply({ type: 'gameStarted', seatOrder });
    if (activePlayers(this._state).length === 0) {
      this.abortRound([]); // §10.5: the end-of-countdown abort carries the empty ranking
      return;
    }
    this.startHole(0);
  }

  /**
   * roundEnded(rank) then backToLobby (clients show "Peli keskeytyi"). In roundSummary the round has already ended, so
   * only the lobby transition is emitted (the reducer rejects a second roundEnded there).
   */
  private abortRound(rank: RankingEntry[]): void {
    this.clearRoundTimers();
    if (this._state.phase !== 'roundSummary') this.apply({ type: 'roundEnded', ranking: rank });
    this.toLobby();
  }

  /**
   * backToLobby plus the §10.6 lobby rule for players who are still disconnected: their round grace timer is shortened
   * to at most LOBBY_DISCONNECT_REMOVE_SEC from now (never extended).
   */
  private toLobby(): void {
    this.clearRoundTimers();
    this.apply({ type: 'backToLobby' });
    const now = this.deps.now();
    for (const [id, t] of [...this.disconnectTimers]) {
      if (!this._state.players.some((p) => p.id === id)) {
        this.clearDisconnectTimer(id); // dropped with the round; nothing left to remove
        continue;
      }
      const remaining = t.dueMs - now;
      if (remaining > LOBBY_DISCONNECT_REMOVE_SEC * 1000) this.armDisconnectTimer(id, LOBBY_DISCONNECT_REMOVE_SEC * 1000);
    }
  }

  /** Replaces the player's removal timer: leave(id) fires after `ms`. */
  private armDisconnectTimer(playerId: string, ms: number): void {
    this.clearDisconnectTimer(playerId);
    const handle = this.deps.setTimeout(() => {
      this.disconnectTimers.delete(playerId);
      if (this.disposed) return;
      this.leave(playerId);
    }, ms);
    this.disconnectTimers.set(playerId, { handle, dueMs: this.deps.now() + ms });
  }

  /**
   * §10.5: a holeSummary whose connected active set is empty ends after HOLE_SUMMARY_SEC regardless of the setting.
   * The timer is set to end at most HOLE_SUMMARY_SEC from now; an already shorter timer is kept.
   */
  private ensureSummaryProgress(): void {
    if (this._state.phase !== 'holeSummary' || this.connectedActive().length > 0) return;
    const ms = HOLE_SUMMARY_SEC * 1000;
    if (this.summaryTimer !== null && this.summaryDueMs - this.deps.now() <= ms) return;
    this.scheduleSummaryTimer(ms);
  }

  private startHole(holeIndex: number): void {
    const s = this._state;
    const order = holeOrder(s.seatOrder, holeIndex, s.players);
    this.apply({ type: 'holeStarted', holeIndex, order });
    this.introTimer = this.deps.setTimeout(() => {
      this.introTimer = null;
      if (this.disposed) return;
      this.advance(null);
    }, HOLE_INTRO_MS);
  }

  private advance(after: string | null): void {
    const s = this._state;
    if (s.phase !== 'hole') return;
    if (isHoleComplete(s)) {
      this.endHole();
      return;
    }
    const next = nextTurnPlayer(s, after);
    if (next === null) {
      this.endHole();
      return;
    }
    this.startTurn(next);
  }

  private startTurn(playerId: string): void {
    const s = this._state;
    const p = s.players.find((q) => q.id === playerId);
    if (p === undefined) return;
    const now = this.deps.now();
    let deadlineMs: number | null;
    if (!p.connected) {
      deadlineMs = now + DISCONNECTED_TURN_WAIT_SEC * 1000;
      this.deadlineKind = 'disconnected';
    } else if (s.settings.turnTimeoutSec === 0) {
      deadlineMs = null;
      this.deadlineKind = 'none';
    } else if (p.afk) {
      deadlineMs = now + AFK_TURN_TIMEOUT_SEC * 1000;
      this.deadlineKind = 'afk';
    } else {
      deadlineMs = now + s.settings.turnTimeoutSec * 1000;
      this.deadlineKind = 'normal';
    }
    const turnSeq = ++this.turnSeqCounter;
    this.apply({ type: 'turnStarted', playerId, turnSeq, deadlineMs });
    if (deadlineMs !== null) {
      this.deadlineTimer = this.deps.setTimeout(() => {
        this.deadlineTimer = null;
        if (this.disposed) return;
        this.onDeadline(playerId, turnSeq);
      }, deadlineMs - now);
    }
  }

  private onDeadline(playerId: string, turnSeq: number): void {
    const s = this._state;
    if (s.phase !== 'hole' || s.turn === null) return;
    if (s.turn.playerId !== playerId || s.turn.turnSeq !== turnSeq || s.turn.shotInFlight) return;
    const p = s.players.find((q) => q.id === playerId);
    if (p === undefined) return;
    if (p.connected) this.apply({ type: 'turnTimedOut', playerId, turnSeq });
    else this.apply({ type: 'turnSkipped', playerId, turnSeq });
    this.advance(playerId);
  }

  private endHole(): void {
    this.clearDeadline();
    this.clearAdvance();
    this.clearIntro();
    const s = this._state;
    this.apply({ type: 'holeEnded', holeIndex: s.holeIndex });
    const connected = this.connectedActive();
    if (connected.length === 0) {
      this.scheduleSummaryTimer(HOLE_SUMMARY_SEC * 1000);
    } else if (s.settings.holeSummarySec > 0) {
      this.scheduleSummaryTimer(s.settings.holeSummarySec * 1000);
    }
    // holeSummarySec 0 (and single player): wait until every connected active player is ready.
  }

  private scheduleSummaryTimer(ms: number): void {
    this.clearSummaryTimer();
    this.summaryDueMs = this.deps.now() + ms;
    this.summaryTimer = this.deps.setTimeout(() => {
      this.summaryTimer = null;
      if (this.disposed) return;
      this.onSummaryTimer();
    }, ms);
  }

  private onSummaryTimer(): void {
    const phase = this._state.phase;
    if (phase === 'holeSummary') this.finishHoleSummary();
    else if (phase === 'roundSummary') this.toLobby();
  }

  /** Every connected active player is ready (and there is at least one) -> next hole / round end / lobby. */
  private checkSummaryComplete(): void {
    const s = this._state;
    const connected = this.connectedActive();
    if (connected.length === 0) return;
    for (const p of connected) if (!s.summaryReady[p.id]) return;
    if (s.phase === 'holeSummary') this.finishHoleSummary();
    else if (s.phase === 'roundSummary') this.toLobby();
  }

  private finishHoleSummary(): void {
    this.clearSummaryTimer();
    const s = this._state;
    if (s.phase !== 'holeSummary') return;
    if (s.holeIndex + 1 < s.courses.length) {
      this.startHole(s.holeIndex + 1);
      return;
    }
    this.apply({ type: 'roundEnded', ranking: ranking(s) });
    if (this.deps.minPlayers === 2) this.scheduleSummaryTimer(ROUND_SUMMARY_AUTO_LOBBY_SEC * 1000);
  }

  private clearDisconnectTimer(playerId: string): void {
    const t = this.disconnectTimers.get(playerId);
    if (t !== undefined) {
      this.deps.clearTimeout(t.handle);
      this.disconnectTimers.delete(playerId);
    }
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) {
      this.deps.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    this.deadlineKind = 'none';
  }

  private clearAdvance(): void {
    if (this.advanceTimer !== null) {
      this.deps.clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
  }

  private clearIntro(): void {
    if (this.introTimer !== null) {
      this.deps.clearTimeout(this.introTimer);
      this.introTimer = null;
    }
  }

  private clearSummaryTimer(): void {
    if (this.summaryTimer !== null) {
      this.deps.clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }
  }

  /** Everything except the per-player disconnect timers (those belong to the room membership, not the round). */
  private clearRoundTimers(): void {
    if (this.countdownTimer !== null) {
      this.deps.clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.clearIntro();
    this.clearDeadline();
    this.clearAdvance();
    this.clearSummaryTimer();
  }
}
