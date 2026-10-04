// Shared test support for the WP-G suites: a fake clock for the Authority timers, a greedy scripted player that
// finds holing shots with the real physics, and a fake PlayView so GameController runs without a DOM or canvas.
// It is a *.test.ts file so it stays inside WP-G's ownership (§3); the sanity test at the bottom keeps Vitest
// happy when the file is collected on its own.
import { describe, expect, it } from 'vitest';
import { MAX_PULL_PX } from '@puttipeli/shared/constants';
import type { CourseLayers, Vec2 } from '@puttipeli/shared/course/types';
import type { GameState } from '@puttipeli/shared/game/types';
import { isNullShot, quantizeShot } from '@puttipeli/shared/sim/shot';
import { simulateShot } from '@puttipeli/shared/sim/simulate';
import type { BallState, ShotInput, ShotIterator, WorldState } from '@puttipeli/shared/sim/types';
import type { SfxCue } from '../audio/sfx';
import type { AimSprite, BallSprite } from '../render/renderer';
import type { Hud } from '../ui/hud';
import type { AnimatorPort, PlayView, RendererPort } from './controller';
import type { AimInput } from './input';
import type { HoleSummaryActions, OverlayContext, Overlays, PauseActions, RoundSummaryActions, SummaryKind } from './summaries';

// ---------------------------------------------------------------------------------------------------------------
// Fake clock (same semantics as the browser timers the LocalHost uses by default)
// ---------------------------------------------------------------------------------------------------------------

export class FakeClock {
  private t: number;
  private nextId = 1;
  private seq = 0;
  private readonly timers = new Map<number, { due: number; fn: () => void; seq: number }>();

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

  /** Advances time, firing due timers in due order (ties by scheduling order); timers scheduled meanwhile run if due. */
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

// ---------------------------------------------------------------------------------------------------------------
// Greedy scripted player
// ---------------------------------------------------------------------------------------------------------------

const dist2 = (a: Vec2, b: Vec2): number => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

/**
 * A shot that holes out when one exists on a straight line to a hole at some power, else one that holes out from
 * a fan of 16 directions at 4 powers (bank shots, teleporters); otherwise the candidate whose ball ends closest to
 * a hole without a penalty (a penalty shot only when nothing else exists). Uses the real simulateShot, so the
 * chosen shot is exactly what the authority will reproduce.
 */
export function greedyShot(layers: CourseLayers, world: WorldState, ball: BallState, others: readonly Vec2[] = []): ShotInput {
  let best: { shot: ShotInput; d: number } | null = null;
  let fallback: ShotInput | null = null;
  const consider = (shot: ShotInput): boolean => {
    if (isNullShot(shot)) return false;
    const out = simulateShot(layers, world, ball, shot, others);
    if (out.result === 'holed') {
      best = { shot, d: -1 };
      return true;
    }
    if (out.penalty === 1) {
      fallback ??= shot;
      return false;
    }
    let d = Infinity;
    for (const h of layers.holes) d = Math.min(d, dist2(out.ball, { x: h.cx, y: h.cy }));
    if (best === null || d < best.d) best = { shot, d };
    return false;
  };
  for (const hole of layers.holes) {
    const dx = hole.cx - ball.x;
    const dy = hole.cy - ball.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) continue;
    for (let pull = 8; pull <= MAX_PULL_PX; pull += 8) {
      if (consider(quantizeShot((dx / len) * pull, (dy / len) * pull))) return best!.shot;
    }
  }
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    for (const pull of [30, 60, 90, MAX_PULL_PX]) {
      if (consider(quantizeShot(Math.cos(a) * pull, Math.sin(a) * pull))) return best!.shot;
    }
  }
  if (best !== null) return (best as { shot: ShotInput }).shot;
  return fallback ?? { dx: 3000, dy: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Fake PlayView
// ---------------------------------------------------------------------------------------------------------------

export interface FakeAnimation { it: ShotIterator; sprite: BallSprite; onDone: (it: ShotIterator) => void }

export class FakeAnimator implements AnimatorPort {
  current: FakeAnimation | null = null;
  plays = 0;
  fastForwards = 0;
  updates = 0;

  get running(): boolean { return this.current !== null; }

  play(it: ShotIterator, sprite: BallSprite, onDone: (it: ShotIterator) => void): void {
    if (this.current) this.fastForward();
    this.current = { it, sprite, onDone };
    this.plays++;
    if (it.done) this.finish();
  }

  fastForward(): void {
    if (!this.current) return;
    this.fastForwards++;
    this.finish();
  }

  /** Runs the iterator to completion and reports it (the real animator clears itself before calling onDone). */
  finish(): void {
    const c = this.current;
    if (!c) return;
    while (!c.it.done) c.it.step();
    this.current = null;
    c.onDone(c.it);
  }

  update(): void { this.updates++; }
}

export class FakeRenderer implements RendererPort {
  courses: { layers: CourseLayers; world: WorldState }[] = [];
  worlds: WorldState[] = [];
  balls: readonly BallSprite[] = [];
  aim: AimSprite | null = null;
  renders = 0;
  destroyed = false;
  readonly effects = { enabled: true, cleared: 0, clear(): void { this.cleared++; } };

  setCourse(layers: CourseLayers, world: WorldState): void { this.courses.push({ layers, world }); this.effects.clear(); }
  setWorld(world: WorldState): void { this.worlds.push(world); }
  setBalls(balls: readonly BallSprite[]): void { this.balls = balls; }
  setAim(aim: AimSprite | null): void { this.aim = aim; }
  render(): void { this.renders++; }
  destroy(): void { this.destroyed = true; }
}

export class FakeAim implements AimInput {
  ball: Vec2 | null = null;
  enabled = false;
  targets: readonly Vec2[] = [];
  /** What getAim() returns while enabled (tests set it to simulate a hovering pointer). */
  preview: AimSprite | null = null;
  setBallCalls = 0;
  destroyed = false;
  private readonly shootCbs = new Set<(shot: ShotInput) => void>();
  private readonly cancelCbs = new Set<() => void>();

  setBall(pos: Vec2 | null): void { this.ball = pos ? { x: pos.x, y: pos.y } : null; this.setBallCalls++; }
  setEnabled(on: boolean): void { this.enabled = on; }
  setTargets(holes: readonly Vec2[]): void { this.targets = holes; }
  getAim(): AimSprite | null { return this.enabled && this.ball ? this.preview : null; }
  onShoot(cb: (shot: ShotInput) => void): () => void { this.shootCbs.add(cb); return () => { this.shootCbs.delete(cb); }; }
  onCancel(cb: () => void): () => void { this.cancelCbs.add(cb); return () => { this.cancelCbs.delete(cb); }; }
  destroy(): void { this.destroyed = true; this.shootCbs.clear(); this.cancelCbs.clear(); }
  /** The pointer released / Space pressed: fires like the real input (only while enabled). */
  fire(shot: ShotInput): boolean {
    if (!this.enabled || !this.ball) return false;
    this.shootCbs.forEach((cb) => cb(shot));
    return true;
  }
}

export class FakeOverlays implements Overlays {
  titleCards: GameState[] = [];
  holeSummaries: GameState[] = [];
  roundSummaries: GameState[] = [];
  updates = 0;
  pauses = 0;
  destroyed = false;
  private _summary: SummaryKind = 'none';
  private _paused = false;
  private _scorecard = false;
  holeActions: HoleSummaryActions | null = null;
  roundActions: RoundSummaryActions | null = null;
  pauseActions: PauseActions | null = null;
  lastCtx: OverlayContext | null = null;

  showTitleCard(state: GameState): void { this.titleCards.push(state); }
  showHoleSummary(state: GameState, ctx: OverlayContext, actions: HoleSummaryActions): void {
    this.holeSummaries.push(state); this.lastCtx = ctx; this.holeActions = actions; this._summary = 'hole';
  }
  showRoundSummary(state: GameState, ctx: OverlayContext, actions: RoundSummaryActions): void {
    this.roundSummaries.push(state); this.lastCtx = ctx; this.roundActions = actions; this._summary = 'round';
  }
  hideSummary(): void { this._summary = 'none'; this.holeActions = null; this.roundActions = null; }
  get summary(): SummaryKind { return this._summary; }
  showPause(ctx: OverlayContext, actions: PauseActions): void { this.pauses++; this.lastCtx = ctx; this.pauseActions = actions; this._paused = true; }
  hidePause(): void { this._paused = false; this.pauseActions = null; }
  get paused(): boolean { return this._paused; }
  toggleScorecard(): void { this._scorecard = !this._scorecard; }
  closeScorecard(): void { this._scorecard = false; }
  get scorecardOpen(): boolean { return this._scorecard; }
  update(_state: GameState, ctx: OverlayContext): void { this.updates++; this.lastCtx = ctx; }
  destroy(): void { this.destroyed = true; }
}

export interface FakeHud extends Hud { updates: number; power: number | null; label: string | null; destroyed: boolean }

function fakeHud(): FakeHud {
  const hud: FakeHud = {
    root: null as unknown as HTMLElement,
    fireButton: null as unknown as HTMLButtonElement,
    updates: 0,
    power: null,
    label: null,
    destroyed: false,
    update() { hud.updates++; },
    setPower(p) { hud.power = p; },
    setLabel(l) { hud.label = l; },
    destroy() { hud.destroyed = true; },
  };
  return hud;
}

export interface FakeView extends PlayView {
  renderer: FakeRenderer;
  animator: FakeAnimator;
  aim: FakeAim;
  hud: FakeHud;
  overlays: FakeOverlays;
  played: SfxCue[];
  unlocks: number;
  destroyed: boolean;
  loopStopped: boolean;
  /** Runs one frame of the loop the controller registered. */
  tick(nowMs: number): void;
  /** Dispatches a keydown on the key target; returns true when the controller consumed it (preventDefault). */
  key(key: string): boolean;
}

export function fakeView(): FakeView {
  let loopTick: ((now: number) => void) | null = null;
  const keyTarget = new EventTarget();
  const view: FakeView = {
    renderer: new FakeRenderer(),
    animator: new FakeAnimator(),
    aim: new FakeAim(),
    hud: fakeHud(),
    overlays: new FakeOverlays(),
    played: [],
    unlocks: 0,
    destroyed: false,
    loopStopped: false,
    sfx: {
      play(cue: SfxCue) { view.played.push(cue); },
      setVolume() {},
      unlock() { view.unlocks++; },
    },
    startLoop(tick) {
      loopTick = tick;
      return () => { view.loopStopped = true; loopTick = null; };
    },
    keyTarget,
    destroy() { view.destroyed = true; },
    tick(now) { loopTick?.(now); },
    key(key) {
      const e = Object.assign(new Event('keydown', { cancelable: true }), { key });
      keyTarget.dispatchEvent(e);
      return e.defaultPrevented;
    },
  };
  return view;
}

// ---------------------------------------------------------------------------------------------------------------

describe('play test support', () => {
  it('fake clock fires timers in due order and reports pending count', () => {
    const c = new FakeClock(0);
    const order: string[] = [];
    c.setTimeout(() => order.push('b'), 20);
    const a = c.setTimeout(() => order.push('a'), 10);
    c.setTimeout(() => order.push('c'), 20);
    expect(c.pending()).toBe(3);
    c.clearTimeout(a);
    c.advance(25);
    expect(order).toEqual(['b', 'c']);
    expect(c.now()).toBe(25);
    expect(c.pending()).toBe(0);
  });
});
