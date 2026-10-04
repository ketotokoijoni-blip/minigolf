// Course solvability golden test (WP-K; DESIGN D12, §15 WP-K, §16.2): a scripted shot sequence per built-in course
// must hole out in <= par + 2 strokes (shots + penalties), replayed with the real simulateShot under default tuning.
// The sequences live in sim/__fixtures__/solvability.json, keyed by SIM_VERSION like the golden fixture.
//
// Also pins the two world-construction paths together (§15 WP-K acceptance): createWorldFromCourse(course) must equal
// the world built from WP-A's decoded layers (createWorld(layers.walls, layers.mines.length)) for every built-in, so
// the reducer (which uses createWorldFromCourse) and the sim/editor (which use decodeLayers) start every hole from
// the same walls, hit counts and armed mines.
//
// Regeneration after a tuning change (lead's tuning pass):
//   SOLVABILITY_UPDATE=1 npx vitest run packages/shared/src/sim/solvability
//   (PowerShell: $env:SOLVABILITY_UPDATE='1'; npx vitest run packages/shared/src/sim/solvability)
// The test then runs a beam search per course (same idea as WP-B's playability probe), rewrites the fixture with the
// best sequence it finds and passes; a course for which no <= par + 2 sequence exists fails with its name, which
// means the course or the tuning needs attention, not the test.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COURSE_H, COURSE_W, SIM_VERSION, TILE, TILE_COUNT } from '../constants';
import { BUILTIN_COURSES } from '../course/builtin';
import { isBreakable, isOneWay } from '../course/chars';
import { tileIndex, tileX, tileY } from '../course/grid';
import { decodeLayers } from '../course/parse';
import { Surface, WallShape } from '../course/types';
import type { Course, CourseLayers } from '../course/types';
import { quantizeShot, validateShot } from './shot';
import { simulateShot } from './simulate';
import { resetSimTuning } from './tuning';
import type { BallState, ShotInput, ShotOutcome, WorldState } from './types';
import { createBallAt, createWorld, createWorldFromCourse } from './worldState';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'solvability.json');
const UPDATE = process.env['SOLVABILITY_UPDATE'] === '1';
const HOW_TO = 'run `SOLVABILITY_UPDATE=1 npx vitest run packages/shared/src/sim/solvability` to regenerate sim/__fixtures__/solvability.json';
/** Strokes allowed over par (D12). */
export const SOLVABILITY_MARGIN = 2;

interface FixtureCourse { id: string; par: number; strokes: number; shots: ShotInput[] }
interface FixtureFile { simVersion: number; note: string; courses: FixtureCourse[] }

interface Builtin { course: Course; layers: CourseLayers; world: WorldState }

interface Played { outcomes: ShotOutcome[]; strokes: number; holed: boolean }

/** Plays `shots` from the start on a fresh world; strokes = shots + penalties; stops at the first hole-out. */
export function playSequence(b: Builtin, shots: readonly ShotInput[]): Played {
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

function trace(played: Played): string {
  return played.outcomes.map((o) => `${o.result}${o.penalty ? '+1' : ''} ${o.ticks}t @(${o.ball.x.toFixed(1)},${o.ball.y.toFixed(1)})`).join(' -> ');
}

// ---------------------------------------------------------------------------------------------------------------------
// Search (SOLVABILITY_UPDATE=1 only): beam search over fans of shots, ranked by tile distance to the nearest hole.

function shotAt(deg: number, pull: number): ShotInput {
  const a = (deg * Math.PI) / 180; // test-only trig; the sim itself never sees an angle
  return quantizeShot(Math.cos(a) * pull, Math.sin(a) * pull);
}

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
    if (x < 0 || y < 0 || x >= COURSE_W || y >= COURSE_H) return;
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
  return (field[tile] ?? 1e6) * TILE + best * 0.5 + strokes * 400;
}

function searchSolution(b: Builtin, maxStrokes: number): { shots: ShotInput[]; strokes: number } | null {
  const field = holeDistanceField(b.layers);
  const fan: ShotInput[] = [];
  for (let deg = 0; deg < 360; deg += 2) for (const pull of [15, 30, 45, 60, 75, 90, 105, 120]) fan.push(shotAt(deg, pull));
  let frontier: Node[] = [{ ball: createBallAt(b.layers.start), world: b.world, shots: [], strokes: 0, score: 0 }];
  let best: { shots: ShotInput[]; strokes: number; ticks: number } | null = null;
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
          if (best === null || strokes < best.strokes || (strokes === best.strokes && o.ticks < best.ticks)) best = { shots, strokes, ticks: o.ticks };
          continue;
        }
        if (best !== null && strokes + 1 > best.strokes) continue;
        const key = `${Math.round(o.ball.x)},${Math.round(o.ball.y)},${o.checksum}`;
        if (seen[key]) continue;
        seen[key] = true;
        next.push({ ball: o.ball, world: o.world, shots, strokes, score: scoreOf(b.layers, field, o.ball, strokes) });
      }
    }
    if (best !== null && depth + 2 > best.strokes) break;
    const cap = best === null ? Infinity : best.strokes - 1;
    next.sort((p, q) => p.score - q.score);
    frontier = next.filter((n) => n.strokes <= cap).slice(0, 8);
  }
  return best === null ? null : { shots: best.shots, strokes: best.strokes };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests

function loadBuiltins(): Builtin[] {
  return BUILTIN_COURSES.map((course) => ({ course, layers: decodeLayers(course), world: createWorldFromCourse(course) }));
}

function readFixture(): FixtureFile | null {
  if (!existsSync(FIXTURE)) return null;
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as FixtureFile;
}

describe('solvability fixture (built-in courses hole out in <= par + 2)', () => {
  beforeAll(() => resetSimTuning());
  afterAll(() => resetSimTuning());

  const builtins = loadBuiltins();
  let fixture = readFixture();

  if (UPDATE) {
    // Regenerate: keep a fixture sequence that still works, search where it does not or where the file is missing.
    const courses: FixtureCourse[] = [];
    for (const b of builtins) {
      const limit = b.course.rules.par + SOLVABILITY_MARGIN;
      const old = fixture?.courses.find((c) => c.id === b.course.id);
      const oldPlayed = old && fixture?.simVersion === SIM_VERSION ? playSequence(b, old.shots) : null;
      if (old && oldPlayed && oldPlayed.holed && oldPlayed.strokes <= limit) {
        courses.push({ id: b.course.id, par: b.course.rules.par, strokes: oldPlayed.strokes, shots: old.shots });
        continue;
      }
      const found = searchSolution(b, limit);
      if (found === null) throw new Error(`${b.course.id} ${b.course.name}: no sequence within par + ${SOLVABILITY_MARGIN} = ${limit} strokes found; adjust the course or the tuning`);
      courses.push({ id: b.course.id, par: b.course.rules.par, strokes: found.strokes, shots: found.shots });
    }
    fixture = {
      simVersion: SIM_VERSION,
      note: fixture?.note ?? 'Scripted shot sequence per built-in course that holes out in <= par + 2 strokes (DESIGN D12, §16.2).',
      courses,
    };
    writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2).replace(/\{\s+"dx": (-?\d+),\s+"dy": (-?\d+)\s+\}/g, '{ "dx": $1, "dy": $2 }') + '\n');
  }

  it(`fixture exists and is keyed by SIM_VERSION ${SIM_VERSION}`, () => {
    expect(fixture, `missing fixture; ${HOW_TO}`).not.toBeNull();
    expect(fixture!.simVersion, `fixture simVersion ${fixture!.simVersion} !== SIM_VERSION ${SIM_VERSION}; ${HOW_TO}`).toBe(SIM_VERSION);
  });

  it('covers every built-in course exactly once with its current par', () => {
    const ids = fixture!.courses.map((c) => c.id);
    expect(ids).toEqual(builtins.map((b) => b.course.id));
    for (const b of builtins) {
      const entry = fixture!.courses.find((c) => c.id === b.course.id)!;
      expect(entry.par, `${b.course.id} par changed (COURSES.md / course JSON); ${HOW_TO}`).toBe(b.course.rules.par);
      expect(entry.shots.length).toBeGreaterThan(0);
    }
  });

  for (const b of builtins) {
    it(`${b.course.id} ${b.course.name} (par ${b.course.rules.par}): the scripted sequence holes out in <= par + ${SOLVABILITY_MARGIN}`, () => {
      const entry = fixture!.courses.find((c) => c.id === b.course.id);
      expect(entry, `${b.course.id} missing from the fixture; ${HOW_TO}`).toBeDefined();
      for (const shot of entry!.shots) expect(validateShot(shot), `invalid shot ${JSON.stringify(shot)}`).toBe(true);
      const played = playSequence(b, entry!.shots);
      const info = `${b.course.id}: ${trace(played)}; ${HOW_TO}`;
      expect(played.holed, info).toBe(true);
      expect(played.strokes, info).toBeLessThanOrEqual(b.course.rules.par + SOLVABILITY_MARGIN);
      expect(played.strokes, `recorded strokes differ: ${info}`).toBe(entry!.strokes);
      const last = played.outcomes[played.outcomes.length - 1]!;
      expect(last.holeIndex).toBeGreaterThanOrEqual(0);
      expect(last.holeIndex).toBeLessThan(b.layers.holes.length);
      expect(last.ball.moving).toBe(false);
      // every shot of the sequence was needed: the sequence is the recorded one, not a longer list with junk at the end
      expect(played.outcomes.length).toBe(entry!.shots.length);
    });
  }

  it('the scripted sequences are deterministic: a second replay yields identical checksums', () => {
    for (const b of builtins) {
      const entry = fixture!.courses.find((c) => c.id === b.course.id)!;
      const a = playSequence(b, entry.shots).outcomes.map((o) => o.checksum);
      const c = playSequence(b, entry.shots).outcomes.map((o) => o.checksum);
      expect(c, b.course.id).toEqual(a);
    }
  });
});

describe('createWorldFromCourse equals the createWorld path for every built-in', () => {
  for (const course of BUILTIN_COURSES) {
    it(`${course.id} ${course.name}`, () => {
      const layers = decodeLayers(course);
      const fromCourse = createWorldFromCourse(course);
      const fromLayers = createWorld(layers.walls, layers.mines.length);
      expect(fromCourse.walls.length).toBe(TILE_COUNT);
      expect(Array.from(fromCourse.walls)).toEqual(Array.from(fromLayers.walls));
      expect(Array.from(fromCourse.breakHits)).toEqual(Array.from(fromLayers.breakHits));
      expect(Array.from(fromCourse.minesArmed)).toEqual(Array.from(fromLayers.minesArmed));
      expect(fromCourse.minesArmed.length).toBe(course.objects.filter((o) => o.type === 'mine').length);
      expect(Array.from(fromCourse.breakHits).every((h) => h === 0)).toBe(true);
      expect(Array.from(fromCourse.minesArmed).every((m) => m === 1)).toBe(true);
      // the world is a copy: mutating it never touches the decoded layers
      fromCourse.walls[0] = (fromCourse.walls[0]! + 1) % 2;
      expect(layers.walls[0]).toBe(fromLayers.walls[0]);
    });
  }
});
