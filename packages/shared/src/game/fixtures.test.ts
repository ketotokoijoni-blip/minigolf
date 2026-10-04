// Shared test support for the WP-C suites (courses, players, deep freeze, fake clock, fake simulate, Authority
// harness). It is a *.test.ts file so that it stays inside WP-C's ownership (§3); the single sanity test below keeps
// Vitest happy when the file is collected on its own.
import { describe, expect, it } from 'vitest';
import { COURSE_H, COURSE_W, TILE } from '../constants';
import type { Course, CourseObject } from '../course/types';
import type { BallState, ShotInput, ShotSummary } from '../sim/types';
import { Authority, type AuthorityDeps } from './authority';
import type { GameEvent } from './events';
import { createLobbyState, DEFAULT_ROOM_SETTINGS } from './initial';
import type { GameState, PlayerColour, PlayerState, RoomSettings } from './types';

export interface CourseOpts {
  id?: string;
  name?: string;
  par?: number;
  maxStrokes?: number;
  start?: { x: number; y: number };
  hole?: { x: number; y: number };
  objects?: CourseObject[];
}

/** Bordered 49x25 grass course with one start and one hole (valid per §7.5). */
export function makeCourse(opts: CourseOpts = {}): Course {
  const start = opts.start ?? { x: 3, y: 12 };
  const hole = opts.hole ?? { x: 44, y: 12 };
  const surface = Array.from({ length: COURSE_H }, () => '.'.repeat(COURSE_W));
  const walls = Array.from({ length: COURSE_H }, (_, y) =>
    y === 0 || y === COURSE_H - 1 ? '#'.repeat(COURSE_W) : '#' + '.'.repeat(COURSE_W - 2) + '#',
  );
  return {
    format: 'puttipeli-course',
    formatVersion: 1,
    id: opts.id ?? 'c_0000000000000001',
    name: opts.name ?? 'Testirata',
    author: 'Testi',
    description: '',
    width: 49,
    height: 25,
    rules: { maxStrokes: opts.maxStrokes ?? 20, par: opts.par ?? 3 },
    surface,
    walls,
    objects: [{ type: 'start', x: start.x, y: start.y }, { type: 'hole', x: hole.x, y: hole.y }, ...(opts.objects ?? [])],
  };
}

export const START_CENTRE = { x: (3 + 0.5) * TILE, y: (12 + 0.5) * TILE };

export function makePlayer(id: string, joinedSeq: number, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name: id.toUpperCase(),
    colour: ((joinedSeq - 1) % 4) as PlayerColour,
    ready: false,
    connected: true,
    afk: false,
    consecutiveTimeouts: 0,
    joinedSeq,
    leftRound: false,
    ...overrides,
  };
}

/** Recursively freezes plain objects and arrays. Typed arrays are skipped (a typed array with elements cannot be frozen). */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}

/** A valid shot: 30 px pull to the east. */
export const SHOT: ShotInput = { dx: 3000, dy: 0 };

export class FakeClock {
  private t: number;
  private nextId = 1;
  private timers = new Map<number, { due: number; fn: () => void; seq: number }>();
  private seq = 0;
  constructor(start = 1_000_000) {
    this.t = start;
  }
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { due: this.t + Math.max(0, ms), fn, seq: this.seq++ });
    return id;
  };
  clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };
  pending(): number {
    return this.timers.size;
  }
  /** Advances time, firing due timers in due-time order (ties by scheduling order); timers scheduled meanwhile run if due. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let best: { id: number; due: number; seq: number; fn: () => void } | null = null;
      for (const [id, tm] of this.timers) {
        if (tm.due <= target && (best === null || tm.due < best.due || (tm.due === best.due && tm.seq < best.seq))) {
          best = { id, due: tm.due, seq: tm.seq, fn: tm.fn };
        }
      }
      if (best === null) break;
      this.timers.delete(best.id);
      this.t = Math.max(this.t, best.due);
      best.fn();
    }
    this.t = target;
  }
}

export interface FakeSim {
  fn: AuthorityDeps['simulate'];
  /** Overrides for the next call(s), consumed in order. */
  queue(...partials: Partial<ShotSummary>[]): void;
  calls: { ball: BallState; shot: ShotInput; others: { x: number; y: number }[] }[];
}

/** Canned physics: the ball moves by shot/100 px and stops after 120 ticks unless a queued override says otherwise. */
export function fakeSimulate(): FakeSim {
  const queued: Partial<ShotSummary>[] = [];
  const calls: FakeSim['calls'] = [];
  const fn: AuthorityDeps['simulate'] = (_course, _world, ball, shot, others) => {
    calls.push({ ball, shot, others });
    const base: ShotSummary = {
      ticks: 120,
      result: 'stopped',
      penalty: 0,
      holeIndex: -1,
      ball: { ...ball, x: ball.x + shot.dx / 100, y: ball.y + shot.dy / 100, vx: 0, vy: 0, moving: false },
      worldDelta: { tiles: [], minesDisarmed: [] },
      checksum: 0,
    };
    const over = queued.shift();
    return over === undefined ? base : { ...base, ...over };
  };
  return { fn, queue: (...p) => queued.push(...p), calls };
}

export interface Harness {
  auth: Authority;
  clock: FakeClock;
  sim: FakeSim;
  events: GameEvent[];
  /** Event types emitted since the last take(). */
  take(): GameEvent['type'][];
  state(): GameState;
}

export function createHarness(opts: {
  courses?: Course[];
  settings?: Partial<RoomSettings>;
  minPlayers?: 1 | 2;
  initial?: GameState;
} = {}): Harness {
  const clock = new FakeClock();
  const sim = fakeSimulate();
  const events: GameEvent[] = [];
  let cursor = 0;
  const courses = opts.courses ?? [makeCourse({ id: 'c_a', name: 'A', par: 3 }), makeCourse({ id: 'c_b', name: 'B', par: 4 })];
  const initial = opts.initial ?? createLobbyState({ ...DEFAULT_ROOM_SETTINGS, ...opts.settings }, courses);
  const auth = new Authority(initial, {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    simulate: sim.fn,
    emit: (ev) => events.push(ev),
    minPlayers: opts.minPlayers ?? 2,
  });
  return {
    auth,
    clock,
    sim,
    events,
    take: () => {
      const slice = events.slice(cursor).map((e) => e.type);
      cursor = events.length;
      return slice;
    },
    state: () => auth.state,
  };
}

/** Seats `n` players (p1..pn), readies everyone except the host, and returns their ids. */
export function seatPlayers(h: Harness, n: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `p${i}`;
    expect(h.auth.join(makePlayer(id, 0, { colour: 0 }))).toBeNull();
    ids.push(id);
  }
  for (const id of ids) if (id !== h.state().hostId) h.auth.setReady(id, true);
  return ids;
}

/** Seats players, starts, runs the countdown and the hole intro: the state is in 'hole' with order[0] on turn. */
export function startRound(h: Harness, n: number): string[] {
  const ids = seatPlayers(h, n);
  expect(h.auth.start('p1')).toBeNull();
  h.clock.advance(3000);
  h.clock.advance(1000);
  expect(h.state().phase).toBe('hole');
  expect(h.state().turn).not.toBeNull();
  return ids;
}

/** Lets the player on turn shoot and waits for the pacing timer to pass the turn on. */
export function shootAndWait(h: Harness, over?: Partial<ShotSummary>): void {
  const s = h.state();
  const turn = s.turn!;
  if (over !== undefined) h.sim.queue(over);
  expect(h.auth.shoot(turn.playerId, s.holeIndex, turn.turnSeq, SHOT)).toBeNull();
  h.clock.advance(1250);
}

describe('fixtures', () => {
  it('build a valid course and a seated lobby', () => {
    const c = makeCourse();
    expect(c.walls).toHaveLength(COURSE_H);
    expect(c.walls[0]).toHaveLength(COURSE_W);
    const h = createHarness();
    seatPlayers(h, 2);
    expect(h.state().players.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
