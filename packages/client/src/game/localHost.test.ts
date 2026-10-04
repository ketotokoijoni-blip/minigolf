// LocalHost through the public GameHost API with a fake clock and the REAL physics on the 9 built-in courses:
// a full round played by the greedy scripted player, the §9.6 replay check for every shot (zero desyncs), the
// hole-summary gate, restart, leave, shot validation (R3), listener semantics and the layers cache.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANIMATION_GRACE_MS, HOLE_INTRO_MS, TICK_HZ } from '@puttipeli/shared/constants';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import type { Course } from '@puttipeli/shared/course/types';
import type { GameEvent } from '@puttipeli/shared/game/events';
import { isMyTurn, otherBallCentres } from '@puttipeli/shared/game/selectors';
import type { GameState } from '@puttipeli/shared/game/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import { resetSimTuning } from '@puttipeli/shared/sim/tuning';
import { checkReplay, planReplay } from './controller';
import { clearLayersCache, createLocalHost, layersFor, LOCAL_PLAYER_ID, LocalHost, simulateLocal } from './localHost';
import { FakeClock, greedyShot } from './playTestSupport.test';

interface Logged { ev: GameEvent | null; prev: GameState | null; state: GameState }

interface Rig { host: LocalHost; clock: FakeClock; log: Logged[]; errors: string[]; types(): GameEvent['type'][] }

function rig(courses: Course[], extra: Partial<Parameters<typeof createLocalHost>[0]> = {}): Rig {
  const clock = new FakeClock();
  const host = createLocalHost({
    courses,
    playerName: '  Testaaja  ',
    colour: 2,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...extra,
  });
  const log: Logged[] = [];
  const errors: string[] = [];
  host.subscribe((state, ev, prev) => log.push({ ev, prev, state }));
  host.onError((code) => errors.push(code));
  return { host, clock, log, errors, types: () => log.filter((l) => l.ev !== null).map((l) => l.ev!.type) };
}

/** Starts the round and runs the 0 ms countdown and the hole intro: phase 'hole', player on turn. */
function startRound(r: Rig): void {
  expect(r.host.start()).toBeNull();
  r.clock.advance(0);
  r.clock.advance(HOLE_INTRO_MS);
  expect(r.host.getState().phase).toBe('hole');
  expect(isMyTurn(r.host.getState(), LOCAL_PLAYER_ID)).toBe(true);
}

/** Shoots the greedy shot and waits for the pacing timer (ticks / TICK_HZ + ANIMATION_GRACE_MS). */
function shootGreedy(r: Rig): void {
  const s = r.host.getState();
  const course = s.courses[s.holeIndex]!;
  const ball = s.balls[LOCAL_PLAYER_ID]!;
  const shot = greedyShot(layersFor(course), s.world!, ball, otherBallCentres(s, LOCAL_PLAYER_ID));
  r.host.shoot(shot);
  const after = r.host.getState();
  expect(after.turn?.shotInFlight).toBe(true);
  r.clock.advance((after.lastShot!.ticks / TICK_HZ) * 1000 + ANIMATION_GRACE_MS);
}

/** Plays until roundSummary, pressing "Jatka" at every hole summary. */
function playRound(r: Rig, maxSteps = 400): void {
  for (let i = 0; i < maxSteps; i++) {
    const s = r.host.getState();
    if (s.phase === 'roundSummary') return;
    if (s.phase === 'hole') {
      if (s.turn === null) {
        r.clock.advance(HOLE_INTRO_MS);
        continue;
      }
      shootGreedy(r);
    } else if (s.phase === 'holeSummary') {
      r.clock.advance(120_000); // holeSummarySec 0: nothing moves without the player
      expect(r.host.getState().phase).toBe('holeSummary');
      r.host.summaryReady();
    } else {
      throw new Error(`unexpected phase ${s.phase}`);
    }
  }
  throw new Error('round did not finish');
}

beforeEach(() => {
  resetSimTuning();
  clearLayersCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected INVALID_SHOT reports
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LocalHost: full single-player round on the built-in courses', () => {
  it('plays all 9 holes with the real physics; every shot replays bit-identically from the previous state', { timeout: 120_000 }, () => {
    const r = rig(BUILTIN_COURSES);
    const initial = r.host.getState();
    expect(initial.phase).toBe('lobby');
    expect(initial.players.map((p) => [p.id, p.name, p.colour, p.ready])).toEqual([[LOCAL_PLAYER_ID, 'Testaaja', 2, true]]);
    expect(initial.hostId).toBe(LOCAL_PLAYER_ID);
    expect(initial.settings).toEqual({ maxPlayers: 2, turnTimeoutSec: 0, holeSummarySec: 0, ballCollision: false });
    expect(r.log[0]).toMatchObject({ ev: null, prev: null }); // subscribe calls back immediately

    startRound(r);
    expect(r.types()).toEqual(['countdownStarted', 'gameStarted', 'holeStarted', 'turnStarted']);
    expect(r.host.getState().turn?.deadlineMs).toBeNull(); // turnTimeoutSec 0

    playRound(r);
    const final = r.host.getState();
    expect(final.phase).toBe('roundSummary');

    // Hole flow: 9 holeStarted in order, each followed by its first turnStarted exactly HOLE_INTRO_MS later.
    const holes = r.log.filter((l) => l.ev?.type === 'holeStarted').map((l) => (l.ev as Extract<GameEvent, { type: 'holeStarted' }>).holeIndex);
    expect(holes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.log.filter((l) => l.ev?.type === 'holeEnded')).toHaveLength(9);
    expect(r.log.filter((l) => l.ev?.type === 'roundEnded')).toHaveLength(1);

    // Scorecard: every hole played within the limits, the ranking has the one player with the total.
    const strokes = final.strokes[LOCAL_PLAYER_ID]!;
    expect(strokes).toHaveLength(9);
    strokes.forEach((s, i) => {
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(BUILTIN_COURSES[i]!.rules.maxStrokes);
    });
    const total = strokes.reduce((a, b) => a + b, 0);
    expect(final.ranking).toEqual([{ playerId: LOCAL_PLAYER_ID, total, rank: 1 }]);
    const holed = strokes.filter((s, i) => s < BUILTIN_COURSES[i]!.rules.maxStrokes).length;
    expect(holed).toBeGreaterThanOrEqual(7); // the greedy straight-line player holes most of the set

    // §9.6 / §12.4: the client's replay recipe (previous ball, previous world, other balls, the event's shot) must
    // reproduce the authority's checksum, result and tick count for every shot of the round: zero desyncs.
    const shots = r.log.filter((l) => l.ev?.type === 'shotTaken');
    expect(shots.length).toBe(total - shots.reduce((acc, l) => acc + (l.ev as Extract<GameEvent, { type: 'shotTaken' }>).outcome.penalty, 0));
    let mismatches = 0;
    for (const l of shots) {
      const ev = l.ev as Extract<GameEvent, { type: 'shotTaken' }>;
      const plan = planReplay(l.prev!, ev, LOCAL_PLAYER_ID);
      expect(plan).not.toBeNull();
      while (!plan!.it.done) plan!.it.step();
      const check = checkReplay(plan!.it, plan!.worldBefore, ev.outcome);
      if (!check.ok) mismatches++;
      // The reducer adopted exactly the authority's ball.
      expect(l.state.balls[LOCAL_PLAYER_ID]).toEqual(ev.outcome.ball);
    }
    expect(mismatches).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.clock.pending()).toBe(0); // single player: no auto-lobby timer in roundSummary
  });

  it('restart ("Pelaa uudelleen") goes back to the lobby and starts hole 1 again on the same courses', { timeout: 60_000 }, () => {
    const r = rig(BUILTIN_COURSES.slice(0, 2));
    startRound(r);
    playRound(r);
    expect(r.host.getState().phase).toBe('roundSummary');
    const before = r.types().length;
    r.host.restart();
    expect(r.types().slice(before)).toEqual(['backToLobby', 'countdownStarted']);
    r.clock.advance(0);
    expect(r.types().slice(before)).toEqual(['backToLobby', 'countdownStarted', 'gameStarted', 'holeStarted']);
    const s = r.host.getState();
    expect(s.phase).toBe('hole');
    expect(s.holeIndex).toBe(0);
    expect(s.courses).toBe(r.host.getState().courses);
    expect(s.strokes[LOCAL_PLAYER_ID]).toEqual([-1, -1]);
    expect(s.players).toHaveLength(1);
    r.clock.advance(HOLE_INTRO_MS);
    expect(isMyTurn(r.host.getState(), LOCAL_PLAYER_ID)).toBe(true);
    expect(r.host.getState().turn?.turnSeq).toBe(1); // turnSeq restarts per round
  });

  it('restart is ignored while a hole is being played', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    startRound(r);
    const n = r.log.length;
    r.host.restart();
    expect(r.log.length).toBe(n);
    expect(r.host.getState().phase).toBe('hole');
  });
});

describe('LocalHost: shots and errors (R3: validated like the server)', () => {
  it('shoot() is a no-op outside my open turn and reports INVALID_SHOT for bad vectors', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    r.host.shoot({ dx: 3000, dy: 0 }); // lobby
    expect(r.host.start()).toBeNull();
    r.clock.advance(0);
    r.host.shoot({ dx: 3000, dy: 0 }); // intro: no turn yet
    expect(r.host.getState().turn).toBeNull();
    r.clock.advance(HOLE_INTRO_MS);
    const seqBefore = r.host.getState().seq;

    r.host.shoot({ dx: 0, dy: 0 });
    r.host.shoot({ dx: 1.5, dy: 0 });
    r.host.shoot({ dx: 12_500, dy: 0 }); // beyond the cap
    r.host.shoot({ dx: -0, dy: 300 });
    expect(r.errors).toEqual([ErrorCode.INVALID_SHOT, ErrorCode.INVALID_SHOT, ErrorCode.INVALID_SHOT, ErrorCode.INVALID_SHOT]);
    expect(r.host.getState().seq).toBe(seqBefore);

    r.host.shoot({ dx: 3000, dy: 0 });
    const inFlight = r.host.getState();
    expect(inFlight.turn?.shotInFlight).toBe(true);
    expect(inFlight.strokes[LOCAL_PLAYER_ID]![0]).toBe(1);
    r.host.shoot({ dx: 3000, dy: 0 }); // in flight: silently ignored
    expect(r.host.getState().seq).toBe(inFlight.seq);
    expect(r.errors).toHaveLength(4);
  });

  it('a shot that lands in water costs a penalty stroke and returns the ball to the shot origin', () => {
    const lampi = BUILTIN_COURSES[3]!;
    expect(lampi.id).toBe('b_04');
    const r = rig([lampi]);
    startRound(r);
    const s = r.host.getState();
    const ball = s.balls[LOCAL_PLAYER_ID]!;
    // Straight east at full power from the tee (3,12) crosses the pond on the isthmus row only if perfectly aimed;
    // aim slightly down into the water instead.
    r.host.shoot({ dx: 11_900, dy: 1500 });
    const after = r.host.getState();
    const ev = r.log[r.log.length - 1]!.ev as Extract<GameEvent, { type: 'shotTaken' }>;
    expect(ev.type).toBe('shotTaken');
    if (ev.outcome.result === 'water') {
      expect(ev.outcome.penalty).toBe(1);
      expect(after.strokes[LOCAL_PLAYER_ID]![0]).toBe(2);
      expect(after.balls[LOCAL_PLAYER_ID]).toMatchObject({ x: ball.x, y: ball.y, moving: false });
    } else {
      expect(after.strokes[LOCAL_PLAYER_ID]![0]).toBe(1 + ev.outcome.penalty);
    }
  });
});

describe('LocalHost: leave, destroy, listeners', () => {
  it('leave() mid-round aborts: playerLeft, roundEnded, backToLobby; afterwards everything is a no-op', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 3));
    startRound(r);
    shootGreedy(r);
    const before = r.types().length;
    r.host.leave();
    expect(r.host.left).toBe(true);
    expect(r.types().slice(before)).toEqual(['playerLeft', 'roundEnded', 'backToLobby']);
    const s = r.host.getState();
    expect(s.phase).toBe('lobby');
    expect(s.players).toEqual([]);
    expect(r.clock.pending()).toBe(0);
    const n = r.log.length;
    r.host.leave();
    r.host.shoot({ dx: 3000, dy: 0 });
    r.host.summaryReady();
    r.host.restart();
    expect(r.host.start()).toBe(ErrorCode.NOT_IN_LOBBY);
    expect(r.log.length).toBe(n);
    r.host.destroy();
    expect(r.host.destroyed).toBe(true);
  });

  it('leave() in the round summary does not emit roundEnded again', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    startRound(r);
    playRound(r);
    const before = r.types().length;
    r.host.leave();
    expect(r.types().slice(before)).toEqual(['playerLeft', 'backToLobby']);
  });

  it('destroy() clears every timer so a destroyed host never emits again', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    expect(r.host.start()).toBeNull();
    expect(r.clock.pending()).toBe(1); // the 0 ms countdown
    r.host.destroy();
    expect(r.clock.pending()).toBe(0);
    const n = r.log.length;
    r.clock.advance(10_000);
    expect(r.log.length).toBe(n);
    expect(r.host.getState().phase).toBe('countdown');
  });

  it('listeners: immediate call, unsubscribe, and a throwing listener does not break the flow', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: (GameEvent['type'] | null)[] = [];
    const off = r.host.subscribe((_s, ev) => seen.push(ev?.type ?? null));
    r.host.subscribe(() => { throw new Error('boom'); });
    expect(seen).toEqual([null]);
    expect(r.host.start()).toBeNull();
    r.clock.advance(0);
    expect(seen).toEqual([null, 'countdownStarted', 'gameStarted', 'holeStarted']);
    expect(err).toHaveBeenCalled();
    off();
    r.clock.advance(HOLE_INTRO_MS);
    expect(seen).toHaveLength(4);
    expect(r.host.getState().phase).toBe('hole'); // the authority kept going despite the throwing listener
    expect(r.log.map((l) => l.ev?.type ?? null)).toEqual([null, 'countdownStarted', 'gameStarted', 'holeStarted', 'turnStarted']);
  });

  it('nowAuthorityMs follows the injected clock; chat is null; kind/local id are fixed', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    expect(r.host.kind).toBe('local');
    expect(r.host.chat).toBeNull();
    expect(r.host.isSpectator).toBe(false);
    expect(r.host.localPlayerId).toBe(LOCAL_PLAYER_ID);
    expect(r.host.nowAuthorityMs()).toBe(r.clock.now());
    r.clock.advance(1234);
    expect(r.host.nowAuthorityMs()).toBe(r.clock.now());
    r.host.requestSnapshot(); // no-op
    expect(r.host.returnTo).toBe('#/');
    expect(r.host.testPlay).toBe(false);
  });

  it('rejects an empty course set and caps the name', () => {
    expect(() => createLocalHost({ courses: [], playerName: 'x', colour: 0 })).toThrow();
    const h = createLocalHost({ courses: BUILTIN_COURSES.slice(0, 1), playerName: '', colour: 0, testPlay: true, returnTo: '#/editor' });
    expect(h.getState().players[0]!.name).toBe('Pelaaja');
    expect(h.testPlay).toBe(true);
    expect(h.returnTo).toBe('#/editor');
    const long = createLocalHost({ courses: BUILTIN_COURSES.slice(0, 1), playerName: 'A'.repeat(40), colour: 3 });
    expect(long.getState().players[0]!.name).toHaveLength(16);
    h.destroy();
    long.destroy();
  });
});

describe('layersFor cache', () => {
  it('reuses the decode for the same course object and for a structurally equal copy', () => {
    const c = BUILTIN_COURSES[0]!;
    const a = layersFor(c);
    expect(layersFor(c)).toBe(a);
    const copy = JSON.parse(JSON.stringify(c)) as Course;
    expect(layersFor(copy)).toBe(a);
  });

  it('never serves stale geometry for a different course that claims the same id (R13 defence)', () => {
    const c = BUILTIN_COURSES[1]!;
    const a = layersFor(c);
    const edited: Course = { ...c, objects: c.objects.map((o) => (o.type === 'hole' ? { ...o, x: o.x - 1 } : o)) };
    const b = layersFor(edited);
    expect(b).not.toBe(a);
    expect(b.holes[0]!.cx).toBe(a.holes[0]!.cx - 15);
  });

  it('simulateLocal wraps the real sim into the wire summary', () => {
    const c = BUILTIN_COURSES[0]!;
    const layers = layersFor(c);
    const world = { walls: layers.walls.slice(), breakHits: new Uint8Array(layers.walls.length), minesArmed: new Uint8Array(layers.mines.length).fill(1) };
    const ball = { x: layers.start.x, y: layers.start.y, vx: 0, vy: 0, moving: false, lastTile: layers.startTile, teleportCooldownTile: -1, insideOneWay: -1, slowTicks: 0 };
    const sum = simulateLocal(c, world, ball, { dx: 3000, dy: 0 }, []);
    expect(sum.ticks).toBeGreaterThan(0);
    expect(sum.result).toBe('stopped');
    expect(sum.ball.x).toBeGreaterThan(ball.x);
    expect(sum.ball.moving).toBe(false);
    expect(sum.worldDelta).toEqual({ tiles: [], minesDisarmed: [] });
    expect(ball.x).toBe(layers.start.x); // inputs untouched
  });
});
