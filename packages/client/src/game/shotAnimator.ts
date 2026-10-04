// Replays a shot on screen (DESIGN §12.2): advances a ShotIterator with a 120 Hz accumulator, draws the ball at a
// position interpolated between the last two tick positions (smooth at 60/144 Hz displays), forwards every
// SimEvent to the sound effects and the particle system at its tick, and reports completion through onDone.
import { TICK_HZ } from '@puttipeli/shared/constants';
import type { BallState, ShotIterator, SimEvent } from '@puttipeli/shared/sim/types';
import type { Sfx } from '../audio/sfx';
import type { BallSprite, Renderer } from '../render/renderer';

const TICK_MS = 1000 / TICK_HZ;
/** A ball cannot travel this far in one tick (max 7.5 px): a larger jump is a teleport/reset and is not interpolated. */
const JUMP_PX = 20;
/** Longest frame gap that is simulated at once (tab switch etc.); the rest is dropped, the sim just takes longer. */
const MAX_FRAME_MS = 250;
/** Events that leave the ball somewhere else than where they happened (effects spawn at the pre-step position). */
const RESET_EVENTS: ReadonlySet<SimEvent['type']> = new Set(['water', 'acid', 'mine']);
const WORLD_EVENTS: ReadonlySet<SimEvent['type']> = new Set(['break', 'destroyed', 'blockMoved', 'mine']);

export class ShotAnimator {
  private it: ShotIterator | null = null;
  private sprite: BallSprite | null = null;
  private onDone: ((it: ShotIterator) => void) | null = null;
  private acc = 0;
  private lastNow = -1;
  private prevX = 0;
  private prevY = 0;
  private eventIndex = 0;

  constructor(private readonly renderer: Renderer, private readonly sfx: Sfx) {}

  get running(): boolean { return this.it !== null; }

  /** Starts animating `it` for `sprite`'s player. A running animation is fast-forwarded first. */
  play(it: ShotIterator, sprite: BallSprite, onDone: (it: ShotIterator) => void): void {
    if (this.it) this.fastForward();
    this.it = it;
    this.onDone = onDone;
    this.sprite = { id: sprite.id, colour: sprite.colour, alpha: sprite.alpha, highlight: sprite.highlight, ball: { ...it.ball } };
    this.prevX = it.ball.x;
    this.prevY = it.ball.y;
    this.acc = 0;
    this.lastNow = -1;
    this.eventIndex = 0;
    this.renderer.setAnimatedBall(this.sprite);
    this.sfx.play('shot');
    if (it.done) this.finish();
  }

  /** Runs the iterator to completion (silently, except the terminal event) and calls onDone. */
  fastForward(): void {
    const it = this.it;
    if (!it) return;
    while (!it.done) it.step();
    const events = it.events;
    for (let i = this.eventIndex; i < events.length; i++) {
      const ev = events[i]!;
      if (WORLD_EVENTS.has(ev.type)) this.renderer.setWorld(it.world);
      // Only the terminal event gets sound/particles; a burst of bounce sounds would be noise. Water/acid particles
      // spawn at the hazard tile (effects.ts resolves event.tile), so passing the already reset ball is correct.
      if (i === events.length - 1 && ev.type !== 'stopped' && ev.type !== 'timeout') {
        this.sfx.play(ev);
        this.renderer.effects.spawn(ev, it.ball);
      }
    }
    this.eventIndex = events.length;
    this.finish();
  }

  /** Called from the loop by the controller every frame. */
  update(nowMs: number): void {
    const it = this.it;
    const sprite = this.sprite;
    if (!it || !sprite) return;
    const dt = this.lastNow < 0 ? 0 : Math.min(MAX_FRAME_MS, Math.max(0, nowMs - this.lastNow));
    this.lastNow = nowMs;
    this.acc += dt;
    while (this.acc >= TICK_MS && !it.done) {
      this.prevX = it.ball.x;
      this.prevY = it.ball.y;
      it.step();
      this.drainEvents(it);
      this.acc -= TICK_MS;
    }
    if (it.done) {
      this.finish();
      return;
    }
    const b = sprite.ball;
    const dx = it.ball.x - this.prevX;
    const dy = it.ball.y - this.prevY;
    if (dx * dx + dy * dy > JUMP_PX * JUMP_PX) {
      b.x = it.ball.x;
      b.y = it.ball.y;
    } else {
      const a = this.acc / TICK_MS; // 0..1 fraction of the next tick already elapsed
      b.x = this.prevX + dx * a;
      b.y = this.prevY + dy * a;
    }
    b.vx = it.ball.vx;
    b.vy = it.ball.vy;
    b.moving = it.ball.moving;
  }

  private drainEvents(it: ShotIterator): void {
    const events = it.events;
    for (; this.eventIndex < events.length; this.eventIndex++) {
      const ev = events[this.eventIndex]!;
      this.sfx.play(ev);
      const at: BallState = RESET_EVENTS.has(ev.type) ? { ...it.ball, x: this.prevX, y: this.prevY } : it.ball;
      this.renderer.effects.spawn(ev, at);
      if (WORLD_EVENTS.has(ev.type)) this.renderer.setWorld(it.world);
    }
  }

  private finish(): void {
    const it = this.it;
    const sprite = this.sprite;
    const onDone = this.onDone;
    if (!it) return;
    if (sprite) {
      sprite.ball.x = it.ball.x;
      sprite.ball.y = it.ball.y;
      sprite.ball.vx = 0;
      sprite.ball.vy = 0;
      sprite.ball.moving = false;
    }
    this.it = null;
    this.sprite = null;
    this.onDone = null;
    this.acc = 0;
    this.lastNow = -1;
    // The controller refreshes its ball sprites inside onDone (the reducer state already holds the final ball),
    // so the animated copy is removed only afterwards: no frame shows the pre-shot position. onDone may start the
    // next shot with play() (a queued shotTaken): then the new sprite is already installed and must stay.
    if (onDone) onDone(it);
    if (this.it === null) this.renderer.setAnimatedBall(null);
  }
}
