// In-process authority for single player and editor test play (DESIGN §6.5 GameHost, §10.7, §12.4).
//
// LocalHost wraps the shared Authority (WP-C) with `minPlayers: 1`, browser timers and the real physics
// (decodeLayers + simulateShot + toShotSummary), so single player, test play and multiplayer share one state
// machine (D1, D2). Shots are validated with validateShot exactly like the server does (R3). Nothing here touches
// the DOM: the same class runs in the node-environment tests with injected timers.
import { DEFAULT_PLAYER_NAME, MAX_COURSES_PER_SET, MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import { decodeLayers } from '@puttipeli/shared/course/parse';
import type { Course, CourseLayers, Vec2 } from '@puttipeli/shared/course/types';
import { Authority, type AuthorityDeps } from '@puttipeli/shared/game/authority';
import type { GameEvent } from '@puttipeli/shared/game/events';
import { createSinglePlayerState } from '@puttipeli/shared/game/initial';
import { isMyTurn } from '@puttipeli/shared/game/selectors';
import type { GameState, PlayerColour, PlayerState } from '@puttipeli/shared/game/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import { validateShot } from '@puttipeli/shared/sim/shot';
import { simulateShot, toShotSummary } from '@puttipeli/shared/sim/simulate';
import type { BallState, ShotInput, ShotSummary, WorldState } from '@puttipeli/shared/sim/types';
import type { GameHost, HostListener } from './gameHost';

// ---------------------------------------------------------------------------------------------------------------
// Course layers cache (shared by the local authority and the play view controller)
// ---------------------------------------------------------------------------------------------------------------

interface LayersEntry { course: Course; signature: string; layers: CourseLayers }

const layersCache = new Map<string, LayersEntry>();
/** Enough for the built-in set plus a generous number of custom courses; the cache is simply emptied beyond this. */
const MAX_CACHED_LAYERS = 64;

/** The parts of a course that determine its decoded layers (name/author/description do not). */
function courseSignature(course: Course): string {
  return JSON.stringify([course.surface, course.walls, course.objects, course.rules]);
}

/**
 * decodeLayers(course), cached per course id (§12.4). Ids are content hashes for custom courses and reserved for
 * built-ins (R13); as a defence against a stale id on an edited course the cached entry is only reused when the
 * object is the same reference or its geometry signature matches, so a collision can never yield wrong geometry.
 */
export function layersFor(course: Course): CourseLayers {
  const hit = layersCache.get(course.id);
  if (hit !== undefined) {
    if (hit.course === course) return hit.layers;
    if (hit.signature === courseSignature(course)) {
      hit.course = course;
      return hit.layers;
    }
  }
  const layers = decodeLayers(course);
  if (layersCache.size >= MAX_CACHED_LAYERS) layersCache.clear();
  layersCache.set(course.id, { course, signature: courseSignature(course), layers });
  return layers;
}

/** Drops every cached decode (tests). */
export function clearLayersCache(): void {
  layersCache.clear();
}

/** The `simulate` dependency of the Authority: decodeLayers (cached) + simulateShot + toShotSummary. */
export function simulateLocal(course: Course, world: WorldState, ball: BallState, shot: ShotInput, otherBalls: Vec2[]): ShotSummary {
  return toShotSummary(simulateShot(layersFor(course), world, ball, shot, otherBalls));
}

// ---------------------------------------------------------------------------------------------------------------
// LocalHost
// ---------------------------------------------------------------------------------------------------------------

export const LOCAL_PLAYER_ID = 'local';

export interface LocalHostOptions {
  /** 1..MAX_COURSES_PER_SET validated courses in play order. */
  courses: Course[];
  playerName: string;
  colour: PlayerColour;
  /** Editor test play: the HUD shows a label and leaving returns to `returnTo`. */
  testPlay?: boolean;
  /** Hash to navigate to after the round / on leave ('#/' by default). */
  returnTo?: string;
  /** Test seams; the defaults are Date.now, the global timers and the real physics. */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
  simulate?: AuthorityDeps['simulate'];
}

function sanitizeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_CHARS);
  return clean.length > 0 ? clean : DEFAULT_PLAYER_NAME;
}

const defaultSetTimeout = (fn: () => void, ms: number): number => globalThis.setTimeout(fn, ms) as unknown as number;
const defaultClearTimeout = (id: number): void => globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>);

export class LocalHost implements GameHost {
  readonly kind = 'local' as const;
  readonly localPlayerId = LOCAL_PLAYER_ID;
  readonly isSpectator = false;
  readonly chat = null;
  readonly testPlay: boolean;
  readonly returnTo: string;
  readonly courses: readonly Course[];

  private readonly auth: Authority;
  private readonly player: PlayerState;
  private readonly clock: () => number;
  private current: GameState;
  private readonly listeners = new Set<HostListener>();
  private readonly errorListeners = new Set<(code: string, message: string) => void>();
  private _started = false;
  private _left = false;
  private _destroyed = false;

  constructor(opts: LocalHostOptions) {
    const courses = opts.courses.slice(0, MAX_COURSES_PER_SET);
    if (courses.length === 0) throw new Error('LocalHost: at least one course is required');
    this.courses = courses;
    this.testPlay = opts.testPlay === true;
    this.returnTo = opts.returnTo && opts.returnTo.length > 0 ? opts.returnTo : '#/';
    this.clock = opts.now ?? (() => Date.now());
    this.player = {
      id: LOCAL_PLAYER_ID,
      name: sanitizeName(opts.playerName),
      colour: opts.colour,
      ready: true,
      connected: true,
      afk: false,
      consecutiveTimeouts: 0,
      joinedSeq: 1,
      leftRound: false,
    };
    this.auth = new Authority(createSinglePlayerState(courses, this.player), {
      now: this.clock,
      setTimeout: opts.setTimeout ?? defaultSetTimeout,
      clearTimeout: opts.clearTimeout ?? defaultClearTimeout,
      simulate: opts.simulate ?? simulateLocal,
      emit: (ev) => this.onEvent(ev),
      minPlayers: 1,
    });
    this.current = this.auth.state;
  }

  /** True once start() has been called (the round may since have ended or been aborted). */
  get started(): boolean { return this._started; }
  /** True after leave(): the round was aborted and the host emits nothing more. */
  get left(): boolean { return this._left; }
  get destroyed(): boolean { return this._destroyed; }

  /**
   * §10.7: join(player) then start(player.id). The player is already seated by createSinglePlayerState, so join is a
   * no-op; start emits countdownStarted and schedules the 0 ms countdown -> gameStarted -> holeStarted(0).
   */
  start(): ErrorCode | null {
    if (this._destroyed || this._left) return ErrorCode.NOT_IN_LOBBY;
    const joinErr = this.auth.join(this.player);
    if (joinErr !== null) {
      this.fail(joinErr, 'join');
      return joinErr;
    }
    const err = this.auth.start(this.localPlayerId);
    if (err !== null) {
      this.fail(err, 'start');
      return err;
    }
    this._started = true;
    return null;
  }

  getState(): GameState {
    return this.auth.state;
  }

  subscribe(listener: HostListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.auth.state, null, null);
    } catch (err) {
      console.error('[puttipeli] game listener failed', err);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** No-op unless phase 'hole', it is my turn and no shot is in flight. An invalid vector reports INVALID_SHOT. */
  shoot(shot: ShotInput): void {
    if (this._destroyed || this._left) return;
    const s = this.auth.state;
    if (!isMyTurn(s, this.localPlayerId) || s.turn === null) return;
    if (!validateShot(shot)) {
      this.fail(ErrorCode.INVALID_SHOT, 'shoot');
      return;
    }
    const err = this.auth.shoot(this.localPlayerId, s.holeIndex, s.turn.turnSeq, shot);
    if (err !== null) this.fail(err, 'shoot');
  }

  summaryReady(): void {
    if (this._destroyed || this._left) return;
    this.auth.summaryReady(this.localPlayerId);
  }

  backToLobby(): void {
    if (this._destroyed || this._left) return;
    const err = this.auth.backToLobby(this.localPlayerId);
    if (err !== null) this.fail(err, 'backToLobby');
  }

  /** "Pelaa uudelleen": backToLobby + start on the same courses (§10.7). Accepted in roundSummary (and the lobby). */
  restart(): void {
    if (this._destroyed || this._left) return;
    const phase = this.auth.state.phase;
    if (phase !== 'roundSummary' && phase !== 'lobby') return;
    if (phase === 'roundSummary') {
      const err = this.auth.backToLobby(this.localPlayerId);
      if (err !== null) {
        this.fail(err, 'restart');
        return;
      }
    }
    this.start();
  }

  /** The local reducer state is the authority state: nothing to fetch. */
  requestSnapshot(): void {
    /* no-op for local */
  }

  nowAuthorityMs(): number {
    return this.clock();
  }

  onError(listener: (code: string, message: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** Aborts the round: playerLeft, then (mid-round) roundEnded + backToLobby per §10.5. Idempotent. */
  leave(): void {
    if (this._destroyed || this._left) return;
    this._left = true;
    if (this.auth.state.players.some((p) => p.id === this.localPlayerId)) this.auth.leave(this.localPlayerId);
  }

  /** Clears every timer and listener; the instance emits nothing afterwards. */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.auth.dispose();
    this.listeners.clear();
    this.errorListeners.clear();
  }

  private onEvent(ev: GameEvent): void {
    const prev = this.current;
    this.current = this.auth.state;
    // A throwing listener must not break the authority's flow (its timers are scheduled after emit).
    for (const listener of [...this.listeners]) {
      try {
        listener(this.current, ev, prev);
      } catch (err) {
        console.error('[puttipeli] game listener failed', err);
      }
    }
  }

  private fail(code: ErrorCode, context: string): void {
    const message = `${context}: ${code}`;
    console.warn('[puttipeli] localHost', message);
    for (const listener of [...this.errorListeners]) {
      try {
        listener(code, message);
      } catch (err) {
        console.error('[puttipeli] error listener failed', err);
      }
    }
  }
}

export function createLocalHost(opts: LocalHostOptions): LocalHost {
  return new LocalHost(opts);
}
