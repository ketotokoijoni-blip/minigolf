// Shot driver (DESIGN §8.1): createShotIterator() advances one tick per step() (client animation), simulateShot() runs
// the same iterator to completion (authority). Both clone their inputs, so a shot never mutates caller state.
import type { CourseLayers, Vec2 } from '../course/types';
import { applyShot, cloneBall } from './ball';
import { hashSimState } from './checksum';
import { stepTick } from './step';
import type {
  BallState, ShotInput, ShotIterator, ShotOutcome, ShotResult, ShotSummary, SimContext, SimEvent, StepStatus, WorldState,
} from './types';
import { cloneWorld, diffWorld } from './worldState';

const EMPTY_BALLS: readonly Vec2[] = [];

class ShotRunner implements ShotIterator {
  readonly ball: BallState;
  readonly world: WorldState;
  readonly events: SimEvent[] = [];
  readonly ctx: SimContext;
  done = false;
  result: ShotResult | null = null;
  penalty: 0 | 1 = 0;
  holeIndex = -1;
  private readonly layers: CourseLayers;

  constructor(layers: CourseLayers, world: WorldState, ball: BallState, shot: ShotInput, otherBalls: readonly Vec2[]) {
    this.layers = layers;
    this.world = cloneWorld(world);
    this.ball = cloneBall(ball);
    this.ctx = {
      shotOrigin: { x: ball.x, y: ball.y },
      startPos: { x: layers.start.x, y: layers.start.y },
      tick: 0,
      teleportCount: 0,
      lastBreakTile: -1,
      lastBreakTick: -1,
      otherBalls,
    };
    applyShot(this.ball, shot);
  }

  step(): StepStatus {
    if (this.done) return this.result ?? 'stopped';
    const status = stepTick(this.layers, this.world, this.ball, this.ctx, this.events);
    if (status !== 'moving') {
      this.done = true;
      this.result = status;
      this.penalty = status === 'water' || status === 'acid' || status === 'mine' ? 1 : 0;
      if (status === 'holed') this.holeIndex = this.findHoleIndex();
    }
    return status;
  }

  private findHoleIndex(): number {
    const last = this.events[this.events.length - 1];
    if (last !== undefined && last.type === 'holed') return last.hole;
    const holes = this.layers.holes;
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i];
      if (h !== undefined && h.cx === this.ball.x && h.cy === this.ball.y) return i;
    }
    return -1;
  }
}

/** The shot one tick at a time. Clones `world` and `ball`; `layers` is read only. */
export function createShotIterator(
  layers: CourseLayers, world: WorldState, ball: BallState, shot: ShotInput, otherBalls?: readonly Vec2[],
): ShotIterator {
  return new ShotRunner(layers, world, ball, shot, otherBalls ?? EMPTY_BALLS);
}

/** Result of a finished iterator: diffWorld against the world the shot started from plus the state checksum. */
export function outcomeOf(it: ShotIterator, worldBefore: WorldState): ShotOutcome {
  if (!it.done || it.result === null) throw new Error('outcomeOf: the shot has not finished');
  return {
    ticks: it.ctx.tick,
    result: it.result,
    penalty: it.penalty,
    holeIndex: it.holeIndex,
    ball: it.ball,
    world: it.world,
    worldDelta: diffWorld(worldBefore, it.world),
    events: it.events,
    checksum: hashSimState(it.ball, it.world),
  };
}

/** Pure: clones inputs, runs the iterator to completion. */
export function simulateShot(
  layers: CourseLayers, world: WorldState, ball: BallState, shot: ShotInput, otherBalls?: readonly Vec2[],
): ShotOutcome {
  const it = createShotIterator(layers, world, ball, shot, otherBalls);
  while (!it.done) it.step();
  return outcomeOf(it, world);
}

/** Wire form: drops events and the world; ball and worldDelta are plain copies. */
export function toShotSummary(o: ShotOutcome): ShotSummary {
  return {
    ticks: o.ticks,
    result: o.result,
    penalty: o.penalty,
    holeIndex: o.holeIndex,
    ball: cloneBall(o.ball),
    worldDelta: {
      tiles: o.worldDelta.tiles.map((t) => ({ i: t.i, wall: t.wall, hits: t.hits })),
      minesDisarmed: o.worldDelta.minesDisarmed.slice(),
    },
    checksum: o.checksum,
  };
}
