// Pure-logic test for the shot animator: 120 Hz accumulator, interpolation, event forwarding, fastForward, onDone.
// Uses a scripted ShotIterator stub and a fake renderer/sfx (no DOM, no canvas).
import { describe, expect, it } from 'vitest';
import { TICK_HZ } from '@puttipeli/shared/constants';
import type { BallState, ShotIterator, ShotResult, SimEvent, StepStatus, WorldState } from '@puttipeli/shared/sim/types';
import type { Sfx, SfxCue } from '../audio/sfx';
import type { BallSprite, Renderer } from '../render/renderer';
import { ShotAnimator } from './shotAnimator';

const TICK_MS = 1000 / TICK_HZ;

function makeBall(x: number, y: number): BallState {
  return { x, y, vx: 0, vy: 0, moving: true, lastTile: 0, teleportCooldownTile: -1, insideOneWay: -1, slowTicks: 0 };
}

/** Moves 2 px per tick along +x for `ticks` ticks, emitting the scripted events at their ticks, then stops. */
class ScriptedIterator implements ShotIterator {
  readonly ball: BallState;
  readonly world: WorldState = { walls: new Uint8Array(4), breakHits: new Uint8Array(4), minesArmed: new Uint8Array(1) };
  readonly events: SimEvent[] = [];
  readonly ctx = { shotOrigin: { x: 0, y: 0 }, startPos: { x: 0, y: 0 }, tick: 0, teleportCount: 0, lastBreakTile: -1, lastBreakTick: -1, otherBalls: [] };
  done = false;
  result: ShotResult | null = null;
  penalty: 0 | 1 = 0;
  holeIndex = -1;
  steps = 0;
  constructor(private readonly ticks: number, private readonly script: SimEvent[], start: BallState) {
    this.ball = { ...start };
  }
  step(): StepStatus {
    if (this.done) return this.result ?? 'stopped';
    this.steps++;
    this.ball.x += 2;
    for (const ev of this.script) if (ev.tick === this.ctx.tick) {
      this.events.push(ev);
      if (ev.type === 'destroyed') this.world.walls[1] = 0;
      if (ev.type === 'teleport') this.ball.x += 100; // jump
    }
    this.ctx.tick++;
    if (this.ctx.tick >= this.ticks) {
      this.done = true;
      this.result = 'stopped';
      this.ball.moving = false;
      this.events.push({ tick: this.ctx.tick, type: 'stopped' });
      return 'stopped';
    }
    return 'moving';
  }
}

interface Fake { renderer: Renderer; sfx: Sfx; animated: (BallSprite | null)[]; spawned: SimEvent[]; played: SfxCue[]; worlds: WorldState[] }

function fakes(): Fake {
  const f: Fake = { animated: [], spawned: [], played: [], worlds: [], renderer: null as unknown as Renderer, sfx: null as unknown as Sfx };
  f.renderer = {
    setAnimatedBall(s: BallSprite | null) { f.animated.push(s); },
    setWorld(w: WorldState) { f.worlds.push(w); },
    effects: { spawn(ev: SimEvent) { f.spawned.push(ev); } },
  } as unknown as Renderer;
  f.sfx = { play(c: SfxCue) { f.played.push(c); }, setVolume() {}, unlock() {} };
  return f;
}

const sprite = (ball: BallState): BallSprite => ({ id: 'p1', ball, colour: 0, alpha: 1, highlight: true });

describe('ShotAnimator', () => {
  it('advances exactly one tick per 1/120 s, interpolates between ticks and finishes with onDone', () => {
    const f = fakes();
    const anim = new ShotAnimator(f.renderer, f.sfx);
    const it = new ScriptedIterator(12, [{ tick: 3, type: 'bounce', x: 0, y: 0, nx: 1, ny: 0, speed: 300, tile: 1, material: 'wall' }], makeBall(10, 10));
    let done: ShotIterator | null = null;
    anim.play(it, sprite(makeBall(10, 10)), (d) => { done = d; });
    expect(anim.running).toBe(true);
    expect(f.played).toEqual(['shot']);
    const animated = f.animated[0]!;
    expect(animated.id).toBe('p1');
    expect(animated.ball).not.toBe(it.ball); // own interpolated copy

    anim.update(1000);            // first frame establishes the clock, no ticks
    expect(it.steps).toBe(0);
    anim.update(1000 + TICK_MS * 2.5); // 2 full ticks, half a tick in the accumulator
    expect(it.steps).toBe(2);
    expect(it.ball.x).toBe(14);
    expect(animated.ball.x).toBeCloseTo(13, 9); // halfway between tick 1 (12) and tick 2 (14)
    expect(animated.ball.moving).toBe(true);

    anim.update(1000 + TICK_MS * 4.1); // ticks 3 and 4 -> bounce at tick 3 forwarded once
    expect(f.played.filter((c) => typeof c !== 'string' && c.type === 'bounce')).toHaveLength(1);
    expect(f.spawned.filter((e) => e.type === 'bounce')).toHaveLength(1);

    anim.update(1000 + TICK_MS * 40); // far beyond the end
    expect(it.done).toBe(true);
    expect(done).toBe(it);
    expect(anim.running).toBe(false);
    expect(f.animated[f.animated.length - 1]).toBeNull();
    expect(animated.ball.x).toBe(it.ball.x);
    expect(animated.ball.moving).toBe(false);
    // Every event forwarded exactly once (bounce + stopped).
    expect(f.spawned.map((e) => e.type)).toEqual(['bounce', 'stopped']);
  });

  it('does not interpolate across a teleport jump and pushes world changes to the renderer', () => {
    const f = fakes();
    const anim = new ShotAnimator(f.renderer, f.sfx);
    const it = new ScriptedIterator(6, [
      { tick: 1, type: 'teleport', from: 0, to: 3 },
      { tick: 2, type: 'destroyed', tile: 1 },
    ], makeBall(0, 0));
    anim.play(it, sprite(makeBall(0, 0)), () => {});
    const animated = f.animated[0]!;
    anim.update(0);
    anim.update(TICK_MS * 2.5); // ticks 1 and 2 done; tick 2 was the teleport (jump of 102 px)
    expect(it.ball.x).toBe(104);
    expect(animated.ball.x).toBe(104); // snapped, not interpolated
    expect(f.worlds.length).toBeGreaterThanOrEqual(0);
    anim.update(TICK_MS * 3.5); // tick 3: destroyed -> setWorld
    expect(f.worlds).toContain(it.world);
  });

  it('caps a long frame gap at 250 ms of simulation', () => {
    const f = fakes();
    const anim = new ShotAnimator(f.renderer, f.sfx);
    const it = new ScriptedIterator(1000, [], makeBall(0, 0));
    anim.play(it, sprite(makeBall(0, 0)), () => {});
    anim.update(0);
    anim.update(5000);
    expect(it.steps).toBe(Math.floor(250 / TICK_MS)); // 30 ticks
  });

  it('fastForward runs to completion, plays only the terminal event and calls onDone once', () => {
    const f = fakes();
    const anim = new ShotAnimator(f.renderer, f.sfx);
    const it = new ScriptedIterator(50, [
      { tick: 5, type: 'bounce', x: 0, y: 0, nx: 1, ny: 0, speed: 300, tile: 1, material: 'wall' },
      { tick: 20, type: 'bounce', x: 0, y: 0, nx: 1, ny: 0, speed: 300, tile: 1, material: 'wall' },
    ], makeBall(0, 0));
    let calls = 0;
    anim.play(it, sprite(makeBall(0, 0)), () => { calls++; });
    anim.update(0);
    anim.update(TICK_MS * 7.2); // 7 ticks, the first bounce played live
    expect(f.played).toHaveLength(2);
    anim.fastForward();
    expect(it.done).toBe(true);
    expect(calls).toBe(1);
    expect(anim.running).toBe(false);
    // The second bounce was skipped (silent fast-forward); 'stopped' is a terminal event without sound.
    expect(f.played).toHaveLength(2);
    anim.fastForward(); // no-op when idle
    anim.update(99999);
    expect(calls).toBe(1);
  });

  it('play() while running fast-forwards the previous shot first', () => {
    const f = fakes();
    const anim = new ShotAnimator(f.renderer, f.sfx);
    const first = new ScriptedIterator(100, [], makeBall(0, 0));
    const second = new ScriptedIterator(3, [], makeBall(50, 50));
    const order: string[] = [];
    anim.play(first, sprite(makeBall(0, 0)), () => order.push('first'));
    anim.play(second, sprite(makeBall(50, 50)), () => order.push('second'));
    expect(first.done).toBe(true);
    expect(order).toEqual(['first']);
    anim.update(0);
    anim.update(TICK_MS * 10);
    expect(order).toEqual(['first', 'second']);
  });

  it('play() inside onDone keeps the new sprite installed (the finished one is not cleared over it)', () => {
    const f = fakes();
    const anim = new ShotAnimator(f.renderer, f.sfx);
    const first = new ScriptedIterator(4, [], makeBall(0, 0));
    const second = new ScriptedIterator(30, [], makeBall(70, 20));
    anim.play(first, sprite(makeBall(0, 0)), () => {
      anim.play(second, sprite(makeBall(70, 20)), () => {});
    });
    anim.update(0);
    anim.update(TICK_MS * 10); // first finishes -> onDone starts second
    expect(first.done).toBe(true);
    expect(anim.running).toBe(true);
    const last = f.animated[f.animated.length - 1];
    expect(last).not.toBeNull();
    expect(last!.ball.x).toBeCloseTo(70, 9);
    anim.update(TICK_MS * 12); // re-established clock for the second shot
    anim.update(TICK_MS * 14);
    expect(second.steps).toBe(2);
    anim.fastForward();
    expect(anim.running).toBe(false);
    expect(f.animated[f.animated.length - 1]).toBeNull(); // cleared only when nothing follows
  });

  it('an already finished iterator completes immediately', () => {
    const f = fakes();
    const anim = new ShotAnimator(f.renderer, f.sfx);
    const it = new ScriptedIterator(1, [], makeBall(0, 0));
    it.step();
    let done = false;
    anim.play(it, sprite(makeBall(0, 0)), () => { done = true; });
    expect(done).toBe(true);
    expect(anim.running).toBe(false);
  });
});
