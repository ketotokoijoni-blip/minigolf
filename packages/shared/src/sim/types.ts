import type { Vec2 } from '../course/types';

export interface BallState {
  x: number; y: number;        // px, centre
  vx: number; vy: number;      // px/s
  moving: boolean;
  lastTile: number;            // tile index under the centre at the end of the previous tick (-1 at creation)
  teleportCooldownTile: number;// pad tile the ball must leave before any pad triggers again; -1 none
  insideOneWay: number;        // one-way tile whose segments are ignored while the centre is inside it; -1 none
  slowTicks: number;           // consecutive ticks below STOP_SPEED while a slope or magnet force acts (wedge detection)
}

export interface WorldState {
  walls: Uint8Array;      // TILE_COUNT current WallShape codes (mutable copy of CourseLayers.walls)
  breakHits: Uint8Array;  // TILE_COUNT hits taken so far
  minesArmed: Uint8Array; // one per CourseLayers.mines entry, 1 = armed
}

/** Changes made to a WorldState by one shot (wire form; applied with applyWorldDelta). */
export interface WorldDelta {
  tiles: { i: number; wall: number; hits: number }[];
  minesDisarmed: number[];
}

/** Integer pull vector in 1/100 px. The ball travels in the direction of (dx, dy). |pull| <= MAX_PULL_PX. */
export interface ShotInput { dx: number; dy: number }

export type ShotResult = 'stopped' | 'holed' | 'water' | 'acid' | 'mine' | 'timeout';
export type StepStatus = 'moving' | ShotResult;

export type SimEvent =
  | { tick: number; type: 'bounce'; x: number; y: number; nx: number; ny: number; speed: number; tile: number; material: 'wall' | 'breakable' | 'movable' | 'bumper' | 'oneway' | 'border' }
  | { tick: number; type: 'break'; tile: number; hitsLeft: number }
  | { tick: number; type: 'destroyed'; tile: number }
  | { tick: number; type: 'blockMoved'; from: number; to: number }
  | { tick: number; type: 'teleport'; from: number; to: number }
  | { tick: number; type: 'tar'; tile: number }
  | { tick: number; type: 'water'; tile: number }
  | { tick: number; type: 'acid'; tile: number }
  | { tick: number; type: 'mine'; index: number }
  | { tick: number; type: 'holed'; hole: number }
  | { tick: number; type: 'stopped' }
  | { tick: number; type: 'timeout' };

/** Per-shot scratch state owned by simulateShot / createShotIterator. */
export interface SimContext {
  shotOrigin: Vec2;            // ball position when the shot started (water/mine reset target)
  startPos: Vec2;              // course start centre (acid reset target)
  tick: number;
  teleportCount: number;
  lastBreakTile: number;       // -1
  lastBreakTick: number;       // -1
  otherBalls: readonly Vec2[]; // centres of other players' resting balls (movable block target check)
}

/** Full in-memory result. */
export interface ShotOutcome {
  ticks: number;
  result: ShotResult;
  penalty: 0 | 1;              // water, acid, mine => 1
  holeIndex: number;           // index into CourseLayers.holes when result === 'holed', else -1
  ball: BallState;             // final ball (after reset for water/acid/mine)
  world: WorldState;           // final world
  worldDelta: WorldDelta;
  events: SimEvent[];
  checksum: number;            // hashSimState(ball, world)
}

/** Wire form carried in GameEvent 'shotTaken' (no typed arrays, no event list). */
export interface ShotSummary {
  ticks: number;
  result: ShotResult;
  penalty: 0 | 1;
  holeIndex: number;
  ball: BallState;
  worldDelta: WorldDelta;
  checksum: number;
}

/** One shot advanced tick by tick (client animation). createShotIterator() in sim/simulate.ts returns it; simulateShot() runs it to completion. */
export interface ShotIterator {
  readonly ball: BallState;          // live, mutated by step()
  readonly world: WorldState;        // live
  readonly events: SimEvent[];
  readonly ctx: SimContext;
  readonly done: boolean;
  readonly result: ShotResult | null;
  readonly penalty: 0 | 1;
  readonly holeIndex: number;        // -1 unless result === 'holed'
  step(): StepStatus;                // advances exactly one tick; no-op when done
}
