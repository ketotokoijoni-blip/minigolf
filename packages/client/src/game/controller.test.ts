// GameController logic with a fake PlayView (no DOM, no canvas) driving a real LocalHost (fake clock, real
// physics): start -> title card -> aim armed, shot replay built from the previous state, checksum comparison,
// fast-forward on a later event, hole/round summaries and keyboard flow, pause, leave confirmation, desync path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANIMATION_GRACE_MS, HOLE_INTRO_MS, MAX_PULL_PX, POWER_SCALE, SHOT_QUANTUM, TICK_HZ } from '@puttipeli/shared/constants';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import type { Course } from '@puttipeli/shared/course/types';
import { isMyTurn, otherBallCentres } from '@puttipeli/shared/game/selectors';
import type { GameState, PlayerState } from '@puttipeli/shared/game/types';
import { isNullShot, validateShot } from '@puttipeli/shared/sim/shot';
import { createBallAt } from '@puttipeli/shared/sim/worldState';
import { resetSimTuning } from '@puttipeli/shared/sim/tuning';
import type { ShotInput } from '@puttipeli/shared/sim/types';
import { GameController, ballSprites, type GameControllerOptions } from './controller';
import type { GameHost } from './gameHost';
import { aimToShot, pullToAim, shotToPull } from './input';
import { clearLayersCache, createLocalHost, layersFor, LOCAL_PLAYER_ID, LocalHost, simulateLocal } from './localHost';
import { FakeClock, fakeView, greedyShot, type FakeView } from './playTestSupport.test';

interface Rig {
  host: LocalHost;
  clock: FakeClock;
  view: FakeView;
  ctl: GameController;
  left: number;
  confirms: string[];
  confirmAnswer: boolean;
}

function rig(courses: Course[], opts: Partial<GameControllerOptions> & { simulate?: typeof simulateLocal } = {}): Rig {
  const clock = new FakeClock();
  const host = createLocalHost({
    courses,
    playerName: 'Testi',
    colour: 1,
    testPlay: opts.testPlay,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    simulate: opts.simulate,
  });
  const view = fakeView();
  const r: Rig = { host, clock, view, ctl: null as unknown as GameController, left: 0, confirms: [], confirmAnswer: true };
  r.ctl = new GameController(host, null as unknown as HTMLElement, {
    view,
    testPlay: opts.testPlay,
    onLeave: () => { r.left++; },
    confirm: (text) => { r.confirms.push(text); return Promise.resolve(r.confirmAnswer); },
    settings: { volume: 0.5, touchFireButton: false, reduceEffects: false },
  });
  return r;
}

const pacing = (r: Rig): number => (r.host.getState().lastShot!.ticks / TICK_HZ) * 1000 + ANIMATION_GRACE_MS;

function start(r: Rig): void {
  expect(r.host.start()).toBeNull();
  r.clock.advance(0); // countdown -> gameStarted -> holeStarted
}

function greedy(r: Rig): ShotInput {
  const s = r.host.getState();
  return greedyShot(layersFor(s.courses[s.holeIndex]!), s.world!, s.balls[LOCAL_PLAYER_ID]!, otherBallCentres(s, LOCAL_PLAYER_ID));
}

/** Fires a greedy shot through the fake aim input, completes the replay, waits for the pacing timer. */
function playStroke(r: Rig): void {
  expect(r.view.aim.fire(greedy(r))).toBe(true);
  r.view.animator.finish();
  r.clock.advance(pacing(r));
}

beforeEach(() => {
  resetSimTuning();
  clearLayersCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameController: start of a round', () => {
  it('sets the course on holeStarted, shows the title card and arms the aim at the tee after the intro', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 2));
    expect(r.view.hud.label).toBeNull();
    expect(r.view.renderer.courses).toHaveLength(0);
    start(r);
    const s = r.host.getState();
    expect(s.phase).toBe('hole');
    const layers = layersFor(s.courses[0]!);
    expect(r.view.renderer.courses).toHaveLength(1);
    expect(r.view.renderer.courses[0]!.layers).toBe(layers);
    expect(r.view.renderer.courses[0]!.world).toBe(s.world);
    expect(r.view.overlays.titleCards).toHaveLength(1);
    expect(r.view.aim.targets).toEqual(layers.holes.map((h) => ({ x: h.cx, y: h.cy })));
    expect(r.view.aim.enabled).toBe(false); // no turn yet during the intro
    expect(r.view.renderer.balls.map((b) => b.id)).toEqual([LOCAL_PLAYER_ID]);
    expect(r.view.renderer.balls[0]!.highlight).toBe(false);

    r.clock.advance(HOLE_INTRO_MS);
    expect(isMyTurn(r.host.getState(), LOCAL_PLAYER_ID)).toBe(true);
    expect(r.view.aim.enabled).toBe(true);
    expect(r.view.aim.ball).toEqual({ x: layers.start.x, y: layers.start.y });
    expect(r.view.aim.setBallCalls).toBe(1);
    expect(r.view.renderer.balls[0]!.highlight).toBe(true);

    // One frame: HUD and renderer updated, power bar at 0 while aiming without a preview, then mirrors the preview.
    r.view.tick(16);
    expect(r.view.hud.updates).toBe(1);
    expect(r.view.renderer.renders).toBe(1);
    expect(r.view.hud.power).toBe(0);
    expect(r.view.renderer.aim).toBeNull();
    r.view.aim.preview = { from: { x: layers.start.x, y: layers.start.y }, pull: { x: 60, y: 0 }, power: 0.5 };
    r.view.tick(32);
    expect(r.view.renderer.aim).toBe(r.view.aim.preview);
    expect(r.view.hud.power).toBe(0.5);
  });

  it('test play shows the HUD label', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1), { testPlay: true });
    expect(r.view.hud.label).toBe('Testaus · Esc: takaisin editoriin');
    r.ctl.destroy();
  });
});

describe('GameController: shots', () => {
  it('replays a shot from the previous state, locks aiming in flight and matches the authority checksum', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    start(r);
    r.clock.advance(HOLE_INTRO_MS);
    const before = r.host.getState();
    const tee = before.balls[LOCAL_PLAYER_ID]!;
    const worldsBefore = r.view.renderer.worlds.length;
    const shot = greedy(r);

    expect(r.view.aim.fire(shot)).toBe(true);
    expect(r.view.unlocks).toBe(1);
    const inFlight = r.host.getState();
    expect(inFlight.turn?.shotInFlight).toBe(true);
    expect(r.view.animator.plays).toBe(1);
    const anim = r.view.animator.current!;
    expect(anim.sprite.id).toBe(LOCAL_PLAYER_ID);
    expect(anim.sprite.colour).toBe(1);
    expect(anim.it.ball.x).toBe(tee.x); // the iterator starts from the PREVIOUS ball (it is moving now)
    expect(anim.it.ball.y).toBe(tee.y);
    expect(anim.it.ball.moving).toBe(true);
    expect(anim.it.ctx.otherBalls).toEqual([]);
    expect(r.view.aim.enabled).toBe(false);
    expect(r.view.renderer.worlds.length).toBe(worldsBefore); // the new world is not pushed before the replay ends
    expect(r.view.aim.fire(shot)).toBe(false); // input locked

    r.view.animator.finish();
    expect(r.ctl.desyncCount).toBe(0);
    const after = r.host.getState();
    expect(r.view.renderer.worlds[r.view.renderer.worlds.length - 1]).toBe(after.world);
    if (after.holeDone[LOCAL_PLAYER_ID]) {
      expect(r.view.renderer.balls).toEqual([]); // holed: the ball has left the field
    } else {
      expect(r.view.renderer.balls).toHaveLength(1);
      expect(r.view.renderer.balls[0]!.ball).toBe(after.balls[LOCAL_PLAYER_ID]);
    }

    r.clock.advance(pacing(r));
    const next = r.host.getState();
    if (next.phase === 'hole') {
      expect(r.view.aim.enabled).toBe(true);
      expect(r.view.aim.ball).toEqual({ x: next.balls[LOCAL_PLAYER_ID]!.x, y: next.balls[LOCAL_PLAYER_ID]!.y });
      expect(r.view.aim.setBallCalls).toBe(2);
    } else {
      expect(next.phase).toBe('holeSummary');
      expect(r.view.overlays.summary).toBe('hole');
    }
  });

  it('fast-forwards a running replay when a later event arrives', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    start(r);
    r.clock.advance(HOLE_INTRO_MS);
    expect(r.view.aim.fire({ dx: 3000, dy: 0 })).toBe(true);
    expect(r.view.animator.running).toBe(true);
    r.clock.advance(pacing(r)); // the authority moves on: turnStarted arrives while "animating"
    expect(r.view.animator.fastForwards).toBe(1);
    expect(r.view.animator.running).toBe(false);
    expect(r.ctl.desyncCount).toBe(0);
    expect(r.host.getState().turn?.shotInFlight).toBe(false);
    expect(r.view.aim.enabled).toBe(true);
  });

  it('a shotTaken that interrupts a running replay keeps its world off the static layer until its own replay ends', () => {
    // Record the real event stream of two strokes, then feed it to the controller WITHOUT the turnStarted between
    // them (a client that fell behind and gets the next shot while the previous one is still animating).
    type Triple = { state: GameState; ev: Parameters<Parameters<LocalHost['subscribe']>[0]>[1]; prev: GameState | null };
    const clock = new FakeClock();
    const src = createLocalHost({ courses: BUILTIN_COURSES.slice(0, 1), playerName: 'Testi', colour: 1, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    const log: Triple[] = [];
    src.subscribe((state, ev, prev) => log.push({ state, ev, prev }));
    expect(src.start()).toBeNull();
    clock.advance(0);
    clock.advance(HOLE_INTRO_MS);
    const weak: ShotInput = { dx: 400, dy: 0 }; // a short putt: the hole continues
    src.shoot(weak);
    expect(src.getState().holeDone[LOCAL_PLAYER_ID]).not.toBe(true);
    clock.advance((src.getState().lastShot!.ticks / TICK_HZ) * 1000 + ANIMATION_GRACE_MS);
    expect(src.getState().turn?.shotInFlight).toBe(false);
    src.shoot({ dx: -400, dy: 0 });
    const shots = log.filter((l) => l.ev?.type === 'shotTaken');
    expect(shots).toHaveLength(2);
    const [a, b] = shots as [Triple, Triple];
    const initial = log.find((l) => l.ev?.type === 'holeStarted')!.state;
    src.destroy();

    let current = initial;
    let listener: ((s: GameState, e: Triple['ev'], p: GameState | null) => void) | null = null;
    const fakeHost: GameHost = {
      kind: 'remote',
      localPlayerId: LOCAL_PLAYER_ID,
      isSpectator: false,
      chat: null,
      getState: () => current,
      subscribe(l) { listener = l; l(current, null, null); return () => { listener = null; }; },
      shoot() {}, summaryReady() {}, backToLobby() {}, restart() {}, requestSnapshot() {},
      nowAuthorityMs: () => clock.now(),
      onError() { return () => {}; },
      leave() {}, destroy() {},
    };
    const view = fakeView();
    const ctl = new GameController(fakeHost, null as unknown as HTMLElement, { view, settings: { volume: 0, touchFireButton: false, reduceEffects: false } });
    const emit = (tr: Triple): void => { current = tr.state; listener!(tr.state, tr.ev, tr.prev); };

    emit(a);
    expect(view.animator.running).toBe(true);
    const worldsBeforeB = view.renderer.worlds.length;
    emit(b); // arrives mid-replay: A is fast-forwarded, B starts
    expect(view.animator.fastForwards).toBe(1);
    expect(view.animator.running).toBe(true);
    expect(view.animator.current!.it.ball.x).toBe(b.prev!.balls[LOCAL_PLAYER_ID]!.x); // B replays from its own previous state
    expect(view.renderer.worlds.length).toBe(worldsBeforeB); // the world containing B's changes is not drawn yet
    expect(view.renderer.worlds).not.toContain(b.state.world);
    view.animator.finish();
    expect(view.renderer.worlds[view.renderer.worlds.length - 1]).toBe(b.state.world); // ...but it is once B ends
    expect(ctl.desyncCount).toBe(0);
    ctl.destroy();
  });

  it('detects a desync: logs, counts and requests a snapshot; gameplay follows the reducer state', () => {
    const wrong: typeof simulateLocal = (course, world, ball, shot, others) => {
      const sum = simulateLocal(course, world, ball, shot, others);
      return { ...sum, checksum: (sum.checksum ^ 1) >>> 0 };
    };
    const r = rig(BUILTIN_COURSES.slice(0, 1), { simulate: wrong });
    const snapshot = vi.spyOn(r.host, 'requestSnapshot');
    start(r);
    r.clock.advance(HOLE_INTRO_MS);
    expect(r.view.aim.fire({ dx: 3000, dy: 0 })).toBe(true);
    r.view.animator.finish();
    expect(r.ctl.desyncCount).toBe(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('[puttipeli] desync', expect.objectContaining({ player: LOCAL_PLAYER_ID, turnSeq: 1 }));
    expect(r.view.renderer.balls[0]!.ball).toBe(r.host.getState().balls[LOCAL_PLAYER_ID]);
  });
});

describe('GameController: summaries, keys, pause and leaving', () => {
  it('runs a 2-hole round: hole summary waits for Space, title card per hole, round summary with applause, restart', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 2));
    start(r);
    for (let guard = 0; guard < 100; guard++) {
      const s = r.host.getState();
      if (s.phase === 'roundSummary') break;
      if (s.phase === 'hole') {
        if (s.turn === null) r.clock.advance(HOLE_INTRO_MS);
        else playStroke(r);
      } else if (s.phase === 'holeSummary') {
        expect(r.view.overlays.summary).toBe('hole');
        expect(r.view.overlays.holeSummaries[r.view.overlays.holeSummaries.length - 1]).toBe(s);
        expect(r.view.overlays.lastCtx).toEqual({ localPlayerId: LOCAL_PLAYER_ID, kind: 'local', testPlay: false, isHost: true, holed: expect.any(Object) });
        // The deciding shot's result travels to the summary (GameState keeps none): holed unless the limit cut it.
        const holedOut = s.strokes[LOCAL_PLAYER_ID]![s.holeIndex]! < s.courses[s.holeIndex]!.rules.maxStrokes;
        expect(r.view.overlays.lastCtx!.holed).toEqual({ [LOCAL_PLAYER_ID]: holedOut });
        expect(r.view.aim.enabled).toBe(false);
        r.clock.advance(60_000); // nothing moves without the player (holeSummarySec 0)
        expect(r.host.getState().phase).toBe('holeSummary');
        expect(r.view.key(' ')).toBe(true); // Space = Jatka
        expect(r.host.getState().phase).not.toBe('holeSummary');
      }
    }
    const final = r.host.getState();
    expect(final.phase).toBe('roundSummary');
    expect(r.view.overlays.titleCards).toHaveLength(2);
    expect(r.view.overlays.holeSummaries).toHaveLength(2);
    expect(r.view.overlays.roundSummaries).toHaveLength(1);
    expect(r.view.overlays.summary).toBe('round');
    expect(r.view.played).toContain('applause');
    expect(r.ctl.desyncCount).toBe(0);
    expect(r.view.key(' ')).toBe(false); // Space does nothing in the round summary

    // "Pelaa uudelleen" through the overlay action: lobby -> new round on the same courses.
    const actions = r.view.overlays.roundActions!;
    expect(actions.onRestart).toBeTypeOf('function');
    expect(actions.onReady).toBeUndefined();
    actions.onRestart!();
    expect(r.view.overlays.summary).toBe('none');
    r.clock.advance(0);
    expect(r.host.getState().phase).toBe('hole');
    expect(r.host.getState().holeIndex).toBe(0);
    expect(r.view.overlays.titleCards).toHaveLength(3);
    expect(r.view.renderer.courses).toHaveLength(3);

    // "Valikkoon" from the round summary leaves without a confirmation.
    for (let guard = 0; guard < 100 && r.host.getState().phase !== 'roundSummary'; guard++) {
      const s = r.host.getState();
      if (s.phase === 'hole') { if (s.turn === null) r.clock.advance(HOLE_INTRO_MS); else playStroke(r); }
      else if (s.phase === 'holeSummary') r.view.overlays.holeActions!.onContinue();
    }
    r.view.overlays.roundActions!.onLeave();
    expect(r.confirms).toEqual([]);
    expect(r.left).toBe(1);
  });

  it('a held (repeating) Space or Enter does not continue the hole summary', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    start(r);
    for (let guard = 0; guard < 100 && r.host.getState().phase !== 'holeSummary'; guard++) {
      const s = r.host.getState();
      if (s.phase !== 'hole') break;
      if (s.turn === null) r.clock.advance(HOLE_INTRO_MS);
      else playStroke(r);
    }
    expect(r.view.overlays.summary).toBe('hole');
    for (const key of [' ', 'Enter']) {
      const held = Object.assign(new Event('keydown', { cancelable: true }), { key, repeat: true });
      r.view.keyTarget!.dispatchEvent(held);
      expect(held.defaultPrevented).toBe(false);
      expect(r.host.getState().phase).toBe('holeSummary');
    }
    const press = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Enter', repeat: false });
    r.view.keyTarget!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(r.host.getState().phase).not.toBe('holeSummary');
  });

  it('Esc pauses and resumes (aiming disabled while paused); Tab toggles the scorecard', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    start(r);
    r.clock.advance(HOLE_INTRO_MS);
    expect(r.view.aim.enabled).toBe(true);
    expect(r.view.key('Escape')).toBe(true);
    expect(r.view.overlays.paused).toBe(true);
    expect(r.view.overlays.pauses).toBe(1);
    expect(r.view.aim.enabled).toBe(false);
    r.view.tick(16);
    expect(r.view.hud.power).toBeNull();
    expect(r.view.key('Tab')).toBe(false); // Tab moves focus between the pause buttons
    expect(r.view.overlays.scorecardOpen).toBe(false);
    expect(r.view.key('Escape')).toBe(true);
    expect(r.view.overlays.paused).toBe(false);
    expect(r.view.aim.enabled).toBe(true);

    expect(r.view.key('Tab')).toBe(true);
    expect(r.view.overlays.scorecardOpen).toBe(true);
    expect(r.view.aim.enabled).toBe(false);
    expect(r.view.key('Escape')).toBe(true); // Esc closes the scorecard first
    expect(r.view.overlays.scorecardOpen).toBe(false);
    expect(r.view.overlays.paused).toBe(false);
    expect(r.view.aim.enabled).toBe(true);

    // The pause overlay's resume/quit actions.
    r.ctl.pause();
    r.view.overlays.pauseActions!.onResume();
    expect(r.view.overlays.paused).toBe(false);
  });

  it('leaving mid-round asks for an in-page confirmation; test play leaves at once', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    start(r);
    r.clock.advance(HOLE_INTRO_MS);
    r.confirmAnswer = false;
    r.ctl.requestLeave();
    return Promise.resolve().then(async () => {
      expect(r.confirms).toEqual(['Lopetetaanko kierros? Tulokset menetetään.']);
      await Promise.resolve();
      expect(r.left).toBe(0);
      r.confirmAnswer = true;
      r.ctl.requestLeave();
      await Promise.resolve();
      await Promise.resolve();
      expect(r.left).toBe(1);

      const tp = rig(BUILTIN_COURSES.slice(0, 1), { testPlay: true });
      start(tp);
      tp.clock.advance(HOLE_INTRO_MS);
      tp.view.key('Escape');
      tp.view.overlays.pauseActions!.onQuit();
      expect(tp.confirms).toEqual([]);
      expect(tp.left).toBe(1);
      expect(tp.view.overlays.paused).toBe(false);
    });
  });

  it('destroy stops the loop, unsubscribes from the host and releases the view', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    start(r);
    const updates = r.view.overlays.updates;
    r.ctl.destroy();
    expect(r.view.loopStopped).toBe(true);
    expect(r.view.destroyed).toBe(true);
    r.clock.advance(HOLE_INTRO_MS);
    expect(r.view.overlays.updates).toBe(updates); // no more host events reach the controller
    expect(r.view.key('Escape')).toBe(false);
    r.ctl.destroy(); // idempotent
  });
});

describe('§12.3 aim/power mapping: what you see is what the authority gets', () => {
  it('the drawn aim equals the de-quantized shot, and the authority simulates exactly that ShotInput', () => {
    const r = rig(BUILTIN_COURSES.slice(0, 1));
    start(r);
    r.clock.advance(HOLE_INTRO_MS);
    const tee = r.host.getState().balls[LOCAL_PLAYER_ID]!;
    // A raw pointer pull beyond the cap, at an awkward angle: the preview clamps + quantizes it.
    const aim = pullToAim({ x: tee.x, y: tee.y }, { x: 173.3, y: -41.7 });
    expect(Math.hypot(aim.pull.x, aim.pull.y)).toBeLessThanOrEqual(MAX_PULL_PX + 0.01);
    expect(aim.power).toBeCloseTo(1, 4); // 1/100 px quantization of the capped pull; the cap mark draws at >= 0.999
    const shot = aimToShot(aim);
    expect(validateShot(shot)).toBe(true);
    expect(shotToPull(shot)).toEqual(aim.pull); // the line on screen IS the shot vector
    expect(aimToShot(pullToAim({ x: tee.x, y: tee.y }, shotToPull(shot)))).toEqual(shot); // idempotent round trip

    r.view.aim.preview = aim;
    r.view.tick(16);
    expect(r.view.renderer.aim).toBe(aim);
    expect(r.view.hud.power).toBe(aim.power);
    expect(r.view.aim.fire(shot)).toBe(true);
    const taken = r.host.getState().lastShot!;
    expect(taken.shot).toEqual(shot); // the authority received the very same integers
    const it = r.view.animator.current!.it;
    expect(it.ball.vx).toBe((shot.dx / SHOT_QUANTUM) * POWER_SCALE); // and launched the ball with them
    expect(it.ball.vy).toBe((shot.dy / SHOT_QUANTUM) * POWER_SCALE);
    r.view.animator.finish();
    expect(r.ctl.desyncCount).toBe(0);

    // The dead zone sends nothing: a 2 px pull is a null shot and the host ignores it.
    const tiny = pullToAim({ x: tee.x, y: tee.y }, { x: 2, y: 0 });
    expect(tiny.power).toBe(0);
    expect(isNullShot(aimToShot(tiny))).toBe(true);
  });
});

describe('ballSprites (§12.2 drawing rule)', () => {
  const player = (id: string, colour: 0 | 1 | 2 | 3, leftRound = false): PlayerState =>
    ({ id, name: id, colour, ready: false, connected: true, afk: false, consecutiveTimeouts: 0, joinedSeq: 1, leftRound });

  it('draws every active, unfinished player; the player on turn last and highlighted; others at 60 %', () => {
    const balls = { a: createBallAt({ x: 10, y: 10 }), b: createBallAt({ x: 20, y: 20 }), c: createBallAt({ x: 30, y: 30 }), d: createBallAt({ x: 40, y: 40 }) };
    const state = {
      phase: 'hole',
      players: [player('a', 0), player('b', 1), player('c', 2), player('d', 3, true)],
      balls,
      holeDone: { c: true, d: true },
      turn: { playerId: 'b', turnSeq: 3, deadlineMs: null, shotInFlight: false },
    } as unknown as GameState;
    const sprites = ballSprites(state, 'a');
    expect(sprites.map((s) => s.id)).toEqual(['a', 'b']);
    expect(sprites[0]).toMatchObject({ colour: 0, alpha: 1, highlight: false }); // the local player's own ball stays opaque
    expect(sprites[1]).toMatchObject({ colour: 1, alpha: 1, highlight: true });
    expect(sprites[1]!.ball).toBe(balls.b);
    const asSpectator = ballSprites(state, '');
    expect(asSpectator.map((s) => s.alpha)).toEqual([0.6, 1]);
    const noTurn = ballSprites({ ...state, phase: 'holeSummary', turn: null } as GameState, 'a');
    expect(noTurn.map((s) => s.highlight)).toEqual([false, false]);
  });
});
