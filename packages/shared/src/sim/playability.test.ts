// Playability probe for the nine built-in courses (WP-B phase 2; DESIGN §15 WP-B, §16.2). Not a golden test: nothing
// here depends on bit-exact checksums, only on coarse outcomes (containment, termination, holing out), so a tuning
// change moves the numbers without breaking the suite unless a course really became unplayable.
//
// Two parts:
//  1. Fan probe (always on): from the start of every built-in a fan of shots (every ANGLE_STEP degrees x PULLS) is run
//     tick by tick; the ball centre must stay inside [R, FIELD_W - R] x [R, FIELD_H - R], never NaN, and every shot
//     must terminate within MAX_SHOT_TICKS.
//  2. Scripted sequences (always on): SOLUTIONS holds, per course, a shot sequence found by the beam search below; it
//     must hole out in <= par + 3 strokes (shots + penalties). These sequences feed WP-K's solvability fixture
//     (sim/__fixtures__/solvability.json, <= par + 2) and the lead's tuning pass.
//
// Re-running the search after a tuning change:  PROBE_SEARCH=1 npx vitest run packages/shared/src/sim/playability
// (Windows PowerShell: $env:PROBE_SEARCH='1'; npx vitest run packages/shared/src/sim/playability). It prints one
// line per course with the best sequence it found; paste those into SOLUTIONS.
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, FIELD_H, FIELD_W, MAX_SHOT_TICKS, TILE, TILE_COUNT } from '../constants';
import { BUILTIN_COURSES } from '../course/builtin';
import { isBreakable, isOneWay } from '../course/chars';
import { tileIndex, tileX, tileY } from '../course/grid';
import { decodeLayers } from '../course/parse';
import { Surface, WallShape } from '../course/types';
import type { Course, CourseLayers } from '../course/types';
import { quantizeShot, validateShot } from './shot';
import { createShotIterator, simulateShot } from './simulate';
import { resetSimTuning } from './tuning';
import type { BallState, ShotInput, ShotOutcome, WorldState } from './types';
import { createBallAt, createWorldFromCourse } from './worldState';

const R = BALL_RADIUS;
const SEARCH = process.env['PROBE_SEARCH'] === '1';

// ---------------------------------------------------------------------------------------------------------------------
// Scripted sequences (output of the PROBE_SEARCH run; strokes = shots + penalties)

interface Solution { id: string; shots: ShotInput[]; strokes: number }

/** Best sequence found per course by the beam search (see file header). Shots are ShotInput (1/100 px pull). */
const SOLUTIONS: Solution[] = [
  // PROBE_SEARCH run at SIM_VERSION 1 (angle step 2 deg, pulls 15..120 px, beam 8). Five courses have a hole-in-one
  // from the start; the deepest sequence needed was three shots (b_08). No penalties in any best sequence.
  { id: 'b_01', strokes: 1, shots: [{ dx: 12000, dy: 0 }] },                                                        // full power straight through the sand
  { id: 'b_02', strokes: 1, shots: [{ dx: 11883, dy: -1670 }] },                                                    // corridor, diagonal bank, up the shaft
  { id: 'b_03', strokes: 1, shots: [{ dx: 8560, dy: -2781 }] },                                                     // bank off the corridor wall across the ice
  { id: 'b_04', strokes: 1, shots: [{ dx: 10500, dy: 0 }] },                                                        // straight along the isthmus
  { id: 'b_05', strokes: 1, shots: [{ dx: 6741, dy: 3288 }] },                                                      // pad B, ice lane, cup
  { id: 'b_06', strokes: 2, shots: [{ dx: 7053, dy: -9708 }, { dx: 2385, dy: -3816 }] },                            // over the inner wall, approach from below past the repeller
  { id: 'b_07', strokes: 2, shots: [{ dx: 7461, dy: -5033 }, { dx: 6000, dy: -10392 }] },                           // around the breakable wall's top end, bank off the top wall
  { id: 'b_08', strokes: 3, shots: [{ dx: 6000, dy: 0 }, { dx: -3694, dy: 4728 }, { dx: 8978, dy: -628 }] },         // gate, bumper bank to the exit gate, approach
  { id: 'b_09', strokes: 2, shots: [{ dx: 7294, dy: 7553 }, { dx: 4366, dy: -1089 }] },                             // bottom-wall bank up the slope lane, putt into hole A
];

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

interface Builtin { course: Course; layers: CourseLayers; world: WorldState }

function loadBuiltins(): Builtin[] {
  return BUILTIN_COURSES.map((course) => ({ course, layers: decodeLayers(course), world: createWorldFromCourse(course) }));
}

/** ShotInput for a pull of `pull` px at `deg` degrees (0 = east, 90 = south; screen coordinates). Test-only trig. */
function shotAt(deg: number, pull: number): ShotInput {
  const a = (deg * Math.PI) / 180;
  return quantizeShot(Math.cos(a) * pull, Math.sin(a) * pull);
}

function insideField(b: BallState): boolean {
  return b.x >= R - 1e-9 && b.x <= FIELD_W - R + 1e-9 && b.y >= R - 1e-9 && b.y <= FIELD_H - R + 1e-9;
}

function finite(b: BallState): boolean {
  return Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.vx) && Number.isFinite(b.vy);
}

/** Plays `shots` from the start on a fresh world; returns per-shot outcomes and the stroke count (shots + penalties). */
function playSequence(b: Builtin, shots: readonly ShotInput[]): { outcomes: ShotOutcome[]; strokes: number; holed: boolean } {
  let world = b.world;
  let ball = createBallAt(b.layers.start);
  const outcomes: ShotOutcome[] = [];
  let strokes = 0;
  for (const shot of shots) {
    const o = simulateShot(b.layers, world, ball, shot);
    outcomes.push(o);
    strokes += 1 + o.penalty;
    world = o.world;
    ball = o.ball;
    if (o.result === 'holed') return { outcomes, strokes, holed: true };
  }
  return { outcomes, strokes, holed: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// Beam search (PROBE_SEARCH=1 only)

/**
 * Tile distance to the nearest hole over 4-connected tiles the ball could occupy (no solid wall, no water/acid;
 * breakable, movable and one-way tiles count as passable), with teleporter edges in both directions. Pure heuristic for
 * ranking intermediate ball positions; unreachable tiles get a large value.
 */
function holeDistanceField(layers: CourseLayers): Float64Array {
  const dist = new Float64Array(TILE_COUNT).fill(1e6);
  const passable = (i: number): boolean => {
    const w = layers.walls[i] ?? 0;
    const s = layers.surface[i] ?? 0;
    if (s === Surface.Water || s === Surface.Acid) return false;
    return w === WallShape.None || isOneWay(w) || isBreakable(w) || w === WallShape.Movable;
  };
  const partner = new Int16Array(TILE_COUNT).fill(-1);
  for (const pad of layers.teleports) partner[pad.tile] = pad.partnerTile;
  const queue: number[] = [];
  for (const h of layers.holes) {
    dist[h.tile] = 0;
    queue.push(h.tile);
  }
  let head = 0;
  const visit = (x: number, y: number, d: number): void => {
    if (x < 0 || y < 0 || x >= FIELD_W / TILE || y >= FIELD_H / TILE) return;
    const i = tileIndex(x, y);
    if (!passable(i) || dist[i]! <= d) return;
    dist[i] = d;
    queue.push(i);
  };
  while (head < queue.length) {
    const i = queue[head++]!;
    const d = dist[i]! + 1;
    const x = tileX(i);
    const y = tileY(i);
    visit(x + 1, y, d);
    visit(x - 1, y, d);
    visit(x, y + 1, d);
    visit(x, y - 1, d);
    const p = partner[i] ?? -1;
    if (p !== -1) visit(tileX(p), tileY(p), d);
  }
  return dist;
}

interface Node { ball: BallState; world: WorldState; shots: ShotInput[]; strokes: number; score: number }

function scoreOf(layers: CourseLayers, field: Float64Array, ball: BallState, strokes: number): number {
  const tile = tileIndex(Math.floor(ball.x / TILE), Math.floor(ball.y / TILE));
  let best = Infinity;
  for (const h of layers.holes) best = Math.min(best, Math.sqrt((h.cx - ball.x) * (h.cx - ball.x) + (h.cy - ball.y) * (h.cy - ball.y)));
  // tile distance dominates (handles walls and teleporters); the Euclidean remainder breaks ties within a region
  return (field[tile] ?? 1e6) * TILE + best * 0.5 + strokes * 400;
}

/** Beam search over fans of shots: the best holing sequence (fewest strokes, then fewest ticks) or null, plus the number
 *  of fan shots from the start that hole out directly (the "ace count", a difficulty signal for the tuning pass). */
function searchSolution(
  b: Builtin, maxStrokes: number, opts: { angleStep: number; pulls: number[]; beam: number },
): { solution: Solution | null; aces: number; fanSize: number } {
  const field = holeDistanceField(b.layers);
  const fan: ShotInput[] = [];
  for (let deg = 0; deg < 360; deg += opts.angleStep) for (const pull of opts.pulls) fan.push(shotAt(deg, pull));
  let frontier: Node[] = [{ ball: createBallAt(b.layers.start), world: b.world, shots: [], strokes: 0, score: 0 }];
  let best: (Solution & { ticks: number }) | null = null;
  let aces = 0;
  for (let depth = 0; depth < maxStrokes && frontier.length > 0; depth++) {
    const next: Node[] = [];
    const seen: Record<string, true> = {};
    for (const node of frontier) {
      for (const shot of fan) {
        const o = simulateShot(b.layers, node.world, node.ball, shot);
        const strokes = node.strokes + 1 + o.penalty;
        if (strokes > maxStrokes) continue;
        const shots = node.shots.concat([shot]);
        if (o.result === 'holed') {
          if (depth === 0) aces++;
          const ticks = o.ticks;
          if (best === null || strokes < best.strokes || (strokes === best.strokes && ticks < best.ticks)) {
            best = { id: b.course.id, shots, strokes, ticks };
          }
          continue;
        }
        if (best !== null && strokes + 1 > best.strokes) continue; // cannot beat the solution we already have
        const key = `${Math.round(o.ball.x)},${Math.round(o.ball.y)},${o.checksum}`;
        if (seen[key]) continue;
        seen[key] = true;
        next.push({ ball: o.ball, world: o.world, shots, strokes, score: scoreOf(b.layers, field, o.ball, strokes) });
      }
    }
    // A sequence one shot longer has >= depth + 2 strokes: keep searching only while it could still tie best (fewer
    // ticks) or beat a best that carries penalties; shorter-but-penalised solutions must not hide penalty-free ones.
    if (best !== null && depth + 2 > best.strokes) break;
    const cap = best === null ? Infinity : best.strokes - 1;
    next.sort((p, q) => p.score - q.score);
    frontier = next.filter((n) => n.strokes <= cap).slice(0, opts.beam);
  }
  return { solution: best === null ? null : { id: best.id, shots: best.shots, strokes: best.strokes }, aces, fanSize: fan.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests

const ANGLE_STEP = 3;
const PULLS = [20, 40, 60, 80, 100, 120];

describe('playability probe (built-in courses)', () => {
  resetSimTuning();
  const builtins = loadBuiltins();

  it('loads all nine built-ins', () => {
    expect(builtins.map((b) => b.course.id)).toEqual(['b_01', 'b_02', 'b_03', 'b_04', 'b_05', 'b_06', 'b_07', 'b_08', 'b_09']);
  });

  for (const b of builtins) {
    it(`${b.course.id} ${b.course.name}: a fan of ${(360 / ANGLE_STEP) * PULLS.length} shots from the start stays inside the field, never NaNs, always terminates`, { timeout: 60_000 }, () => {
      const results: Record<string, number> = {};
      for (let deg = 0; deg < 360; deg += ANGLE_STEP) {
        for (const pull of PULLS) {
          const shot = shotAt(deg, pull);
          expect(validateShot(shot)).toBe(true);
          const iter = createShotIterator(b.layers, b.world, createBallAt(b.layers.start), shot);
          let steps = 0;
          while (!iter.done) {
            iter.step();
            steps++;
            const ball = iter.ball;
            if (!finite(ball) || !insideField(ball)) {
              throw new Error(`${b.course.id} shot ${deg}deg/${pull}px: ball at (${ball.x}, ${ball.y}) v (${ball.vx}, ${ball.vy}) after ${steps} ticks`);
            }
            if (steps > MAX_SHOT_TICKS) throw new Error(`${b.course.id} shot ${deg}deg/${pull}px did not terminate`);
          }
          expect(iter.result).not.toBeNull();
          expect(iter.ball.moving).toBe(false);
          expect(finite(iter.ball) && insideField(iter.ball)).toBe(true);
          results[iter.result!] = (results[iter.result!] ?? 0) + 1;
        }
      }
      // a flood of timeouts would mean the start is next to a trap; a few are legitimate (bumpers, ice)
      const total = (360 / ANGLE_STEP) * PULLS.length;
      expect((results['timeout'] ?? 0) / total).toBeLessThan(0.05);
    });
  }

  for (const b of builtins) {
    const sol = SOLUTIONS.find((s) => s.id === b.course.id);
    it.skipIf(sol === undefined)(`${b.course.id} ${b.course.name} (par ${b.course.rules.par}): the scripted sequence holes out in <= par + 3`, () => {
      const s = sol!;
      for (const shot of s.shots) expect(validateShot(shot), JSON.stringify(shot)).toBe(true);
      const played = playSequence(b, s.shots);
      const trace = played.outcomes.map((o) => `${o.result}${o.penalty ? '+1' : ''}@(${o.ball.x.toFixed(1)},${o.ball.y.toFixed(1)})`).join(' -> ');
      expect(played.holed, `${b.course.id}: ${trace}`).toBe(true);
      expect(played.strokes, `${b.course.id}: ${trace}`).toBe(s.strokes);
      expect(played.strokes).toBeLessThanOrEqual(b.course.rules.par + 3);
      expect(played.outcomes[played.outcomes.length - 1]!.holeIndex).toBeGreaterThanOrEqual(0);
    });
  }

  it.runIf(SEARCH)('PROBE_SEARCH: beam search for a holing sequence per course (prints results)', { timeout: 3_600_000 }, () => {
    const lines: string[] = [];
    for (const b of builtins) {
      const t0 = performance.now();
      const limit = b.course.rules.par + 3;
      const { solution: sol, aces, fanSize } = searchSolution(b, limit, { angleStep: 2, pulls: [15, 30, 45, 60, 75, 90, 105, 120], beam: 8 });
      const ms = Math.round(performance.now() - t0);
      const aceNote = `aces from the start: ${aces}/${fanSize}`;
      if (sol === null) {
        lines.push(`${b.course.id} ${b.course.name} par ${b.course.rules.par}: NO SOLUTION within ${limit} strokes (${aceNote}, ${ms} ms)`);
        continue;
      }
      const played = playSequence(b, sol.shots);
      const trace = played.outcomes.map((o) => `${o.result}${o.penalty ? '+1' : ''} ${o.ticks}t @(${o.ball.x.toFixed(1)},${o.ball.y.toFixed(1)})`).join(' -> ');
      lines.push(`${b.course.id} ${b.course.name} par ${b.course.rules.par}: ${sol.strokes} strokes, ${sol.shots.length} shots (${aceNote}, ${ms} ms)\n` +
        `  { id: '${sol.id}', strokes: ${sol.strokes}, shots: ${JSON.stringify(sol.shots).replace(/"/g, '').replace(/,/g, ', ').replace(/:/g, ': ')} },\n  ${trace}`);
    }
    console.log('\nPROBE_SEARCH results\n' + lines.join('\n'));
    expect(lines.length).toBe(builtins.length);
  });
});
