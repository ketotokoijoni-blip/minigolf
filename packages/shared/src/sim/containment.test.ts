import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, COURSE_H, COURSE_W, FIELD_H, FIELD_W, MAX_SHOT_TICKS, TILE, TILE_COUNT } from '../constants';
import { tileX, tileY } from '../course/grid';
import { Surface, WallShape } from '../course/types';
import type { CourseLayers } from '../course/types';
import { xorshift32 } from '../math/rng';
import { quantizeShot } from './shot';
import { createShotIterator } from './simulate';
import { freshWorld, testCourse } from './testCourses';
import { createBallAt } from './worldState';

const R = BALL_RADIUS;

/** Tiles a ball may legally rest on: no wall, no water/acid. */
function freeTiles(layers: CourseLayers): number[] {
  const out: number[] = [];
  for (let i = 0; i < TILE_COUNT; i++) {
    const s = layers.surface[i];
    if (layers.walls[i] === WallShape.None && s !== Surface.Water && s !== Surface.Acid) out.push(i);
  }
  return out;
}

function containmentRun(name: string, seed: number, shots: number) {
  const layers = testCourse(name);
  const free = freeTiles(layers);
  const rnd = xorshift32(seed);
  const results: Record<string, number> = {};
  let ticks = 0;
  for (let s = 0; s < shots; s++) {
    const tile = free[Math.floor(rnd() * free.length)]!;
    const x = Math.min(FIELD_W - R, Math.max(R, (tileX(tile) + 0.5) * TILE + (rnd() - 0.5) * 8));
    const y = Math.min(FIELD_H - R, Math.max(R, (tileY(tile) + 0.5) * TILE + (rnd() - 0.5) * 8));
    const angle = rnd() * Math.PI * 2;
    const pull = 3 + rnd() * 117;
    const shot = quantizeShot(Math.cos(angle) * pull, Math.sin(angle) * pull);
    const it = createShotIterator(layers, freshWorld(layers), createBallAt({ x, y }), shot);
    let steps = 0;
    while (!it.done) {
      it.step();
      steps++;
      const b = it.ball;
      const ok = b.x >= R - 1e-9 && b.x <= FIELD_W - R + 1e-9 && b.y >= R - 1e-9 && b.y <= FIELD_H - R + 1e-9;
      if (!ok || Number.isNaN(b.x) || Number.isNaN(b.y) || Number.isNaN(b.vx) || Number.isNaN(b.vy)) {
        throw new Error(`${name} seed ${seed} shot ${s} from (${x}, ${y}) ${JSON.stringify(shot)}: ball at (${b.x}, ${b.y}) v (${b.vx}, ${b.vy}) after ${steps} ticks`);
      }
      if (steps > MAX_SHOT_TICKS) throw new Error(`${name} shot ${s} did not terminate`);
    }
    expect(it.result).not.toBeNull();
    expect(it.ball.moving).toBe(false);
    results[it.result!] = (results[it.result!] ?? 0) + 1;
    ticks += it.ctx.tick;
  }
  return { results, ticks };
}

describe('containment', () => {
  it('open course: 10 000 seeded random shots stay inside the field, never NaN, always terminate', { timeout: 120_000 }, () => {
    const { results } = containmentRun('open', 0x5eed1, 10_000);
    expect((results['timeout'] ?? 0)).toBe(0); // nothing to get stuck on
    expect(COURSE_W * COURSE_H).toBe(TILE_COUNT);
  });

  it('arena (every shape, surface and object): 10 000 seeded random shots stay inside the field', { timeout: 120_000 }, () => {
    const { results } = containmentRun('arena', 0x5eed2, 10_000);
    const total = Object.values(results).reduce((a, b) => a + b, 0);
    expect(total).toBe(10_000);
    // the ice patch with bumpers can legitimately keep a ball alive for 30 s, but traps would show up as a flood of timeouts
    expect((results['timeout'] ?? 0) / total).toBeLessThan(0.02);
    expect(results['holed'] ?? 0).toBeGreaterThan(0);
    expect(results['water'] ?? 0).toBeGreaterThan(0);
  });
});
